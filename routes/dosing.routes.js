// routes/dosing.routes.js
//
// Exposes the server-side dosing totalizer to the frontend.
// All values are computed and persisted in Postgres by services/dosingService.js,
// which is fed by services/plcService.js on every PLC report of the dosing bit.
//
//   GET /api/dosing/totals           — today's running total
//   GET /api/dosing/month            — current month's rollup
//   GET /api/dosing/history?month=   — one row per day for a given YYYY-MM

const express = require('express');
const router = express.Router();

const { getTodayTotals, getMonthSummary } = require('../services/dosingService');
const { getDosingHistoryForMonth } = require('../database/postgres');

// If auth is applied per-route in your app (not globally), uncomment and
// import the middleware you use on other protected routes. If auth is
// applied globally under /api, leave this out.
//
// const requireAuth = require('../middleware/requireAuth');

// Today's running total. Cheap — reads from the in-memory cache in
// dosingService. Safe to poll every few seconds.
router.get('/totals', /* requireAuth, */ (req, res) => {
  try {
    res.json(getTodayTotals());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current month's aggregate (sum across all day rows).
router.get('/month', /* requireAuth, */ async (req, res) => {
  try {
    res.json(await getMonthSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One row per calendar day for a given month. Used by the monthly chart.
router.get('/history', /* requireAuth, */ async (req, res) => {
  const month = String(req.query.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month query param must be YYYY-MM' });
  }
  try {
    const rows = await getDosingHistoryForMonth(month);
    res.json({
      month,
      days: rows.map((r) => ({
        day: r.day,
        secondsOn: Number(r.secondsOn),
        mlDosed: Number(r.mlDosed),
        primedToday: Boolean(r.primedToday),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;