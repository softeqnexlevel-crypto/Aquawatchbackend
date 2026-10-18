'use strict';
// services/dailySummary.js
//
// Keeps a permanent per-day record of:
//   - System run hours        (PLC tag RO5-SystemDailyRunHrs, resets to 0 at midnight)
//   - Antiscalant dosed (ml)  (PLC tag RO5-AntiscalantDaily,   resets to 0 at midnight)
//
// Every minute the running value for TODAY is saved (keeping the highest value seen).
// So when the PLC resets to zero, the final value of the previous day is already
// stored as that day's row. "24 hrs ago" = the previous calendar day (Nairobi time).
//
// Table: daily_summary(day TEXT PRIMARY KEY 'YYYY-MM-DD', run_hours, antiscalant_ml, updated_at)

const { getPool, getDosingTotalsForDay, dosingDayKey } = require('../database/postgres');

const RUN_TAG = 'RO5-SystemDailyRunHrs';
const DOSE_TAG = 'RO5-AntiscalantDaily';
const SAMPLE_EVERY_MS = 60 * 1000;
const FRESH_MS = 5 * 60 * 1000;          // ignore readings older than 5 min (PLC offline)
const RUN_FRESH_MS = 2 * 60 * 60 * 1000;
const MIDNIGHT_GRACE_MIN = 10;           // skip sampling right after midnight (PLC reset may lag)
const TZ = 'Africa/Nairobi';             // UTC+3, no DST
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

let timer = null;

function plantMinutesSinceMidnight(now = new Date()) {
  const w = new Date(now.getTime() + TZ_OFFSET_MS);
  return w.getUTCHours() * 60 + w.getUTCMinutes() + w.getUTCSeconds() / 60;
}

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS daily_summary (
      day TEXT PRIMARY KEY,
      run_hours DOUBLE PRECISION,
      antiscalant_ml DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function readTag(latest, key, freshMs = FRESH_MS) {
  const rec = latest && latest[key];
  if (!rec) return null;
  const v = Number(rec.value);
  if (!Number.isFinite(v)) return null;
  const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : Date.now();
  if (!Number.isFinite(ts) || Date.now() - ts > freshMs) return null;
  return v;
}

async function upsertMax(day, runHours, ml) {
  await getPool().query(
    `INSERT INTO daily_summary (day, run_hours, antiscalant_ml, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (day) DO UPDATE SET
       run_hours = CASE
         WHEN EXCLUDED.run_hours IS NULL THEN daily_summary.run_hours
         ELSE GREATEST(COALESCE(daily_summary.run_hours, 0), EXCLUDED.run_hours) END,
       antiscalant_ml = CASE
         WHEN EXCLUDED.antiscalant_ml IS NULL THEN daily_summary.antiscalant_ml
         ELSE GREATEST(COALESCE(daily_summary.antiscalant_ml, 0), EXCLUDED.antiscalant_ml) END,
       updated_at = NOW()`,
    [day, runHours, ml]
  );
}

// Run-hours counter tracking: the PLC counter resets to 0 (around 22:00 Nairobi).
// When it drops, the value just before the drop is the finished day's run hours.
let cycleMax = null;
let pendingReset = null;
const RESET_CONFIRM_MS = 15 * 60 * 1000;

async function saveCompletedCycle(day, hours) {
  await getPool().query(
    `INSERT INTO daily_summary (day, run_hours, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (day) DO UPDATE SET run_hours = EXCLUDED.run_hours, updated_at = NOW()`,
    [day, hours]
  );
  console.log(`[dailySummary] counter reset detected - saved ${hours}h for ${day}`);
}

async function sample() {
  try {
    const mins = plantMinutesSinceMidnight();
    if (mins < MIDNIGHT_GRACE_MIN) return;               // PLC counter may not have reset yet

    const latest = require('./plcParser').getLatestFull();   // lazy: avoids circular require
    let run = readTag(latest, RUN_TAG, RUN_FRESH_MS);   // slow hourly tag: accept up to 2h old
    let ml = readTag(latest, DOSE_TAG);

    // The PLC counter resets around 22:00 Nairobi (not midnight), so only check 0..24
    if (run !== null && (run < 0 || run > 24)) run = null;
    if (ml !== null && ml < 0) ml = null;

    // Reset detection. The PLC sometimes sends a brief 0 (a few minutes) and then returns to the
    // real value - that is a glitch, not a new day. A drop only counts as a reset if the value is
    // STILL lower than before after RESET_CONFIRM_MS. Then the previous value is saved.
    if (run !== null) {
      const now = Date.now();
      if (pendingReset) {
        if (run >= pendingReset.max) {                       // came back: it was a glitch
          cycleMax = run; pendingReset = null;
        } else if (now - pendingReset.at >= RESET_CONFIRM_MS) {  // still low: real reset
          await saveCompletedCycle(pendingReset.day, pendingReset.max);
          cycleMax = run; pendingReset = null;
        }
      } else if (cycleMax !== null && run < cycleMax) {
        if (cycleMax >= 2) pendingReset = { max: cycleMax, at: now, day: dosingDayKey() };
        else cycleMax = run;
      } else if (cycleMax === null || run > cycleMax) {
        cycleMax = run;
      }
    }

    const day = dosingDayKey();

    // Fallback for antiscalant: the server-side dosing totalizer (dosing_totals table)
    if (ml === null) {
      try {
        const t = await getDosingTotalsForDay(day);
        if (t && Number.isFinite(Number(t.mlDosed))) ml = Number(t.mlDosed);
      } catch (_) { /* ignore */ }
    }

    if (run === null && ml === null) return;
    await upsertMax(day, run, ml);
  } catch (err) {
    console.error('[dailySummary] sample failed:', err.message);
  }
}

// One-time fill of past days from the measurements table (if those tags were stored there)
async function backfill(days = 60) {
  try {
    const q = (tag) => getPool().query(
      `SELECT to_char((time AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, MAX(value) AS v
         FROM measurements
        WHERE parameter = $1
          AND time > NOW() - ($2 * INTERVAL '1 day')
          AND (time AT TIME ZONE '${TZ}')::time >= TIME '00:${String(MIDNIGHT_GRACE_MIN).padStart(2, '0')}'
        GROUP BY 1`,
      [tag, days]
    );
    const [runs, doses] = await Promise.all([q(RUN_TAG), q(DOSE_TAG)]);
    const map = new Map();
    for (const r of runs.rows) map.set(r.day, { run: Number(r.v), ml: null });
    for (const r of doses.rows) {
      const e = map.get(r.day) || { run: null, ml: null };
      e.ml = Number(r.v);
      map.set(r.day, e);
    }
    const today = dosingDayKey();
    let n = 0;
    for (const [day, e] of map) {
      if (day >= today) continue;                       // today is handled by sample()
      if (e.run !== null && (e.run < 0 || e.run > 24)) e.run = null;
      await upsertMax(day, e.run, e.ml);
      n++;
    }
    console.log(`[dailySummary] backfilled ${n} past day(s) from measurements`);
  } catch (err) {
    console.error('[dailySummary] backfill failed:', err.message);
  }
}

function rowOut(r) {
  if (!r) return null;
  return {
    day: r.day,
    runHours: r.run_hours === null ? null : Number(r.run_hours),
    antiscalantMl: r.antiscalant_ml === null ? null : Number(r.antiscalant_ml),
  };
}

async function getDay(day) {
  const r = await getPool().query('SELECT * FROM daily_summary WHERE day = $1', [day]);
  return rowOut(r.rows[0]);
}

// { today, yesterday }  ("yesterday" = Antiscalant dosed 24hrs ago / System run 24hrs ago)
async function getSummary() {
  const now = new Date();
  const todayKey = dosingDayKey(now);
  const yesterdayKey = dosingDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const [today, yesterday] = await Promise.all([getDay(todayKey), getDay(yesterdayKey)]);
  return {
    today: today || { day: todayKey, runHours: null, antiscalantMl: null },
    yesterday: yesterday || { day: yesterdayKey, runHours: null, antiscalantMl: null },
  };
}

// For reports: inclusive range of day keys 'YYYY-MM-DD', oldest first
async function getRange(fromDay, toDay) {
  const r = await getPool().query(
    'SELECT * FROM daily_summary WHERE day >= $1 AND day <= $2 ORDER BY day ASC',
    [fromDay, toDay]
  );
  return r.rows.map(rowOut);
}

async function getHistory(days = 30) {
  const n = Math.max(1, Math.min(Number(days) || 30, 730));
  const from = dosingDayKey(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
  return getRange(from, dosingDayKey());
}

async function start() {
  await ensureTable();
  await backfill();
  if (timer) clearInterval(timer);
  timer = setInterval(sample, SAMPLE_EVERY_MS);
  if (timer.unref) timer.unref();
  setTimeout(sample, 15 * 1000);
  // re-run backfill hourly (last 3 days) so any missed readings are recovered from stored history
  const bf = setInterval(() => backfill(3), 60 * 60 * 1000);
  if (bf.unref) bf.unref();
  console.log('[dailySummary] started (saving daily run hours + antiscalant every 60s)');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, sample, getSummary, getRange, getHistory, getDay };