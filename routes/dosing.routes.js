// routes/dosing.routes.js
//
// Exposes the server-side dosing totalizer to the frontend.
//
//   GET /api/dosing/totals           — today's running total
//   GET /api/dosing/month            — current month's rollup
//   GET /api/dosing/history?month=   — one row per day for a given YYYY-MM
//
// Auth is applied where the router is mounted (see routes/index.js).

const express = require('express');
const router = express.Router();

const { getTodayTotals, getMonthSummary, getMonthHistory } = require('../services/dosingService');

// Always serve fresh numbers (no ETag/304 games for a live counter)
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/totals', (req, res) => {
  try {
    const totals = getTodayTotals();
    if (!totals.hydrated) {
      // Better to say "not ready" than to show a false zero
      return res.status(503).json({ error: 'dosing totalizer is starting up' });
    }
    res.json(totals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/month', async (req, res) => {
  try {
    res.json(await getMonthSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', async (req, res) => {
  const month = String(req.query.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month query param must be YYYY-MM' });
  }
  try {
    res.json({ month, days: await getMonthHistory(month) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;