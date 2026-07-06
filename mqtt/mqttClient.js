const mqtt = require("mqtt");
const { handleIncoming } = require("../services/plcParser");

let client = null;

function initMqtt() {
  const url = process.env.MQTT_BROKER || process.env.MQTT_URL || "mqtt://broker.emqx.io:1883";
  const root = process.env.MQTT_TOPIC_ROOT || "RO5";

  console.log(`[mqtt] connecting to ${url}, topic root "${root}"...`);

  try {
    client = mqtt.connect(url, {
      clientId: process.env.MQTT_CLIENT_ID || `water-mgmt-${Math.random().toString(16).slice(2)}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      clean: true,
      connectTimeout: 10000,
      keepalive: 30,
      reconnectPeriod: 2000,
    });

    client.on("connect", () => {
      console.log(`[mqtt] ✅ connected to ${url}`);
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