'use strict';
// routes/dailySummary.routes.js
//   GET /api/daily-summary            -> { today, yesterday }
//   GET /api/daily-summary/history    -> ?days=30  or  ?from=YYYY-MM-DD&to=YYYY-MM-DD

const express = require('express');
const dailySummary = require('../services/dailySummary');
const { dosingDayKey } = require('../database/postgres');

// Use the same login check as the other routes (works whichever way the middleware is exported)
const am = require('../middleware/auth.middleware');
const auth = typeof am === 'function'
  ? am
  : (am.authenticate || am.authMiddleware || am.verifyToken || am.protect || am.requireAuth);
if (typeof auth !== 'function') {
  throw new Error('dailySummary.routes: could not find the auth middleware function in ../middleware/auth.middleware');
}

const router = express.Router();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/', auth, async (req, res) => {
  try {
    res.json(await dailySummary.getSummary());
  } catch (err) {
    console.error('[daily-summary] failed:', err.message);
    res.status(500).json({ error: 'Failed to load daily summary' });
  }
});

router.get('/history', auth, async (req, res) => {
  try {
    const { from, to, days } = req.query;
    let rows;
    if (from && DAY_RE.test(from)) {
      rows = await dailySummary.getRange(from, to && DAY_RE.test(to) ? to : dosingDayKey());
    } else {
      rows = await dailySummary.getHistory(days);
    }
    res.json({ days: rows });
  } catch (err) {
    console.error('[daily-summary/history] failed:', err.message);
    res.status(500).json({ error: 'Failed to load daily history' });
  }
});

module.exports = router;