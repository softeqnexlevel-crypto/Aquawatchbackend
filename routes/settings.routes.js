// backend/routes/settings.routes.js
const express = require('express');
const router = express.Router();
const db = require('../database/postgres');
const authMiddleware = require('../middleware/auth.middleware');

// GET /api/settings — any authenticated user can view current settings
router.get('/settings', authMiddleware.requireAuth, async (req, res) => {
    try {
        const settings = await db.getSettings();
        res.json({ settings });
    } catch (error) {
        console.error('[api] get settings error:', error.message);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// PUT /api/settings — admin only
router.put('/settings', authMiddleware.requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const {
            plantName, operatorId, productionTarget, recoveryTarget,
            filterDpWarn, filterDpCrit, lowRecoveryWarn, lowChemAlert,
            minDosing, maxDosing,
        } = req.body;

        // Basic server-side validation — mirrors the frontend's checks, but
        // must also live here since the frontend check alone can't be trusted.
        const errors = [];
        if (Number(productionTarget) < 1000) errors.push('Production target should be at least 1000 m³/day');
        if (Number(recoveryTarget) < 50 || Number(recoveryTarget) > 95) errors.push('Recovery target should be between 50% and 95%');
        if (Number(minDosing) >= Number(maxDosing)) errors.push('Min dosing rate must be less than max dosing rate');
        if (Number(filterDpWarn) >= Number(filterDpCrit)) errors.push('Filter warning threshold must be less than critical threshold');

        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join('. ') });
        }

        const settings = await db.saveSettings({
            plantName, operatorId, productionTarget, recoveryTarget,
            filterDpWarn, filterDpCrit, lowRecoveryWarn, lowChemAlert,
            minDosing, maxDosing,
        }, req.user.id);

        res.json({ message: 'Settings saved', settings });
    } catch (error) {
        console.error('[api] save settings error:', error.message);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

module.exports = router;