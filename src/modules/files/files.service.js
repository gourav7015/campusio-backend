import {
  File, Ticket, Homework, StudyMaterial, Announcement, Student, Teacher, StudentEnrolment, TeachingAssignment, ClassTeacherAssignment, LeaveApplication, User,
} from '../../models/index.js';
import { notFound, forbidden } from '../../core/utils.js';
import { fileAvailable, signFileToken, verifyFileToken } from '../../services/files.js';
import { effectiveStatus } from '../homework/homework.service.js';
import { visibleNow } from '../materials/materials.service.js';
import { visibleTo } from '../comms/announcements.service.js';
import { schoolToday } from '../../services/context.js';

const sectionsOf = async (user) => {
  if (user.role === 'student') {
    const s = await Student.findOne({ userId: user._id, tenantId: user.tenantId });
    const enr = s ? await StudentEnrolment.find({ tenantId: user.tenantId, studentId: s._id, status: 'active' }) : [];
    return { ids: enr.map((e) => String(e.sectionId)), student: s };
  }
  if (user.role === 'teacher') {
    const t = await Teacher.findOne({ userId: user._id, tenantId: user.tenantId });
    const [a, c] = t ? await Promise.all([TeachingAssignment.find({ tenantId: user.tenantId, teacherId: t._id }), ClassTeacherAssignment.find({ tenantId: user.tenantId, teacherId: t._id })]) : [[], []];
    return { ids: [...a, ...c].map((x) => String(x.sectionId)), teacher: t };
  }
  return { ids: [] };
};

/** Single permission gate for every file download (tenant, kind and ownership are all checked). */
export async function canAccess(user, tenantId, file) {
  if (!file || String(file.tenantId) !== String(tenantId)) return false;
  if (user.role === 'school_admin' || user.role === 'super_admin') return true;
  if (file.ownerType === 'expense') return user.role === 'finance'; // bills and quotes on an expense: Finance (the School Admin is let through above)
  if (file.ownerType === 'bus') return user.role === 'transport'; // a vehicle's papers: the transport officer (the School Admin is let through above)
  if (file.ownerType === 'school' || file.ownerType === 'license') return true; // the school's own gallery and licences are for everyone at the school
  const { ids, student, teacher } = await sectionsOf(user);
  const { today } = await schoolToday(tenantId);
  switch (file.kind) {
    case 'homework': {
      const h = await Homework.findOne({ _id: file.ownerId, tenantId });
      if (!h) return false;
      if (user.role === 'teacher') return ids.includes(String(h.sectionId));
      return user.role === 'student' && ids.includes(String(h.sectionId)) && effectiveStatus(h) === 'published';
    }
    case 'material': {
      const m = await StudyMaterial.findOne({ _id: file.ownerId, tenantId });
      if (!m) return false;
      if (user.role === 'teacher') return ids.includes(String(m.sectionId));
      return user.role === 'student' && ids.includes(String(m.sectionId)) && visibleNow(m, today);
    }
    case 'announcement': {
      const a = await Announcement.findOne({ _id: file.ownerId, tenantId });
      return !!a && visibleTo(a, { role: user.role, sectionIds: ids });
    }
    case 'document': case 'photo':
      if (file.ownerType === 'student') {
        if (student) return String(student._id) === String(file.ownerId);
        if (user.role === 'teacher' && file.kind === 'photo') return !!(await StudentEnrolment.exists({ tenantId: user.tenantId, studentId: file.ownerId, status: 'active', sectionId: { $in: ids } })); // a teacher sees the photos of their own students
        return false;
      }
      if (file.ownerType === 'teacher') return !!teacher && String(teacher._id) === String(file.ownerId);
      return false;
    case 'ticket': { // a help desk attachment: only the person who raised the ticket, and never one that sits on a private note
      const t = await Ticket.findOne({ _id: file.ownerId, tenantId, 'raisedBy.userId': user._id }).select('messages');
      return !!t && t.messages.some((m) => !m.internal && (m.attachments || []).some((a) => String(a.fileId) === String(file._id)));
    }
    case 'leave': {
      const l = await LeaveApplication.findOne({ attachmentFileId: file._id, tenantId });
      return !!l && !!teacher && String(l.teacherId) === String(teacher._id);
    }
    default: return false;
  }
}

export async function issueLink(user, tenantId, fileId) {
  const file = await File.findOne({ _id: fileId, tenantId });
  if (!file || !(await canAccess(user, tenantId, file))) throw notFound('File not found'); // 404 so ids can't be probed
  const token = signFileToken(file._id, user._id);
  return { url: `/api/files/download/${file._id}?token=${encodeURIComponent(token)}`, name: file.originalName, expiresInSeconds: 300 };
}

export async function openByToken(fileId, token) {
  let p;
  try { p = verifyFileToken(token); } catch { throw forbidden('This download link is invalid or has expired'); }
  if (p.f !== String(fileId)) throw forbidden('This download link is invalid');
  const user = await User.findById(p.u);
  if (!user || user.status !== 'active') throw forbidden('This download link is invalid');
  const file = await File.findById(fileId);
  if (!file) throw notFound('File not found');
  if (!(await canAccess(user, file.tenantId, file))) throw notFound('File not found');
  if (!(await fileAvailable(file))) throw notFound('File is no longer available');
  return { file };
}
