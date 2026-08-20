const express = require("express");
const ctrl = require("../controllers/deviceController");
const authRoutes = require("./auth.routes");
const productionRoutes = require("./production.routes"); // ✅ ADDED
const settingsRoutes = require("./settings.routes"); // ✅ ADDED
<<<<<<< HEAD
const billingRoutes = require("./billing.routes"); // ✅ ADDED — exposes /api/billing/*
const aiRoutes = require("./ai"); // ✅ ADDED — exposes POST /api/ai/chat
=======
>>>>>>> 13fc14314d7a2e189775b38a074b46d2541c8462

const router = express.Router();

// ✅ FIX: Remove '/api' prefix - router is already under /api
router.use("/auth", authRoutes);
router.use("/", productionRoutes); // ✅ ADDED — exposes GET /api/production-summary
router.use("/", settingsRoutes);   // ✅ ADDED — exposes GET/PUT /api/settings
<<<<<<< HEAD
router.use("/billing", billingRoutes); // ✅ ADDED — exposes /api/billing/plans, /history, /subscribe/initialize, /webhook
router.use("/ai", aiRoutes); // ✅ ADDED — exposes POST /api/ai/chat
=======
>>>>>>> 13fc14314d7a2e189775b38a074b46d2541c8462

router.get("/health", (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

router.get("/current", ctrl.current);
router.get("/status", ctrl.status);
router.get("/alarms", ctrl.alarms);
router.get("/mqtt-status", ctrl.mqttStatus);
router.post("/publish", ctrl.publish);

module.exports = router;