import { Bus, StudentTransport, Student, StudentEnrolment, Section, ClassModel, StaffMember, Designation } from '../../models/index.js';
import { notFound, conflict, bad, addDays, escapeRegex } from '../../core/utils.js';
import { billTransport, cancelTransportCharges } from '../finance/finance.service.js';

const EXPIRIES = ['insuranceExpiry', 'fitnessExpiry', 'pollutionExpiry'];
const expiryAlerts = (bus, today) => EXPIRIES.filter((k) => bus[k] && bus[k] <= addDays(today, 30)).map((k) => ({ field: k.replace('Expiry', ''), date: bus[k], expired: bus[k] < today }));
const card = (s) => (s ? { id: s._id, staffId: s.staffId, name: s.name, phone: s.phone, licenseNo: s.licenseNo, licenseExpiry: s.licenseExpiry, status: s.status } : null);

async function crewOf(tenantId, buses) {
  const ids = buses.flatMap((b) => [b.driverId, b.conductorId]).filter(Boolean);
  const staff = ids.length ? await StaffMember.find({ tenantId, _id: { $in: ids } }).lean() : [];
  return new Map(staff.map((s) => [String(s._id), s]));
}
const withCrew = (b, crew, today) => ({
  ...b, driver: card(crew.get(String(b.driverId))), conductor: card(crew.get(String(b.conductorId))),
  alerts: [...expiryAlerts(b, today), ...(crew.get(String(b.driverId))?.licenseExpiry && crew.get(String(b.driverId)).licenseExpiry <= addDays(today, 30) ? [{ field: 'driver licence', date: crew.get(String(b.driverId)).licenseExpiry, expired: crew.get(String(b.driverId)).licenseExpiry < today }] : [])],
});

/** A driver must be an active staff member whose designation is a driver; same for the conductor; nobody crews two buses. */
async function assertCrew(ctx, busId, body) {
  for (const [field, role] of [['driverId', 'driver'], ['conductorId', 'conductor']]) {
    const id = body[field];
    if (!id) continue;
    const s = await StaffMember.findOne({ _id: id, tenantId: ctx.tenantId });
    if (!s) throw notFound(`The ${role} was not found`);
    if (s.status !== 'active') throw bad(`${s.name} is not active`);
    const d = await Designation.findById(s.designationId).lean();
    if (d?.busRole !== role) throw bad(`${s.name} is a ${d?.name || 'staff member'}, not a ${role}`);
    const other = await Bus.findOne({ tenantId: ctx.tenantId, [field]: s._id, ...(busId ? { _id: { $ne: busId } } : {}) }).select('busNo').lean();
    if (other) throw conflict(`${s.name} is already the ${role} of bus ${other.busNo}`);
  }
}

export async function listBuses(ctx) {
  const [buses, counts] = await Promise.all([
    Bus.find({ tenantId: ctx.tenantId }).sort({ busNo: 1 }).lean(),
    StudentTransport.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$busId', n: { $sum: 1 } } }]),
  ]);
  const crew = await crewOf(ctx.tenantId, buses);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return buses.map((b) => ({ ...withCrew(b, crew, ctx.today), students: n.get(String(b._id)) || 0 }));
}

export async function createBus(ctx, body) {
  if (await Bus.exists({ tenantId: ctx.tenantId, busNo: body.busNo })) throw conflict(`Bus ${body.busNo} already exists`);
  await assertCrew(ctx, null, body);
  return Bus.create({ ...body, tenantId: ctx.tenantId });
}

export async function updateBus(ctx, id, patch) {
  const b = await Bus.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!b) throw notFound('Bus not found');
  if (patch.busNo && patch.busNo !== b.busNo && await Bus.exists({ tenantId: ctx.tenantId, busNo: patch.busNo, _id: { $ne: b._id } })) throw conflict(`Bus ${patch.busNo} already exists`);
  if (patch.capacity) {
    const n = await StudentTransport.countDocuments({ tenantId: ctx.tenantId, busId: b._id });
    if (patch.capacity < n) throw conflict(`${n} students ride this bus. Capacity cannot be lower.`);
  }
  await assertCrew(ctx, b._id, patch);
  Object.assign(b, patch);
  return b.save();
}

export async function deleteBus(ctx, id) {
  const b = await Bus.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!b) throw notFound('Bus not found');
  if (await StudentTransport.exists({ tenantId: ctx.tenantId, busId: b._id })) throw conflict('Students are assigned to this bus. Move them first, or set the bus to retired.');
  await b.deleteOne();
}

/** Where a set of students are in the school right now, for rider lists. Class and section names only. */
async function describeStudents(ctx, studentIds) {
  const [students, enrs] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, _id: { $in: studentIds } }).select('name admissionNo').lean(),
    StudentEnrolment.find({ tenantId: ctx.tenantId, studentId: { $in: studentIds }, yearId: ctx.year?._id, status: 'active' }).lean(),
  ]);
  const [secs, cls] = await Promise.all([Section.find({ _id: { $in: enrs.map((e) => e.sectionId) } }).select('name').lean(), ClassModel.find({ _id: { $in: enrs.map((e) => e.classId) } }).select('name').lean()]);
  const S = new Map(secs.map((s) => [String(s._id), s.name])); const C = new Map(cls.map((c) => [String(c._id), c.name]));
  const E = new Map(enrs.map((e) => [String(e.studentId), e]));
  return new Map(students.map((s) => { const e = E.get(String(s._id)); return [String(s._id), { name: s.name, admissionNo: s.admissionNo, className: e ? C.get(String(e.classId)) : null, section: e ? S.get(String(e.sectionId)) : null, rollNo: e?.rollNo }]; }));
}

export async function getBus(ctx, id) {
  const bus = await Bus.findOne({ _id: id, tenantId: ctx.tenantId }).lean();
  if (!bus) throw notFound('Bus not found');
  const [riders, crew] = await Promise.all([StudentTransport.find({ tenantId: ctx.tenantId, busId: bus._id }).lean(), crewOf(ctx.tenantId, [bus])]);
  const info = await describeStudents(ctx, riders.map((r) => r.studentId));
  const rows = riders.map((r) => ({ studentId: r.studentId, stop: r.stop, since: r.since, ...info.get(String(r.studentId)) }))
    .sort((a, b) => String(a.stop || '').localeCompare(String(b.stop || '')) || String(a.name).localeCompare(String(b.name)));
  return { ...withCrew(bus, crew, ctx.today), students: rows };
}

export async function assign(ctx, { busId, studentIds, stop }) {
  const bus = await Bus.findOne({ _id: busId, tenantId: ctx.tenantId });
  if (!bus) throw notFound('Bus not found');
  if (bus.status !== 'active') throw bad(`Bus ${bus.busNo} is ${bus.status}`);
  if (stop && bus.stops.length && !bus.stops.some((s) => s.name === stop)) throw bad(`"${stop}" is not a stop on this bus's route`);
  const ids = [...new Set(studentIds)];
  const found = await Student.countDocuments({ tenantId: ctx.tenantId, _id: { $in: ids }, status: 'active' });
  if (found !== ids.length) throw notFound('One or more students were not found or are not active');
  const already = await StudentTransport.find({ tenantId: ctx.tenantId, busId: bus._id, studentId: { $in: ids } }).select('studentId').lean();
  const seated = await StudentTransport.countDocuments({ tenantId: ctx.tenantId, busId: bus._id });
  const adding = ids.length - already.length;
  if (seated + adding > bus.capacity) throw conflict(`Bus ${bus.busNo} has ${bus.capacity - seated} seat(s) left, not ${adding}`);
  await StudentTransport.bulkWrite(ids.map((studentId) => ({ updateOne: { filter: { tenantId: ctx.tenantId, studentId }, update: { $set: { busId: bus._id, stop, since: ctx.today, assignedBy: ctx.actorId } }, upsert: true } })));
  // Finance bills the monthly fare to each student from this month on: the stop's fare, or the bus's default fare
  const fare = bus.stops.find((s) => s.name === stop)?.fare ?? bus.monthlyFare ?? 0;
  let billed = 0;
  for (const studentId of ids) { await cancelTransportCharges(ctx, studentId); billed += await billTransport(ctx, studentId, { fare, busNo: bus.busNo, stop }); }
  return { assigned: ids.length, seatsLeft: bus.capacity - seated - adding, monthlyFare: fare, monthsBilled: billed };
}

export async function unassign(ctx, studentId) {
  const r = await StudentTransport.deleteOne({ tenantId: ctx.tenantId, studentId });
  if (!r.deletedCount) throw notFound('This student does not use the school bus');
  await cancelTransportCharges(ctx, studentId); // future unpaid transport months are no longer owed
}

/** Bus details as a student sees them (and as the admin sees on the student's page). */
export async function busOfStudent(tenantId, studentId) {
  const t = await StudentTransport.findOne({ tenantId, studentId }).lean();
  if (!t) return null;
  const b = await Bus.findOne({ _id: t.busId, tenantId }).lean();
  if (!b) return null;
  const crew = await crewOf(tenantId, [b]);
  const stop = b.stops.find((s) => s.name === t.stop);
  const person = (s) => (s ? { name: s.name, phone: s.phone, licenseNo: s.licenseNo } : undefined);
  return {
    busNo: b.busNo, registrationNo: b.registrationNo, routeName: b.routeName, status: b.status, stop: t.stop, pickupTime: stop?.pickupTime, dropTime: stop?.dropTime,
    startTime: b.startTime, endTime: b.endTime, driver: person(crew.get(String(b.driverId))), conductor: person(crew.get(String(b.conductorId))), stops: b.stops, since: t.since, busId: b._id, monthlyFare: stop?.fare ?? b.monthlyFare ?? 0,
  };
}

/** studentId -> bus number for a set of students (list columns). */
export async function busNumbers(tenantId, studentIds) {
  const t = await StudentTransport.find({ tenantId, studentId: { $in: studentIds } }).lean();
  if (!t.length) return new Map();
  const buses = await Bus.find({ tenantId, _id: { $in: t.map((x) => x.busId) } }).select('busNo').lean();
  const B = new Map(buses.map((b) => [String(b._id), b.busNo]));
  return new Map(t.map((x) => [String(x.studentId), B.get(String(x.busId))]));
}

// ───────────── the Transport officer's dashboard ─────────────
export async function dashboard(ctx) {
  const [buses, counts, designations] = await Promise.all([
    Bus.find({ tenantId: ctx.tenantId }).sort({ busNo: 1 }).lean(),
    StudentTransport.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$busId', n: { $sum: 1 } } }]),
    Designation.find({ tenantId: ctx.tenantId, group: 'transport' }).lean(),
  ]);
  const staff = await StaffMember.find({ tenantId: ctx.tenantId, status: 'active', designationId: { $in: designations.map((d) => d._id) } }).select('name staffId designationId licenseExpiry').lean();
  const crew = await crewOf(ctx.tenantId, buses);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  const active = buses.filter((b) => b.status === 'active');
  const onBus = new Set(buses.flatMap((b) => [String(b.driverId), String(b.conductorId)]));
  const D = new Map(designations.map((d) => [String(d._id), d]));
  const riders = buses.reduce((x, b) => x + (n.get(String(b._id)) || 0), 0);
  const seats = active.reduce((x, b) => x + b.capacity, 0);
  return {
    buses: { total: buses.length, running: active.length, maintenance: buses.filter((b) => b.status === 'maintenance').length, retired: buses.filter((b) => b.status === 'retired').length },
    riders, seatsFree: Math.max(seats - riders, 0), occupancy: seats ? Math.round((riders / seats) * 100) : null,
    staff: { total: staff.length, byDesignation: designations.map((d) => ({ name: d.name, count: staff.filter((s) => String(s.designationId) === String(d._id)).length })) },
    needsCrew: active.filter((b) => !b.driverId || !b.conductorId).map((b) => ({ id: b._id, busNo: b.busNo, missing: [!b.driverId && 'driver', !b.conductorId && 'conductor'].filter(Boolean) })),
    idleCrew: staff.filter((s) => D.get(String(s.designationId))?.busRole && !onBus.has(String(s._id))).map((s) => ({ id: s._id, name: s.name, staffId: s.staffId, designation: D.get(String(s.designationId)).name })),
    alerts: [
      ...buses.flatMap((b) => withCrew(b, crew, ctx.today).alerts.map((a) => ({ bus: b.busNo, ...a }))),
    ],
    fullBuses: buses.filter((b) => b.status === 'active').map((b) => ({ id: b._id, busNo: b.busNo, riders: n.get(String(b._id)) || 0, capacity: b.capacity })).sort((a, b) => b.riders / b.capacity - a.riders / a.capacity).slice(0, 6),
  };
}

// ───────────── finding students to seat (class and section names only, no academic data) ─────────────
export async function lookups(ctx) {
  const [classes, sections] = await Promise.all([
    ClassModel.find({ tenantId: ctx.tenantId, status: 'active' }).sort({ level: 1 }).select('name').lean(),
    Section.find({ tenantId: ctx.tenantId, yearId: ctx.year?._id, status: 'active' }).select('name classId').lean(),
  ]);
  return { classes, sections };
}

export async function findStudents(ctx, { sectionId, q }) {
  let ids = [];
  if (sectionId) ids = (await StudentEnrolment.find({ tenantId: ctx.tenantId, sectionId, yearId: ctx.year?._id, status: 'active' }).sort({ rollNo: 1 }).select('studentId').lean()).map((e) => e.studentId);
  else if (q && q.length >= 2) { const rx = new RegExp(escapeRegex(q), 'i'); ids = (await Student.find({ tenantId: ctx.tenantId, status: 'active', $or: [{ name: rx }, { admissionNo: rx }] }).select('_id').limit(25).lean()).map((s) => s._id); }
  else return [];
  const [info, buses] = await Promise.all([describeStudents(ctx, ids), busNumbers(ctx.tenantId, ids)]);
  return ids.map((id) => ({ studentId: id, ...info.get(String(id)), bus: buses.get(String(id)) || null }));
}
