// backend/services/billing.service.js
'use strict';

const crypto = require('crypto');
const db = require('../database/postgres');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const TRIAL_DAYS = 30;

if (!PAYSTACK_SECRET_KEY) {
    console.warn('[billing] PAYSTACK_SECRET_KEY is not set — checkout/webhook calls will fail until it is configured');
}

/* ============================================================
   PAYSTACK API HELPER
   Node's built-in fetch (Node 18+) — no extra dependency needed.
   ============================================================ */

async function paystackRequest(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok || data.status === false) {
        throw new Error(data.message || `Paystack request failed (${res.status})`);
    }
    return data;
}

/* ============================================================
   TRIAL / SUBSCRIPTION STATUS
   ============================================================ */

/**
 * Computes what the frontend needs to know about a user's access level.
 * Priority: an active paid subscription always wins. Otherwise, fall
 * back to a 30-day trial counted from account creation.
 *
 * Returns one of:
 *   { subscriptionStatus: 'active',  planCode, currentPeriodEnd }
 *   { subscriptionStatus: 'trial',   daysRemaining }
 *   { subscriptionStatus: 'expired', daysRemaining: 0 }
 */
async function getSubscriptionStatus(userId, userCreatedAt) {
    const db2 = db.getDb();
    const rows = await db2
        .select()
        .from(db.schema.billingSubscriptions)
        .where(
            require('drizzle-orm').sql`${db.schema.billingSubscriptions.userId} = ${userId} AND ${db.schema.billingSubscriptions.status} = 'active'`
        )
        .limit(1);

    const activeSub = rows[0] || null;

    if (activeSub && (!activeSub.currentPeriodEnd || new Date(activeSub.currentPeriodEnd) > new Date())) {
        return {
            subscriptionStatus: 'active',
            planCode: activeSub.planCode,
            currentPeriodEnd: activeSub.currentPeriodEnd,
        };
    }

    // No active paid subscription — fall back to trial window.
    const createdAt = userCreatedAt ? new Date(userCreatedAt) : new Date();
    const msElapsed = Date.now() - createdAt.getTime();
    const daysElapsed = Math.floor(msElapsed / (24 * 60 * 60 * 1000));
    const daysRemaining = Math.max(0, TRIAL_DAYS - daysElapsed);

    if (daysRemaining > 0) {
        return { subscriptionStatus: 'trial', daysRemaining };
    }
    return { subscriptionStatus: 'expired', daysRemaining: 0 };
}

/* ============================================================
   PLANS / HISTORY
   ============================================================ */

async function getPlans() {
    return db.getActiveBillingPlans();
}

async function getHistory(userId) {
    return db.getBillingHistoryByUser(userId);
}

/* ============================================================
   CHECKOUT
   ============================================================ */

async function initializeCheckout({ userId, email, planCode }) {
    const plan = await db.getBillingPlanByCode(planCode);
    if (!plan) throw new Error('Plan not found');
    if (!plan.paystackPlanCode) throw new Error('This plan requires contacting sales — no self-serve checkout');

    const reference = `aqs_${crypto.randomBytes(12).toString('hex')}`;

    // Record the attempt immediately as 'processing' so it shows in
    // Billing History right away, and so the webhook has a matching
    // row to update by reference when Paystack confirms it later.
    await db.createBillingHistoryEntry({
        userId,
        planCode: plan.code,
        planName: plan.name,
        amountKes: plan.amountKes,
        paystackReference: reference,
        status: 'processing',
    });

    const initData = await paystackRequest('/transaction/initialize', {
        method: 'POST',
        body: {
            email,
            amount: Math.round(plan.amountKes * 100), // Paystack expects kobo/cents-equivalent
            currency: 'KES',
            reference,
            plan: plan.paystackPlanCode, // enables recurring billing on Paystack's side
            metadata: { userId, planCode: plan.code },
        },
    });

    return {
        authorizationUrl: initData.data.authorization_url,
        reference,
    };
}

/* ============================================================
   WEBHOOK
   ============================================================ */

function verifyWebhookSignature(rawBody, signatureHeader) {
    if (!PAYSTACK_SECRET_KEY || !signatureHeader) return false;
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    return hash === signatureHeader;
}

async function handleWebhookEvent(event) {
    const { event: eventType, data } = event;

    switch (eventType) {
        case 'charge.success': {
            const reference = data.reference;
            const metadata = data.metadata || {};
            const userId = metadata.userId;
            const planCode = metadata.planCode;

            await db.updateBillingHistoryStatus(reference, 'success');

            if (userId && planCode) {
                const plan = await db.getBillingPlanByCode(planCode);
                const periodDays = plan?.interval === 'yearly' ? 365 : 30;
                const currentPeriodEnd = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000);

                await db.upsertActiveSubscription({
                    userId,
                    planCode,
                    paystackCustomerCode: data.customer?.customer_code || null,
                    currentPeriodEnd,
                });
            }
            break;
        }

        case 'subscription.disable':
        case 'subscription.not_renew': {
            const customerCode = data.customer?.customer_code;
            if (customerCode) {
                await db.updateSubscriptionByCustomerCode(customerCode, { status: 'cancelled' });
            }
            break;
        }

        case 'invoice.payment_failed': {
            const reference = data.transaction_reference || data.reference;
            if (reference) {
                await db.updateBillingHistoryStatus(reference, 'failed');
            }
            break;
        }

        default:
            console.log(`[billing] Unhandled Paystack event: ${eventType}`);
    }
}

module.exports = {
    TRIAL_DAYS,
    getSubscriptionStatus,
    getPlans,
    getHistory,
    initializeCheckout,
    verifyWebhookSignature,
    handleWebhookEvent,
};