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

// ==================== FIXED CORS ====================
const allowedOrigins = [
    'https://aquawatch-flax-nine.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:3001'
];

const corsOptions = {
    origin: (origin, callback) => {
        // Handle server-to-server or curl requests (origin is undefined)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS] Rejected origin block: ${origin}`);
            // ✅ FIX: Pass 'false' instead of an Error object. 
            // Passing an Error crashes the preflight options pipeline, resulting in "Failed to fetch".
            callback(null, false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

// Apply CORS options globally
app.use(cors(corsOptions));
// Automatically handle preflight OPTIONS requests across all routes
app.options('*', cors(corsOptions));
// ===================================================
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