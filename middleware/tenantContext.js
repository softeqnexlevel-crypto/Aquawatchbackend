// backend/middleware/tenantContext.js
// Runs AFTER requireAuth. Decides which client (tenant) the request is about:
// the X-Tenant-Id header (or ?tenant=), falling back to tenant 1. A user can only ever open
// tenants they were given; anything else is refused, so one client can't read another's data.
const tenants = require('../services/tenants.service');

async function tenantContext(req, res, next) {
  try {
    const raw = req.headers['x-tenant-id'] || (req.query && req.query.tenant);
    const wanted = raw ? Number(raw) : tenants.DEFAULT_TENANT_ID;
    if (!Number.isInteger(wanted) || wanted < 1) return res.status(400).json({ error: 'Invalid tenant' });
    if (!(await tenants.canAccess(req.user, wanted))) return res.status(403).json({ error: 'You do not have access to this client' });
    req.tenantId = wanted;
    next();
  } catch (e) {
    console.error('[tenant] context', e.message);
    res.status(500).json({ error: 'Failed to resolve client' });
  }
}
module.exports = tenantContext;
