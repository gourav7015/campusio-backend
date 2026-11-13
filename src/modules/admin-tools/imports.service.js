import { z } from 'zod';
import { ImportBatch, Student, Teacher, StudentEnrolment, Section, User, AttendanceRecord, Marks, MarksSheet, TeachingAssignment, Session } from '../../models/index.js';
import { notFound, conflict, escapeRegex } from '../../core/utils.js';
import { admitStudent } from '../students/students.service.js';
import { createTeacher } from '../teachers/teachers.service.js';
import { admitBody } from '../students/students.validation.js';
import { teacherBody } from '../teachers/teachers.validation.js';
import { assertWithinLimit } from '../../services/enrolment.js';

export const rowsBody = z.object({ rows: z.array(z.record(z.any())).min(1).max(1000), dryRun: z.boolean().default(true), skipInvalid: z.boolean().default(false), yearId: z.string().optional() });

const clean = (v) => (v === undefined || v === null ? undefined : String(v).trim() || undefined);

export async function importStudents(ctx, { rows, dryRun, skipInvalid, yearId }) {
  const year = ctx.year;
  const sections = await Section.find({ tenantId: ctx.tenantId, yearId: yearId || year._id }).populate('classId', 'name').lean();
  const key = (cn, sn) => `${String(cn).toLowerCase().trim()}|${String(sn).toLowerCase().trim()}`;
  const secMap = new Map(sections.map((s) => [key(s.classId.name, s.name), s]));
  await assertWithinLimit(ctx.tenantId, 'student', 0);
  const seenAdm = new Set(); const seenId = new Set();
  const report = [];
  const valid = [];
  for (const [i, raw] of rows.entries()) {
    const errors = [];
    const sec = secMap.get(key(raw.className ?? raw.class ?? '', raw.section ?? ''));
    if (!sec) errors.push(`Class/section "${raw.className ?? raw.class ?? ''} ${raw.section ?? ''}" not found in this academic year`);
    const admissionNo = clean(raw.admissionNo);
    if (admissionNo) {
      if (seenAdm.has(admissionNo)) errors.push('Duplicate admission number in this file');
      else if (await Student.exists({ tenantId: ctx.tenantId, admissionNo })) errors.push('Admission number already exists');
      seenAdm.add(admissionNo);
    }
    const candidate = {
      name: clean(raw.name), dob: clean(raw.dob), gender: clean(raw.gender)?.toLowerCase() || '', address: clean(raw.address), phone: clean(raw.phone), email: clean(raw.email), house: clean(raw.house), admissionNo,
      admissionDate: clean(raw.admissionDate), yearId: String(yearId || year._id), sectionId: sec && String(sec._id), rollNo: raw.rollNo ? Number(raw.rollNo) : undefined,
      guardians: [{ name: clean(raw.guardianName), relationship: clean(raw.guardianRelationship) || 'Guardian', phone: clean(raw.guardianPhone), isPrimary: true }],
    };
    const parsed = admitBody.safeParse(candidate);
    if (!parsed.success) parsed.error.issues.forEach((x) => errors.push(`${x.path.join('.')}: ${x.message}`));
    if (parsed.success) {
      const dupKey = `${parsed.data.name.toLowerCase()}|${parsed.data.dob}`;
      if (seenId.has(dupKey)) errors.push('Same name and date of birth appears twice in this file');
      seenId.add(dupKey);
      if (await Student.exists({ tenantId: ctx.tenantId, name: new RegExp(`^${escapeRegex(parsed.data.name)}$`, 'i'), dob: parsed.data.dob })) errors.push('A student with the same name and date of birth already exists');
    }
    report.push({ row: i + 1, name: candidate.name, ok: !errors.length, errors });
    if (!errors.length) valid.push({ row: i + 1, data: parsed.data });
  }
  const invalid = report.filter((r) => !r.ok).length;
  if (dryRun || (invalid && !skipInvalid)) return { dryRun: true, total: rows.length, valid: valid.length, invalid, report, committed: false };
  await assertWithinLimit(ctx.tenantId, 'student', valid.length);
  const batch = await ImportBatch.create({ tenantId: ctx.tenantId, entity: 'students', createdBy: ctx.actorId, actingAsSuperAdmin: ctx.role === 'super_admin', total: rows.length });
  const credentials = []; const ids = []; const userIds = []; const failed = [];
  for (const v of valid) {
    try {
      const out = await admitStudent({ tenantId: ctx.tenantId, actorId: ctx.actorId, importBatchId: batch._id }, { ...v.data, confirmDuplicate: true });
      ids.push(out.student._id); userIds.push(out.student.userId);
      credentials.push({ name: out.student.name, admissionNo: out.student.admissionNo, loginId: out.credentials.loginId, temporaryPassword: out.credentials.temporaryPassword });
    } catch (e) { failed.push({ row: v.row, error: e.message }); }
  }
  batch.created = ids.length; batch.skipped = rows.length - ids.length; batch.recordIds = ids; batch.userIds = userIds; batch.rowErrors = failed;
  await batch.save();
  return { dryRun: false, committed: true, batchId: batch._id, total: rows.length, created: ids.length, skipped: rows.length - ids.length, report: [...report.filter((r) => !r.ok), ...failed.map((f) => ({ row: f.row, ok: false, errors: [f.error] }))], credentials };
}

export async function importTeachers(ctx, { rows, dryRun, skipInvalid }) {
  const seen = new Set(); const seenEmail = new Set();
  const report = []; const valid = [];
  for (const [i, raw] of rows.entries()) {
    const errors = [];
    const subjectNames = (clean(raw.subjects) || '').split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
    const candidate = { name: clean(raw.name), employeeId: clean(raw.employeeId), email: clean(raw.email) || '', phone: clean(raw.phone), qualification: clean(raw.qualification), designation: clean(raw.designation), joiningDate: clean(raw.joiningDate), subjects: subjectNames };
    const parsed = teacherBody.safeParse(candidate);
    if (!parsed.success) parsed.error.issues.forEach((x) => errors.push(`${x.path.join('.')}: ${x.message}`));
    else {
      if (seen.has(parsed.data.employeeId)) errors.push('Duplicate employee id in this file');
      else if (await Teacher.exists({ tenantId: ctx.tenantId, employeeId: parsed.data.employeeId })) errors.push('Employee id already exists');
      seen.add(parsed.data.employeeId);
      if (parsed.data.email) {
        const e = parsed.data.email.toLowerCase();
        if (seenEmail.has(e) || (await User.exists({ loginId: e }))) errors.push('Email is already used as a login');
        seenEmail.add(e);
      }
    }
    report.push({ row: i + 1, name: candidate.name, ok: !errors.length, errors });
    if (!errors.length) valid.push({ row: i + 1, data: parsed.data });
  }
  const invalid = report.filter((r) => !r.ok).length;
  if (dryRun || (invalid && !skipInvalid)) return { dryRun: true, total: rows.length, valid: valid.length, invalid, report, committed: false };
  await assertWithinLimit(ctx.tenantId, 'teacher', valid.length);
  const batch = await ImportBatch.create({ tenantId: ctx.tenantId, entity: 'teachers', createdBy: ctx.actorId, actingAsSuperAdmin: ctx.role === 'super_admin', total: rows.length });
  const credentials = []; const ids = []; const userIds = []; const failed = [];
  for (const v of valid) {
    try {
      const out = await createTeacher({ tenantId: ctx.tenantId, actorId: ctx.actorId, importBatchId: batch._id }, v.data);
      ids.push(out.teacher._id); userIds.push(out.teacher.userId);
      credentials.push({ name: out.teacher.name, employeeId: out.teacher.employeeId, loginId: out.credentials.loginId, temporaryPassword: out.credentials.temporaryPassword });
    } catch (e) { failed.push({ row: v.row, error: e.message }); }
  }
  batch.created = ids.length; batch.skipped = rows.length - ids.length; batch.recordIds = ids; batch.userIds = userIds; batch.rowErrors = failed;
  await batch.save();
  return { dryRun: false, committed: true, batchId: batch._id, total: rows.length, created: ids.length, skipped: rows.length - ids.length, report: failed.map((f) => ({ row: f.row, ok: false, errors: [f.error] })), credentials };
}

export const listBatches = (tenantId) => ImportBatch.find({ tenantId }).select('-recordIds -userIds').sort({ createdAt: -1 }).limit(50).lean();

/** Undo a data dump: removes only records that have no academic history; anything used is kept and reported. */
export async function rollback(tenantId, id) {
  const b = await ImportBatch.findOne({ _id: id, tenantId });
  if (!b) throw notFound('Import batch not found');
  if (b.status === 'rolled_back') throw conflict('This batch has already been rolled back');
  let removed = 0; const kept = [];
  for (const rid of b.recordIds) {
    if (b.entity === 'students') {
      const used = await Promise.all([AttendanceRecord.exists({ tenantId, studentId: rid }), Marks.exists({ tenantId, studentId: rid })]);
      const s = await Student.findOne({ _id: rid, tenantId });
      if (!s) continue;
      if (used.some(Boolean)) { kept.push(s.name); continue; }
      await StudentEnrolment.deleteMany({ tenantId, studentId: rid });
      if (s.userId) { await Session.deleteMany({ userId: s.userId }); await User.deleteOne({ _id: s.userId }); }
      await s.deleteOne(); removed++;
    } else {
      const t = await Teacher.findOne({ _id: rid, tenantId });
      if (!t) continue;
      const used = await Promise.all([TeachingAssignment.exists({ tenantId, teacherId: rid }), MarksSheet.exists({ tenantId, teacherId: rid })]);
      if (used.some(Boolean)) { kept.push(t.name); continue; }
      if (t.userId) { await Session.deleteMany({ userId: t.userId }); await User.deleteOne({ _id: t.userId }); }
      await t.deleteOne(); removed++;
    }
  }
  b.status = 'rolled_back';
  await b.save();
  return { removed, kept };
}
