import { Router } from 'express';
import { User } from '../../models/index.js';
import { notFound, forbidden, isId } from '../../core/utils.js';
import { audit } from '../../services/audit.js';
import { twoFactorReset } from './auth.service.js';

/** School Admin: someone in this school lost their phone and recovery codes, so their two-factor sign-in is switched off and every device is signed out. */
export const adminRoutes = Router();
adminRoutes.post('/users/:id/reset-2fa', async (req, res) => {
  if (!isId(req.params.id)) throw notFound('User not found');
  const u = await User.findOne({ _id: req.params.id, tenantId: req.tenantId });
  if (!u || u.role === 'super_admin') throw notFound('User not found');
  if (String(u._id) === String(req.user._id)) throw forbidden('Ask another administrator, or the AtKaksha team, to reset your own two-factor sign-in');
  await twoFactorReset(u);
  await audit(req, 'auth.2fa_reset', 'User', u._id, `Reset two-factor sign-in for ${u.name}`);
  res.json({ ok: true });
});
