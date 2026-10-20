// backend/routes/tenants.routes.js — clients (tenants): list, add, edit MQTT + dashboard settings.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const tenants = require('../services/tenants.service');
const mqttClient = require('../mqtt/mqttClient');

const requireAuth = authMiddleware.requireAuth;
const superOnly = (req, res, next) => (req.user && req.user.isSuperAdmin ? next() : res.status(403).json({ error: 'Super admin access required' }));
const bad = (res, e) => res.status(400).json({ error: e.message || 'Invalid request' });

// Tenants this user may open (the switcher). The MQTT details are only included for super admins.
router.get('/tenants', requireAuth, async (req, res) => {
  try {
    const ids = await tenants.tenantIdsForUser(req.user);
    const rows = (await tenants.listAll()).filter((r) => ids.includes(r.id));
    const list = rows.map((r) => {
      const t = tenants.publicTenant(r);
      if (!req.user.isSuperAdmin) t.mqtt = undefined;
      return t;
    });
    res.json({ tenants: list, canCreate: !!req.user.isSuperAdmin });
  } catch (e) { console.error('[tenants] list', e.message); res.status(500).json({ error: 'Failed to load clients' }); }
});

// Add a client: name + MQTT connection + what they offer. Connects straight away.
router.post('/tenants', requireAuth, superOnly, async (req, res) => {
  let row;
  try { row = await tenants.create(req.body || {}, req.user.id); } catch (e) { return bad(res, e); }
  try {
    await tenants.setUserTenants(req.user.id, [...new Set([...(await tenants.tenantIdsForUser(req.user)), row.id])]);
    await mqttClient.reloadTenant(row.id);
  } catch (e) { console.error('[tenants] connect', e.message); }
  res.status(201).json({ tenant: tenants.publicTenant(row), status: mqttClient.getStatus(row.id) });
});

// One client's full settings (+ live MQTT status)
router.get('/tenants/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await tenants.canAccess(req.user, id))) return res.status(403).json({ error: 'No access to this client' });
    const t = tenants.publicTenant(await tenants.getRow(id));
    if (!t) return res.status(404).json({ error: 'Client not found' });
    if (!req.user.isSuperAdmin) t.mqtt = undefined;
    res.json({ tenant: t, status: mqttClient.getStatus(id) });
  } catch (e) { res.status(500).json({ error: 'Failed to load client' }); }
});

// Edit. MQTT/name/pages/systems: super admin. Targets & capacities: any admin of that client.
router.put('/tenants/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await tenants.canAccess(req.user, id))) return res.status(403).json({ error: 'No access to this client' });
    const body = req.body || {};
    const patch = {};
    if (req.user.isSuperAdmin) {
      if (body.name !== undefined) patch.name = body.name;
      if (body.mqtt) patch.mqtt = body.mqtt;
      if (body.config) patch.config = body.config;
    } else if (req.user.role === 'admin') {
      const c = body.config || {};
      patch.config = {};
      for (const k of ['productionTarget', 'recoveryTarget', 'feedTankCapacity', 'flushTankCapacity']) if (c[k] !== undefined) patch.config[k] = c[k];
    } else return res.status(403).json({ error: 'Admin access required' });
    const row = await tenants.update(id, patch);
    if (patch.mqtt) { try { await mqttClient.reloadTenant(id); } catch (e) { console.error('[tenants] reconnect', e.message); } }
    const t = tenants.publicTenant(row);
    if (!req.user.isSuperAdmin) t.mqtt = undefined;
    res.json({ message: 'Saved', tenant: t, status: mqttClient.getStatus(id) });
  } catch (e) { bad(res, e); }
});

// Reconnect now (after fixing a broker password, say)
router.post('/tenants/:id/reconnect', requireAuth, superOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await mqttClient.reloadTenant(id);
    res.json({ status: mqttClient.getStatus(id) });
  } catch (e) { bad(res, e); }
});

// Delete a client (super admin). Disconnects its MQTT, removes its stored readings. Tenant 1 is protected.
router.delete('/tenants/:id', requireAuth, superOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await tenants.remove(id);
    try { await mqttClient.reloadTenant(id); } catch (e) { /* connection already closed */ }
    res.json({ message: `Deleted ${row.name}` });
  } catch (e) { bad(res, e); }
});

router.get('/tenants/:id/status', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!(await tenants.canAccess(req.user, id))) return res.status(403).json({ error: 'No access to this client' });
  res.json({ status: mqttClient.getStatus(id) });
});

module.exports = router;
