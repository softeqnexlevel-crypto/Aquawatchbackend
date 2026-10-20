// backend/routes/production.routes.js
const express = require('express');
const router = express.Router();
const db = require('../database/postgres');
const authMiddleware = require('../middleware/auth.middleware');
const tenantContext = require('../middleware/tenantContext');
const tenants = require('../services/tenants.service');

const MAIN = 1;
// Where a tenant's readings live. Tenant ids are validated integers, so this is safe to inline.
const readings = (tid) => (tid === MAIN ? 'measurements' : `(SELECT time, value, parameter FROM tenant_measurements WHERE tenant_id = ${Number(tid)}) AS m`);

// Volume (m3) of a flow tag between two instants, for any tenant (trapezoid of the flow history).
async function volumeBetween(tid, parameter, from, to) {
    const r = await db.getPool().query(
        `WITH ordered AS (
            SELECT time, value, LAG(time) OVER (ORDER BY time) AS pt, LAG(value) OVER (ORDER BY time) AS pv
            FROM ${readings(tid)} WHERE parameter = $1 AND time <= $3::timestamptz AND time >= $2::timestamptz - INTERVAL '2 days')
         SELECT COALESCE(SUM(((value + pv) / 2.0) * (EXTRACT(EPOCH FROM (time - GREATEST(pt, $2::timestamptz))) / 3600.0)), 0)::float AS v
         FROM ordered WHERE pt IS NOT NULL AND time > $2::timestamptz`, [parameter, from.toISOString(), to.toISOString()]);
    return Number(r.rows[0].v) || 0;
}

// The summary integrates the whole flow history (8 heavy queries per request), so
// every signed-in user shares one cached result for a short time. Concurrent
// requests also share the same in-flight computation.
const CACHE_MS = 30 * 1000;
const sumCache = {};       // tenantId -> { at, value }
const sumFlight = {};

async function otherSummary(tid, parameter) {
    const now = new Date();
    const w = new Date(now.getTime() + 3 * 3600 * 1000);
    const Y = w.getUTCFullYear(), M = w.getUTCMonth(), D = w.getUTCDate();
    const dow = (w.getUTCDay() + 6) % 7;
    const at = (d) => new Date(d.getTime() - 3 * 3600 * 1000);
    const [daily, weekly, monthly, yearly] = await Promise.all([
        volumeBetween(tid, parameter, at(new Date(Date.UTC(Y, M, D))), now),
        volumeBetween(tid, parameter, at(new Date(Date.UTC(Y, M, D - dow))), now),
        volumeBetween(tid, parameter, at(new Date(Date.UTC(Y, M, 1))), now),
        volumeBetween(tid, parameter, at(new Date(Date.UTC(Y, 0, 1))), now),
    ]);
    return { daily, weekly, monthly, yearly };
}

async function computeSummary(tid) {
    const get = (p) => (tid === MAIN ? db.getProductionSummary(p) : otherSummary(tid, p));
    const [feed, permeate] = await Promise.all([get('RO5-FEEDFlow'), get('RO5-Permeateflow')]);
    return {
        feed,      // { daily, weekly, monthly, yearly } in m³
        permeate,  // { daily, weekly, monthly, yearly } in m³
        generatedAt: new Date().toISOString(),
    };
}

async function getSummaryCached(tid) {
    const c = sumCache[tid];
    if (c && Date.now() - c.at < CACHE_MS) return c.value;
    if (!sumFlight[tid]) {
        sumFlight[tid] = computeSummary(tid)
            .then((value) => { sumCache[tid] = { at: Date.now(), value }; return value; })
            .finally(() => { sumFlight[tid] = null; });
    }
    return sumFlight[tid];
}

// GET /api/production-summary  (signed-in, active users only)
// Real daily/weekly/monthly/yearly production volume (m³), computed by
// integrating flow-rate history in Postgres.
router.get('/production-summary', authMiddleware.requireAuth, tenantContext, async (req, res) => {
    try {
        res.json(await getSummaryCached(req.tenantId));
    } catch (error) {
        console.error('[api] production-summary error:', error.message);
        res.status(500).json({ error: 'Failed to compute production summary' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/production-breakdown?period=today|week|month|year
// Permeate volume (m³) per hour / day / day / month, plus target, pace and days left.
// Same integration (trapezoid of the flow history) as /production-summary.
// ---------------------------------------------------------------------------
const TZ_MS = 3 * 60 * 60 * 1000;                  // plant time = UTC+3 (Nairobi)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const bCache = {};                                 // `tenant:period` -> { at, value }

function plantNow() { return new Date(Date.now() + TZ_MS); }           // UTC fields = plant wall clock
const toUtc = (wall) => new Date(wall.getTime() - TZ_MS);
const pad = (n) => String(n).padStart(2, '0');

async function computeBreakdown(period, tid) {
    const w = plantNow();
    const Y = w.getUTCFullYear(), M = w.getUTCMonth(), D = w.getUTCDate();
    const dayMs = 24 * 3600 * 1000;
    let startWall, unit, labels, keyOf, totalDays, daysBefore, elapsedFrac;
    const sinceMidnightDays = (w.getUTCHours() * 3600 + w.getUTCMinutes() * 60 + w.getUTCSeconds()) / 86400;

    if (period === 'today') {
        startWall = new Date(Date.UTC(Y, M, D));
        unit = 'hour';
        labels = Array.from({ length: 24 }, (_, i) => String(i));
        keyOf = (i) => `${Y}-${pad(M + 1)}-${pad(D)} ${pad(i)}`;
        totalDays = 1; daysBefore = 0; elapsedFrac = sinceMidnightDays;
    } else if (period === 'week') {
        const dow = (w.getUTCDay() + 6) % 7;            // Monday = 0
        startWall = new Date(Date.UTC(Y, M, D - dow));
        unit = 'day';
        labels = DAYS;
        keyOf = (i) => { const d = new Date(startWall.getTime() + i * dayMs); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
        totalDays = 7; daysBefore = dow; elapsedFrac = (dow + sinceMidnightDays) / 7;
    } else if (period === 'month') {
        startWall = new Date(Date.UTC(Y, M, 1));
        unit = 'day';
        const n = new Date(Date.UTC(Y, M + 1, 0)).getUTCDate();
        labels = Array.from({ length: n }, (_, i) => String(i + 1));
        keyOf = (i) => `${Y}-${pad(M + 1)}-${pad(i + 1)}`;
        totalDays = n; daysBefore = D - 1; elapsedFrac = (D - 1 + sinceMidnightDays) / n;
    } else {
        startWall = new Date(Date.UTC(Y, 0, 1));
        unit = 'month';
        labels = MONTHS;
        keyOf = (i) => `${Y}-${pad(i + 1)}`;
        totalDays = (Date.UTC(Y + 1, 0, 1) - Date.UTC(Y, 0, 1)) / dayMs;
        daysBefore = Math.floor((Date.UTC(Y, M, D) - Date.UTC(Y, 0, 1)) / dayMs);
        elapsedFrac = (daysBefore + sinceMidnightDays) / totalDays;
    }

    const fmt = unit === 'hour' ? 'YYYY-MM-DD HH24' : unit === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    const startUtc = toUtc(startWall);
    const r = await db.getPool().query(
        `WITH ordered AS (
            SELECT time, value, LAG(time) OVER (ORDER BY time) AS prev_time, LAG(value) OVER (ORDER BY time) AS prev_value
            FROM ${readings(tid)}
            WHERE parameter = 'RO5-Permeateflow' AND time >= $1::timestamptz - INTERVAL '2 days'
         )
         SELECT to_char((time + INTERVAL '3 hours') AT TIME ZONE 'UTC', '${fmt}') AS k,
                SUM(((value + prev_value) / 2.0) * (EXTRACT(EPOCH FROM (time - GREATEST(prev_time, $1::timestamptz))) / 3600.0))::float AS v
         FROM ordered
         WHERE prev_time IS NOT NULL AND time > $1::timestamptz
         GROUP BY 1`, [startUtc.toISOString()]);
    const byKey = {};
    r.rows.forEach((row) => { byKey[row.k] = Number(row.v) || 0; });

    const buckets = labels.map((label, i) => ({ label, value: Math.max(0, byKey[keyOf(i)] || 0) }));
    const total = buckets.reduce((a, b) => a + b.value, 0);

    let daily = 1100;
    try {
        if (tid === MAIN) { const s = await db.getSettings(); if (Number(s.productionTarget) > 0) daily = Number(s.productionTarget); }
        else { const t = tenants.mergeConfig((await tenants.getRow(tid) || {}).config); if (Number(t.productionTarget) > 0) daily = Number(t.productionTarget); }
    } catch (_) { /* default */ }

    return {
        period, unit, buckets, total,
        target: daily * totalDays,
        dailyTarget: daily,
        elapsedFraction: Math.min(1, Math.max(0, elapsedFrac)),
        daysLeft: totalDays - daysBefore,
        generatedAt: new Date().toISOString(),
    };
}

router.get('/production-breakdown', authMiddleware.requireAuth, tenantContext, async (req, res) => {
    try {
        const period = ['today', 'week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'week';
        const ck = `${req.tenantId}:${period}`;
        const c = bCache[ck];
        if (c && Date.now() - c.at < CACHE_MS) return res.json(c.value);
        const value = await computeBreakdown(period, req.tenantId);
        bCache[ck] = { at: Date.now(), value };
        res.json(value);
    } catch (error) {
        console.error('[api] production-breakdown error:', error.message);
        res.status(500).json({ error: 'Failed to compute production breakdown' });
    }
});

module.exports = router;
