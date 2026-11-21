import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Student, User, Session, File, StudentRemark } from '../../models/index.js';
import { bad, notFound, conflict, isId } from '../../core/utils.js';
import { removeFileBytes } from '../../services/files.js';
import { hashPassword } from '../../services/users.js';

const loadStudent = async (tenantId, id) => {
  if (!isId(String(id))) throw notFound('Student not found');
  const s = await Student.findOne({ _id: id, tenantId });
  if (!s) throw notFound('Student not found');
  return s;
};

/** Which families have given their consent for the school to hold the child's details (the school records it; the consent itself is on paper or in the admission form). */
export async function consentSummary(tenantId) {
  const [active, withConsent] = await Promise.all([Student.countDocuments({ tenantId, status: 'active' }), Student.countDocuments({ tenantId, status: 'active', 'consent.givenOn': { $exists: true, $ne: null } })]);
  return { activeStudents: active, withConsent, without: active - withConsent };
}

/** What the Privacy tab shows for one student. */
export async function privacyStatus(tenantId, studentId) {
  const s = await loadStudent(tenantId, studentId);
  return { status: s.status, consent: s.consent?.givenOn ? s.consent.toObject() : null, erased: !!s.anonymisedAt, erasedAt: s.anonymisedAt || null, canErase: s.status !== 'active' && !s.anonymisedAt, admissionNo: s.admissionNo };
}

export async function setConsent(ctx, studentId, { givenOn, guardianName, relationship, note }) {
  const s = await loadStudent(ctx.tenantId, studentId);
  s.consent = { givenOn, guardianName, relationship, note, recordedByName: ctx.actorName, recordedAt: new Date() };
  await s.save();
  return s.consent;
}
export async function clearConsent(ctx, studentId) {
  const s = await loadStudent(ctx.tenantId, studentId);
  s.consent = undefined; await s.save();
}

/**
 * Everything the school holds about one student, as one JSON document: the profile, the login's contact details, and every record in any
 * collection that points at the student (attendance, marks, fees, library, remarks, bus…). File contents are listed, not included.
 */
export async function exportStudent(ctx, studentId) {
  const s = await loadStudent(ctx.tenantId, studentId);
  const user = s.userId ? await User.findById(s.userId).select('loginId email lastLoginAt createdAt').lean() : null;
  const records = {};
  for (const name of mongoose.modelNames()) {
    const M = mongoose.model(name);
    if (name === 'Student' || !M.schema.path('studentId')) continue;
    const rows = await M.find({ studentId: s._id, ...(M.schema.path('tenantId') ? { tenantId: ctx.tenantId } : {}) }).lean();
    if (rows.length) records[name] = rows;
  }
  const files = await File.find({ tenantId: ctx.tenantId, ownerType: 'student', ownerId: String(s._id) }).select('originalName mime size kind docType createdAt').lean();
  return { exportedAt: new Date().toISOString(), exportedBy: ctx.actorName, note: 'Personal data held about this student. Files are listed by name; ask the school for the files themselves.', student: s.toObject(), login: user, records, files };
}

/**
 * Erase a student's personal details while keeping what the law or the school's accounts need: fee payments and charges, marks and attendance
 * stay (without a name or contact). Only a student who has left can be erased, and the admission number has to be typed to confirm.
 */
export async function anonymiseStudent(ctx, studentId, { confirmAdmissionNo, reason }) {
  const s = await loadStudent(ctx.tenantId, studentId);
  if (s.status === 'active') throw conflict('This student is still at the school. Withdraw or complete their admission first.');
  if (s.anonymisedAt) throw conflict('This student was already erased');
  if (String(confirmAdmissionNo).trim().toLowerCase() !== String(s.admissionNo).toLowerCase()) throw bad('Type the admission number to confirm');
  // files: photo and documents are deleted from disk
  const files = await File.find({ tenantId: ctx.tenantId, ownerType: 'student', ownerId: String(s._id) });
  const ids = new Set(files.map((f) => String(f._id)));
  if (s.photoFileId && !ids.has(String(s.photoFileId))) { const p = await File.findOne({ _id: s.photoFileId, tenantId: ctx.tenantId }); if (p) files.push(p); }
  for (const f of files) { await removeFileBytes(f); await f.deleteOne(); }
  s.name = `Former student ${s.admissionNo}`;
  for (const k of ['dob', 'address', 'phone', 'email', 'bloodGroup', 'house']) s[k] = undefined;
  s.gender = ''; s.guardians = []; s.emergencyContact = undefined; s.photoFileId = undefined; s.consent = undefined;
  s.anonymisedAt = new Date(); s.anonymisedByName = ctx.actorName; s.anonymisationReason = String(reason || '').slice(0, 300);
  await s.save();
  await StudentRemark.updateMany({ tenantId: ctx.tenantId, studentId: s._id }, { $set: { text: '[removed]' } });
  if (s.userId) {
    const u = await User.findById(s.userId);
    if (u) {
      u.name = s.name; u.email = undefined; u.loginId = `erased-${crypto.randomBytes(6).toString('hex')}`; u.status = 'disabled'; u.passwordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
      await u.save(); await Session.updateMany({ userId: u._id, revokedAt: null }, { revokedAt: new Date() });
    }
  }
  return { ok: true, filesRemoved: files.length };
}
