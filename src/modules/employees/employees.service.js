import { Teacher, StaffMember, User, Session, Designation, Bus, TeachingAssignment, ClassTeacherAssignment, Subject, ClassModel, Section } from '../../models/index.js';
import { escapeRegex, addDays } from '../../core/utils.js';
import { ensureDeskStaff, ensureDesignations } from '../support-staff/support-staff.service.js';

/**
 * Everyone who works at the school, in one list: teaching staff, non-teaching staff, the school's own officers (finance, librarian,
 * transport officer) and the transport crew. Each person is in exactly one category.
 */
export const CATEGORIES = ['teaching', 'non_teaching', 'office', 'transport'];
const DESK_LABEL = { finance: 'Finance', library: 'Library', transport: 'Transport', office: 'Office' };

export async function listEmployees(ctx, f) {
  const { category, q, status = 'active', limit = 500 } = f;
  await ensureDesignations(ctx.tenantId);
  await ensureDeskStaff(ctx.tenantId, ctx.actorId);
  const rx = q ? new RegExp(escapeRegex(q), 'i') : null;
  const statusF = status === 'all' ? {} : { status };

  const [teachers, staff, designations, teaching, classTeachers, subjects, classes, sections] = await Promise.all([
    Teacher.find({ tenantId: ctx.tenantId, ...statusF, ...(rx ? { $or: [{ name: rx }, { employeeId: rx }, { phone: rx }, { designation: rx }] } : {}) }).sort({ name: 1 }).select('name employeeId designation phone email joiningDate status userId').lean(),
    StaffMember.find({ tenantId: ctx.tenantId, ...statusF, ...(rx ? { $or: [{ name: rx }, { staffId: rx }, { phone: rx }] } : {}) }).sort({ name: 1 }).lean(),
    Designation.find({ tenantId: ctx.tenantId }).lean(),
    TeachingAssignment.find({ tenantId: ctx.tenantId, open: true }).select('teacherId subjectId classId').lean(),
    ClassTeacherAssignment.find({ tenantId: ctx.tenantId, open: true }).select('teacherId sectionId').lean(),
    Subject.find({ tenantId: ctx.tenantId }).select('name').lean(),
    ClassModel.find({ tenantId: ctx.tenantId }).select('name level').sort({ level: 1 }).lean(),
    Section.find({ tenantId: ctx.tenantId }).select('name classId').lean(),
  ]);
  const D = new Map(designations.map((d) => [String(d._id), d]));
  const subjectName = new Map(subjects.map((s) => [String(s._id), s.name]));
  const className = new Map(classes.map((c) => [String(c._id), c.name]));
  const sectionName = new Map(sections.map((s) => [String(s._id), `${className.get(String(s.classId)) || ''} ${s.name}`.trim()]));
  const taught = new Map(); // teacherId -> { subjects:Set, classes:Set }
  for (const a of teaching) { const k = String(a.teacherId); if (!taught.has(k)) taught.set(k, { subjects: new Set(), classes: new Set() }); taught.get(k).subjects.add(String(a.subjectId)); taught.get(k).classes.add(String(a.classId)); }
  const classTeacherOf = new Map(classTeachers.map((c) => [String(c.teacherId), sectionName.get(String(c.sectionId))]));

  const crew = staff.filter((s) => D.get(String(s.designationId))?.group === 'transport').map((s) => s._id);
  const buses = crew.length ? await Bus.find({ tenantId: ctx.tenantId, $or: [{ driverId: { $in: crew } }, { conductorId: { $in: crew } }] }).select('busNo driverId conductorId').lean() : [];
  const bus = new Map();
  for (const b of buses) { if (b.driverId) bus.set(String(b.driverId), `${b.busNo} · driver`); if (b.conductorId) bus.set(String(b.conductorId), `${b.busNo} · conductor`); }
  const soon = addDays(ctx.today, 30);
  // when each desk holder was last active: the latest the sign-in was used, else the last time they signed in
  const deskUsers = staff.filter((s) => s.userId).map((s) => s.userId);
  const seen = new Map();
  if (deskUsers.length) {
    for (const u of await User.find({ _id: { $in: deskUsers } }).select('lastLoginAt').lean()) if (u.lastLoginAt) seen.set(String(u._id), u.lastLoginAt);
    for (const x of await Session.aggregate([{ $match: { userId: { $in: deskUsers } } }, { $group: { _id: '$userId', at: { $max: '$lastSeenAt' } } }])) if (x.at && (!seen.get(String(x._id)) || x.at > seen.get(String(x._id)))) seen.set(String(x._id), x.at);
  }

  const all = [
    ...teachers.map((t) => {
      const tt = taught.get(String(t._id));
      return { id: t._id, kind: 'teacher', category: 'teaching', name: t.name, code: t.employeeId, designation: t.designation || 'Teacher', phone: t.phone, email: t.email, joiningDate: t.joiningDate, status: t.status, hasLogin: !!t.userId,
        subjects: tt ? [...tt.subjects].map((x) => subjectName.get(x)).filter(Boolean).sort() : [], classes: tt ? [...tt.classes].map((x) => className.get(x)).filter(Boolean) : [], classTeacherOf: classTeacherOf.get(String(t._id)),
        _subjectIds: tt ? [...tt.subjects] : [], _classIds: tt ? [...tt.classes] : [] };
    }),
    ...staff.map((s) => {
      const d = D.get(String(s.designationId));
      const deskOf = s.deskRole || (s.canMarkAttendance && s.userId ? 'office' : undefined); // the office desk is held through the attendance permission, the other three through a desk role
      const category = deskOf ? 'office' : d?.group === 'transport' ? 'transport' : 'non_teaching';
      return { id: s._id, kind: 'staff', category, name: s.name, code: s.staffId, designation: d?.name || '', phone: s.phone, joiningDate: s.joiningDate, status: s.status, hasLogin: !!s.userId, lastActiveAt: s.userId ? seen.get(String(s.userId)) : undefined,
        canMarkAttendance: !!s.canMarkAttendance, desk: deskOf ? DESK_LABEL[deskOf] : undefined, bus: bus.get(String(s._id)) || undefined, licenseExpiry: s.licenseExpiry || undefined };
    }),
  ];
  const counts = { ...Object.fromEntries(CATEGORIES.map((c) => [c, all.filter((i) => i.category === c).length])), all: all.length };
  const inCategory = category ? all.filter((i) => i.category === category) : all;
  // the choices offered for each filter come from the tab being looked at, never from what is already selected, so choosing one never hides the others
  const designationCounts = [...inCategory.reduce((m, i) => m.set(i.designation, (m.get(i.designation) || 0) + 1), new Map())].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name));
  const options = {
    subjects: category === 'teaching' ? [...new Map(teaching.map((a) => [String(a.subjectId), subjectName.get(String(a.subjectId))]).filter(([, n]) => n)).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) : [],
    classes: category === 'teaching' ? classes.filter((c) => teaching.some((a) => String(a.classId) === String(c._id))).map((c) => ({ id: String(c._id), name: c.name })) : [],
    desks: category === 'office' ? [...new Set(inCategory.map((i) => i.desk).filter(Boolean))] : [],
  };

  let items = inCategory;
  if (f.designation) items = items.filter((i) => i.designation.toLowerCase() === String(f.designation).toLowerCase());
  if (f.login === 'has') items = items.filter((i) => i.hasLogin); else if (f.login === 'none') items = items.filter((i) => !i.hasLogin);
  if (f.subjectId) items = items.filter((i) => i._subjectIds?.includes(String(f.subjectId)));
  if (f.classId) items = items.filter((i) => i._classIds?.includes(String(f.classId)));
  if (f.classTeacher === 'yes') items = items.filter((i) => i.classTeacherOf);
  if (f.desk) items = items.filter((i) => i.desk === f.desk);
  if (f.attendanceDesk === 'yes') items = items.filter((i) => i.canMarkAttendance);
  if (f.bus === 'on') items = items.filter((i) => i.bus); else if (f.bus === 'off') items = items.filter((i) => i.category === 'transport' && !i.bus);
  if (f.licence === 'expired') items = items.filter((i) => i.licenseExpiry && i.licenseExpiry < ctx.today);
  else if (f.licence === 'expiring') items = items.filter((i) => i.licenseExpiry && i.licenseExpiry >= ctx.today && i.licenseExpiry <= soon);
  else if (f.licence === 'missing') items = items.filter((i) => i.designation && D.size && designations.find((d) => d.name === i.designation)?.busRole === 'driver' && !i.licenseExpiry);

  const shown = items.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit).map(({ _subjectIds, _classIds, ...rest }) => rest);
  return { counts, designations: designationCounts, options, total: items.length, items: shown };
}
