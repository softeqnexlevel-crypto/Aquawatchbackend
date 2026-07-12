const express = require("express");
const ctrl = require("../controllers/deviceController");
const authRoutes = require("./auth.routes");
const productionRoutes = require("./production.routes"); // ✅ ADDED
const settingsRoutes = require("./settings.routes"); // ✅ ADDED

const router = express.Router();

// ✅ FIX: Remove '/api' prefix - router is already under /api
router.use("/auth", authRoutes);
router.use("/", productionRoutes); // ✅ ADDED — exposes GET /api/production-summary
router.use("/", settingsRoutes);   // ✅ ADDED — exposes GET/PUT /api/settings

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