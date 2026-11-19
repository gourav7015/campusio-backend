import PDFDocument from 'pdfkit';
import { Section, ClassModel, TimetablePeriod, TimetableEntry, TeachingAssignment, School } from '../../models/index.js';
import { notFound, toCsv } from '../../core/utils.js';
import { getCurrentYear } from '../../services/context.js';

const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The timetables to print: one section, every section of a class, or every section of the school (current session), in school order. */
export async function loadTimetables(ctx, { classId, sectionId }) {
  const year = ctx.year || (await getCurrentYear(ctx.tenantId));
  const f = { tenantId: ctx.tenantId, yearId: year?._id, status: 'active' };
  if (sectionId) f._id = sectionId; else if (classId) f.classId = classId;
  const [sections, periods, classes] = await Promise.all([
    Section.find(f).lean(), TimetablePeriod.find({ tenantId: ctx.tenantId }).sort({ order: 1 }).lean(), ClassModel.find({ tenantId: ctx.tenantId }).select('name level').lean(),
  ]);
  if (!sections.length) throw notFound(sectionId ? 'Section not found' : 'No sections to print');
  const C = new Map(classes.map((c) => [String(c._id), c]));
  sections.sort((a, b) => (C.get(String(a.classId))?.level ?? 99) - (C.get(String(b.classId))?.level ?? 99) || String(a.name).localeCompare(String(b.name)));
  const entries = await TimetableEntry.find({ tenantId: ctx.tenantId, yearId: year?._id, sectionId: { $in: sections.map((s) => s._id) } }).lean();
  const asg = await TeachingAssignment.find({ tenantId: ctx.tenantId, _id: { $in: entries.map((e) => e.assignmentId).filter(Boolean) } }).populate('teacherId', 'name').populate('subjectId', 'name').lean();
  const A = new Map(asg.map((a) => [String(a._id), a]));
  const days = (ctx.settings.workingDays?.length ? [...ctx.settings.workingDays] : [1, 2, 3, 4, 5, 6]).sort((a, b) => a - b);
  const cell = new Map(entries.map((e) => [`${e.sectionId}|${e.day}|${e.periodId}`, { subject: A.get(String(e.assignmentId))?.subjectId?.name || '', teacher: A.get(String(e.assignmentId))?.teacherId?.name || '', room: e.room || '' }]));
  return { year, periods, days, cell, sections: sections.map((s) => ({ id: s._id, className: C.get(String(s.classId))?.name || '', name: s.name, room: s.room })) };
}

/** One row per lesson: class, section, day, period, times, subject, teacher, room. Opens in Excel. */
export function timetableCsv(t) {
  const rows = [];
  for (const s of t.sections) for (const d of t.days) for (const p of t.periods.filter((x) => x.type === 'lesson')) {
    const c = t.cell.get(`${s.id}|${d}|${p._id}`);
    if (c) rows.push({ Class: s.className, Section: s.name, Day: DAY[d], Period: p.name, Start: p.startTime, End: p.endTime, Subject: c.subject, Teacher: c.teacher, Room: c.room });
  }
  return toCsv(rows, ['Class', 'Section', 'Day', 'Period', 'Start', 'End', 'Subject', 'Teacher', 'Room'].map((label) => ({ label, get: (r) => r[label] })));
}

/** A landscape page per section: periods down the side, working days across, subject and teacher in each box. */
export async function timetablePdf(ctx, t, res) {
  const school = await School.findById(ctx.tenantId).select('name').lean();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  doc.pipe(res);
  const left = 28; const width = doc.page.width - 56;
  const first = 74; const dayW = (width - first) / t.days.length;
  t.sections.forEach((s, i) => {
    if (i) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(15).text(school?.name || 'School', left, 26, { width, align: 'center' });
    doc.font('Helvetica').fontSize(11).text(`Timetable · ${s.className} ${s.name}${s.room ? ` · Room ${s.room}` : ''} · ${t.year?.name || ''}`, left, 46, { width, align: 'center' });
    let y = 70;
    const rowH = Math.max(34, Math.min(52, (doc.page.height - 70 - 60) / Math.max(t.periods.length + 1, 1)));
    const box = (x, yy, w, h, text, o = {}) => {
      doc.rect(x, yy, w, h).lineWidth(0.5).stroke('#9aa0a6');
      if (o.fill) doc.save().rect(x, yy, w, h).fill(o.fill).restore().rect(x, yy, w, h).lineWidth(0.5).stroke('#9aa0a6');
      doc.fillColor('#111').font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 8).text(text, x + 3, yy + 4, { width: w - 6, height: h - 6, ellipsis: true, align: o.align || 'left' });
    };
    box(left, y, first, 22, 'Period', { bold: true, fill: '#eef1f5', size: 9 });
    t.days.forEach((d, j) => box(left + first + j * dayW, y, dayW, 22, DAY[d], { bold: true, fill: '#eef1f5', size: 9, align: 'center' }));
    y += 22;
    for (const p of t.periods) {
      if (p.type === 'break') {
        box(left, y, width, 18, `${p.name || 'Break'} · ${p.startTime}–${p.endTime}`, { fill: '#f6f6f6', align: 'center' });
        y += 18; continue;
      }
      box(left, y, first, rowH, `${p.name}\n${p.startTime}–${p.endTime}`, { bold: true, size: 8 });
      t.days.forEach((d, j) => {
        const c = t.cell.get(`${s.id}|${d}|${p._id}`);
        box(left + first + j * dayW, y, dayW, rowH, c ? `${c.subject}\n${c.teacher}${c.room ? ` · ${c.room}` : ''}` : '', { size: 8 });
      });
      y += rowH;
    }
    doc.fillColor('#666').font('Helvetica').fontSize(7).text(`Printed from Campusio · ${new Date().toLocaleDateString('en-GB')}`, left, doc.page.height - 40, { width, align: 'right', lineBreak: false });
  });
  doc.end();
}

export const fileName = (t, f) => (f.sectionId && t.sections.length === 1 ? `timetable-${slug(`${t.sections[0].className}-${t.sections[0].name}`)}` : f.classId ? `timetable-${slug(t.sections[0].className)}` : 'timetable-all-sections');
