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

const corsOptions = {
    origin: process.env.NODE_ENV === 'production'
        ? ['https://your-frontend-domain.com', 'https://aquawatch-flax-nine.vercel.app']
        : ['http://localhost:3000', 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    exposedHeaders: ['Content-Length', 'X-Request-Id']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use("/api", apiRoutes);

app.use("/api", (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});


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