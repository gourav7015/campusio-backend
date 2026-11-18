import {
  StudentRemark, ChatThread, ChatMessage, Student, StudentEnrolment, Teacher, Section, User, School, AttendanceSession, AttendanceRecord, TeachingAssignment, ClassTeacherAssignment, ClassModel,
} from '../../models/index.js';
import { notFound, conflict, bad, forbidden, addDays, todayStr } from '../../core/utils.js';
import { notifyUsers } from '../../services/notify.js';
import { settingsOf } from '../../services/context.js';

const mk = (a) => new Map(a.map((x) => [String(x._id), x]));

// ───────────── remarks the family must acknowledge ─────────────
const MAX_REMINDERS = 14;

async function myStudentEnrolment(ctx, studentId) {
  const enr = await StudentEnrolment.findOne({ tenantId: ctx.tenantId, studentId, status: 'active', yearId: ctx.year._id });
  if (!enr || !ctx.scope.hasSection(enr.sectionId)) throw notFound('Student not found in your classes');
  return enr;
}

export async function addRemark(ctx, studentId, { text, category = 'remark', requireAck = true }) {
  await myStudentEnrolment(ctx, studentId);
  const r = await StudentRemark.create({ tenantId: ctx.tenantId, studentId, teacherId: ctx.teacher._id, text, date: ctx.today, category, requireAck });
  const stu = await Student.findById(studentId).select('userId name');
  await notifyUsers(ctx.tenantId, [stu?.userId], {
    category: 'remarks', title: `${category === 'guideline' ? 'Guideline' : 'Remark'} from ${ctx.teacher.name}`, body: text.slice(0, 140) + (requireAck ? ' Please read and acknowledge.' : ''),
    link: { type: 'remark', id: String(r._id) }, dedupeKey: `rem:${r._id}`,
  });
  return r;
}

/** Remarks this teacher wrote, with who has acknowledged. */
export async function teacherRemarks(ctx, { pending } = {}) {
  const f = { tenantId: ctx.tenantId, teacherId: ctx.teacher._id };
  if (pending) { f.requireAck = true; f.ackAt = null; }
  const rows = await StudentRemark.find(f).sort({ createdAt: -1 }).limit(200).lean();
  const students = mk(await Student.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.studentId) } }).select('name admissionNo').lean());
  return rows.map((r) => ({ ...r, student: students.get(String(r.studentId))?.name, admissionNo: students.get(String(r.studentId))?.admissionNo, acknowledged: !!r.ackAt }));
}

export async function remindNow(ctx, id) {
  const r = await StudentRemark.findOne({ _id: id, tenantId: ctx.tenantId, teacherId: ctx.teacher._id });
  if (!r) throw notFound('Remark not found');
  if (r.ackAt) throw conflict('This has already been acknowledged');
  return remindOne(ctx.tenantId, r, ctx.today, `manual:${Date.now()}`);
}

async function remindOne(tenantId, r, today, key) {
  const stu = await Student.findById(r.studentId).select('userId');
  const t = await Teacher.findById(r.teacherId).select('name');
  const sent = await notifyUsers(tenantId, [stu?.userId], { category: 'remarks', title: `Reminder: please acknowledge the ${r.category === 'guideline' ? 'guideline' : 'remark'} from ${t?.name || 'the teacher'}`, body: r.text.slice(0, 140), link: { type: 'remark', id: String(r._id) }, dedupeKey: `remr:${r._id}:${key}` });
  if (sent) { r.reminders += 1; r.lastRemindedOn = today; await r.save(); }
  return { sent };
}

/** Run daily (and safe to run more often): nudge families that have not acknowledged yet, at most once a day, up to MAX_REMINDERS times. */
export async function runRemarkReminders(tenantId, today) {
  const open = await StudentRemark.find({ tenantId, requireAck: true, ackAt: null, date: { $lt: today }, reminders: { $lt: MAX_REMINDERS }, lastRemindedOn: { $ne: today } }).limit(2000);
  let sent = 0;
  for (const r of open) sent += (await remindOne(tenantId, r, today, today)).sent;
  return sent;
}
export async function runAllReminders() {
  let n = 0;
  for (const s of await School.find({ status: 'active' }).select('_id settings').lean()) n += await runRemarkReminders(s._id, todayStr(settingsOf(s).timezone));
  return n;
}

export async function studentRemarks(ctx) {
  const rows = await StudentRemark.find({ tenantId: ctx.tenantId, studentId: ctx.student._id }).sort({ createdAt: -1 }).limit(100).lean();
  const t = mk(await Teacher.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.teacherId) } }).select('name').lean());
  return rows.map((r) => ({ _id: r._id, text: r.text, date: r.date, category: r.category, teacher: t.get(String(r.teacherId))?.name, requireAck: r.requireAck, acknowledged: !!r.ackAt, ackAt: r.ackAt }));
}
export async function acknowledge(ctx, id, byName) {
  const r = await StudentRemark.findOne({ _id: id, tenantId: ctx.tenantId, studentId: ctx.student._id });
  if (!r) throw notFound('Remark not found');
  if (!r.ackAt) { r.ackAt = new Date(); r.ackByName = byName; await r.save(); }
  return { ok: true, ackAt: r.ackAt };
}
export async function pendingCount(ctx) { return StudentRemark.countDocuments({ tenantId: ctx.tenantId, studentId: ctx.student._id, requireAck: true, ackAt: null }); }

// ───────────── parent–teacher chat ─────────────
const LIMIT = 1000;
const previewOf = (t) => t.slice(0, 80);

async function postMessage(tenantId, thread, from, user, text) {
  const m = await ChatMessage.create({ tenantId, threadId: thread._id, from, fromUserId: user._id, text });
  thread.lastMessageAt = new Date(); thread.lastPreview = previewOf(text);
  if (from === 'teacher') thread.unreadStudent += 1; else thread.unreadTeacher += 1;
  await thread.save();
  const [stu, t] = await Promise.all([Student.findById(thread.studentId).select('userId name'), Teacher.findById(thread.teacherId).select('userId name')]);
  const toUser = from === 'teacher' ? stu?.userId : t?.userId;
  await notifyUsers(tenantId, [toUser], { category: 'chat', title: `Message from ${from === 'teacher' ? t?.name : `${stu?.name}'s family`}`, body: previewOf(text), link: { type: 'chat', id: String(thread._id) }, dedupeKey: `chat:${m._id}` });
  return m;
}

/** Teachers a student's family may write to: the class teacher and every subject teacher of the section. */
export async function chatTeachersFor(ctx) {
  const sectionIds = ctx.sectionIds;
  const [a, c] = await Promise.all([TeachingAssignment.find({ tenantId: ctx.tenantId, sectionId: { $in: sectionIds } }).lean(), ClassTeacherAssignment.find({ tenantId: ctx.tenantId, sectionId: { $in: sectionIds } }).lean()]);
  const ids = [...new Set([...a, ...c].map((x) => String(x.teacherId)))];
  const ts = await Teacher.find({ tenantId: ctx.tenantId, _id: { $in: ids }, status: 'active' }).select('name designation').lean();
  const ct = new Set(c.map((x) => String(x.teacherId)));
  return ts.map((t) => ({ teacherId: t._id, name: t.name, role: ct.has(String(t._id)) ? 'Class teacher' : 'Subject teacher' })).sort((x, y) => (x.role === y.role ? x.name.localeCompare(y.name) : x.role === 'Class teacher' ? -1 : 1));
}

async function threadFor(tenantId, studentId, teacherId) {
  return (await ChatThread.findOne({ tenantId, studentId, teacherId })) || ChatThread.create({ tenantId, studentId, teacherId });
}

export async function startFromTeacher(ctx, user, { studentId, text }) {
  await myStudentEnrolment(ctx, studentId);
  const t = await threadFor(ctx.tenantId, studentId, ctx.teacher._id);
  await postMessage(ctx.tenantId, t, 'teacher', user, text);
  return t;
}
export async function startFromStudent(ctx, user, { teacherId, text }) {
  const allowed = await chatTeachersFor(ctx);
  if (!allowed.some((x) => String(x.teacherId) === String(teacherId))) throw forbidden('You can write only to your own teachers');
  const t = await threadFor(ctx.tenantId, ctx.student._id, teacherId);
  await postMessage(ctx.tenantId, t, 'student', user, text);
  return t;
}

async function listThreads(ctx, f, side) {
  const rows = await ChatThread.find({ tenantId: ctx.tenantId, ...f, lastMessageAt: { $ne: null } }).sort({ lastMessageAt: -1 }).limit(100).lean();
  const [stu, tch] = await Promise.all([Student.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.studentId) } }).select('name admissionNo').lean(), Teacher.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.teacherId) } }).select('name').lean()]);
  const S = mk(stu); const T = mk(tch);
  return rows.map((r) => ({ _id: r._id, student: S.get(String(r.studentId))?.name, admissionNo: S.get(String(r.studentId))?.admissionNo, teacher: T.get(String(r.teacherId))?.name, lastMessageAt: r.lastMessageAt, lastPreview: r.lastPreview, unread: side === 'teacher' ? r.unreadTeacher : r.unreadStudent }));
}
export const teacherThreads = (ctx) => listThreads(ctx, { teacherId: ctx.teacher._id }, 'teacher');
export const studentThreads = (ctx) => listThreads(ctx, { studentId: ctx.student._id }, 'student');

async function ownThread(ctx, id, side) {
  const t = await ChatThread.findOne({ _id: id, tenantId: ctx.tenantId, ...(side === 'teacher' ? { teacherId: ctx.teacher._id } : { studentId: ctx.student._id }) });
  if (!t) throw notFound('Conversation not found');
  return t;
}
export async function openThread(ctx, id, side) {
  const t = await ownThread(ctx, id, side);
  const [msgs, stu, tch] = await Promise.all([ChatMessage.find({ threadId: t._id }).sort({ createdAt: 1 }).limit(500).lean(), Student.findById(t.studentId).select('name'), Teacher.findById(t.teacherId).select('name')]);
  if (side === 'teacher' ? t.unreadTeacher : t.unreadStudent) { if (side === 'teacher') t.unreadTeacher = 0; else t.unreadStudent = 0; await t.save(); }
  return { _id: t._id, student: stu?.name, teacher: tch?.name, messages: msgs.map((m) => ({ _id: m._id, from: m.from, text: m.text, at: m.createdAt })) };
}
export async function reply(ctx, user, id, side, text) {
  const t = await ownThread(ctx, id, side);
  if (side === 'teacher') await myStudentEnrolment(ctx, t.studentId).catch(() => { throw forbidden('This student is no longer in your classes'); });
  return postMessage(ctx.tenantId, t, side, user, text);
}
export async function unreadChats(ctx, side) {
  const f = side === 'teacher' ? { teacherId: ctx.teacher._id, unreadTeacher: { $gt: 0 } } : { studentId: ctx.student._id, unreadStudent: { $gt: 0 } };
  return ChatThread.countDocuments({ tenantId: ctx.tenantId, ...f });
}

// ───────────── what the class teacher may correct about a student ─────────────
export async function updateStudentContact(ctx, studentId, body) {
  const enr = await myStudentEnrolment(ctx, studentId);
  if (!ctx.scope.classTeacherSectionIds.includes(String(enr.sectionId))) throw forbidden('Only the class teacher can update a student\'s details');
  const s = await Student.findOne({ _id: studentId, tenantId: ctx.tenantId });
  const { guardian, ...own } = body;
  Object.assign(s, own);
  if (guardian) {
    const g = s.guardians.find((x) => x.isPrimary) || s.guardians[0];
    if (g) Object.assign(g, guardian); else s.guardians.push({ ...guardian, relationship: 'Guardian', isPrimary: true });
  }
  await s.save();
  if (body.email && s.userId) await User.updateOne({ _id: s.userId, tenantId: ctx.tenantId }, { $set: { email: body.email.toLowerCase() } });
  return s;
}

// ───────────── class monitors ─────────────
export async function setMonitors(ctx, sectionId, studentIds) {
  const section = await Section.findOne({ _id: sectionId, tenantId: ctx.tenantId });
  if (!section) throw notFound('Section not found');
  if (ctx.role === 'teacher' && !ctx.scope.classTeacherSectionIds.includes(String(sectionId))) throw forbidden('Only the class teacher can choose the monitors');
  const unique = [...new Set(studentIds.map(String))];
  if (unique.length > 5) throw bad('A class can have at most 5 monitors');
  const enrolled = await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, status: 'active', studentId: { $in: unique } }).select('studentId').lean();
  if (enrolled.length !== unique.length) throw bad('A monitor must be a student of this class');
  section.monitorIds = unique;
  await section.save();
  return { sectionId, monitorIds: unique };
}
export async function monitorsOf(tenantId, sectionId) {
  const s = await Section.findOne({ _id: sectionId, tenantId }).select('monitorIds').lean();
  return new Set((s?.monitorIds || []).map(String));
}

// ───────────── regularise a missed or late day ─────────────
export const REGULARISE_DAYS = 7;
/** The class teacher turns an absent or late mark into present, with a reason, within a week. The record keeps who did it, from what, and why. */
export async function regularise(ctx, user, { sectionId, date, studentId, reason }) {
  if (!ctx.scope.classTeacherSectionIds.includes(String(sectionId))) throw forbidden('Only the class teacher can regularise attendance');
  if (date > ctx.today) throw bad('That date has not happened yet');
  if (date < addDays(ctx.today, -REGULARISE_DAYS)) throw bad(`Attendance can be regularised for ${REGULARISE_DAYS} days. Ask the school admin for an older correction.`);
  const session = await AttendanceSession.findOne({ tenantId: ctx.tenantId, sectionId, date });
  if (!session) throw notFound('No attendance was taken for that date');
  const rec = await AttendanceRecord.findOne({ sessionId: session._id, studentId });
  if (!rec) throw notFound('That student is not on that register');
  if (!['absent', 'late'].includes(rec.status)) throw bad('Only an absent or late mark can be regularised');
  rec.history.push({ from: rec.status, to: 'present', by: user._id, byName: user.name, reason, kind: 'regularise', at: new Date() });
  rec.status = 'present'; rec.regularised = true;
  await rec.save();
  const stu = await Student.findById(studentId).select('userId');
  await notifyUsers(ctx.tenantId, [stu?.userId], { category: 'attendance', title: 'Attendance regularised', body: `Your attendance for ${date} was regularised to present: ${reason}`, link: { type: 'attendance', id: date }, dedupeKey: `attr:${rec._id}:${rec.history.length}` });
  return rec;
}

export { ClassModel };
