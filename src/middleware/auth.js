import jwt from 'jsonwebtoken';
import { config } from '../core/config.js';
import { verifyToken } from '../core/tokens.js';
import { User, Session, School, Subscription, AuditLog } from '../models/index.js';
import { HttpError, forbidden, isId } from '../core/utils.js';
import { todayStr } from '../core/utils.js';
import { audit } from '../services/audit.js';
import { memo } from '../core/memo.js';
import { loadSchool } from '../services/context.js';

const unauth = (m = 'Authentication required') => new HttpError(401, m, 'UNAUTHENTICATED');

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauth();
  let payload;
  try { payload = verifyToken(token); } catch { throw unauth('Session expired, please sign in again'); }
  if (payload.p) throw unauth();
  const [session, user] = await Promise.all([Session.findOne({ jti: payload.jti }), User.findById(payload.sub)]);
  if (!session || session.revokedAt || !user) throw unauth('Session expired, please sign in again');
  if (user.status !== 'active') throw unauth('This account has been disabled');

  if (user.role !== 'super_admin') {
    // the school and its subscription change rarely and are read on every request: kept in memory for a few seconds (cleared whenever either is saved)
    const school = await loadSchool(user.tenantId).catch((e) => { if (e?.status === 404) return null; throw e; });
    if (!school || school.status !== 'active') throw new HttpError(403, 'This school account is not active', 'SCHOOL_INACTIVE');
    const sub = await memo(`sub:${school._id}`, () => Subscription.findOne({ schoolId: school._id }).lean());
    if (sub && (sub.status === 'cancelled' || sub.status === 'expired' || (sub.expiresOn && sub.expiresOn < todayStr()))) {
      throw new HttpError(403, 'This school subscription is not active', 'SUBSCRIPTION_INACTIVE');
    }
  }

  req.user = user;
  req.session = session;
  req.tenantId = user.tenantId || null;

  // Super Admin may act inside one school for onboarding / data dumping. The school is
  // chosen explicitly, verified server-side, and every write is audited as such.
  if (user.role === 'super_admin') {
    const acting = req.headers['x-acting-school'];
    if (acting) {
      if (!isId(String(acting))) throw new HttpError(400, 'Invalid acting school', 'BAD_REQUEST');
      const school = await School.findById(acting);
      if (!school) throw new HttpError(404, 'Acting school not found', 'NOT_FOUND');
      req.tenantId = school._id;
      req.acting = true;
      // Any platform-administrator access to a school's records (reads included) leaves a trace: one entry per administrator, school and half hour.
      const recent = await AuditLog.exists({ actorId: user._id, tenantId: school._id, action: 'platform.acting', createdAt: { $gt: new Date(Date.now() - 30 * 60 * 1000) } });
      if (!recent) await audit(req, 'platform.acting', 'School', school._id, `Platform administrator started working inside ${school.name}`);
    }
  }

  if (Date.now() - (session.lastSeenAt?.getTime() || 0) > 5 * 60 * 1000) {
    session.lastSeenAt = new Date();
    session.save().catch(() => {});
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) throw forbidden();
  next();
};

export const requireTenant = (req, _res, next) => {
  if (!req.tenantId) throw new HttpError(400, 'Select a school to act on first (X-Acting-School)', 'TENANT_REQUIRED');
  next();
};

/** Super Admin must never reach teacher/student endpoints via acting mode. */
export const rejectActing = (req, _res, next) => {
  if (req.acting) throw forbidden('Not available while acting on a school');
  next();
};

export function signToken(user, jti, expiresIn) {
  return jwt.sign({ sub: String(user._id), role: user.role, jti }, config.jwtSecret, { expiresIn });
}
