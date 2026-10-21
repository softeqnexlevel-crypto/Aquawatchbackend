'use strict';
// services/dailySummary.js
//
// Keeps a permanent per-day record of:
//   - System run hours        (PLC tag RO5-SystemDailyRunHrs: one cycle per PLC reset, see below)
//   - Antiscalant dosed (ml)  (PLC tag RO5-AntiscalantDaily,   resets to 0 at midnight)
//
// Every minute the running value for TODAY is saved (keeping the highest value seen).
// So when the PLC resets to zero, the final value of the previous day is already
// stored as that day's row.
//
// "24 hrs ago" / yesterday.runHours = the final Daily Run Hours value before the PLC counter's
// most recent reset, see lastCompletedRunCycle() below. The stored per-day row is only a fallback.
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
const TZ_OFFSET_MS = 0;                  // the PLC's day starts at 00:00 UTC (= 03:00 Nairobi), see dosingDayKey()

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

// ─────────────────────────────────────────────────────────────────────────────
// RUN HOURS = one "cycle" of the PLC counter, from one reset to the next.
// The PLC's own daily counter does NOT reset at Nairobi midnight (seen resets: Sat 22:22, Mon 02:59),
// so a calendar-day "highest value" is wrong. Instead:
//   - when the counter drops back (e.g. 22 -> 0) the value just before the drop is that cycle's hours
//   - the cycle is filed under the Nairobi date of its MIDDLE (reset time minus 12 h), so a cycle
//     that ran mostly on Sunday is Sunday's figure even if it reset at 03:00 Monday
//   - a brief 0 that comes back up within minutes is a gateway glitch, not a reset
// ─────────────────────────────────────────────────────────────────────────────
const RESET_CONFIRM_MS = 15 * 60 * 1000;   // a drop must stand this long to count as a reset
const LOW_REPEAT_MS = 5 * 60 * 1000;       // ...or be seen again at least this much later
const HALF_DAY_MS = 12 * 60 * 60 * 1000;

// The PLC resets its daily counter at ITS midnight. The stored readings show that is 00:00 UTC
// (= 03:00 Nairobi): resets logged at 23:59:0x-23:59:5x UTC every night since 18 Oct. A drop to 0 close to that
// moment is the real reset, so it is believed after 1 minute instead of 15. Drops at any other time are
// still treated with suspicion (the gateway sometimes publishes a stray 0 and then the real value again).
const PLC_MIDNIGHT_WINDOW_MS = 10 * 60 * 1000;
function nearPlcMidnight(t) {
  const sinceUtcMidnight = ((t % 86400000) + 86400000) % 86400000;
  return sinceUtcMidnight <= PLC_MIDNIGHT_WINDOW_MS || sinceUtcMidnight >= 86400000 - PLC_MIDNIGHT_WINDOW_MS;
}
const confirmMs = (t) => (nearPlcMidnight(t) ? 60 * 1000 : RESET_CONFIRM_MS);
const lowRepeatMs = (t) => (nearPlcMidnight(t) ? 30 * 1000 : LOW_REPEAT_MS);
const HOUR_MS = 60 * 60 * 1000;

const labelForReset = (t) => dosingDayKey(new Date(t - HALF_DAY_MS));
const labelForStart = (t) => dosingDayKey(new Date(t + HALF_DAY_MS));

/** readings: [{t: ms, v: hours}] oldest first -> { cycles: [{max, startAt, resetAt}], open: {max, startAt} | null } */
function analyzeRunCycles(readings, nowMs = Date.now()) {
  const cycles = [];
  let max = null, startAt = null, pending = null;
  for (const { t, v } of readings) {
    if (!Number.isFinite(v) || v < 0 || v > 24) continue;
    if (max === null) { max = v; startAt = t - v * HOUR_MS; continue; }
    if (pending) {
      if (v >= pending.max) { max = v; pending = null; continue; }            // came back up: it was a glitch
      if (t - pending.at >= lowRepeatMs(pending.at)) {                                  // still low later: real reset
        cycles.push({ max: pending.max, startAt, resetAt: pending.at });
        startAt = pending.at; max = Math.max(pending.low, v); pending = null;
      }
      continue;
    }
    if (v < max) {
      if (max >= 2) pending = { max, at: t, low: v };                         // suspicious drop: wait and see
      else max = v;
    } else {
      max = v;
    }
  }
  if (pending && nowMs - pending.at >= confirmMs(pending.at)) {                    // drop with nothing after it
    cycles.push({ max: pending.max, startAt, resetAt: pending.at });
    startAt = pending.at; max = pending.low; pending = null;
  }
  return { cycles, open: max === null ? null : { max: pending ? pending.max : max, startAt } };
}

// ─────────────────────────────────────────────────────────────────────────────
// "24HRS AGO" = THE LAST COMPLETED DAILY-RUN-HOURS CYCLE
// Whenever the PLC's daily run-hours counter resets (e.g. 14 -> 0 at ~22:00), the value it had
// just before the reset becomes the "24hrs ago" figure - immediately (within ~15 min, which is how
// long a drop must stand to be believed), not at midnight. Brief 0 glitches that come back up
// are ignored. Uses analyzeRunCycles() on the stored readings of the last 4 days.
// ─────────────────────────────────────────────────────────────────────────────
async function lastCompletedRunCycle() {
  const { rows } = await getPool().query(
    `SELECT time, value FROM measurements
      WHERE parameter = $1 AND time > NOW() - INTERVAL '4 days'
      ORDER BY time`,
    [RUN_TAG]
  );
  const readings = rows.map((r) => ({ t: new Date(r.time).getTime(), v: Number(r.value) }));
  const { cycles } = analyzeRunCycles(readings);
  const last = cycles[cycles.length - 1];
  return last ? { hours: last.max, resetAt: new Date(last.resetAt).toISOString() } : null;
}

async function saveRunLabel(day, hours, { onlyIfHigher = false } = {}) {
  await getPool().query(
    `INSERT INTO daily_summary (day, run_hours, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (day) DO UPDATE SET
       run_hours = ${onlyIfHigher ? 'GREATEST(COALESCE(daily_summary.run_hours, 0), EXCLUDED.run_hours)' : 'EXCLUDED.run_hours'},
       updated_at = NOW()`,
    [day, hours]
  );
}

// live state, fed by sample() once a minute
let cycleMax = null;
let cycleStartAt = null;
let pendingReset = null;
let lastWritten = null;

async function trackRunHours(run) {
  if (run === null || run < 0 || run > 24) return;
  const now = Date.now();
  if (cycleMax === null) { cycleMax = run; cycleStartAt = now - run * HOUR_MS; }
  else if (pendingReset) {
    if (run >= pendingReset.max) { cycleMax = run; pendingReset = null; }      // glitch: value came back
    else if (now - pendingReset.at >= confirmMs(pendingReset.at)) {                       // still low: real reset
      const day = labelForReset(pendingReset.at);
      await saveRunLabel(day, pendingReset.max);
      console.log(`[dailySummary] counter reset detected - saved ${pendingReset.max}h for ${day}`);
      cycleStartAt = pendingReset.at; cycleMax = run; pendingReset = null; lastWritten = null;
    }
  } else if (run < cycleMax) {
    if (cycleMax >= 2) pendingReset = { max: cycleMax, at: now };
    else cycleMax = run;
  } else if (run > cycleMax) {
    cycleMax = run;
  }
  // keep the running cycle's figure up to date (never lowers an already-saved higher value)
  if (!pendingReset && cycleMax !== lastWritten) {
    await saveRunLabel(labelForStart(cycleStartAt), cycleMax, { onlyIfHigher: true });
    lastWritten = cycleMax;
  }
}

async function sample() {
  try {
    const latest = require('./plcParser').getLatestFull();   // lazy: avoids circular require
    const run = readTag(latest, RUN_TAG, RUN_FRESH_MS);     // slow hourly tag: accept up to 2h old
    let ml = readTag(latest, DOSE_TAG);
    if (ml !== null && ml < 0) ml = null;

    await trackRunHours(run);

    // Antiscalant dosed does reset at Nairobi midnight, so it stays a calendar-day figure.
    if (plantMinutesSinceMidnight() >= MIDNIGHT_GRACE_MIN) {
      const day = dosingDayKey();
      if (ml === null) {                                      // fallback: server-side dosing totalizer
        try {
          const t = await getDosingTotalsForDay(day);
          if (t && Number.isFinite(Number(t.mlDosed))) ml = Number(t.mlDosed);
        } catch (_) { /* ignore */ }
      }
      if (ml !== null) await upsertMax(day, null, ml);
    }
  } catch (err) {
    console.error('[dailySummary] sample failed:', err.message);
  }
}

// Rebuild past figures from the stored measurements (runs at start and then hourly).
async function backfill(days = 60) {
  try {
    // 1) run hours: from the counter's own resets
    const rr = await getPool().query(
      `SELECT time, value FROM measurements
        WHERE parameter = $1 AND time > NOW() - ($2 * INTERVAL '1 day')
        ORDER BY time`,
      [RUN_TAG, days + 2]
    );
    const readings = rr.rows.map((r) => ({ t: new Date(r.time).getTime(), v: Number(r.value) }));
    const { cycles, open } = analyzeRunCycles(readings);
    const byDay = new Map();
    const put = (day, v) => byDay.set(day, Math.max(byDay.has(day) ? byDay.get(day) : -1, v));
    for (const c of cycles) put(labelForReset(c.resetAt), c.max);
    if (open) put(labelForStart(open.startAt), open.max);
    for (const [day, v] of byDay) await saveRunLabel(day, v);
    if (open && cycleMax === null) { cycleMax = open.max; cycleStartAt = open.startAt; lastWritten = open.max; }

    // 2) antiscalant dosed: highest value per Nairobi calendar day
    const dd = await getPool().query(
      `SELECT to_char((time AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, MAX(value) AS v
         FROM measurements
        WHERE parameter = $1 AND time > NOW() - ($2 * INTERVAL '1 day')
          AND (time AT TIME ZONE '${TZ}')::time >= TIME '00:${String(MIDNIGHT_GRACE_MIN).padStart(2, '0')}'
        GROUP BY 1`,
      [DOSE_TAG, days]
    );
    const today = dosingDayKey();
    let n = 0;
    for (const r of dd.rows) {
      if (r.day >= today) continue;                          // today is handled by sample()
      await upsertMax(r.day, null, Number(r.v));
      n++;
    }
    console.log(`[dailySummary] backfilled ${byDay.size} run-hour cycle(s) and ${n} antiscalant day(s) from measurements`);
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

// Hours the plant really ran on one PLC day (00:00-24:00 UTC), from the stored feed flow
// (running = feed flow above 1 m3/h; gaps over 15 min are skipped, not guessed).
async function runtimeFromFlow(day) {
  const [y, m, d] = day.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d) - TZ_OFFSET_MS;
  const endMs = startMs + 24 * HOUR_MS;
  const r = await getPool().query(
    `SELECT time, value FROM measurements
      WHERE parameter = 'RO5-FEEDFlow' AND time >= $1 AND time < $2 ORDER BY time`,
    [new Date(startMs - HOUR_MS), new Date(endMs)]
  );
  if (r.rows.length < 2) return null;
  let ms = 0, prev = null;
  for (const row of r.rows) {
    const t = new Date(row.time).getTime();
    const v = Number(row.value);
    if (prev && t > startMs) {
      const dt = t - Math.max(prev.t, startMs);
      if (dt > 0 && dt <= 15 * 60 * 1000 && prev.v > 1) ms += dt;
    }
    prev = { t, v };
  }
  return Math.round((ms / HOUR_MS) * 100) / 100;
}

// { today, yesterday }
// yesterday.runHours = the final Daily Run Hours value before the PLC counter's most recent reset
// (so it updates when the daily counter resets, not at midnight). If no reset is found in the
// stored readings, it falls back to the saved per-day row.
async function getSummary() {
  const now = new Date();
  const todayKey = dosingDayKey(now);
  const yesterdayKey = dosingDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  let cycle = null;
  try {
    cycle = await lastCompletedRunCycle();
  } catch (err) {
    console.error('[dailySummary] lastCompletedRunCycle failed:', err.message);
  }

  const [today, yesterday] = await Promise.all([getDay(todayKey), getDay(yesterdayKey)]);
  const y = yesterday || { day: yesterdayKey, runHours: null, antiscalantMl: null };
  let hours = cycle ? cycle.hours : y.runHours;
  let source = cycle ? 'plc-cycle' : (y.runHours !== null ? 'plc-day' : null);
  if (hours === null) {
    // No PLC figure at all: work the running time out from the stored feed flow instead.
    try {
      const h = await runtimeFromFlow(yesterdayKey);
      if (h !== null) { hours = h; source = 'flow'; }
    } catch (err) { console.error('[dailySummary] flow runtime failed:', err.message); }
  }
  return {
    today: today || { day: todayKey, runHours: null, antiscalantMl: null },
    yesterday: {
      ...y,
      runHours: hours,
      runHoursSource: source,
      resetAt: cycle ? cycle.resetAt : null,
    },
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

module.exports = {
  start, stop, sample,
  getSummary, getRange, getHistory, getDay,
  analyzeRunCycles, lastCompletedRunCycle,
};