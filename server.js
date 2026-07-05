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

// ==================== CORS CONFIGURATION ====================
const allowedOrigins = [
    'https://aquawatch-flax-nine.vercel.app',
    'https://aquawatch.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173'
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            // Allow all for testing (remove in production)
            callback(null, true);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'Accept',
        'X-Requested-With',
        'Origin',
        'Access-Control-Allow-Origin'
    ],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400 // 24 hours
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.headers.origin || 'unknown'}`);
    next();
});

// ==================== API ROUTES ====================
app.use("/api", apiRoutes);

// ==================== 404 HANDLER ====================
app.use("/api", (req, res) => {
    res.status(404).json({ 
        error: `Endpoint not found: ${req.method} ${req.originalUrl}`,
        timestamp: new Date().toISOString()
    });
});

// ==================== GLOBAL ERROR HANDLER ====================
app.use((err, req, res, next) => {
    console.error('[api error]', {
        message: err.message,
        stack: err.stack,
        path: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    res.status(err.status || 500).json({ 
        error: err.message || "Internal server error",
        timestamp: new Date().toISOString()
    });
});

// ==================== SOCKET.IO ====================
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket", "polling"]
});

// ==================== STARTUP ====================
(async () => {
    try {
        await initDb();
        console.log("[db] Database initialized successfully");
    } catch (err) {
        console.error("[db] Init failed (continuing without persistence):", err.message);
    }

    initSocket(io);
    console.log("[socket] Socket.IO initialized");

    initMqtt();
    console.log("[mqtt] MQTT client initialized");

    // Broadcast MQTT status every 10 seconds
    setInterval(() => {
        broadcastMqttStatus();
    }, 10000);

    const port = Number(process.env.PORT || 4000);
    const host = process.env.HOST || "0.0.0.0";
    
    server.listen(port, host, () => {
        console.log("\n========================================");
        console.log(`🚀 Server running on ${host}:${port}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
        console.log(`📡 Mode: ${getStatus().simulationMode ? '🎮 SIMULATION' : '📡 LIVE'}`);
        console.log("========================================");
        console.log(`📊 Health: http://localhost:${port}/api/health`);
        console.log(`🔐 Auth: http://localhost:${port}/api/auth/login`);
        console.log(`📡 MQTT Status: http://localhost:${port}/api/mqtt-status`);
        console.log("========================================");
        console.log("🌐 CORS enabled for:");
        allowedOrigins.forEach(origin => console.log(`   ${origin}`));
        console.log("========================================\n");
    });
})();

// ==================== GRACEFUL SHUTDOWN ====================
const shutdown = (signal) => {
    console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);
    
    server.close(() => {
        console.log("[server] HTTP server closed");
    });
    
    io.close(() => {
        console.log("[socket] Socket.IO closed");
    });
    
    try {
        const mqttClient = require("./mqtt/mqttClient");
        if (mqttClient.client) {
            mqttClient.client.end();
            console.log("[mqtt] MQTT client disconnected");
        }
    } catch (err) {
        console.error("[mqtt] Error disconnecting:", err.message);
    }
    
    setTimeout(() => {
        console.log("[server] Shutdown complete");
        process.exit(0);
    }, 2000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ==================== ERROR HANDLING ====================
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    // Don't exit in production, just log
    if (process.env.NODE_ENV !== 'production') {
        shutdown("uncaughtException");
    }
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[unhandledRejection]", reason);
    if (process.env.NODE_ENV !== 'production') {
        console.error("Unhandled rejection at:", promise);
        console.error("Reason:", reason);
    }
});