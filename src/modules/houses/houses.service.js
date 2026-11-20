import { House, Student, Teacher, StudentEnrolment, Section, ClassModel } from '../../models/index.js';
import { notFound, conflict, bad, escapeRegex } from '../../core/utils.js';

/**
 * A student or teacher can be in one of the school's own houses only. Give the name as typed: it comes back as the house is spelt,
 * '' means "no house", and undefined means "not given". A name that is not a house of this school is refused.
 */
export async function resolveHouse(tenantId, name) {
  if (name === undefined || name === null) return undefined;
  const t = String(name).trim();
  if (!t) return '';
  const h = await House.findOne({ tenantId, name: new RegExp(`^${escapeRegex(t)}$`, 'i') }).lean();
  if (!h) throw bad(`"${t}" is not one of the school's houses. Add it under Houses first.`);
  if (h.status !== 'active') throw bad(`The house "${h.name}" is archived`);
  return h.name;
}

const byName = (tenantId, name) => House.findOne({ tenantId, name: new RegExp(`^${escapeRegex(name)}$`, 'i') });

export async function listHouses(ctx) {
  const [houses, students, teachers] = await Promise.all([
    House.find({ tenantId: ctx.tenantId }).sort({ name: 1 }).lean(),
    Student.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active', house: { $nin: [null, ''] } } }, { $group: { _id: '$house', n: { $sum: 1 } } }]),
    Teacher.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active', house: { $nin: [null, ''] } } }, { $group: { _id: '$house', n: { $sum: 1 } } }]),
  ]);
  const s = new Map(students.map((x) => [x._id, x.n])); const t = new Map(teachers.map((x) => [x._id, x.n]));
  // not placed = no house, or a name that is not one of the school's houses (an old free-text house such as "Red")
  const names = houses.filter((h) => h.status === 'active').map((h) => h.name);
  const [unplacedStudents, unplacedTeachers] = await Promise.all([
    Student.countDocuments({ tenantId: ctx.tenantId, status: 'active', house: { $nin: names } }),
    Teacher.countDocuments({ tenantId: ctx.tenantId, status: 'active', house: { $nin: names } }),
  ]);
  return { houses: houses.map((h) => ({ ...h, students: s.get(h.name) || 0, teachers: t.get(h.name) || 0 })), unplaced: { students: unplacedStudents, teachers: unplacedTeachers } };
}

/** Each house has its own colour: two houses cannot share one. */
async function ensureColourFree(tenantId, color, exceptId) {
  if (!color) return;
  const other = await House.findOne({ tenantId, color: new RegExp(`^${escapeRegex(color)}$`, 'i'), ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).lean();
  if (other) throw conflict(`That colour already belongs to ${other.name}. Pick a different one.`);
}

export async function createHouse(ctx, body) {
  if (await byName(ctx.tenantId, body.name)) throw conflict(`"${body.name}" already exists`);
  await ensureColourFree(ctx.tenantId, body.color);
  return House.create({ tenantId: ctx.tenantId, ...body });
}

/** Renaming a house renames it for everyone in it. */
export async function updateHouse(ctx, id, patch) {
  const h = await House.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('House not found');
  if (patch.name && patch.name.toLowerCase() !== h.name.toLowerCase() && await byName(ctx.tenantId, patch.name)) throw conflict(`"${patch.name}" already exists`);
  if (patch.color && patch.color.toLowerCase() !== (h.color || '').toLowerCase()) await ensureColourFree(ctx.tenantId, patch.color, h._id);
  if (patch.status === 'archived' && (await Student.exists({ tenantId: ctx.tenantId, house: h.name, status: 'active' }) || await Teacher.exists({ tenantId: ctx.tenantId, house: h.name, status: 'active' }))) throw conflict('People are still in this house. Move them first.');
  const old = h.name;
  Object.assign(h, patch);
  await h.save();
  if (h.name !== old) await Promise.all([Student.updateMany({ tenantId: ctx.tenantId, house: old }, { house: h.name }), Teacher.updateMany({ tenantId: ctx.tenantId, house: old }, { house: h.name })]);
  return h;
}

export async function deleteHouse(ctx, id) {
  const h = await House.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!h) throw notFound('House not found');
  const [s, t] = await Promise.all([Student.countDocuments({ tenantId: ctx.tenantId, house: h.name }), Teacher.countDocuments({ tenantId: ctx.tenantId, house: h.name })]);
  if (s || t) throw conflict(`${s} student(s) and ${t} teacher(s) are in this house. Move them first, or archive it once it is empty.`);
  await h.deleteOne();
}

/** Everyone in one house: the teachers who mentor it, and its students with their class and section. */
export async function houseRoster(ctx, id) {
  const h = await House.findOne({ _id: id, tenantId: ctx.tenantId }).lean();
  if (!h) throw notFound('House not found');
  return { house: h, ...(await rosterOf(ctx, h.name)) };
}
export async function rosterOf(ctx, name) {
  const [students, teachers] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, house: name, status: 'active' }).select('name admissionNo gender').sort({ name: 1 }).lean(),
    Teacher.find({ tenantId: ctx.tenantId, house: name, status: 'active' }).select('name employeeId designation phone').sort({ name: 1 }).lean(),
  ]);
  const enr = ctx.year ? await StudentEnrolment.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, studentId: { $in: students.map((s) => s._id) }, status: { $in: ['active', 'promoted', 'retained'] } }).select('studentId sectionId classId').lean() : [];
  const [sections, classes] = await Promise.all([Section.find({ _id: { $in: enr.map((e) => e.sectionId) } }).select('name').lean(), ClassModel.find({ _id: { $in: enr.map((e) => e.classId) } }).select('name').lean()]);
  const S = new Map(sections.map((x) => [String(x._id), x.name])); const C = new Map(classes.map((x) => [String(x._id), x.name])); const E = new Map(enr.map((e) => [String(e.studentId), e]));
  return {
    teachers,
    students: students.map((s) => { const e = E.get(String(s._id)); return { ...s, className: C.get(String(e?.classId)) || '', section: S.get(String(e?.sectionId)) || '' }; }),
  };
}

/**
 * Puts everyone who has no house into one, evenly: students class by class so every house gets a share of each class, and teachers so that
 * each house has mentors. Anyone already in a house stays where they are.
 */
export async function distribute(ctx) {
  const houses = (await House.find({ tenantId: ctx.tenantId, status: 'active' }).sort({ name: 1 }).lean());
  if (!houses.length) throw bad('Add the houses of the school first');
  const names = houses.map((h) => h.name);
  const count = new Map(names.map((n) => [n, 0]));
  for (const row of await Student.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active', house: { $in: names } } }, { $group: { _id: '$house', n: { $sum: 1 } } }])) count.set(row._id, row.n);
  const tcount = new Map(names.map((n) => [n, 0]));
  for (const row of await Teacher.aggregate([{ $match: { tenantId: ctx.tenantId, status: 'active', house: { $in: names } } }, { $group: { _id: '$house', n: { $sum: 1 } } }])) tcount.set(row._id, row.n);

  const unplaced = await Student.find({ tenantId: ctx.tenantId, status: 'active', house: { $nin: names } }).select('name').sort({ name: 1 }).lean();
  const enr = ctx.year ? await StudentEnrolment.find({ tenantId: ctx.tenantId, yearId: ctx.year._id, studentId: { $in: unplaced.map((s) => s._id) } }).select('studentId sectionId').lean() : [];
  const sec = new Map(enr.map((e) => [String(e.studentId), String(e.sectionId)]));
  unplaced.sort((a, b) => (sec.get(String(a._id)) || '').localeCompare(sec.get(String(b._id)) || '') || a.name.localeCompare(b.name));
  const next = (m) => [...m.entries()].sort((a, b) => a[1] - b[1] || names.indexOf(a[0]) - names.indexOf(b[0]))[0][0];
  const ops = [];
  for (const s of unplaced) { const h = next(count); count.set(h, count.get(h) + 1); ops.push({ updateOne: { filter: { _id: s._id }, update: { $set: { house: h } } } }); }
  if (ops.length) await Student.bulkWrite(ops);

  const teachers = await Teacher.find({ tenantId: ctx.tenantId, status: 'active', house: { $nin: names } }).select('name').sort({ name: 1 }).lean();
  const tops = [];
  for (const t of teachers) { const h = next(tcount); tcount.set(h, tcount.get(h) + 1); tops.push({ updateOne: { filter: { _id: t._id }, update: { $set: { house: h } } } }); }
  if (tops.length) await Teacher.bulkWrite(tops);
  return { students: ops.length, teachers: tops.length };
}

export async function setTeacherHouse(ctx, teacherId, name) {
  const t = await Teacher.findOne({ _id: teacherId, tenantId: ctx.tenantId });
  if (!t) throw notFound('Teacher not found');
  t.house = (await resolveHouse(ctx.tenantId, name)) || undefined;
  return t.save();
}
