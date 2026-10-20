'use strict';
// routes/dosingOverview.routes.js
//   GET /api/dosing-overview
//   -> {
//        intervals: [{ label: '14:00', start, end, minutes }],   // 12 x 2-hour intervals, oldest first,
//                                                                // the last one is the current, still running interval
//        rateMlPerMin: 3.2 | null,                               // average ml/min while the pump ran (same window)
//        totalMinutes: 410.5,
//        totalMl: 1310,
//        generatedAt: '...'
//      }
//
// HOW MINUTES ARE COUNTED
//   The dosing pump bit (RO5-AntiscalantDosingActive) is read from the stored `measurements` table.
//   Every reading is held ("sample-and-hold") until the next reading, so a pump that was ON between
//   two readings counts for that whole time. A reading is never held longer than MAX_HOLD_MS, so a
//   PLC / data outage is NOT counted as dosing time.
//
// ASSUMPTIONS (adjust if your schema differs)
//   - table `measurements(time, parameter, value)`   (same one dailySummary.js reads)
//   - the pump bit is stored as 1/0 (or any number >= 0.5 for ON)
//   - the antiscalant daily counter (ml) is RO5-AntiscalantDaily and resets at Nairobi midnight
//
// MOUNT IT BEFORE the generic /api router in server.js, so it wins over any older handler:
//   app.use('/api/dosing-overview', require('./routes/dosingOverview.routes'));
//   app.use('/api', apiRoutes);

const express = require('express');
const { getPool } = require('../database/postgres');

const am = require('../middleware/auth.middleware');
const auth = typeof am === 'function'
  ? am
  : (am.authenticate || am.authMiddleware || am.verifyToken || am.protect || am.requireAuth);
if (typeof auth !== 'function') {
  throw new Error('dosingOverview.routes: could not find the auth middleware function in ../middleware/auth.middleware');
}

const router = express.Router();

// ── constants ───────────────────────────────────────────────────────────────
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;        // Africa/Nairobi = UTC+3, no DST
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const STEP_MS = 2 * HOUR_MS;                    // one bar = 2 hours
const BUCKETS = 12;                             // 12 bars = 24 hours
const MAX_HOLD_MS = 30 * MIN_MS;                // never count a single reading for longer than this
const LOOKBACK_MS = 6 * HOUR_MS;                // readings before the window, to know the state at its start

// the pump bit can be stored under several names depending on the gateway mapping
const PUMP_TAGS = [
  'RO5-AntiscalantDosingActive',
  'RO5-AntiscalantDoser',
  'AntiscalantDosingActive',
  'AntiscalantDoser',
  'siemens200smart-RO5-AntiscalantDosingActive',
  'siemens200smart-RO5-AntiscalantDoser',
];
const DOSE_TAG = 'RO5-AntiscalantDaily';

const pad2 = (n) => String(n).padStart(2, '0');
const localHourLabel = (utcMs) => `${pad2(new Date(utcMs + TZ_OFFSET_MS).getUTCHours())}:00`;

// ── minutes the pump ran in each interval ───────────────────────────────────
function minutesPerBucket(points, buckets, nowMs) {
  const mins = buckets.map(() => 0);
  for (let i = 0; i < points.length; i++) {
    if (!points[i].on) continue;
    const a = points[i].t;
    const nextT = i + 1 < points.length ? points[i + 1].t : nowMs;
    const b = Math.min(nextT, a + MAX_HOLD_MS, nowMs);
    if (b <= a) continue;
    buckets.forEach((bk, idx) => {
      const overlap = Math.min(b, bk.end, nowMs) - Math.max(a, bk.start);
      if (overlap > 0) mins[idx] += overlap / MIN_MS;
    });
  }
  return mins;
}

// ── ml dosed in the window, from the PLC's daily counter ────────────────────
// The counter only goes up during a day and resets to ~0 at Nairobi midnight.
// A drop is counted as a reset only when the two readings straddle a local midnight;
// any other drop is a gateway glitch and is ignored.
function mlDosedInWindow(readings, windowStart) {
  const localDay = (t) => Math.floor((t + TZ_OFFSET_MS) / DAY_MS);
  let total = 0;
  let prev = null;
  for (const r of readings) {
    if (prev === null) { prev = r; continue; }
    let delta = null;
    if (r.v >= prev.v) delta = r.v - prev.v;                       // normal increase
    else if (localDay(r.t) !== localDay(prev.t)) delta = r.v;      // midnight reset: restarted from 0
    if (delta === null) continue;                                  // any other drop = glitch, ignore it
    if (r.t > windowStart) total += delta;
    prev = r;
  }
  return total;
}

router.get('/', auth, async (req, res) => {
  try {
    const nowMs = Date.now();

    // current interval starts at the latest even Nairobi hour (00, 02, 04 ... 22)
    const curStart = Math.floor((nowMs + TZ_OFFSET_MS) / STEP_MS) * STEP_MS - TZ_OFFSET_MS;
    const firstStart = curStart - (BUCKETS - 1) * STEP_MS;
    const buckets = Array.from({ length: BUCKETS }, (_, i) => {
      const start = firstStart + i * STEP_MS;
      return { start, end: start + STEP_MS, label: localHourLabel(start) };
    });

    const pool = getPool();
    const from = new Date(firstStart - LOOKBACK_MS);
    const to = new Date(nowMs);

    const [pumpRes, doseRes] = await Promise.all([
      pool.query(
        `SELECT time, value FROM measurements
          WHERE parameter = ANY($1) AND time >= $2 AND time <= $3
          ORDER BY time`,
        [PUMP_TAGS, from, to]
      ),
      pool.query(
        `SELECT time, value FROM measurements
          WHERE parameter = $1 AND time >= $2 AND time <= $3
          ORDER BY time`,
        [DOSE_TAG, from, to]
      ),
    ]);

    const pumpPoints = pumpRes.rows
      .map((r) => ({ t: new Date(r.time).getTime(), on: Number(r.value) >= 0.5 }))
      .filter((p) => Number.isFinite(p.t));

    const mins = minutesPerBucket(pumpPoints, buckets, nowMs);
    const totalMinutes = mins.reduce((a, b) => a + b, 0);

    const doseReadings = doseRes.rows
      .map((r) => ({ t: new Date(r.time).getTime(), v: Number(r.value) }))
      .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v) && r.v >= 0);
    const totalMl = mlDosedInWindow(doseReadings, firstStart);

    res.json({
      intervals: buckets.map((bk, i) => ({
        label: bk.label,
        start: new Date(bk.start).toISOString(),
        end: new Date(bk.end).toISOString(),
        minutes: Math.round(mins[i] * 10) / 10,
      })),
      rateMlPerMin: totalMinutes >= 1 ? Math.round((totalMl / totalMinutes) * 10) / 10 : null,
      totalMinutes: Math.round(totalMinutes * 10) / 10,
      totalMl: Math.round(totalMl),
      generatedAt: new Date(nowMs).toISOString(),
    });
  } catch (err) {
    console.error('[dosing-overview] failed:', err.message);
    res.status(500).json({ error: 'Failed to load dosing overview' });
  }
});

module.exports = router;