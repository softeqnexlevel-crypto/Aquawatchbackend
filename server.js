/**
 * Water Management Backend
 * MQTT subscriber + REST API + Socket.IO + TimescaleDB persistence.
 */
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const { initMqtt, getStatus } = require("./mqtt/mqttClient");
const { initSocket, broadcastMqttStatus } = require("./services/socketService");
const { initDb } = require("./database/postgres");
const apiRoutes = require("./routes/api");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use("/api", apiRoutes);

// FIX: Express's built-in 404 page is HTML ("Cannot GET /api/...").
// Your frontend does `await response.json()` on every response, so an
// unmatched route was crashing the client with "Unexpected token '<'".
// This catches anything under /api that didn't match a real route and
// guarantees JSON back instead.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// FIX: global error handler — if any route handler throws (including inside
// async functions wrapped without try/catch), Express's default behavior
// is to render an HTML stack trace page. This ensures API consumers always
// get JSON, even on a 500.
app.use((err, req, res, next) => {
  console.error("[api error]", err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

(async () => {
  try {
    await initDb();
  } catch (err) {
    console.error("[db] init failed (continuing without persistence):", err.message);
  }

  initSocket(io);
  initMqtt();

  // Broadcast MQTT status every 10 seconds
  setInterval(() => {
    broadcastMqttStatus();
  }, 10000);

  const port = Number(process.env.PORT || 4000);
  server.listen(port, () => {
    console.log(`[http] listening on :${port}`);
    console.log(`[mqtt] Mode: ${getStatus().simulationMode ? '🎮 SIMULATION' : '📡 LIVE'}`);
  });
})();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[server] Shutting down gracefully...');
  server.close(() => {
    console.log('[server] Server closed');
    process.exit(0);
  });
});