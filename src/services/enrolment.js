import {
  Student, StudentEnrolment, Section, AcademicYear, ClassModel,
} from '../models/index.js';
import { conflict, notFound, bad } from '../core/utils.js';
import { nextSeq } from './context.js';

export async function nextRollNo(tenantId, sectionId) {
  const last = await StudentEnrolment.findOne({ tenantId, sectionId, status: 'active' }).sort({ rollNo: -1 }).select('rollNo');
  return (last?.rollNo || 0) + 1;
}

export async function assertSectionHasRoom(tenantId, section, adding = 1) {
  const n = await StudentEnrolment.countDocuments({ tenantId, sectionId: section._id, status: 'active' });
  if (n + adding > section.capacity) throw conflict(`Section is full (${n}/${section.capacity})`, { capacity: section.capacity, enrolled: n });
}

/** Resolve and cross-check year / class / section so a record can never point across tenants or years. */
export async function resolvePlacement(tenantId, { yearId, classId, sectionId }) {
  const [year, section] = await Promise.all([
    AcademicYear.findOne({ _id: yearId, tenantId }), Section.findOne({ _id: sectionId, tenantId }),
  ]);
  if (!year) throw notFound('Academic year not found');
  if (!section) throw notFound('Section not found');
  if (String(section.yearId) !== String(year._id)) throw bad('Section does not belong to that academic year');
  if (classId && String(section.classId) !== String(classId)) throw bad('Section does not belong to that class');
  if (section.status !== 'active') throw conflict('Section is archived');
  const cls = await ClassModel.findOne({ _id: section.classId, tenantId });
  if (!cls || cls.status !== 'active') throw conflict('Class is archived');
  return { year, section, cls };
}

export async function generateAdmissionNo(tenantId, format, dateStr) {
  const yyyy = dateStr.slice(0, 4);
  for (let i = 0; i < 20; i++) {
    const seq = await nextSeq(tenantId, `admission:${format}:${yyyy}`);
    const no = format.replace('{YYYY}', yyyy).replace('{YY}', yyyy.slice(2)).replace(/\{SEQ:(\d)\}/, (_, n) => String(seq).padStart(Number(n), '0'));
    if (!(await Student.exists({ tenantId, admissionNo: no }))) return no;
  }
  throw conflict('Could not generate a unique admission number');
}
