// backend/routes/billing.routes.js
'use strict';

const express = require('express');
const router = express.Router();
const billingService = require('../services/billing.service');
const authMiddleware = require('../middleware/auth.middleware');

// ==================== PUBLIC ====================

router.get('/plans', async (req, res) => {
    try {
        const plans = await billingService.getPlans();
        res.json(plans);
    } catch (error) {
        console.error('[billing] GET /plans error:', error.message);
        res.status(500).json({ error: 'Failed to load plans' });
    }
});

// ==================== PROTECTED ====================

router.get('/history', authMiddleware.requireAuth, async (req, res) => {
    try {
        const history = await billingService.getHistory(req.user.id);
        res.json(history);
    } catch (error) {
        console.error('[billing] GET /history error:', error.message);
        res.status(500).json({ error: 'Failed to load billing history' });
    }
});

router.post('/subscribe/mpesa/initialize', authMiddleware.requireAuth, async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }
        const result = await billingService.initiateStkPush({ userId: req.user.id, phone });
        res.json(result);
    } catch (error) {
        console.error('[billing] POST /subscribe/mpesa/initialize error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

router.get('/subscribe/mpesa/status/:checkoutRequestId', authMiddleware.requireAuth, async (req, res) => {
    try {
        const result = await billingService.checkStkStatus(req.params.checkoutRequestId);
        res.json(result);
    } catch (error) {
        console.error('[billing] GET /subscribe/mpesa/status error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// ==================== CALLBACK ====================
// Public — Safaricom calls this directly.

const MPESA_CALLBACK_TOKEN = process.env.MPESA_CALLBACK_TOKEN;
const MPESA_ALLOWED_IPS = (process.env.MPESA_ALLOWED_IPS || '').split(',').filter(Boolean);

router.post('/webhook/mpesa/:token', async (req, res) => {
    if (!MPESA_CALLBACK_TOKEN || req.params.token !== MPESA_CALLBACK_TOKEN) {
        console.warn('[billing] rejected M-Pesa callback: bad token');
        return res.status(404).end();
    }
    if (MPESA_ALLOWED_IPS.length && !MPESA_ALLOWED_IPS.includes(req.ip)) {
        console.warn('[billing] rejected M-Pesa callback from', req.ip);
        return res.status(403).end();
    }
    try {
        await billingService.handleStkCallback(req.body);    } catch (error) {
        console.error('[billing] webhook/mpesa processing error:', error);
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

module.exports = router;