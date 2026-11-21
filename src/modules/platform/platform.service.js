import { School, Subscription, User, Student, Teacher, Session, AuditLog, defaultSettings } from '../../models/index.js';
import { notFound, conflict, escapeRegex, todayStr, generatePassword } from '../../core/utils.js';
import { createUserAccount, hashPassword } from '../../services/users.js';

const revokeSessions = (userIds) => Session.updateMany({ userId: { $in: userIds }, revokedAt: null }, { revokedAt: new Date() });

export async function platformStats() {
  const [schools, active, students, teachers, admins, subs] = await Promise.all([
    School.countDocuments(), School.countDocuments({ status: 'active' }),
    Student.countDocuments({ status: 'active' }), Teacher.countDocuments({ status: 'active' }),
    User.countDocuments({ role: 'school_admin' }), Subscription.find().lean(),
  ]);
  const today = todayStr();
  const in30 = todayStr('UTC', new Date(Date.now() + 30 * 86400000));
  return {
    schools, activeSchools: active, students, teachers, schoolAdmins: admins,
    subscriptions: {
      trial: subs.filter((s) => s.status === 'trial').length,
      active: subs.filter((s) => s.status === 'active').length,
      expired: subs.filter((s) => s.status === 'expired' || (s.expiresOn && s.expiresOn < today)).length,
      expiringSoon: subs.filter((s) => s.expiresOn && s.expiresOn >= today && s.expiresOn <= in30).length,
    },
  };
}

export async function listSchools({ q, status }) {
  const f = {};
  if (status) f.status = String(status);
  if (q) f.$or = [{ name: new RegExp(escapeRegex(q), 'i') }, { code: new RegExp(escapeRegex(q), 'i') }];
  const schools = await School.find(f).sort({ createdAt: -1 }).lean();
  const ids = schools.map((s) => s._id);
  const countBy = (Model) => Model.aggregate([{ $match: { tenantId: { $in: ids }, status: 'active' } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]);
  const [subs, sc, tc, admins] = await Promise.all([
    Subscription.find({ schoolId: { $in: ids } }).lean(), countBy(Student), countBy(Teacher),
    User.find({ tenantId: { $in: ids }, role: 'school_admin' }).select('name loginId status tenantId').lean(),
  ]);
  const toMap = (rows) => new Map(rows.map((x) => [String(x._id), x.n]));
  const sMap = toMap(sc); const tMap = toMap(tc);
  return schools.map((s) => ({
    ...s, settings: undefined,
    subscription: subs.find((x) => String(x.schoolId) === String(s._id)) || null,
    studentCount: sMap.get(String(s._id)) || 0, teacherCount: tMap.get(String(s._id)) || 0,
    admins: admins.filter((a) => String(a.tenantId) === String(s._id)),
  }));
}

export async function createSchool(body, actorId) {
  if (await School.exists({ code: body.code.toLowerCase() })) throw conflict('School code already exists');
  const school = await School.create({
    name: body.name, code: body.code, address: body.address, phone: body.phone, email: body.email || undefined, board: body.board, settings: defaultSettings(),
  });
  const subscription = await Subscription.create({ schoolId: school._id, startsOn: todayStr(), ...(body.subscription || {}) });
  let admin = null;
  if (body.admin) {
    try {
      const { user, temporaryPassword } = await createUserAccount({
        role: 'school_admin', tenantId: school._id, name: body.admin.name, email: body.admin.email, password: body.admin.password, createdBy: actorId,
      });
      admin = { id: user._id, name: user.name, loginId: user.loginId, temporaryPassword };
    } catch (e) {
      await Promise.all([Subscription.deleteOne({ _id: subscription._id }), School.deleteOne({ _id: school._id })]);
      throw e;
    }
  }
  return { school, subscription, admin };
}

export async function getSchool(id) {
  const school = await School.findById(id).lean();
  if (!school) throw notFound('School not found');
  const [subscription, admins, studentCount, teacherCount] = await Promise.all([
    Subscription.findOne({ schoolId: school._id }),
    User.find({ tenantId: school._id, role: 'school_admin' }).select('name loginId email status lastLoginAt totp.enabled').lean(),
    Student.countDocuments({ tenantId: school._id, status: 'active' }), Teacher.countDocuments({ tenantId: school._id, status: 'active' }),
  ]);
  return { ...school, subscription, admins: admins.map(({ totp, ...a }) => ({ ...a, twoFactor: !!totp?.enabled })), studentCount, teacherCount };
}

export async function updateSchool(id, body) {
  const school = await School.findById(id);
  if (!school) throw notFound('School not found');
  Object.assign(school, body);
  await school.save();
  if (body.status && body.status !== 'active') {
    const users = await User.find({ tenantId: school._id }).select('_id');
    await revokeSessions(users.map((u) => u._id));
  }
  return school;
}

export async function updateSubscription(schoolId, body) {
  const school = await School.findById(schoolId);
  if (!school) throw notFound('School not found');
  const sub = await Subscription.findOneAndUpdate({ schoolId: school._id }, { $set: body }, { new: true, upsert: true });
  return { school, sub };
}

export async function createSchoolAdmin(schoolId, body, actorId) {
  const school = await School.findById(schoolId);
  if (!school) throw notFound('School not found');
  const { user, temporaryPassword } = await createUserAccount({
    role: 'school_admin', tenantId: school._id, name: body.name, email: body.email, loginId: body.loginId, password: body.password, createdBy: actorId,
  });
  return { school, user, temporaryPassword };
}

export async function resetAdminPassword(userId) {
  const u = await User.findOne({ _id: userId, role: 'school_admin' });
  if (!u) throw notFound('School admin not found');
  const temporaryPassword = generatePassword();
  u.passwordHash = await hashPassword(temporaryPassword);
  u.mustChangePassword = true; u.failedLogins = 0; u.lockedUntil = undefined;
  await u.save();
  await revokeSessions([u._id]);
  return { user: u, temporaryPassword };
}

export async function setAdminStatus(userId, status) {
  const u = await User.findOne({ _id: userId, role: 'school_admin' });
  if (!u) throw notFound('School admin not found');
  u.status = status;
  await u.save();
  if (status === 'disabled') await revokeSessions([u._id]);
  return u;
}

export async function listAudit({ schoolId, action, limit }) {
  const f = {};
  if (schoolId) f.tenantId = schoolId;
  if (action) f.action = new RegExp(`^${escapeRegex(action)}`);
  return AuditLog.find(f).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
}
