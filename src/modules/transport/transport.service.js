import { rollStatus } from '../../services/context.js';
import { Bus, BusDocument, BUS_DOC_TYPES, File, User, School, StudentTransport, Student, StudentEnrolment, Section, ClassModel, StaffMember, Designation } from '../../models/index.js';
import { notFound, conflict, bad, addDays, daysBetween, escapeRegex } from '../../core/utils.js';
import { busRolesOf } from './crew.js';
import { removeFileBytes } from '../../services/files.js';
import { notifyUsers } from '../../services/notify.js';
import { billTransport, cancelTransportCharges } from '../finance/finance.service.js';

const EXPIRIES = ['insuranceExpiry', 'fitnessExpiry', 'pollutionExpiry'];
const expiryAlerts = (bus, today) => EXPIRIES.filter((k) => bus[k] && bus[k] <= addDays(today, 30)).map((k) => ({ field: k.replace('Expiry', ''), date: bus[k], expired: bus[k] < today }));
/** valid / expiring (within 30 days) / expired / missing (no date on file). Dates are plain YYYY-MM-DD strings in the school's calendar. */
const certState = (date, today) => (!date ? 'missing' : date < today ? 'expired' : date <= addDays(today, 30) ? 'expiring' : 'valid');
const DOCS = [['insuranceExpiry', 'Insurance'], ['fitnessExpiry', 'Fitness certificate'], ['pollutionExpiry', 'Pollution certificate']];
/** Every document of every non-retired bus, not just the problems. The driver's licence is listed only when a driver is assigned. */
export function certificateRows(buses, crew, today, docs = []) {
  const out = [];
  const extra = new Map(); for (const d of docs) { const k = String(d.busId); if (!extra.has(k)) extra.set(k, []); extra.get(k).push(d); }
  for (const b of buses.filter((x) => x.status !== 'retired')) {
    const row = (doc, label, date) => out.push({ busId: b._id, bus: b.busNo, doc, label, date: date || null, daysLeft: date ? daysBetween(today, date) : null, state: certState(date, today) });
    for (const [k, label] of DOCS) row(k.replace('Expiry', ''), label, b[k]);
    // registration (always expected), and permit, road tax and anything else once they have been recorded
    const mine = extra.get(String(b._id)) || [];
    const reg = mine.find((d) => d.type === 'registration');
    out.push({ busId: b._id, bus: b.busNo, doc: 'registration', label: BUS_DOC_TYPES.registration.label, date: reg?.expiresOn || null, daysLeft: reg?.expiresOn ? daysBetween(today, reg.expiresOn) : null, state: reg ? (reg.expiresOn ? certState(reg.expiresOn, today) : 'valid') : 'missing' });
    for (const d of mine.filter((x) => ['permit', 'road_tax', 'other'].includes(x.type))) row(d.type === 'other' ? `other-${d._id}` : d.type, d.type === 'other' ? (d.title || 'Other document') : BUS_DOC_TYPES[d.type].label, d.expiresOn);
    const d = crew.get(String(b.driverId));
    if (d) row('licence', `Driver licence (${d.name})`, d.licenseExpiry);
  }
  const rank = { expired: 0, expiring: 1, missing: 2, valid: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || String(a.bus).localeCompare(String(b.bus), undefined, { numeric: true }));
}
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

/**
 * A driver must be an active staff member who can drive (their job title is Driver, or they are marked "can also drive"); same for the conductor.
 * Nobody crews two buses, and nobody holds both seats of one bus.
 */
async function assertCrew(ctx, busId, body) {
  if (body.driverId && body.conductorId && String(body.driverId) === String(body.conductorId)) throw bad('One person cannot be both the driver and the conductor of the same bus');
  for (const [field, role] of [['driverId', 'driver'], ['conductorId', 'conductor']]) {
    const id = body[field];
    if (!id) continue;
    const s = await StaffMember.findOne({ _id: id, tenantId: ctx.tenantId });
    if (!s) throw notFound(`The ${role} was not found`);
    if (s.status !== 'active') throw bad(`${s.name} is not active`);
    const d = await Designation.findById(s.designationId).lean();
    if (!busRolesOf(d, s).includes(role)) throw bad(`${s.name} is a ${d?.name || 'staff member'}, not a ${role}`);
    const other = await Bus.findOne({ tenantId: ctx.tenantId, $or: [{ driverId: s._id }, { conductorId: s._id }], ...(busId ? { _id: { $ne: busId } } : {}) }).select('busNo driverId').lean();
    if (other) throw conflict(`${s.name} is already ${String(other.driverId) === String(s._id) ? 'the driver' : 'the conductor'} of bus ${other.busNo}`);
  }
}

/**
 * Swap crew between two buses (the driver, the conductor, or both), or swap the driver and conductor of one bus with each other (`roles`).
 * Every person must be able to fill the seat they move to (a driver who "can also conduct" may take a conductor's seat). With `preview` nothing is saved.
 */
export async function swapCrew(ctx, { busId, otherBusId, what, preview }) {
  const a = await Bus.findOne({ _id: busId, tenantId: ctx.tenantId });
  if (!a) throw notFound('Bus not found');
  let b = null;
  if (what !== 'roles') {
    if (!otherBusId) throw bad('Choose the other bus');
    if (String(otherBusId) === String(busId)) throw bad('Choose a different bus');
    b = await Bus.findOne({ _id: otherBusId, tenantId: ctx.tenantId });
    if (!b) throw notFound('The other bus was not found');
  }
  const next = { a: { driverId: a.driverId || null, conductorId: a.conductorId || null }, b: b ? { driverId: b.driverId || null, conductorId: b.conductorId || null } : null };
  if (what === 'driver') [next.a.driverId, next.b.driverId] = [next.b.driverId, next.a.driverId];
  else if (what === 'conductor') [next.a.conductorId, next.b.conductorId] = [next.b.conductorId, next.a.conductorId];
  else if (what === 'both') { [next.a.driverId, next.b.driverId] = [next.b.driverId, next.a.driverId]; [next.a.conductorId, next.b.conductorId] = [next.b.conductorId, next.a.conductorId]; }
  else if (what === 'roles') [next.a.driverId, next.a.conductorId] = [next.a.conductorId, next.a.driverId];
  // everyone moved must be able to fill the seat they land in
  const ids = [a.driverId, a.conductorId, b?.driverId, b?.conductorId].filter(Boolean);
  const staff = new Map((await StaffMember.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).lean()).map((s) => [String(s._id), s]));
  const D = new Map((await Designation.find({ tenantId: ctx.tenantId, _id: { $in: [...staff.values()].map((s) => s.designationId) } }).lean()).map((d) => [String(d._id), d]));
  const changes = [];
  for (const [bus, tag] of [[a, 'a'], [b, 'b']]) {
    if (!bus) continue;
    for (const [field, role] of [['driverId', 'driver'], ['conductorId', 'conductor']]) {
      const was = bus[field] ? String(bus[field]) : null; const now = next[tag][field] ? String(next[tag][field]) : null;
      if (was === now) continue;
      const person = now ? staff.get(now) : null;
      if (person && !busRolesOf(D.get(String(person.designationId)), person).includes(role)) throw bad(`${person.name} cannot be the ${role} of bus ${bus.busNo}: they are not marked as a ${role}. Edit them in Drivers and staff first.`);
      changes.push({ busId: bus._id, busNo: bus.busNo, seat: role, from: was ? staff.get(was)?.name : null, to: person?.name || null });
    }
  }
  if (!changes.length) throw bad('Nothing would change: the crews are already the same');
  if (!preview) {
    await Bus.updateOne({ _id: a._id }, { $set: { driverId: next.a.driverId, conductorId: next.a.conductorId } });
    if (b) await Bus.updateOne({ _id: b._id }, { $set: { driverId: next.b.driverId, conductorId: next.b.conductorId } });
  }
  return { preview: !!preview, what, changes };
}

export async function listBuses(ctx) {
  const [buses, counts] = await Promise.all([
    Bus.find({ tenantId: ctx.tenantId }).sort({ busNo: 1 }).lean(),
    StudentTransport.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$busId', n: { $sum: 1 } } }]),
  ]);
  const crew = await crewOf(ctx.tenantId, buses);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  const docRows = await BusDocument.aggregate([{ $match: { tenantId: ctx.tenantId } }, { $group: { _id: '$busId', total: { $sum: 1 }, withCopy: { $sum: { $cond: [{ $ifNull: ['$fileId', false] }, 1, 0] } } } }]);
  const dc = new Map(docRows.map((d) => [String(d._id), { total: d.total, withCopy: d.withCopy }]));
  return buses.map((b) => ({ ...withCrew(b, crew, ctx.today), students: n.get(String(b._id)) || 0, documents: dc.get(String(b._id)) || { total: 0, withCopy: 0 } }));
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
    StudentEnrolment.find({ tenantId: ctx.tenantId, studentId: { $in: studentIds }, yearId: ctx.year?._id, status: rollStatus(ctx.year) }).lean(),
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
    idleCrew: staff.filter((s) => busRolesOf(D.get(String(s.designationId)), s).length && !onBus.has(String(s._id))).map((s) => ({ id: s._id, name: s.name, staffId: s.staffId, designation: D.get(String(s.designationId)).name })),
    alerts: [
      ...buses.flatMap((b) => withCrew(b, crew, ctx.today).alerts.map((a) => ({ bus: b.busNo, ...a }))),
    ],
    certificates: certificateRows(buses, crew, ctx.today, await BusDocument.find({ tenantId: ctx.tenantId, busId: { $in: buses.map((b) => b._id) } }).lean()),
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


// ───────────── vehicle documents ─────────────
const LEGACY = { insurance: 'insuranceExpiry', pollution: 'pollutionExpiry', fitness: 'fitnessExpiry' };
const stateOf = (d, today) => (d.expiresOn ? certState(d.expiresOn, today) : 'valid');
const view = (d, today, files) => ({
  id: d._id, type: d.type, label: d.type === 'other' ? (d.title || BUS_DOC_TYPES.other.label) : BUS_DOC_TYPES[d.type].label, number: d.number || '', issuedOn: d.issuedOn || '', expiresOn: d.expiresOn || '', notes: d.notes || '',
  fileId: d.fileId || null, file: files?.get(String(d.fileId)) || null, state: stateOf(d, today), daysLeft: d.expiresOn ? daysBetween(today, d.expiresOn) : null, updatedByName: d.updatedByName || '',
});
const loadBus = async (ctx, id) => { const b = await Bus.findOne({ _id: id, tenantId: ctx.tenantId }); if (!b) throw notFound('Bus not found'); return b; };

/** The bus's papers: every standard type is listed (as "missing" until recorded), then anything extra. */
export async function listBusDocuments(ctx, busId) {
  const bus = await loadBus(ctx, busId);
  const docs = await BusDocument.find({ tenantId: ctx.tenantId, busId }).sort({ createdAt: 1 }).lean();
  // what each copy is (its name, kind and size), so the form can say what is already on file
  const fileRows = docs.some((d) => d.fileId) ? await File.find({ _id: { $in: docs.map((d) => d.fileId).filter(Boolean) } }).select('originalName mime size').lean() : [];
  const files = new Map(fileRows.map((f) => [String(f._id), { name: f.originalName, mime: f.mime, size: f.size }]));
  const by = new Map(docs.filter((d) => d.type !== 'other').map((d) => [d.type, d]));
  // a date that was only ever typed on the bus itself (before documents existed) still shows, as a document without a number or copy
  const legacy = (type) => (LEGACY[type] && bus[LEGACY[type]] ? { _id: null, type, expiresOn: bus[LEGACY[type]] } : null);
  const standard = Object.entries(BUS_DOC_TYPES).filter(([t]) => t !== 'other').map(([type, def]) => (by.has(type) ? view(by.get(type), ctx.today, files) : legacy(type) ? view(legacy(type), ctx.today)
    : { id: null, type, label: def.label, number: '', issuedOn: '', expiresOn: '', notes: '', fileId: null, file: null, state: 'missing', daysLeft: null, required: def.expiry === 'required', updatedByName: '' }));
  return { types: Object.fromEntries(Object.entries(BUS_DOC_TYPES).map(([t, d]) => [t, d])), documents: [...standard, ...docs.filter((d) => d.type === 'other').map((d) => view(d, ctx.today, files))] };
}

/** Records or renews a document (type 'other' adds another). A new copy replaces the old file. Insurance, pollution and fitness dates also update the bus's own expiry fields. */
export async function saveBusDocument(ctx, busId, type, body, savedFile) {
  const bus = await loadBus(ctx, busId);
  const def = BUS_DOC_TYPES[type];
  if (!def) throw bad('Unknown document type');
  if (def.expiry === 'required' && !body.expiresOn) throw bad('Enter the date it is valid until');
  if (body.issuedOn && body.expiresOn && body.expiresOn < body.issuedOn) throw bad('The valid-until date is before the issue date');
  if (type === 'other' && !body.title) throw bad('Give the document a name');
  let doc = type === 'other' ? null : await BusDocument.findOne({ tenantId: ctx.tenantId, busId, type });
  const fields = { number: body.number || undefined, issuedOn: body.issuedOn || undefined, expiresOn: body.expiresOn || undefined, notes: body.notes || undefined, title: type === 'other' ? body.title : undefined, updatedByName: ctx.actorName };
  if (!doc) doc = new BusDocument({ tenantId: ctx.tenantId, busId, type });
  Object.assign(doc, fields);
  if (savedFile) { const old = doc.fileId ? await File.findById(doc.fileId) : null; doc.fileId = savedFile._id; if (old) { await removeFileBytes(old); await old.deleteOne(); } }
  await doc.save();
  if (LEGACY[type]) { bus.set(LEGACY[type], doc.expiresOn || undefined); await bus.save(); }
  return view(doc.toObject(), ctx.today);
}

export async function removeBusDocument(ctx, busId, docId) {
  await loadBus(ctx, busId);
  const doc = await BusDocument.findOne({ _id: docId, tenantId: ctx.tenantId, busId });
  if (!doc) throw notFound('Document not found');
  if (doc.fileId) { const f = await File.findById(doc.fileId); if (f) { await removeFileBytes(f); await f.deleteOne(); } }
  if (LEGACY[doc.type]) await Bus.updateOne({ _id: busId, tenantId: ctx.tenantId }, { $unset: { [LEGACY[doc.type]]: 1 } });
  await doc.deleteOne();
}

/**
 * Tells the transport officer (and the School Admin) when a vehicle document is about to run out or has: once at 30 days, 7 days and on expiry,
 * for the documents recorded here and for the older expiry dates on the bus. Safe to run often: each stage is sent once.
 */
export async function busDocumentReminders(now = new Date()) {
  let sent = 0;
  const today = now.toLocaleDateString('en-CA');
  for (const school of await School.find({ status: 'active' }).select('_id').lean()) {
    const tenantId = school._id;
    const [buses, docs, users] = await Promise.all([Bus.find({ tenantId, status: { $ne: 'retired' } }).lean(), BusDocument.find({ tenantId }).lean(), User.find({ tenantId, status: 'active', $or: [{ role: 'transport' }, { role: 'school_admin', adminLevel: { $ne: 'sub' } }] }).select('_id').lean()]);
    if (!users.length) continue;
    const items = [];
    for (const b of buses) {
      for (const [type, field] of Object.entries(LEGACY)) if (b[field]) items.push({ key: `${b._id}:${type}`, bus: b.busNo, label: BUS_DOC_TYPES[type].label, date: b[field] });
    }
    const busNo = new Map(buses.map((b) => [String(b._id), b.busNo]));
    for (const d of docs) if (d.expiresOn && busNo.has(String(d.busId)) && !LEGACY[d.type]) items.push({ key: `${d.busId}:${d._id}`, bus: busNo.get(String(d.busId)), label: d.type === 'other' ? (d.title || 'Document') : BUS_DOC_TYPES[d.type].label, date: d.expiresOn });
    for (const it of items) {
      const left = daysBetween(today, it.date);
      const stage = left < 0 ? 'expired' : left <= 7 ? '7' : left <= 30 ? '30' : null;
      if (!stage) continue;
      sent += await notifyUsers(tenantId, users.map((u) => u._id), {
        category: 'transport', title: stage === 'expired' ? `Bus ${it.bus}: ${it.label} has expired` : `Bus ${it.bus}: ${it.label} runs out in ${left} day${left === 1 ? '' : 's'}`,
        body: `Valid until ${it.date}. Renew it and record the new dates under Buses and riders.`, link: { type: 'transport' }, dedupeKey: `busdoc:${it.key}:${it.date}:${stage}`,
      });
    }
  }
  return sent;
}
