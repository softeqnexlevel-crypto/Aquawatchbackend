// backend/routes/billing.routes.js
const express = require('express');
const router = express.Router();
const billingService = require('../services/billing.service');
const authMiddleware = require('../middleware/auth.middleware');

// ==================== PUBLIC ====================

// Plan list is public — pricing pages don't require login to view.
router.get('/plans', async (req, res) => {
    try {
        const plans = await billingService.getPlans();
        res.json(plans);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load plans' });
    }
});

// ==================== PROTECTED ====================

router.get('/history', authMiddleware.requireAuth, async (req, res) => {
    try {
        const history = await billingService.getHistory(req.user.id);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load billing history' });
    }
});

router.post('/subscribe/initialize', authMiddleware.requireAuth, async (req, res) => {
    try {
        const { planCode, email } = req.body;
        if (!planCode || !email) {
            return res.status(400).json({ error: 'planCode and email are required' });
        }
        const result = await billingService.initializeCheckout({
            userId: req.user.id,
            email,
            planCode,
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ==================== WEBHOOK ====================
//
// req.body arrives here as a raw Buffer already — server.js carves out
// this exact path BEFORE its global express.json() middleware runs, so
// Paystack's signature (computed over the raw bytes) can be verified
// correctly. Do NOT add express.json() or express.raw() here again —
// the request stream has already been consumed once; parsing it a
// second time would silently produce an empty body and break
// verification. See the PAYSTACK_WEBHOOK_PATH carve-out in server.js.
router.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        const rawBody = req.body; // Buffer, thanks to express.raw() above

        if (!billingService.verifyWebhookSignature(rawBody, signature)) {
            console.warn('[billing] Webhook signature verification failed');
            return res.status(401).send('Invalid signature');
        }

        const event = JSON.parse(rawBody.toString('utf8'));
        await billingService.handleWebhookEvent(event);

        res.sendStatus(200); // Paystack just needs a 200 to stop retrying
    } catch (error) {
        console.error('[billing] Webhook processing error:', error);
        res.sendStatus(500);
    }
});

module.exports = router;