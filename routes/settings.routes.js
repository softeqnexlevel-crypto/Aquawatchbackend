// backend/routes/settings.routes.js
const express = require('express');
const router = express.Router();
const db = require('../database/postgres');
const authMiddleware = require('../middleware/auth.middleware');

// Allowed range for every numeric setting (anything outside is rejected, incl. NaN/Infinity)
const NUMERIC_LIMITS = {
    productionTarget: [0, 1_000_000],
    recoveryTarget:   [0, 100],
    filterDpWarn:     [0, 100],
    filterDpCrit:     [0, 100],
    lowRecoveryWarn:  [0, 100],
    lowChemAlert:     [0, 100],
    minDosing:        [0, 1000],
    maxDosing:        [0, 1000],
};

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

        // Fields missing from the request keep their current saved value
        // (previously a missing field was saved as NaN).
        const current = await db.getSettings();
        const body = req.body || {};
        const merged = { ...current };
        for (const key of ['plantName', 'operatorId', ...Object.keys(NUMERIC_LIMITS)]) {
            if (body[key] !== undefined && body[key] !== null && body[key] !== '') merged[key] = body[key];
        }

        // Server-side validation — the frontend check alone can't be trusted.
        const errors = [];
        for (const [key, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
            const n = Number(merged[key]);
            if (!Number.isFinite(n) || n < min || n > max) {
                errors.push(`${key} must be a number between ${min} and ${max}`);
            }
            merged[key] = n;
        }
        if (typeof merged.plantName !== 'string' || !merged.plantName.trim() || merged.plantName.length > 255) {
            errors.push('Plant name is required (max 255 characters)');
        }
        if (merged.operatorId != null && String(merged.operatorId).length > 100) {
            errors.push('Operator ID is too long (max 100 characters)');
        }
        if (errors.length === 0) {
            if (merged.productionTarget < 1000) errors.push('Production target should be at least 1000 m³/day');
            if (merged.recoveryTarget < 50 || merged.recoveryTarget > 95) errors.push('Recovery target should be between 50% and 95%');
            if (merged.minDosing >= merged.maxDosing) errors.push('Min dosing rate must be less than max dosing rate');
            if (merged.filterDpWarn >= merged.filterDpCrit) errors.push('Filter warning threshold must be less than critical threshold');
        }

        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join('. ') });
        }

        const settings = await db.saveSettings({
            plantName: merged.plantName.trim(),
            operatorId: merged.operatorId,
            productionTarget: merged.productionTarget,
            recoveryTarget: merged.recoveryTarget,
            filterDpWarn: merged.filterDpWarn,
            filterDpCrit: merged.filterDpCrit,
            lowRecoveryWarn: merged.lowRecoveryWarn,
            lowChemAlert: merged.lowChemAlert,
            minDosing: merged.minDosing,
            maxDosing: merged.maxDosing,
        }, req.user.id);

        res.json({ message: 'Settings saved', settings });
    } catch (error) {
        console.error('[api] save settings error:', error.message);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

module.exports = router;