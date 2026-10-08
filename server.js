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
const {
  initSocket,
  broadcastMqttStatus,
} = require("./services/socketService");
const { initDb } = require("./database/postgres.js");
const apiRoutes = require("./routes/api");
const authService = require("./services/auth.service");

const app = express();

// ==================== CORS CONFIG ====================

const allowedOrigins = [
  "https://www.aquasystemtech.co.ke",
  "https://aquawatch-flax-nine.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:3001",
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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
  ],
  exposedHeaders: ["Content-Length", "X-Request-Id"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ==================== BODY PARSER ====================

app.use(express.json());

// ==================== DATABASE READINESS ====================

app.locals.dbReady = false;

// ==================== API ROUTES ====================

app.use("/api", apiRoutes);

// ==================== 404 HANDLER ====================

app.use((req, res) => {
  res.status(404).json({
    error: `Not found: ${req.method} ${req.originalUrl}`,
  });
});

// ==================== ERROR HANDLER ====================

app.use((err, req, res, next) => {
  console.error("[api error]", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
  });
});

// ==================== HTTP SERVER ====================

const server = http.createServer(app);

// ==================== SOCKET.IO ====================

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ==================== STARTUP ====================

(async () => {
  // --------------------------------------------------
  // DATABASE
  // --------------------------------------------------
  try {
    await initDb();
    app.locals.dbReady = true;
    console.log("[db] Database initialized successfully");

    // Seed/default users only after the database is ready.
    await authService.initUsers();
  } catch (err) {
    app.locals.dbReady = false;
    console.error("========================================");
    console.error("[db] INIT FAILED — running WITHOUT persistence");
    console.error("[db] Reason:", err.message);
    console.error(
      "[db] Login, alarms, history, and settings routes will not work."
    );
    console.error("[db] Check DATABASE_URL and DB_SSL in your .env file.");
    console.error("========================================");
  }

  // --------------------------------------------------
  // SOCKET.IO
  // --------------------------------------------------
  try {
    initSocket(io);
    console.log("[socket] Socket.IO initialized");

    setTimeout(() => {
      console.log("🔍 Socket clients:", io.sockets.sockets.size);
      console.log("🔍 Socket namespaces:", io.nsps);
    }, 2000);
  } catch (err) {
    console.error("[socket] init FAILED:", err);
  }

  // --------------------------------------------------
  // MQTT
  // --------------------------------------------------
  // The alert notifier is started inside plcService (triggered by the MQTT
  // pipeline) so it always has access to the live PLC tag store.
  // Do NOT start a second notifier here — that would double-send emails.
  try {
    initMqtt();
  } catch (err) {
    console.error("[mqtt] init FAILED:", err);
  }

  // --------------------------------------------------
  // MQTT STATUS BROADCAST
  // --------------------------------------------------
  setInterval(() => {
    try {
      broadcastMqttStatus();
    } catch (err) {
      console.error("[mqtt-status] broadcast error:", err.message);
    }
  }, 10000);

  // --------------------------------------------------
  // HTTP SERVER
  // --------------------------------------------------
  const port = Number(process.env.PORT || 4000);

  server.listen(port, () => {
    console.log(`[http] listening on :${port}`);
    console.log(
      `[mqtt] Mode: ${
        getStatus().simulationMode ? "🎮 SIMULATION" : "📡 LIVE"
      }`
    );
    console.log(
      `[db] Ready: ${
        app.locals.dbReady ? "✅ yes" : "❌ NO — see errors above"
      }`
    );
  });
})().catch((err) => {
  console.error("[startup] FATAL — server never started:", err);
});

// ==================== SERVER ERROR HANDLER ====================

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[http] Port ${process.env.PORT || 4000} is already in use.`
    );
    console.error(
      "[http] Stop the other backend process before starting this one."
    );
    return;
  }
  console.error("[http] Server error:", err);
});

// ==================== GRACEFUL SHUTDOWN ====================

function shutdown(signal) {
  console.log(
    `\n[server] ${signal} received — shutting down gracefully...`
  );
  server.close(() => {
    console.log("[server] Server closed");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));