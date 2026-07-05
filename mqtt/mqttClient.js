const mqtt = require("mqtt");
const { handleIncoming } = require("../services/plcParser");

let client = null;
let simulationInterval = null;
let isSimulationMode = false;

function initMqtt() {
  const url = process.env.MQTT_BROKER || process.env.MQTT_URL || "mqtt://localhost:1883";
  // "RO5" — letter O, not zero. Confirmed from the A-Box gateway's own
  // topic convention (e.g. "RO5/FEEDFlow"). The old default here was
  // "R05" (zero), which would silently subscribe to the wrong topic
  // even on a successful connection.
  const root = process.env.MQTT_TOPIC_ROOT || "RO5";

  // Simulation is opt-in ONLY now. It used to auto-activate on any
  // connection error, which is exactly what was masking real connection
  // failures as if everything were working.
  if (url === "SIMULATION" || process.env.MQTT_SIMULATION === "true") {
    console.log("[mqtt] 🎮 Simulation mode forced via config");
    startSimulation();
    return;
  }

  console.log(`[mqtt] connecting to ${url}, topic root "${root}"...`);

  try {
    client = mqtt.connect(url, {
      clientId: process.env.MQTT_CLIENT_ID || `water-mgmt-${Math.random().toString(16).slice(2)}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      clean: true,
      connectTimeout: 10000,
      keepalive: 30,
      reconnectPeriod: 2000, // single source of truth — let mqtt.js retry on its own
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

    client.on("offline", () => {
      console.warn("[mqtt] offline — broker unreachable, will keep retrying automatically");
    });

    client.on("close", () => {
      console.log("[mqtt] connection closed");
    });

    // Full error object, not just .message — some connection failures
    // (bad URL, DNS issues, broker rejecting the CONNECT packet) carry
    // no .message at all and were producing blank-looking error lines.
    client.on("error", (err) => {
      console.error("[mqtt] error:");
      console.error(err);
    });

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

function startSimulation() {
  if (isSimulationMode) return;
  isSimulationMode = true; // was `false` before — broke the status flag and this exact guard
  console.log("[mqtt] 🎮 Starting simulation mode (explicit only — won't auto-trigger from a connection failure)");

  generateSimulatedData();
  simulationInterval = setInterval(generateSimulatedData, 3000);
}

function generateSimulatedData() {
  const timestamp = new Date().toISOString();

  // This array was commented out before while the code below still
  // referenced it — that threw "simulatedTopics is not defined" the
  // instant simulation mode started.
  const simulatedTopics = [
    { topic: "RO5/FEEDFlow", value: 100 + (Math.random() - 0.5) * 10 },
    { topic: "RO5/Permeateflow", value: 75 + (Math.random() - 0.5) * 5 },
    { topic: "RO5/ConcentrateFlow", value: 25 + (Math.random() - 0.5) * 3 },
    { topic: "RO5/ROPressure", value: 15.5 + (Math.random() - 0.5) * 1.5 },
    { topic: "RO5/InterstagePress", value: 12 + (Math.random() - 0.5) * 0.8 },
    { topic: "RO5/ConcentratePress", value: 14 + (Math.random() - 0.5) * 1 },
    { topic: "RO5/Stage1Delta", value: 3.5 + (Math.random() - 0.5) * 0.3 },
    { topic: "RO5/Stage2Delta", value: 2.8 + (Math.random() - 0.5) * 0.3 },
    { topic: "RO5/MediaFilterInPress", value: 4.2 + (Math.random() - 0.5) * 0.4 },
    { topic: "RO5/MediaFilterOutPress", value: 3.8 + (Math.random() - 0.5) * 0.3 },
    { topic: "RO5/SystemRecovery", value: 78.6 + (Math.random() - 0.5) * 2 },
    { topic: "RO5/PureWaterEC", value: 120 + (Math.random() - 0.5) * 15 },
  ];

  console.log(`[simulation] 📊 generating ${simulatedTopics.length} parameters`);

  simulatedTopics.forEach(({ topic, value }) => {
    const payload = JSON.stringify({
      value: parseFloat(value.toFixed(1)),
      timestamp,
      simulated: true,
    });
    try {
      handleIncoming(topic, payload);
    } catch (err) {
      console.error("[simulation] handler error:", err.message);
    }
  });
}

function stopSimulation() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  isSimulationMode = false;
  console.log("[mqtt] Simulation mode stopped");
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
    connected: !isSimulationMode && !!(client && client.connected),
    simulationMode: isSimulationMode,
    broker: isSimulationMode ? "SIMULATION" : (process.env.MQTT_BROKER || process.env.MQTT_URL || "mqtt://localhost:1883"),
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

module.exports = { initMqtt, publish, getStatus, stopSimulation, isSimulationMode: () => isSimulationMode };