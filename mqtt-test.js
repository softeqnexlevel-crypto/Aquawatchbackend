/**
 * Standalone MQTT test script.
 * Run this with: node mqtt-test.js
 * (Run it from inside your backend folder so it can find node_modules/mqtt)
 *
 * This subscribes to the exact same broker + topic your server uses,
 * completely independent of your app code, and just prints whatever
 * arrives. If nothing prints after 30-60 seconds, the PLC/gateway is
 * not publishing to this broker/topic — that's a device-side issue,
 * not a backend bug.
 */
const mqtt = require("mqtt");

const BROKER_URL = "mqtt://broker.emqx.io:1883";
const TOPIC = "069107032F4002485/#";

console.log(`Connecting to ${BROKER_URL} ...`);
const client = mqtt.connect(BROKER_URL);

client.on("connect", () => {
  console.log("✅ Connected to broker");
  client.subscribe(TOPIC, (err) => {
    if (err) {
      console.error("❌ Subscribe failed:", err);
    } else {
      console.log(`📡 Subscribed to ${TOPIC} — waiting for messages...`);
    }
  });
});

client.on("message", (topic, payload) => {
  console.log(`\n📩 MESSAGE on [${topic}]`);
  console.log(payload.toString());
});

client.on("error", (err) => {
  console.error("❌ MQTT error:", err.message);
});

client.on("reconnect", () => {
  console.log("🔄 Reconnecting...");
});

client.on("close", () => {
  console.log("🔌 Connection closed");
});

// Print a heartbeat every 10s so you can see it's still alive and listening
setInterval(() => {
  console.log(`... still listening (${new Date().toLocaleTimeString()})`);
}, 10000);