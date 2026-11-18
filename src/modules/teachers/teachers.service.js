import { Teacher, User, Session, TeachingAssignment, ClassTeacherAssignment } from '../../models/index.js';
import { notFound, conflict, escapeRegex, generatePassword } from '../../core/utils.js';
import { createUserAccount, schoolCode, hashPassword } from '../../services/users.js';
import { initialPassword } from '../../services/initialPassword.js';
import { settingsOf, loadSchool } from '../../services/context.js';
import { schoolToday } from '../../services/context.js';
import { findOrCreateSubject } from '../../services/subjects.js';
import { clearanceFor } from '../../services/clearance.js';
import { endTeacherAssignments } from '../assignments/assignments.service.js';

export async function listTeachers(tenantId, q) {
  const f = { tenantId };
  if (q.status) f.status = q.status;
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ name: rx }, { employeeId: rx }, { email: rx }]; }
  const [total, items] = await Promise.all([
    Teacher.countDocuments(f),
    Teacher.find(f).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('subjectIds', 'name code').lean(),
  ]);
  const users = await User.find({ _id: { $in: items.map((t) => t.userId).filter(Boolean) } }).select('loginId status lastLoginAt').lean();
  const um = new Map(users.map((u) => [String(u._id), u]));
  return { total, items: items.map((t) => ({ ...t, account: um.get(String(t.userId)) })) };
}

/** Subjects a teacher can teach, given as names; created if the school hasn't used them before. */
async function resolveSubjects(tenantId, names = []) {
  const ids = [];
  for (const n of names) ids.push((await findOrCreateSubject(tenantId, n))._id);
  return ids;
}

export async function createTeacher(ctx, body) {
  const { tenantId, actorId } = ctx;
  if (await Teacher.exists({ tenantId, employeeId: body.employeeId })) throw conflict(`Employee id ${body.employeeId} already exists`);
  const subjectIds = await resolveSubjects(tenantId, body.subjects);
  const code = await schoolCode(tenantId);
  const { user, temporaryPassword } = await createUserAccount({
    role: 'teacher', tenantId, name: body.name, email: body.email || undefined,
    loginId: body.loginId || (body.email ? body.email : `${code}.t${body.employeeId}`), createdBy: actorId,
    // chosen by the office, else the school's starting-password format (name + date of birth), else random
    password: body.password || initialPassword(settingsOf(await loadSchool(tenantId)), { name: body.name, dob: body.dob, phone: body.phone }),
  });
  try {
    const { loginId: _l, password: _p, subjects: _s, ...profile } = body;
    const teacher = await Teacher.create({ ...profile, subjectIds, tenantId, userId: user._id, importBatchId: ctx.importBatchId });
    return { teacher, credentials: { loginId: user.loginId, temporaryPassword } };
  } catch (e) {
    await User.deleteOne({ _id: user._id });
    throw e;
  }
}

export async function getTeacher(tenantId, id) {
  const t = await Teacher.findOne({ _id: id, tenantId }).populate('subjectIds', 'name code').lean();
  if (!t) throw notFound('Teacher not found');
  const [account, assignments, classTeacher] = await Promise.all([
    User.findById(t.userId).select('loginId status lastLoginAt'),
    TeachingAssignment.find({ tenantId, teacherId: t._id }).populate('subjectId', 'name code').populate('sectionId', 'name classId').populate('classId', 'name').sort({ createdAt: -1 }).lean(),
    ClassTeacherAssignment.find({ tenantId, teacherId: t._id }).populate('sectionId', 'name classId').lean(),
  ]);
  return { ...t, account, assignments, classTeacherOf: classTeacher };
}

export async function updateTeacher(tenantId, id, body) {
  const t = await Teacher.findOne({ _id: id, tenantId });
  if (!t) throw notFound('Teacher not found');
  if (body.employeeId && body.employeeId !== t.employeeId && (await Teacher.exists({ tenantId, employeeId: body.employeeId, _id: { $ne: t._id } }))) {
    throw conflict(`Employee id ${body.employeeId} already exists`);
  }
  const { subjects, ...rest } = body;
  if (subjects) t.subjectIds = await resolveSubjects(tenantId, subjects);
  Object.assign(t, rest);
  await t.save();
  if (body.name || body.email) await User.updateOne({ _id: t.userId }, { ...(body.name ? { name: body.name } : {}), ...(body.email ? { email: body.email.toLowerCase() } : {}) });
  return t;
}

/** A teacher who leaves is deactivated, never deleted. History stays attributed to them. */
export async function deactivateTeacher(tenantId, id, { overrideClearance } = {}) {
  const t = await Teacher.findOne({ _id: id, tenantId });
  if (!t) throw notFound('Teacher not found');
  const clearance = await clearanceFor(tenantId, 'teacher', t._id);
  if (!clearance.clear && !overrideClearance) throw conflict('This teacher still has library books. Collect them, or confirm to deactivate anyway.', { code: 'CLEARANCE_REQUIRED', ...clearance });
  const { today } = await schoolToday(tenantId);
  t.status = 'inactive';
  await t.save();
  const ended = await endTeacherAssignments(tenantId, t._id, today);
  if (t.userId) {
    await User.updateOne({ _id: t.userId }, { status: 'disabled' });
    await Session.updateMany({ userId: t.userId, revokedAt: null }, { revokedAt: new Date() });
  }
  return { teacher: t, endedAssignments: ended };
}

export async function reactivateTeacher(tenantId, id) {
  const t = await Teacher.findOne({ _id: id, tenantId });
  if (!t) throw notFound('Teacher not found');
  if (t.status === 'active') throw conflict('Teacher is already active');
  t.status = 'active';
  await t.save();
  if (t.userId) await User.updateOne({ _id: t.userId }, { status: 'active' });
  return t;
}

export async function resetTeacherPassword(tenantId, id) {
  const t = await Teacher.findOne({ _id: id, tenantId });
  if (!t?.userId) throw notFound('Teacher account not found');
  const temporaryPassword = initialPassword(settingsOf(await loadSchool(tenantId)), { name: t.name, dob: t.dob, phone: t.phone }) || generatePassword();
  const u = await User.findById(t.userId);
  u.passwordHash = await hashPassword(temporaryPassword); u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
  return { loginId: u.loginId, temporaryPassword };
}
