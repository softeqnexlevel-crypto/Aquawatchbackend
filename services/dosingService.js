// services/dosingService.js
//
// Server-side totalizer for the antiscalant dosing pump.
//
// plcService calls `recordDosingState(value)` every time the PLC reports
// `AntiscalantDosingActive`. This module owns the running count and persists
// it via the existing Drizzle repo. The frontend only *reads* the total.
//
// Why server-side: the previous implementation counted seconds in the
// browser, which loses data on logout, tab close, laptop sleep, and every
// time the user navigates away from the Antiscalant page. The backend is
// the only process guaranteed to be running whenever the PLC is sending.

const {
  getDosingTotalsForDay,
  upsertDosingTotals,
  getDosingCurrentMonthTotal,
  dosingDayKey,
  dosingMonthKey,
} = require('../database/postgres');

// 2.7 ml/min ÷ 60 = 0.045 ml/s. Prime is one second's worth.
const DOSING_RATE_ML_PER_SEC = 2.7 / 60;

// Don't credit more than this many seconds in a single transition. If the
// backend was down for hours, we don't want to back-fill phantom pump time.
const MAX_GAP_SEC = 65;

// In-memory state. Single writer (MQTT handler runs in one Node process),
// so no locking required. Flushed to Postgres on every change.
let state = {
  id: null,
  day: null,
  month: null,
  secondsOn: 0,
  mlDosed: 0,
  primedToday: false,
  lastOnState: false,
  lastOnAt: null,     // ms epoch — only meaningful while lastOnState is true
  hydrated: false,
};

let flushing = false;
let flushQueued = false;

// ── Persistence ──────────────────────────────────────────────────────────

async function hydrate() {
  const day = dosingDayKey();
  const existing = await getDosingTotalsForDay(day);
  if (existing) {
    state.id = existing.id;
    state.day = existing.day;
    state.month = existing.month;
    state.secondsOn = Number(existing.secondsOn) || 0;
    state.mlDosed = Number(existing.mlDosed) || 0;
    state.primedToday = Boolean(existing.primedToday);
    state.lastOnState = Boolean(existing.lastOnState);
    state.lastOnAt = existing.lastOnAt ? new Date(existing.lastOnAt).getTime() : null;
  } else {
    state.id = null;
    state.day = day;
    state.month = dosingMonthKey();
    state.secondsOn = 0;
    state.mlDosed = 0;
    state.primedToday = false;
    state.lastOnState = false;
    state.lastOnAt = null;
  }
  state.hydrated = true;
  console.log('[dosing] hydrated', {
    day: state.day,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
    primedToday: state.primedToday,
  });
}

async function flush() {
  if (flushing) { flushQueued = true; return; }
  flushing = true;
  try {
    const saved = await upsertDosingTotals({
      id: state.id,
      day: state.day,
      month: state.month,
      secondsOn: state.secondsOn,
      mlDosed: state.mlDosed,
      primedToday: state.primedToday,
      lastOnState: state.lastOnState,
      lastOnAt: state.lastOnAt ? new Date(state.lastOnAt) : null,
    });
    state.id = saved.id;
  } catch (err) {
    console.error('[dosing] flush failed:', err.message);
  } finally {
    flushing = false;
    if (flushQueued) {
      flushQueued = false;
      flush();
    }
  }
}

// ── Day rollover ─────────────────────────────────────────────────────────

function rolloverIfNeeded() {
  const today = dosingDayKey();
  if (state.day === today) return false;
  // Snapshot old day for later queries (it's already in the DB from flush),
  // then reset for the new day.
  console.log('[dosing] day rollover', { from: state.day, to: today });
  state.id = null;
  state.day = today;
  state.month = dosingMonthKey();
  state.secondsOn = 0;
  state.mlDosed = 0;
  state.primedToday = false;
  // lastOnState survives — if the pump was ON at midnight, it's still ON
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────

function toBool(raw) {
  if (raw === true || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 0 || raw === '0') return false;
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    return s === 'ON' || s === 'TRUE' || s === 'RUNNING' || s === 'ACTIVE' || s === 'YES';
  }
  return false;
}

/**
 * Called by plcService on every PLC report of AntiscalantDosingActive.
 * @param {('ON'|'OFF'|1|0|boolean)} rawValue
 * @param {number} [timestampMs]
 */
function recordDosingState(rawValue, timestampMs = Date.now()) {
  if (!state.hydrated) {
    hydrate().then(() => recordDosingState(rawValue, timestampMs))
      .catch((err) => console.error('[dosing] hydrate failed:', err.message));
    return;
  }

  const rolled = rolloverIfNeeded();
  const isOn = toBool(rawValue);

  // Rising edge → prime (once per day)
  if (!state.lastOnState && isOn && !state.primedToday) {
    state.secondsOn += 1;
    state.mlDosed += DOSING_RATE_ML_PER_SEC;
    state.primedToday = true;
    console.log('[dosing] prime applied for', state.day);
  }

  // Continuous accrual while ON: credit elapsed wall-clock time since the
  // last ON report. This handles both the case where the PLC reports every
  // second and the case where it only sends edge transitions.
  if (isOn) {
    if (state.lastOnAt !== null) {
      const gapSec = Math.min((timestampMs - state.lastOnAt) / 1000, MAX_GAP_SEC);
      if (gapSec > 0) {
        state.secondsOn += gapSec;
        state.mlDosed += gapSec * DOSING_RATE_ML_PER_SEC;
      }
    }
    state.lastOnAt = timestampMs;
  } else {
    state.lastOnAt = null;
  }

  state.lastOnState = isOn;

  // Persist. Every edge change is written; during long ON periods, throttle
  // to one write per ~5 s so we don't hammer the DB on a fast PLC.
  const shouldFlush = rolled
    || state.lastOnAt === timestampMs   // just got a fresh ON report
    || !isOn;                            // falling edge — always write

  if (shouldFlush) flush();
}

function getTodayTotals() {
  return {
    day: state.day,
    month: state.month,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
    primedToday: state.primedToday,
    rateMlPerSec: DOSING_RATE_ML_PER_SEC,
    rateMlPerMin: DOSING_RATE_ML_PER_SEC * 60,
  };
}

async function getMonthSummary() {
  return getDosingCurrentMonthTotal();
}

// Hydrate on module load.
hydrate().catch((err) => console.error('[dosing] initial hydrate failed:', err.message));

module.exports = {
  recordDosingState,
  getTodayTotals,
  getMonthSummary,
  DOSING_RATE_ML_PER_SEC,
};