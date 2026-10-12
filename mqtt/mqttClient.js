const mqtt = require("mqtt");

const { handleIncoming } = require("../services/plcParser");

let client = null;
let watchdogTimer = null;
let lastMessageAt = 0;
let lastForcedReconnectAt = 0;
let stopping = false;

// ABox publishes about once a minute. If nothing arrives for this long,
// assume the broker connection is stuck and rebuild it.
const STALE_MS = Number(process.env.MQTT_STALE_MS) || 180000; // 3 minutes
const CHECK_EVERY_MS = 30000;

function getConfig() {
  return {
    url: process.env.MQTT_BROKER || process.env.MQTT_URL || "mqtt://broker.emqx.io:1883",
    root: process.env.MQTT_TOPIC_ROOT || "RO5",
  };
}

function connectClient() {
  const { url, root } = getConfig();

  console.log(`[mqtt] connecting to ${url}, topic root "${root}"...`);

  try {
    client = mqtt.connect(url, {
      clientId: `RO5-${Date.now()}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      clean: true,
      connectTimeout: 10000,
      keepalive: 30,
      reconnectPeriod: 2000,
    });

    client.on("connect", () => {
      console.log(`[mqtt] ✅ connected to ${url}`);
      // Give the watchdog a fresh start after every (re)connect
      lastMessageAt = Date.now();

      const wildcard = `${root}/#`;
      client.subscribe(wildcard, { qos: 1 }, (err) => {
        if (err) console.error("[mqtt] subscribe error:", err.message);
        else console.log(`[mqtt] 📡 subscribed to ${wildcard}`);
      });
    });

    client.on("reconnect", () => console.log("[mqtt] reconnecting..."));
    client.on("offline", () => console.warn("[mqtt] offline — broker unreachable, will keep retrying automatically"));
    client.on("close", () => console.log("[mqtt] connection closed"));
    client.on("error", (err) => console.error("[mqtt] error:", err));

    client.on("message", (topic, payload) => {
      lastMessageAt = Date.now();
      console.log(`[mqtt] message on ${topic} (${payload.length} bytes)`);

      try {
        handleIncoming(topic, payload.toString());
      } catch (err) {
        console.error("[mqtt] handler error:", err.message);
      }
    });
  } catch (error) {
    console.error("[mqtt] Failed to create MQTT client:", error.message);
  }
}

// Tear down the current client and build a brand new connection
function forceReconnect(reason) {
  const now = Date.now();
  // Don't hammer the broker: at most one forced rebuild per STALE_MS
  if (now - lastForcedReconnectAt < STALE_MS) return;
  lastForcedReconnectAt = now;

  console.warn(`[mqtt] ⚠️ watchdog: ${reason} — rebuilding broker connection`);

  const old = client;
  client = null;

  const rebuild = () => {
    if (!stopping) connectClient();
  };

  if (old) {
    try {
      old.removeAllListeners();
      old.on("error", () => {}); // swallow late errors from the dead client
      old.end(true, {}, rebuild); // force close, then rebuild
      // Safety net in case the end callback never fires
      setTimeout(() => {
        if (!client) rebuild();
      }, 3000);
    } catch (err) {
      console.error("[mqtt] error closing old client:", err.message);
      rebuild();
    }
  } else {
    rebuild();
  }
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);

  watchdogTimer = setInterval(() => {
    if (!lastMessageAt) return;
    const silentFor = Date.now() - lastMessageAt;

    if (silentFor > STALE_MS) {
      forceReconnect(`no MQTT message for ${Math.round(silentFor / 1000)}s`);
    }
  }, CHECK_EVERY_MS);

  // Don't keep the process alive just for this timer
  if (watchdogTimer.unref) watchdogTimer.unref();
}

function initMqtt() {
  stopping = false;
  lastMessageAt = Date.now();
  connectClient();
  startWatchdog();
}

function closeMqtt() {
  stopping = true;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (client) {
    try {
      client.end(true);
    } catch (err) {
      console.error("[mqtt] error closing client:", err.message);
    }
    client = null;
  }
  console.log("[mqtt] closed for shutdown");
}

function publish(topic, value) {
  try {
    const payload = typeof value === "object" ? JSON.stringify(value) : String(value);
    handleIncoming(topic, payload);
    console.log(`[mqtt] 📤 Published to ${topic}`);
  } catch (err) {
    console.error("[mqtt] Publish error:", err.message);
    throw err;
  }
}

function getStatus() {
  return {
    connected: !!(client && client.connected),
    simulationMode: false,
    broker: process.env.MQTT_BROKER || process.env.MQTT_URL || "mqtt://localhost:1883",
    topicRoot: process.env.MQTT_TOPIC_ROOT || "RO5",
    dataPoints: getDataPointCount(),
    lastMessageAt: lastMessageAt || null,
    secondsSinceLastMessage: lastMessageAt ? Math.round((Date.now() - lastMessageAt) / 1000) : null,
  };
}

function getDataPointCount() {
  try {
    const { getLatestFull } = require("../services/plcParser");
    return Object.keys(getLatestFull()).length;
  } catch (err) {
    return 0;
  }
}

module.exports = { initMqtt, publish, getStatus };