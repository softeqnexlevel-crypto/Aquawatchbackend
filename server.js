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

// Simple readiness flag so routes can tell real auth/DB failures
// apart from "DB never connected" failures instead of both looking
// like a generic 401/500.
app.locals.dbReady = false;

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
  // ---- Database init ----
  // NOTE: previously this failure was swallowed and the server kept running
  // "without persistence," which meant every DB-backed route (including
  // login) would silently throw "Database not initialized" deep inside a
  // repository function. In auth.service/routes, that error was getting
  // caught by a generic catch block and turned into a 401, which looked
  // exactly like "wrong password" instead of "DB never connected."
  //
  // We still don't hard-crash the whole process here (MQTT/socket/API for
  // non-DB routes can still be useful even if DB is down), but we now:
  //   1. Log loudly and distinctly so it's impossible to miss in the console.
  //   2. Expose app.locals.dbReady so DB-dependent routes (like login) can
  //      return a clear 503 instead of a misleading 401 when DB is down.
  try {
    await initDb();
    app.locals.dbReady = true;
    console.log("[db] Database initialized successfully");

    // Must run after initDb() resolves, since initUsers() queries the
    // database. Calling this at module-require time would race against
    // initDb() and silently fail with "Database not initialized",
    // leaving the users table empty forever.
    await authService.initUsers();
  } catch (err) {
    app.locals.dbReady = false;
    console.error("========================================");
    console.error("[db] INIT FAILED — running WITHOUT persistence");
    console.error("[db] Reason:", err.message);
    console.error("[db] Login, alarms, history, and settings routes will not work.");
    console.error("[db] Check DATABASE_URL and DB_SSL in your .env file.");
    console.error("========================================");
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
    console.log(`[db] Ready: ${app.locals.dbReady ? '✅ yes' : '❌ NO — see errors above'}`);
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