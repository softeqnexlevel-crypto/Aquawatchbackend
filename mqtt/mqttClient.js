// backend/mqtt/mqttClient.js — one MQTT connection per tenant.
// Tenant 1 (the original plant) works exactly as before: broker/login from the environment
// unless a broker is saved for it on the website. Other tenants use the broker saved for them
// on the website (or the shared platform broker with their own topic root when none is set).
const mqtt = require("mqtt");
const { handleIncoming } = require("../services/plcParser");
const tenants = require("../services/tenants.service");

const DEFAULT_TENANT_ID = tenants.DEFAULT_TENANT_ID;

// ABox publishes about once a minute. If nothing arrives for this long,
// assume the broker connection is stuck and rebuild it.
const STALE_MS = Number(process.env.MQTT_STALE_MS) || 180000; // 3 minutes
const CHECK_EVERY_MS = 30000;

const conns = new Map();   // tenantId -> { client, cfg, lastMessageAt, lastForcedAt }
let watchdogTimer = null;
let stopping = false;

function envConfig() {
  return {
    url: process.env.MQTT_BROKER || process.env.MQTT_URL || "mqtt://broker.emqx.io:1883",
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    root: process.env.MQTT_TOPIC_ROOT || "RO5",
  };
}

/** Connection settings for one tenant row. */
function configFor(row) {
  const env = envConfig();
  const own = !!row.mqtt_url;
  const isDefault = Number(row.id) === DEFAULT_TENANT_ID;
  return {
    id: Number(row.id),
    name: row.name,
    url: row.mqtt_url || env.url,
    username: own ? (row.mqtt_username || undefined) : env.username,
    password: own ? (tenants.decrypt(row.mqtt_password_enc) || undefined) : env.password,
    root: row.topic_root || (isDefault ? env.root : `tenants/${row.slug}`),
    shared: !own,
  };
}

function connectTenant(cfg) {
  const c = { client: null, cfg, lastMessageAt: Date.now(), lastForcedAt: 0 };
  conns.set(cfg.id, c);
  console.log(`[mqtt][${cfg.name}] connecting to ${cfg.url}, topic root "${cfg.root}"...`);
  try {
    const client = mqtt.connect(cfg.url, {
      clientId: `RO5-t${cfg.id}-${Date.now()}`,
      username: cfg.username,
      password: cfg.password,
      clean: true,
      connectTimeout: 10000,
      keepalive: 30,
      reconnectPeriod: 2000,
    });
    c.client = client;

    client.on("connect", () => {
      console.log(`[mqtt][${cfg.name}] ✅ connected to ${cfg.url}`);
      c.lastMessageAt = Date.now();
      const wildcard = `${cfg.root}/#`;
      client.subscribe(wildcard, { qos: 1 }, (err) => {
        if (err) console.error(`[mqtt][${cfg.name}] subscribe error:`, err.message);
        else console.log(`[mqtt][${cfg.name}] 📡 subscribed to ${wildcard}`);
      });
    });
    client.on("reconnect", () => console.log(`[mqtt][${cfg.name}] reconnecting...`));
    client.on("offline", () => console.warn(`[mqtt][${cfg.name}] offline — broker unreachable, will keep retrying automatically`));
    client.on("close", () => console.log(`[mqtt][${cfg.name}] connection closed`));
    client.on("error", (err) => console.error(`[mqtt][${cfg.name}] error:`, err && err.message ? err.message : err));
    client.on("message", (topic, payload) => {
      c.lastMessageAt = Date.now();
      console.log(`[mqtt][${cfg.name}] message on ${topic} (${payload.length} bytes)`);
      try { handleIncoming(topic, payload.toString(), cfg.id); }
      catch (err) { console.error(`[mqtt][${cfg.name}] handler error:`, err.message); }
    });
  } catch (error) {
    console.error(`[mqtt][${cfg.name}] Failed to create MQTT client:`, error.message);
  }
}

function endTenant(id) {
  const c = conns.get(id);
  if (!c) return;
  conns.delete(id);
  if (c.client) {
    try { c.client.removeAllListeners(); c.client.on("error", () => {}); c.client.end(true); }
    catch (err) { console.error("[mqtt] error closing client:", err.message); }
  }
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    for (const [id, c] of conns) {
      const silentFor = Date.now() - c.lastMessageAt;
      if (silentFor > STALE_MS && Date.now() - c.lastForcedAt >= STALE_MS) {
        console.warn(`[mqtt][${c.cfg.name}] ⚠️ watchdog: no MQTT message for ${Math.round(silentFor / 1000)}s — rebuilding broker connection`);
        try { await reloadTenant(id, true); const n = conns.get(id); if (n) n.lastForcedAt = Date.now(); }
        catch (e) { console.error("[mqtt] watchdog reload failed:", e.message); }
      }
    }
  }, CHECK_EVERY_MS);
  if (watchdogTimer.unref) watchdogTimer.unref();
}

/** Start a connection for every tenant. A tenant that fails does not stop the others. */
async function initMqtt() {
  stopping = false;
  let rows = [];
  try { rows = await tenants.listAll(); }
  catch (e) {
    // database not ready: still connect the original plant from the environment
    console.error("[mqtt] could not load tenants, starting tenant 1 from the environment:", e.message);
    rows = [{ id: DEFAULT_TENANT_ID, name: "Aqua System Tech", slug: "aqua-system-tech" }];
  }
  if (!rows.some((r) => Number(r.id) === DEFAULT_TENANT_ID)) rows.unshift({ id: DEFAULT_TENANT_ID, name: "Aqua System Tech", slug: "aqua-system-tech" });
  for (const row of rows) {
    try { connectTenant(configFor(row)); } catch (e) { console.error(`[mqtt] tenant ${row.id} failed:`, e.message); }
  }
  startWatchdog();
}

/** Re-read one tenant's saved settings and reconnect it (used by "Save & Connect"). */
async function reloadTenant(id) {
  id = Number(id);
  endTenant(id);
  if (stopping) return;
  const row = await tenants.getRow(id);
  if (!row) return;
  connectTenant(configFor(row));
}

function closeMqtt() {
  stopping = true;
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  for (const id of [...conns.keys()]) endTenant(id);
  console.log("[mqtt] closed for shutdown");
}

// Used by the API's "publish" (staff only): feeds a value into the original plant's pipeline.
function publish(topic, value) {
  try {
    const payload = typeof value === "object" ? JSON.stringify(value) : String(value);
    handleIncoming(topic, payload, DEFAULT_TENANT_ID);
    console.log(`[mqtt] 📤 Published to ${topic}`);
  } catch (err) {
    console.error("[mqtt] Publish error:", err.message);
    throw err;
  }
}

function getStatus(tenantId = DEFAULT_TENANT_ID) {
  tenantId = Number(tenantId) || DEFAULT_TENANT_ID;
  const c = conns.get(tenantId);
  const env = envConfig();
  const cfg = c ? c.cfg : null;
  let host = "";
  try { host = new URL(cfg ? cfg.url : env.url).host; } catch (_) { /* hide anything unparsable */ }
  return {
    tenantId,
    connected: !!(c && c.client && c.client.connected),
    simulationMode: false,
    broker: cfg ? cfg.url.replace(/\/\/[^@/]*@/, "//") : env.url,   // never show embedded credentials
    brokerHost: host,
    shared: cfg ? cfg.shared : true,
    topicRoot: cfg ? cfg.root : env.root,
    dataPoints: getDataPointCount(tenantId),
    lastMessageAt: c && c.lastMessageAt ? c.lastMessageAt : null,
    secondsSinceLastMessage: c && c.lastMessageAt ? Math.round((Date.now() - c.lastMessageAt) / 1000) : null,
  };
}

function getDataPointCount(tenantId) {
  try {
    const { getLatestFull } = require("../services/plcParser");
    return Object.keys(getLatestFull(tenantId)).length;
  } catch (err) {
    return 0;
  }
}

function activeTenantIds() { return [...conns.keys()]; }

module.exports = { initMqtt, publish, getStatus, closeMqtt, reloadTenant, activeTenantIds };
