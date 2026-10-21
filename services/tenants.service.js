// backend/services/tenants.service.js
// Tenants (clients): their own MQTT connection, settings, systems and users.
// Tenant 1 is the original plant ("Aqua System Tech"). It keeps using the existing tables,
// so nothing that already works changes. Every other tenant stores its readings in
// `tenant_measurements`, so its data can never mix with tenant 1's.
'use strict';

const crypto = require('crypto');
const db = require('../database/postgres');

const DEFAULT_TENANT_ID = 1;
const DEFAULT_PAGES = [
  'dashboard', 'mimic', 'tank level', 'production', 'antiscalant', 'filtration',
  'system recovery', 'maintenance', 'analytics', 'reports', 'alerts',
];
const DEFAULT_CONFIG = {
  productionTarget: 1100, recoveryTarget: 70, feedTankCapacity: 300, flushTankCapacity: 2,
  pages: DEFAULT_PAGES,
  systems: [{ type: 'Reverse Osmosis', name: 'Reverse Osmosis', chemicals: ['Antiscalant'] }],
};

let ready = null;
const pool = () => db.getPool();

async function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    const p = pool();
    await p.query(`CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      mqtt_url TEXT,
      mqtt_username TEXT,
      mqtt_password_enc TEXT,
      topic_root TEXT,
      command_topic TEXT,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // older versions of this table (name + slug only) get the new columns
    for (const col of ['mqtt_url TEXT', 'mqtt_username TEXT', 'mqtt_password_enc TEXT', 'topic_root TEXT', 'command_topic TEXT', "config JSONB NOT NULL DEFAULT '{}'::jsonb"]) {
      await p.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await p.query(`CREATE TABLE IF NOT EXISTS user_tenants (
      user_id UUID NOT NULL, tenant_id INTEGER NOT NULL, PRIMARY KEY (user_id, tenant_id))`);
    await p.query(`CREATE TABLE IF NOT EXISTS tenant_measurements (
      tenant_id INTEGER NOT NULL, time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      parameter TEXT NOT NULL, value DOUBLE PRECISION NOT NULL, unit TEXT)`);
    await p.query(`CREATE INDEX IF NOT EXISTS tenant_measurements_idx ON tenant_measurements (tenant_id, parameter, time DESC)`);
    const c = await p.query('SELECT COUNT(*)::int AS n FROM tenants');
    if (c.rows[0].n === 0) {
      await p.query(`INSERT INTO tenants (id, name, slug, config) VALUES (1, 'Aqua System Tech', 'aqua-system-tech', $1::jsonb)`, [JSON.stringify(DEFAULT_CONFIG)]);
      await p.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), GREATEST(1, (SELECT MAX(id) FROM tenants)))`);
    }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

/* ---------- password encryption (AES-256-GCM) ---------- */
function secretKey() {
  const s = process.env.TENANT_SECRET || process.env.PASETO_SECRET || process.env.JWT_SECRET || process.env.DATABASE_URL || 'aquasystemtech-tenant-secret';
  return crypto.scryptSync(String(s), 'tenant-mqtt-password', 32);
}
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}
function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split(':').map((h) => Buffer.from(h, 'hex'));
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/* ---------- shaping ---------- */
function mergeConfig(c) {
  const cfg = { ...DEFAULT_CONFIG, ...(c || {}) };
  if (!Array.isArray(cfg.pages)) cfg.pages = DEFAULT_PAGES;
  if (!Array.isArray(cfg.systems)) cfg.systems = DEFAULT_CONFIG.systems;
  if (!cfg.tagMap || typeof cfg.tagMap !== 'object' || Array.isArray(cfg.tagMap)) cfg.tagMap = {};
  return cfg;
}
// Safe for the browser: never includes the MQTT password.
function publicTenant(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, slug: r.slug,
    mqtt: { url: r.mqtt_url || '', username: r.mqtt_username || '', hasPassword: !!r.mqtt_password_enc, topicRoot: r.topic_root || '', commandTopic: r.command_topic || '' },
    config: mergeConfig(r.config),
    createdAt: r.created_at,
  };
}

async function listAll() { await ensureTables(); return (await pool().query('SELECT * FROM tenants ORDER BY id')).rows; }
async function getRow(id) { await ensureTables(); return (await pool().query('SELECT * FROM tenants WHERE id = $1', [id])).rows[0] || null; }

/** Ids this user may open. Super admins: all. Everyone else: their assigned ones, or just tenant 1 if none are assigned. */
async function tenantIdsForUser(user) {
  await ensureTables();
  if (user && user.isSuperAdmin) return (await pool().query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
  const raw = await pool().query('SELECT tenant_id FROM user_tenants WHERE user_id = $1', [user.id]);
  if (!raw.rows.length) return [DEFAULT_TENANT_ID];
  // only clients that still exist (a login whose only client was deleted sees nothing)
  const live = await pool().query('SELECT id FROM tenants WHERE id = ANY($1::int[])', [raw.rows.map((x) => x.tenant_id)]);
  return live.rows.map((x) => x.id);
}
/** The client a user lands on when none is chosen: tenant 1 if they may open it, else their lowest allowed id. null = none left. */
async function defaultTenantFor(user) {
  const ids = (await tenantIdsForUser(user)).map(Number).sort((a, b) => a - b);
  if (!ids.length) return null;
  return ids.includes(DEFAULT_TENANT_ID) ? DEFAULT_TENANT_ID : ids[0];
}
async function canAccess(user, tenantId) {
  if (!user) return false;
  return (await tenantIdsForUser(user)).includes(Number(tenantId));
}
async function setUserTenants(userId, tenantIds) {
  await ensureTables();
  await pool().query('DELETE FROM user_tenants WHERE user_id = $1', [userId]);
  for (const t of tenantIds) await pool().query('INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, Number(t)]);
}
/** User ids that belong to a tenant (tenant 1 also owns every user with no assignment). */
async function userIdsOfTenant(tenantId) {
  await ensureTables();
  const assigned = (await pool().query('SELECT user_id FROM user_tenants WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.user_id);
  if (Number(tenantId) !== DEFAULT_TENANT_ID) return { only: assigned };
  const anyAssigned = (await pool().query('SELECT DISTINCT user_id FROM user_tenants')).rows.map((r) => r.user_id);
  return { only: assigned, unassignedAlso: true, assignedAnywhere: anyAssigned };
}

/* ---------- create / update ---------- */
function cleanMqtt(m = {}) {
  const url = String(m.url || '').trim();
  if (url && !/^(mqtt|mqtts|ws|wss|tcp|ssl):\/\//i.test(url)) throw new Error('Broker URL must start with mqtt://, mqtts://, ws:// or wss://');
  return {
    url, username: String(m.username || '').trim(), password: m.password === undefined ? undefined : String(m.password),
    topicRoot: String(m.topicRoot || '').trim().replace(/^\/+|\/+$|#$/g, ''), commandTopic: String(m.commandTopic || '').trim(),
  };
}
function cleanConfig(c = {}, prev = {}) {
  const out = { ...prev };
  const num = (v, min, max, label) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be a number between ${min} and ${max}`); return n; };
  if (c.productionTarget !== undefined && c.productionTarget !== '') out.productionTarget = num(c.productionTarget, 0, 1e6, 'Production target');
  if (c.recoveryTarget !== undefined && c.recoveryTarget !== '') out.recoveryTarget = num(c.recoveryTarget, 0, 100, 'Recovery target');
  if (c.feedTankCapacity !== undefined && c.feedTankCapacity !== '') out.feedTankCapacity = num(c.feedTankCapacity, 0.001, 1e6, 'Feed tank capacity');
  if (c.flushTankCapacity !== undefined && c.flushTankCapacity !== '') out.flushTankCapacity = num(c.flushTankCapacity, 0.001, 1e6, 'Flush tank capacity');
  if (Array.isArray(c.pages)) out.pages = c.pages.map(String).filter((p) => DEFAULT_PAGES.includes(p) || ['tag manager', 'billing', 'settings', 'user-management'].includes(p));
  if (c.tagMap !== undefined) {
    // { standard tag name: this client's own tag name }. Empty value = not renamed.
    if (!c.tagMap || typeof c.tagMap !== 'object' || Array.isArray(c.tagMap)) throw new Error('Tag names must be an object');
    const map = {}; const used = new Map();
    for (const [std, mine] of Object.entries(c.tagMap)) {
      const k = String(std).trim(); const v = String(mine == null ? '' : mine).trim();
      if (!k || !v) continue;
      if (!/^[A-Za-z0-9_.%\- ]{1,100}$/.test(k) || v.length > 100) throw new Error(`Invalid tag name: ${k}`);
      if (used.has(v)) throw new Error(`"${v}" is used for both ${used.get(v)} and ${k}. One client tag can only mean one thing.`);
      used.set(v, k); map[k] = v;
    }
    out.tagMap = map;
  }
  if (Array.isArray(c.systems)) {
    out.systems = c.systems.slice(0, 20).map((s) => ({
      type: String(s.type || '').slice(0, 60), name: String(s.name || s.type || '').slice(0, 80),
      chemicals: Array.isArray(s.chemicals) ? s.chemicals.map((x) => String(x).slice(0, 40)).slice(0, 20) : [],
    })).filter((s) => s.type);
  }
  return out;
}

async function create({ name, mqtt, config }, userId) {
  await ensureTables();
  name = String(name || '').trim();
  if (!name || name.length > 100) throw new Error('Tenant name is required (max 100 characters)');
  const slug = slugify(name);
  if (!slug) throw new Error('Tenant name must contain letters or numbers');
  const m = cleanMqtt(mqtt);
  const cfg = cleanConfig(config || {}, { ...DEFAULT_CONFIG });
  const r = await pool().query(
    `INSERT INTO tenants (name, slug, mqtt_url, mqtt_username, mqtt_password_enc, topic_root, command_topic, config, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (slug) DO NOTHING RETURNING *`,
    [name, slug, m.url || null, m.username || null, encrypt(m.password), m.topicRoot || null, m.commandTopic || null, JSON.stringify(cfg), userId || null]);
  if (!r.rows.length) throw new Error('A tenant with that name already exists');
  return r.rows[0];
}

/** `patch`: { name?, mqtt?, config? } — mqtt.password undefined/'' keeps the saved password. */
async function update(id, patch) {
  const cur = await getRow(id);
  if (!cur) throw new Error('Tenant not found');
  const sets = []; const vals = [];
  const add = (col, v, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n || n.length > 100) throw new Error('Tenant name is required (max 100 characters)');
    add('name', n);
  }
  if (patch.mqtt) {
    const m = cleanMqtt(patch.mqtt);
    add('mqtt_url', m.url || null); add('mqtt_username', m.username || null);
    add('topic_root', m.topicRoot || null); add('command_topic', m.commandTopic || null);
    if (m.password) add('mqtt_password_enc', encrypt(m.password));
  }
  if (patch.config) add('config', JSON.stringify(cleanConfig(patch.config, mergeConfig(cur.config))), '::jsonb');
  if (!sets.length) return cur;
  vals.push(id);
  const row = (await pool().query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
  if (patch.config) await refreshTagMaps();
  return row;
}

/* ---------- per-client tag names ----------
   Each client may call its tags something else (e.g. "Feed_Pr" instead of "RO5-ROPressure"). The editor on the
   Dashboard saves { standard name: client name } in the client's config; incoming readings are renamed to the
   standard name here, so storage, live data, charts and the apps all see one set of names. */
const tagMapCache = new Map();   // tenantId -> { clientName: standardName }
async function refreshTagMaps() {
  try {
    await ensureTables();
    const rows = (await pool().query('SELECT id, config FROM tenants')).rows;
    tagMapCache.clear();
    for (const r of rows) {
      const m = (r.config && r.config.tagMap) || {};
      const inv = {};
      for (const [std, mine] of Object.entries(m)) if (mine) inv[String(mine)] = std;
      if (Object.keys(inv).length) tagMapCache.set(Number(r.id), inv);
    }
  } catch (e) { console.error('[tenants] tag map refresh', e.message); }
}
/** sync: { clientName: standardName } for one client ({} when none) */
function tagMapFor(id) { return tagMapCache.get(Number(id)) || {}; }

/** Delete a client and its stored readings. The original plant (1) can never be deleted. */
async function remove(id) {
  id = Number(id);
  if (id === DEFAULT_TENANT_ID) throw new Error('The main plant cannot be deleted');
  const cur = await getRow(id);
  if (!cur) throw new Error('Client not found');
  await pool().query('DELETE FROM tenant_measurements WHERE tenant_id = $1', [id]);
  // logins that also belong to another client just lose this one; logins that only had this client keep an
  // orphan row, so they end up with no access at all (never falling back to the main plant)
  await pool().query(`DELETE FROM user_tenants WHERE tenant_id = $1 AND user_id IN
    (SELECT user_id FROM user_tenants GROUP BY user_id HAVING COUNT(*) > 1)`, [id]);
  await pool().query('DELETE FROM tenants WHERE id = $1', [id]);
  return cur;
}

/* ---------- measurements of tenants other than 1 ---------- */
async function saveMeasurement(tenantId, m) {
  let v = m.value;
  if (v === 'ON') v = 1; else if (v === 'OFF') v = 0;
  v = Number(v);
  if (!Number.isFinite(v)) return;
  await ensureTables();
  await pool().query('INSERT INTO tenant_measurements (tenant_id, time, parameter, value, unit) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, m.timestamp ? new Date(m.timestamp) : new Date(), m.parameter, v, m.unit || null]);
}

// first load a little after start (the database is ready by then), then every 5 minutes
setTimeout(refreshTagMaps, 20 * 1000).unref();
setInterval(refreshTagMaps, 5 * 60 * 1000).unref();

module.exports = {
  DEFAULT_TENANT_ID, DEFAULT_PAGES, ensureTables, listAll, getRow, publicTenant, mergeConfig,
  tenantIdsForUser, defaultTenantFor, canAccess, tagMapFor, refreshTagMaps, setUserTenants, userIdsOfTenant, create, update, remove, saveMeasurement, decrypt,
};