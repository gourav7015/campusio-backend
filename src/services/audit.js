import { AuditLog } from '../models/index.js';

export async function audit(req, action, entityType, entityId, summary, meta) {
  try {
    await AuditLog.create({
      tenantId: req.tenantId || req.user?.tenantId || null,
      actorId: req.user?._id, actorName: req.user?.name, actorRole: req.user?.role,
      actingAsSuperAdmin: !!req.acting,
      action, entityType, entityId: entityId ? String(entityId) : undefined, summary, meta, ip: req.ip,
    });
  } catch (e) {
    console.error('audit failed', e.message);
  }
}
