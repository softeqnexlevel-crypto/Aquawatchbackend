// backend/services/billing.service.js
'use strict';

const db = require('../database/postgres');

const {
    MPESA_CONSUMER_KEY,
    MPESA_CONSUMER_SECRET,
    MPESA_SHORTCODE,
    MPESA_TILL_NUMBER,
    MPESA_PASSKEY,
    MPESA_CALLBACK_URL,
    MPESA_ENV = 'sandbox',
    MPESA_TRANSACTION_TYPE = 'CustomerPayBillOnline', // switch to CustomerBuyGoodsOnline after Till Go-Live
} = process.env;

const BASE_URL = MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const TRIAL_DAYS = 30;
const CANCELLED_RESULT_CODE = 1032; // "Request cancelled by user"

const SUBSCRIPTION = {
    code: 'standard',
    name: 'AguaWatch Subscription',
    amountKes: 1,
    intervalDays: 30,
};

console.log('[billing] module loaded. Config:', {
    env: MPESA_ENV,
    baseUrl: BASE_URL,
    shortcode: MPESA_SHORTCODE,
    transactionType: MPESA_TRANSACTION_TYPE,
    keyLength: MPESA_CONSUMER_KEY?.length,
    keyPrefix: MPESA_CONSUMER_KEY?.slice(0, 5),
    secretLength: MPESA_CONSUMER_SECRET?.length,
    secretPrefix: MPESA_CONSUMER_SECRET?.slice(0, 5),
    passkeySet: !!MPESA_PASSKEY,
    callbackUrl: MPESA_CALLBACK_URL,
});

if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY) {
    console.error('[billing] Missing Daraja credentials — set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY');
}

/* ============================================================
   OAUTH TOKEN
   ============================================================ */

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 30_000) {
        console.log('[billing] getAccessToken: using cached token');
        return cachedToken;
    }

    console.log('[billing] getAccessToken: requesting new token from', `${BASE_URL}/oauth/v1/generate`);

    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');

    let res;
    try {
        res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${auth}` },
        });
    } catch (networkError) {
        console.error('[billing] getAccessToken: fetch() threw before receiving a response:', networkError);
        throw new Error(`Could not reach M-Pesa OAuth endpoint: ${networkError.message}`);
    }

    const responseText = await res.text();
    console.log('[billing] getAccessToken: HTTP', res.status, '- raw body:', JSON.stringify(responseText).slice(0, 300));

    let data;
    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error(
            `M-Pesa OAuth endpoint returned a non-JSON response (HTTP ${res.status}). ` +
            `Raw response: ${responseText.slice(0, 200)}`
        );
    }

    if (!res.ok || !data.access_token) {
        throw new Error(data.errorMessage || `Failed to obtain M-Pesa access token (HTTP ${res.status})`);
    }

    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 3599) * 1000;
    console.log('[billing] getAccessToken: success, token cached for', data.expires_in, 'seconds');
    return cachedToken;
}

/* ============================================================
   HELPERS
   ============================================================ */

function timestampNow() {
    const nairobi = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return (
        nairobi.getUTCFullYear().toString() +
        pad(nairobi.getUTCMonth() + 1) +
        pad(nairobi.getUTCDate()) +
        pad(nairobi.getUTCHours()) +
        pad(nairobi.getUTCMinutes()) +
        pad(nairobi.getUTCSeconds())
    );
}

function buildPassword(timestamp) {
    return Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
}

function normalizeMsisdn(phone) {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
    if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return `254${digits}`;
    throw new Error(`Unrecognized phone number format: ${phone}`);
}

async function darajaFetch(url, options) {
    let res;
    try {
        res = await fetch(url, options);
    } catch (networkError) {
        throw new Error(`Could not reach M-Pesa (${url}): ${networkError.message}`);
    }

    const responseText = await res.text();
    let data;
    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error(`M-Pesa returned a non-JSON response (HTTP ${res.status}): ${responseText.slice(0, 200)}`);
    }
    return { ok: res.ok, status: res.status, data };
}

/* ============================================================
   TRIAL / SUBSCRIPTION STATUS
   ============================================================ */

async function getSubscriptionStatus(userId, userCreatedAt) {
    const activeSub = await db.getActiveSubscription(userId);

    if (activeSub && (!activeSub.currentPeriodEnd || new Date(activeSub.currentPeriodEnd) > new Date())) {
        return {
            subscriptionStatus: 'active',
            planCode: activeSub.planCode,
            currentPeriodEnd: activeSub.currentPeriodEnd,
        };
    }

    const createdAt = userCreatedAt ? new Date(userCreatedAt) : new Date();
    const daysElapsed = Math.floor((Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
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
    return [SUBSCRIPTION];
}

async function getHistory(userId) {
    return db.getBillingHistoryByUser(userId);
}

/* ============================================================
   STK PUSH
   ============================================================ */

async function initiateStkPush({ userId, phone }) {
    console.log(`[billing] initiateStkPush: user=${userId} phone=${phone}`);

    const pending = await db.getPendingMpesaHistoryByUser(userId);
    if (pending) {
        throw new Error('A payment request is already pending on your phone. Please complete or cancel it before trying again.');
    }

    const token = await getAccessToken();
    const timestamp = timestampNow();
    const password = buildPassword(timestamp);
    const msisdn = normalizeMsisdn(phone);
    const amount = Math.round(SUBSCRIPTION.amountKes);

    const body = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: MPESA_TRANSACTION_TYPE,
        Amount: amount,
        PartyA: msisdn,
        PartyB: MPESA_TRANSACTION_TYPE === 'CustomerBuyGoodsOnline'
            ? (MPESA_TILL_NUMBER || MPESA_SHORTCODE)
            : MPESA_SHORTCODE,
        PhoneNumber: msisdn,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: SUBSCRIPTION.code.slice(0, 12),
        TransactionDesc: 'Subscription',
    };

    console.log('[billing] initiateStkPush: request body:', JSON.stringify(body));

    const { ok, status, data } = await darajaFetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    console.log('[billing] initiateStkPush: response:', status, JSON.stringify(data));

    if (!ok || data.ResponseCode !== '0') {
        const knownErrors = {
            '500.001.1001': 'There is already a pending payment request on that phone, or a session lock. Wait a minute and try again.',
            '400.002.02': 'M-Pesa rejected the request as malformed. Check BusinessShortCode/Password/Timestamp.',
            '404.001.03': 'M-Pesa access token was invalid or expired.',
        };
        throw new Error(knownErrors[data.ResponseCode] || data.errorMessage || data.ResponseDescription || `STK push request failed (HTTP ${status})`);
    }

    try {
        await db.createBillingHistoryEntry({
            userId,
            planCode: SUBSCRIPTION.code,
            planName: SUBSCRIPTION.name,
            amountKes: SUBSCRIPTION.amountKes,
            mpesaCheckoutRequestId: data.CheckoutRequestID,
            mpesaMerchantRequestId: data.MerchantRequestID,
            mpesaPhone: msisdn,
        });
    } catch (dbError) {
        // The STK push already succeeded on Safaricom's side — don't fail
        // the whole request just because our own history log write failed.
        console.error('[billing] initiateStkPush: failed to write billing history:', dbError.message);
    }

    return {
        checkoutRequestId: data.CheckoutRequestID,
        merchantRequestId: data.MerchantRequestID,
        customerMessage: data.CustomerMessage,
    };
}

async function queryStkStatus(checkoutRequestId) {
    const token = await getAccessToken();
    const timestamp = timestampNow();
    const password = buildPassword(timestamp);

    const { data } = await darajaFetch(`${BASE_URL}/mpesa/stkpushquery/v1/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            BusinessShortCode: MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            CheckoutRequestID: checkoutRequestId,
        }),
    });

    return data;
}

/* ============================================================
   RESOLUTION — the ONLY place that writes a final status.
   Idempotent by checking the existing row first.
   ============================================================ */

async function resolveStkResult(checkoutRequestId, resultCode, metadataItems = []) {
    const existing = await db.getBillingHistoryByCheckoutRequestId(checkoutRequestId);
    if (existing && existing.status !== 'processing') {
        return { status: existing.status, alreadyProcessed: true };
    }

    const code = Number(resultCode);

    if (code === 0) {
        const getItem = (name) => metadataItems.find((i) => i.Name === name)?.Value;
        const mpesaReceiptNumber = getItem('MpesaReceiptNumber');

        const historyEntry = await db.updateBillingHistoryByCheckoutRequestId(checkoutRequestId, {
            status: 'success',
            mpesaReceiptNumber,
        });

        if (historyEntry) {
            const currentPeriodEnd = new Date(Date.now() + SUBSCRIPTION.intervalDays * 24 * 60 * 60 * 1000);
            await db.upsertActiveSubscription({
                userId: historyEntry.userId,
                planCode: SUBSCRIPTION.code,
                mpesaPhone: historyEntry.mpesaPhone,
                currentPeriodEnd,
            });
        }
        return { status: 'success' };
    }

    const status = code === CANCELLED_RESULT_CODE ? 'cancelled' : 'failed';
    await db.updateBillingHistoryByCheckoutRequestId(checkoutRequestId, { status });
    return { status };
}

/* ============================================================
   CALLBACK
   ============================================================ */

async function handleStkCallback(body) {
    const callback = body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) {
        console.warn('[billing] M-Pesa callback missing stkCallback/CheckoutRequestID');
        return;
    }

    const metadataItems = callback.CallbackMetadata?.Item || [];
    await resolveStkResult(callback.CheckoutRequestID, callback.ResultCode, metadataItems);
}

/* ============================================================
   STATUS — client polling endpoint
   ============================================================ */

async function checkStkStatus(checkoutRequestId) {
    const existing = await db.getBillingHistoryByCheckoutRequestId(checkoutRequestId);
    if (existing && existing.status !== 'processing') {
        return { ResultCode: existing.status === 'success' ? 0 : 1, status: existing.status };
    }

    const result = await queryStkStatus(checkoutRequestId);
    const code = Number(result.ResultCode);

    if (!Number.isNaN(code)) {
        await resolveStkResult(checkoutRequestId, code);
    }

    return result;
}

module.exports = {
    TRIAL_DAYS,
    SUBSCRIPTION,
    getSubscriptionStatus,
    getPlans,
    getHistory,
    initiateStkPush,
    checkStkStatus,
    handleStkCallback,
};