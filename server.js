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
const authService = require("./services/auth.service");

const app = express();

// ==================== CORS CONFIG ====================
const allowedOrigins = [
  'https://www.aquasystemtech.co.ke',
  'https://aquawatch-flax-nine.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:3001'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));   // Explicitly handle preflight
// ===================================================

app.use(express.json());
app.use("/api", apiRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: `Not found: ${req.method} ${req.originalUrl}`
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error("[api error]", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error"
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

(async () => {
  // ---- Database init (non-fatal if it fails) ----
  try {
    await initDb();
    console.log("[db] Database initialized successfully");

    // Must run after initDb() resolves, since initUsers() queries the
    // database. Calling this at module-require time would race against
    // initDb() and silently fail with "Database not initialized",
    // leaving the users table empty forever.
    await authService.initUsers();
  } catch (err) {
    console.error("[db] init failed (continuing without persistence):", err.message);
  }

  // ---- Socket.IO init (isolated so a failure here doesn't block server.listen) ----
  try {
    initSocket(io);
    setTimeout(() => {
      console.log('🔍 Socket clients:', io.sockets.sockets.size);
      console.log('🔍 Socket namespaces:', io.nsps);
    }, 2000);
  } catch (err) {
    console.error("[socket] init FAILED:", err);
  }

  // ---- MQTT init (isolated so a failure here doesn't block server.listen) ----
  try {
    initMqtt();
  } catch (err) {
    console.error("[mqtt] init FAILED:", err);
  }

  setInterval(() => {
    broadcastMqttStatus();
  }, 10000);

  const port = Number(process.env.PORT || 4000);
  server.listen(port, () => {
    console.log(`[http] listening on :${port}`);
    console.log(`[mqtt] Mode: ${getStatus().simulationMode ? '🎮 SIMULATION' : '📡 LIVE'}`);
  });
})().catch(err => {
  // Catches anything that slipped through the individual try/catch blocks
  // above (or errors thrown by code between them) so a startup failure is
  // always logged instead of dying as a silent unhandled rejection.
  console.error("[startup] FATAL — server never started:", err);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[server] Shutting down gracefully...');
  server.close(() => {
    console.log('[server] Server closed');
    process.exit(0);
  });
});