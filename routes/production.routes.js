// backend/routes/production.routes.js
const express = require('express');
const router = express.Router();
const db = require('../database/postgres');

// GET /api/production-summary
// Returns real daily/weekly/monthly/yearly production volume (m³),
// computed by integrating flow-rate history in Postgres — not from
// whatever happens to be sitting in the frontend's in-browser buffer.
router.get('/production-summary', async (req, res) => {
    try {
        const [feed, permeate] = await Promise.all([
            db.getProductionSummary('RO5-FEEDFlow'),
            db.getProductionSummary('RO5-Permeateflow'),
        ]);

        res.json({
            feed,      // { daily, weekly, monthly, yearly } in m³
            permeate,  // { daily, weekly, monthly, yearly } in m³
            generatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[api] production-summary error:', error.message);
        res.status(500).json({ error: 'Failed to compute production summary' });
    }
});

module.exports = router;