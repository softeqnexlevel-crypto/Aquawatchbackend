const { getLatestSnapshot, getLatestFull } = require("../services/plcParser");
const { getAlarms } = require("../services/alarmService");
const { publish, getStatus } = require("../mqtt/mqttClient");

exports.current = (_req, res) => res.json(getLatestSnapshot());

exports.status = (_req, res) => {
  const full = getLatestFull();
  const now = Date.now();
  const out = {};
  for (const [param, rec] of Object.entries(full)) {
    const ageMs = now - new Date(rec.timestamp).getTime();
    out[param] = { 
      online: ageMs < 30_000, 
      lastUpdate: rec.timestamp, 
      value: rec.value,
      simulated: rec.simulated || false
    };
  }
  res.json(out);
};

exports.alarms = (_req, res) => res.json(getAlarms());

exports.publish = (req, res) => {
  const { topic, value } = req.body || {};
  if (!topic || value === undefined) {
    return res.status(400).json({ error: "topic and value required" });
  }
  try { 
    publish(topic, value); 
    res.json({ ok: true }); 
  } catch (err) { 
    res.status(503).json({ error: err.message }); 
  }
};

// New endpoint for MQTT connection status
exports.mqttStatus = (_req, res) => {
  try {
    const status = getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};