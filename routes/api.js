const express = require("express");
const ctrl = require("../controllers/deviceController");
const authRoutes = require("./auth.routes");
const productionRoutes = require("./production.routes"); // ✅ ADDED
const settingsRoutes = require("./settings.routes"); // ✅ ADDED
const billingRoutes = require("./Billing.routes"); // ✅ ADDED — exposes /api/billing/*
const aiRoutes = require("./ai"); // ✅ ADDED — exposes POST /api/ai/chat
const { getAlertEvents, getPool } = require("../database/postgres");

const router = express.Router();

// ✅ FIX: Remove '/api' prefix - router is already under /api
router.use("/auth", authRoutes);
router.use("/", productionRoutes); // ✅ ADDED — exposes GET /api/production-summary
router.use("/", settingsRoutes);   // ✅ ADDED — exposes GET/PUT /api/settings
router.use("/billing", billingRoutes); // ✅ ADDED — exposes /api/billing/plans, /history, /subscribe/initialize, /webhook
router.use("/ai", aiRoutes); // ✅ ADDED — exposes POST /api/ai/chat

router.get("/health", (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

router.get("/current", ctrl.current); router.get("/alert-events", async (req, res) => {
  try {
    res.json(await getAlertEvents(Number(req.query.limit) || 500));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get("/history/:parameter", async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 1, 0.1), 24 * 30);
    const bucketSec = Math.max(10, Math.round((hours * 3600) / 300));
    const r = await getPool().query(
      `SELECT to_timestamp(floor(extract(epoch from time) / $3::int) * $3::int) AS t,
              AVG(value)::float AS value
       FROM measurements
       WHERE parameter = $1
         AND time > NOW() - ($2::float * INTERVAL '1 hour')
       GROUP BY 1
       ORDER BY 1`,
      [req.params.parameter, hours, bucketSec]
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[history]", err);
    res.status(500).json({ error: err.message });
  }
});
router.get("/status", ctrl.status);
router.get("/alarms", ctrl.alarms);
router.get("/mqtt-status", ctrl.mqttStatus);
router.post("/publish", ctrl.publish);

module.exports = router;