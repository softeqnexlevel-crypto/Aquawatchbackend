// backend/routes/api.js
const express = require("express");
const ctrl = require("../controllers/deviceController");
const authRoutes = require("./auth.routes");
const productionRoutes = require("./production.routes");
const settingsRoutes = require("./settings.routes");
const billingRoutes = require("./Billing.routes"); // exposes /api/billing/*
const aiRoutes = require("./ai"); // exposes POST /api/ai/chat
const authMiddleware = require("../middleware/auth.middleware");
const { getAlertEvents, getPool } = require("../database/postgres");

const router = express.Router();
const requireAuth = authMiddleware.requireAuth;

router.use("/auth", authRoutes);
router.use("/", productionRoutes);   // GET /api/production-summary
router.use("/", settingsRoutes);     // GET/PUT /api/settings
router.use("/billing", billingRoutes);
router.use("/ai", aiRoutes);

// Public on purpose: used by Render's health check / uptime monitors. Reveals nothing sensitive.
router.get("/health", (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// ── Everything below needs a signed-in, ACTIVE user ──────────────────────────
// (A paused user is rejected by requireAuth, so pausing also cuts off the data API.)

router.get("/current", requireAuth, ctrl.current);

router.get("/alert-events", requireAuth, async (req, res) => {
  try {
    res.json(await getAlertEvents(Number(req.query.limit) || 500));
  } catch (err) {
    console.error("[alert-events]", err);
    res.status(500).json({ error: "Failed to load alert events" });
  }
});

router.get("/history/:parameter", requireAuth, async (req, res) => {
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
    res.status(500).json({ error: "Failed to load history" });
  }
});

router.get("/status", requireAuth, ctrl.status);
router.get("/alarms", requireAuth, ctrl.alarms);
router.get("/mqtt-status", requireAuth, ctrl.mqttStatus);

// Sends a message to the plant over MQTT -> staff only. Clients must never reach this.
router.post("/publish", requireAuth, authMiddleware.requireRole("admin", "operator"), ctrl.publish);

module.exports = router;