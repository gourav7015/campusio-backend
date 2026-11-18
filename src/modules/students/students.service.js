import { rollStatus } from '../../services/context.js';
import {
  Student, StudentEnrolment, TransferRecord, User, Session, AttendanceRecord, Marks, ReportCard, Section, ClassModel, AcademicYear, } from '../../models/index.js';
import { notFound, conflict, bad, todayStr, escapeRegex, generatePassword } from '../../core/utils.js';
import { createUserAccount, schoolCode, hashPassword } from '../../services/users.js';
import { settingsOf, getCurrentYear, loadSchool } from '../../services/context.js';
import { initialPassword } from '../../services/initialPassword.js';
import { clearanceFor } from '../../services/clearance.js';
import { autoAssignForEnrolment, admissionFeePreview, assertDiscountFits } from '../finance/finance.service.js';
import {
  nextRollNo, assertSectionHasRoom, resolvePlacement, generateAdmissionNo,
} from '../../services/enrolment.js';

export async function listStudents(tenantId, q) {
  const year = q.yearId ? await AcademicYear.findOne({ _id: q.yearId, tenantId }) : await getCurrentYear(tenantId);
  const filter = { tenantId };
  if (q.status) filter.status = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { admissionNo: rx }, { 'guardians.name': rx }];
  }
  const enrolFilter = { tenantId, yearId: year?._id, status: rollStatus(year) };
  if (q.classId) enrolFilter.classId = q.classId;
  if (q.sectionId) enrolFilter.sectionId = q.sectionId;
  const enrolments = await StudentEnrolment.find(enrolFilter).lean();
  if (q.classId || q.sectionId) filter._id = { $in: enrolments.map((e) => e.studentId) };
  const [total, students] = await Promise.all([
    Student.countDocuments(filter),
    Student.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
  ]);
  const enrolByStudent = new Map();
  if (!(q.classId || q.sectionId)) {
    const extra = await StudentEnrolment.find({ tenantId, yearId: year?._id, status: rollStatus(year), studentId: { $in: students.map((s) => s._id) } }).lean();
    extra.forEach((e) => enrolByStudent.set(String(e.studentId), e));
  } else enrolments.forEach((e) => enrolByStudent.set(String(e.studentId), e));
  const [sections, classes] = await Promise.all([Section.find({ tenantId, yearId: year?._id }).lean(), ClassModel.find({ tenantId }).lean()]);
  const sec = new Map(sections.map((s) => [String(s._id), s]));
  const cls = new Map(classes.map((c) => [String(c._id), c]));
  return {
    total, page: q.page, limit: q.limit, year: year && { id: year._id, name: year.name },
    items: students.map((s) => {
      const e = enrolByStudent.get(String(s._id));
      return { ...s, enrolment: e && { id: e._id, rollNo: e.rollNo, sectionId: e.sectionId, classId: e.classId, section: sec.get(String(e.sectionId))?.name, className: cls.get(String(e.classId))?.name } };
    }),
  };
}

async function findDuplicateIdentity(tenantId, { name, dob }) {
  return Student.findOne({ tenantId, name: new RegExp(`^${escapeRegex(name)}$`, 'i'), dob, status: { $ne: 'archived' } }).select('name admissionNo dob');
}

export async function admitStudent(ctx, body) {
  const { tenantId, actorId } = ctx;
  const school = await loadSchool(tenantId);
  const settings = settingsOf(school);
  const year = body.yearId ? await AcademicYear.findOne({ _id: body.yearId, tenantId }) : await getCurrentYear(tenantId);
  if (!year) throw bad('Create an academic year first');
  const { section, cls } = await resolvePlacement(tenantId, { yearId: year._id, classId: body.classId, sectionId: body.sectionId });
  if (year.status === 'closed') throw conflict('Cannot admit into a closed academic year');

  await assertSectionHasRoom(tenantId, section);
  const dup = await findDuplicateIdentity(tenantId, body);
  if (dup && !body.confirmDuplicate) {
    throw conflict(`A student named ${dup.name} with the same date of birth already exists (${dup.admissionNo}). Confirm to admit anyway.`, { duplicateOf: dup.admissionNo, code: 'DUPLICATE_IDENTITY' });
  }

  const admissionDate = body.admissionDate || todayStr(settings.timezone);
  const admissionNo = body.admissionNo || (await generateAdmissionNo(tenantId, settings.admissionFormat, admissionDate));
  if (await Student.exists({ tenantId, admissionNo })) throw conflict(`Admission number ${admissionNo} already exists`);

  if (body.discount) assertDiscountFits(body.discount, await admissionFeePreview(tenantId, { yearId: year._id, classId: cls._id, startDate: admissionDate })); // refuse before anything is created

  const rollNo = body.rollNo || (await nextRollNo(tenantId, section._id));
  const code = await schoolCode(tenantId);
  const created = {};
  try {
    const { user, temporaryPassword } = await createUserAccount({
      role: 'student', tenantId, name: body.name, email: body.email || undefined,
      loginId: body.loginId || `${code}.${admissionNo}`.toLowerCase(), createdBy: actorId,
      password: body.password || initialPassword(settings, { name: body.name, dob: body.dob, phone: body.phone || body.guardians?.[0]?.phone }),
    });
    created.user = user;
    const { loginId: _l, password: _p, confirmDuplicate: _c, discount: _d, yearId: _y, classId: _cl, sectionId: _s, rollNo: _r, ...profile } = body;
    const student = await Student.create({ ...profile, tenantId, userId: user._id, admissionNo, admissionDate, importBatchId: ctx.importBatchId });
    created.student = student;
    const enrolment = await StudentEnrolment.create({ tenantId, studentId: student._id, yearId: year._id, classId: cls._id, sectionId: section._id, rollNo, startDate: admissionDate });
    // bill the new student with every auto-assigned fee structure of this class and year
    const result = await autoAssignForEnrolment(tenantId, enrolment, actorId, body.discount).catch((e) => { if (body.discount) throw e; return 0; });
    const billed = body.discount ? result.billed : result;
    if (body.discount) {
      const months = (await admissionFeePreview(tenantId, { yearId: year._id, classId: cls._id, startDate: admissionDate })).months || 1;
      student.personalDiscount = { type: body.discount.type === 'percent' ? 'percent' : 'per_month', value: body.discount.type === 'percent' ? body.discount.value : Math.round((body.discount.value / months) * 100) / 100, reason: body.discount.reason, setByName: 'Admission', setAt: new Date() };
      await student.save();
    }
    return { billed, discount: body.discount ? { ...body.discount, applied: result.discountApplied } : undefined, student, enrolment, credentials: { loginId: user.loginId, temporaryPassword } };
  } catch (e) {
    if (created.student) await Student.deleteOne({ _id: created.student._id });
    if (created.user) await User.deleteOne({ _id: created.user._id });
    throw e;
  }
}

/** What admitting a student into this section today would bill, for the admission form. */
export async function feePreview(tenantId, { sectionId, admissionDate }) {
  const school = await loadSchool(tenantId);
  const section = await Section.findOne({ _id: sectionId, tenantId });
  if (!section) throw notFound('Section not found');
  const date = admissionDate || todayStr(settingsOf(school).timezone);
  return { admissionDate: date, ...(await admissionFeePreview(tenantId, { yearId: section.yearId, classId: section.classId, startDate: date })) };
}

export async function getStudent(tenantId, id) {
  const student = await Student.findOne({ _id: id, tenantId }).lean();
  if (!student) throw notFound('Student not found');
  const [enrolments, transfers, user, years, sections, classes] = await Promise.all([
    StudentEnrolment.find({ tenantId, studentId: id }).sort({ startDate: -1, createdAt: -1 }).lean(),
    TransferRecord.find({ tenantId, studentId: id }).sort({ createdAt: -1 }).lean(),
    User.findById(student.userId).select('loginId status lastLoginAt mustChangePassword'),
    AcademicYear.find({ tenantId }).lean(), Section.find({ tenantId }).lean(), ClassModel.find({ tenantId }).lean(),
  ]);
  const nm = (arr, k = 'name') => new Map(arr.map((x) => [String(x._id), x[k]]));
  const Y = nm(years); const S = nm(sections); const C = nm(classes);
  return {
    ...student, account: user,
    enrolments: enrolments.map((e) => ({ ...e, year: Y.get(String(e.yearId)), section: S.get(String(e.sectionId)), className: C.get(String(e.classId)) })),
    transfers: transfers.map((t) => ({ ...t, fromSection: S.get(String(t.fromSectionId)), toSection: S.get(String(t.toSectionId)) })),
  };
}

export async function updateStudent(tenantId, id, body) {
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Student not found');
  if (body.admissionNo && body.admissionNo !== s.admissionNo && (await Student.exists({ tenantId, admissionNo: body.admissionNo, _id: { $ne: s._id } }))) {
    throw conflict(`Admission number ${body.admissionNo} already exists`);
  }
  Object.assign(s, body);
  await s.save();
  if (body.name) await User.updateOne({ _id: s.userId }, { name: body.name });
  return s;
}

export async function withdrawStudent(tenantId, id, { reason, date, outcome, overrideClearance }) {
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Student not found');
  if (s.status !== 'active') throw conflict(`Student is already ${s.status}`);
  // library books and unpaid fees must be cleared first (or knowingly overridden)
  const clearance = await clearanceFor(tenantId, 'student', s._id);
  if (!clearance.clear && !overrideClearance) {
    throw conflict('This student still has library books or unpaid fees. Clear them, or confirm to withdraw anyway.', { code: 'CLEARANCE_REQUIRED', ...clearance });
  }
  const today = date || todayStr(await loadSchoolTz(tenantId));
  await StudentEnrolment.updateMany({ tenantId, studentId: s._id, status: 'active' }, { status: outcome, endDate: today });
  s.status = outcome;
  await s.save();
  if (s.userId) {
    await User.updateOne({ _id: s.userId }, { status: 'disabled' });
    await Session.updateMany({ userId: s.userId, revokedAt: null }, { revokedAt: new Date() });
  }
  return { student: s, reason };
}
async function loadSchoolTz(tenantId) { return settingsOf(await loadSchool(tenantId)).timezone; }

export async function reactivateStudent(tenantId, id) {
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Student not found');
  if (s.status === 'active') throw conflict('Student is already active');
  s.status = 'active';
  await s.save();
  if (s.userId) await User.updateOne({ _id: s.userId }, { status: 'active' });
  return s;
}

/** Hard removal is allowed only for a student with no academic history (e.g. created by mistake). */
export async function archiveStudent(tenantId, id) {
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Student not found');
  const critical = await Promise.all([
    AttendanceRecord.exists({ tenantId, studentId: s._id }), Marks.exists({ tenantId, studentId: s._id }), ReportCard.exists({ tenantId, studentId: s._id }),
  ]);
  if (critical.some(Boolean)) throw conflict('This student has attendance or marks history and cannot be archived. Withdraw the student instead.');
  s.status = 'archived';
  await s.save();
  await StudentEnrolment.updateMany({ tenantId, studentId: s._id, status: 'active' }, { status: 'withdrawn', endDate: todayStr() });
  if (s.userId) {
    await User.updateOne({ _id: s.userId }, { status: 'disabled' });
    await Session.updateMany({ userId: s.userId, revokedAt: null }, { revokedAt: new Date() });
  }
  return s;
}

export async function resetStudentPassword(tenantId, id) {
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s?.userId) throw notFound('Student account not found');
  const temporaryPassword = initialPassword(settingsOf(await loadSchool(tenantId)), { name: s.name, dob: s.dob, phone: s.phone || s.guardians?.[0]?.phone }) || generatePassword();
  const u = await User.findById(s.userId);
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  return { loginId: u.loginId, temporaryPassword };
}

export async function transferStudent(ctx, id, { toSectionId, effectiveDate, reason, rollNo }) {
  const { tenantId, actorId } = ctx;
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Student not found');
  const current = await StudentEnrolment.findOne({ tenantId, studentId: s._id, status: 'active' });
  if (!current) throw conflict('Student has no active enrolment to transfer');
  if (String(current.sectionId) === String(toSectionId)) throw bad('Student is already in that section');
  const { section, cls } = await resolvePlacement(tenantId, { yearId: current.yearId, sectionId: toSectionId });
  await assertSectionHasRoom(tenantId, section);
  const eff = effectiveDate || todayStr(await loadSchoolTz(tenantId));
  if (eff < current.startDate) throw bad('Effective date is before the current enrolment started');

  const newRoll = rollNo || (await nextRollNo(tenantId, section._id));
  // Close the old enrolment (history keeps its attendance/marks) and open a new one in the new section.
  current.status = 'section_changed'; current.endDate = eff;
  await current.save();
  let next;
  try {
    next = await StudentEnrolment.create({ tenantId, studentId: s._id, yearId: current.yearId, classId: cls._id, sectionId: section._id, rollNo: newRoll, startDate: eff });
  } catch (e) {
    current.status = 'active'; current.endDate = undefined;
    await current.save();
    throw e;
  }
  const record = await TransferRecord.create({
    tenantId, studentId: s._id, fromEnrolmentId: current._id, toEnrolmentId: next._id, fromSectionId: current.sectionId, toSectionId: section._id, effectiveDate: eff, reason, by: actorId,
  });
  return { enrolment: next, transfer: record };
}

/** One change for many students at once (the list's filter picks them). Each student succeeds or fails on its own and the answer says which. */
export async function bulkUpdate(ctx, { studentIds, action, house, toSectionId, reason, effectiveDate }) {
  const ids = [...new Set(studentIds.map(String))];
  const found = await Student.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('name').lean();
  const name = new Map(found.map((x) => [String(x._id), x.name]));
  const failed = []; let done = 0;
  if (action === 'house') {
    const r = await Student.updateMany({ tenantId: ctx.tenantId, _id: { $in: found.map((x) => x._id) } }, { $set: { house } });
    done = r.modifiedCount ?? found.length;
  } else {
    for (const id of ids) {
      if (!name.has(id)) { failed.push({ studentId: id, error: 'Student not found' }); continue; }
      try { await transferStudent(ctx, id, { toSectionId, effectiveDate, reason }); done += 1; } catch (e) { failed.push({ studentId: id, name: name.get(id), error: e.message }); }
    }
  }
  return { requested: ids.length, done, failed };
}
