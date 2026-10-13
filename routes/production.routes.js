// backend/routes/production.routes.js
const express = require('express');
const router = express.Router();
const db = require('../database/postgres');
const authMiddleware = require('../middleware/auth.middleware');

// The summary integrates the whole flow history (8 heavy queries per request), so
// every signed-in user shares one cached result for a short time. Concurrent
// requests also share the same in-flight computation.
const CACHE_MS = 30 * 1000;
let cache = null;          // { at, value }
let inFlight = null;

async function computeSummary() {
    const [feed, permeate] = await Promise.all([
        db.getProductionSummary('RO5-FEEDFlow'),
        db.getProductionSummary('RO5-Permeateflow'),
    ]);
    return {
        feed,      // { daily, weekly, monthly, yearly } in m³
        permeate,  // { daily, weekly, monthly, yearly } in m³
        generatedAt: new Date().toISOString(),
    };
}

async function getSummaryCached() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    if (!inFlight) {
        inFlight = computeSummary()
            .then((value) => { cache = { at: Date.now(), value }; return value; })
            .finally(() => { inFlight = null; });
    }
    return inFlight;
}

// GET /api/production-summary  (signed-in, active users only)
// Real daily/weekly/monthly/yearly production volume (m³), computed by
// integrating flow-rate history in Postgres.
router.get('/production-summary', authMiddleware.requireAuth, async (req, res) => {
    try {
        res.json(await getSummaryCached());
    } catch (error) {
        console.error('[api] production-summary error:', error.message);
        res.status(500).json({ error: 'Failed to compute production summary' });
    }
});

module.exports = router;