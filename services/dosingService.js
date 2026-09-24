// services/dosingService.js
//
// Server-side totalizer for the antiscalant dosing pump.
//
// plcService calls `recordDosingState(value)` every time the PLC reports
// `AntiscalantDosingActive`. This module owns the running count, keeps it
// accurate with a 1-second server tick (independent of PLC report rate and of
// any logged-in user), handles midnight rollover, and persists to Postgres.
// The frontend only READS the totals.
//
// Env:
//   DOSING_STALE_SEC  Max seconds the pump is credited after the last PLC
//                     report (default 65). If your PLC only publishes on
//                     CHANGE (not periodically), set this high (e.g. 86400)
//                     so a long ON period keeps counting.

const {
  getDosingTotalsForDay,
  upsertDosingTotals,
  getDosingHistoryForMonth,
  dosingDayKey,
  dosingMonthKey,
} = require('../database/postgres');

// 2.7 ml/min ÷ 60 = 0.045 ml/s. Prime is one second's worth.
const DOSING_RATE_ML_PER_SEC = 2.7 / 60;

const PLANT_TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // Africa/Nairobi, UTC+3, no DST
const STALE_SEC = Number(process.env.DOSING_STALE_SEC) > 0 ? Number(process.env.DOSING_STALE_SEC) : 65;
const STALE_MS = STALE_SEC * 1000;
const FLUSH_INTERVAL_MS = 5000;
const TICK_MS = 1000;

// ── State ────────────────────────────────────────────────────────────────

const state = {
  id: null,
  day: null,
  month: null,
  dayEndMs: 0,          // UTC ms of the next plant-local midnight
  secondsOn: 0,
  mlDosed: 0,
  primedToday: false,
  lastOnState: false,
  lastOnAt: null,       // ms epoch up to which ON time has been credited
  hydrated: false,
};

let lastReportAt = 0;   // ms epoch of the last PLC report
let lastFlushAt = 0;
let lastHydrateTry = 0;
let hydratePromise = null;
let writeChain = Promise.resolve();
const pending = [];     // reports that arrived before hydration finished

// ── Helpers ──────────────────────────────────────────────────────────────

function endOfDayMs(ms) {
  const wall = new Date(ms + PLANT_TZ_OFFSET_MS);
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1) - PLANT_TZ_OFFSET_MS;
}

function toBool(raw) {
  if (raw === true || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 0 || raw === '0') return false;
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    return s === 'ON' || s === 'TRUE' || s === 'RUNNING' || s === 'ACTIVE' || s === 'YES';
  }
  return false;
}

// ── Persistence ──────────────────────────────────────────────────────────

async function hydrate() {
  const nowMs = Date.now();
  const day = dosingDayKey(new Date(nowMs));
  const existing = await getDosingTotalsForDay(day);

  if (existing) {
    state.id = existing.id;
    state.day = existing.day;
    state.month = existing.month;
    state.secondsOn = Number(existing.secondsOn) || 0;
    state.mlDosed = Number(existing.mlDosed) || 0;
    state.primedToday = Boolean(existing.primedToday);
    state.lastOnState = Boolean(existing.lastOnState);
  } else {
    state.id = null;
    state.day = day;
    state.month = dosingMonthKey(new Date(nowMs));
    state.secondsOn = 0;
    state.mlDosed = 0;
    state.primedToday = false;
    state.lastOnState = false;
  }

  // We can't know what happened while the backend was down, so never credit
  // that gap. Accrual resumes at the next PLC report.
  state.lastOnAt = null;
  lastReportAt = 0;
  state.dayEndMs = endOfDayMs(nowMs);
  state.hydrated = true;

  console.log('[dosing] hydrated', {
    day: state.day,
    secondsOn: Math.round(state.secondsOn),
    mlDosed: Number(state.mlDosed.toFixed(3)),
    primedToday: state.primedToday,
    staleSec: STALE_SEC,
  });

  drainPending();
}

function ensureHydrated() {
  if (!hydratePromise) {
    hydratePromise = hydrate().catch((err) => {
      hydratePromise = null; // allow retry
      if (!/not initialized/i.test(err.message)) {
        console.error('[dosing] hydrate failed:', err.message);
      }
      throw err;
    });
  }
  return hydratePromise;
}

// Writes are serialised and use a snapshot, so a rollover can never cause the
// old day's final numbers to be overwritten by the new day's.
function flush() {
  lastFlushAt = Date.now();
  const snap = {
    id: state.id,
    day: state.day,
    month: state.month,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
    primedToday: state.primedToday,
    lastOnState: state.lastOnState,
    lastOnAt: state.lastOnAt ? new Date(state.lastOnAt) : null,
  };
  writeChain = writeChain.then(async () => {
    try {
      const saved = await upsertDosingTotals(snap);
      if (saved && snap.day === state.day && !state.id) state.id = saved.id;
    } catch (err) {
      console.error('[dosing] flush failed:', err.message);
    }
  });
  return writeChain;
}

function flushNow() {
  return state.hydrated ? flush() : Promise.resolve();
}

// ── Accrual + rollover ───────────────────────────────────────────────────

// Credit ON time from lastOnAt up to `toMs`, but never further than
// STALE_MS after the last PLC report (so a dead PLC/backend gap isn't back-filled).
function accrueTo(toMs) {
  if (!state.lastOnState || state.lastOnAt === null) return;
  const until = Math.min(toMs, lastReportAt + STALE_MS);
  const dt = (until - state.lastOnAt) / 1000;
  if (dt <= 0) return;
  state.secondsOn += dt;
  state.mlDosed += dt * DOSING_RATE_ML_PER_SEC;
  state.lastOnAt = until;
}

// Split accrual exactly at plant-local midnight, persist the finished day,
// then start the new day. lastOnState survives (pump ON at midnight stays ON).
function rollDay(nowMs) {
  let rolled = false;
  while (nowMs >= state.dayEndMs) {
    const boundary = state.dayEndMs;
    accrueTo(boundary);

    if (state.id || state.secondsOn > 0 || state.mlDosed > 0) flush();

    const carryOn = state.lastOnState && state.lastOnAt === boundary;
    const boundaryDate = new Date(boundary);
    console.log('[dosing] day rollover', { from: state.day, to: dosingDayKey(boundaryDate) });

    state.id = null;
    state.day = dosingDayKey(boundaryDate);
    state.month = dosingMonthKey(boundaryDate);
    state.secondsOn = 0;
    state.mlDosed = 0;
    state.primedToday = false;
    state.lastOnAt = carryOn ? boundary : null;
    state.dayEndMs = endOfDayMs(boundary);
    rolled = true;
  }
  return rolled;
}

// ── PLC entry point ──────────────────────────────────────────────────────

function applyReport(rawValue, timestampMs) {
  const isOn = toBool(rawValue);
  const wasOn = state.lastOnState;

  // Never let time go backwards (out-of-order / clock-skewed reports)
  const ts = Math.max(timestampMs, lastReportAt, state.lastOnAt || 0);

  const rolled = rollDay(ts);
  const gapped = wasOn && lastReportAt > 0 && ts - lastReportAt > STALE_MS;

  accrueTo(ts); // credits time up to this report (incl. the falling edge)

  // Rising edge → startup prime, once per day
  if (!wasOn && isOn && !state.primedToday) {
    state.secondsOn += 1;
    state.mlDosed += DOSING_RATE_ML_PER_SEC;
    state.primedToday = true;
    console.log('[dosing] prime applied for', state.day);
  }

  lastReportAt = ts;
  state.lastOnState = isOn;
  if (!isOn) state.lastOnAt = null;
  else if (gapped || state.lastOnAt === null) state.lastOnAt = ts; // don't back-fill silence

  if (rolled || isOn !== wasOn) flush(); // edges are written immediately
}

function drainPending() {
  while (pending.length) {
    const r = pending.shift();
    applyReport(r.raw, r.ts);
  }
}

/**
 * Called by plcService on every PLC report of AntiscalantDosingActive.
 * @param {('ON'|'OFF'|1|0|boolean)} rawValue
 * @param {number} [timestampMs]
 */
function recordDosingState(rawValue, timestampMs = Date.now()) {
  if (!state.hydrated) {
    if (pending.length < 100) pending.push({ raw: rawValue, ts: timestampMs });
    ensureHydrated().catch(() => {});
    return;
  }
  applyReport(rawValue, timestampMs);
}

// ── 1-second server tick: accrual + rollover + periodic persistence ──────

function tick() {
  const now = Date.now();

  if (!state.hydrated) {
    if (now - lastHydrateTry >= 5000) {
      lastHydrateTry = now;
      ensureHydrated().catch(() => {});
    }
    return;
  }

  const rolled = rollDay(now);
  accrueTo(now);

  if (!rolled && state.lastOnState && state.lastOnAt !== null && now - lastFlushAt >= FLUSH_INTERVAL_MS) {
    flush();
  }
}

const tickTimer = setInterval(tick, TICK_MS);
if (tickTimer.unref) tickTimer.unref();

// ── Read API (used by routes) ────────────────────────────────────────────

function getTodayTotals() {
  const now = Date.now();
  if (state.hydrated) {
    rollDay(now);
    accrueTo(now);
  }
  return {
    hydrated: state.hydrated,
    day: state.day,
    month: state.month,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
    primedToday: state.primedToday,
    isOn: state.lastOnState,
    // true only while the server is actively crediting time right now
    accruing: state.lastOnState && state.lastOnAt !== null && now <= lastReportAt + STALE_MS,
    rateMlPerSec: DOSING_RATE_ML_PER_SEC,
    rateMlPerMin: DOSING_RATE_ML_PER_SEC * 60,
    serverTime: now,
  };
}

// One entry per day for `month` (YYYY-MM). Today's row uses the live
// in-memory values, so it's never up to 5 s behind the database.
async function getMonthHistory(month) {
  const rows = await getDosingHistoryForMonth(month);
  const days = rows.map((r) => ({
    day: r.day,
    secondsOn: Number(r.secondsOn) || 0,
    mlDosed: Number(r.mlDosed) || 0,
    primedToday: Boolean(r.primedToday),
  }));

  if (state.hydrated && state.month === month) {
    const live = {
      day: state.day,
      secondsOn: state.secondsOn,
      mlDosed: state.mlDosed,
      primedToday: state.primedToday,
    };
    const i = days.findIndex((d) => d.day === state.day);
    if (i >= 0) days[i] = live;
    else if (state.secondsOn > 0 || state.mlDosed > 0) days.push(live);
  }

  return days.sort((a, b) => a.day.localeCompare(b.day));
}

async function getMonthSummary() {
  const month = dosingMonthKey();
  const days = await getMonthHistory(month);
  return {
    month,
    mlDosed: days.reduce((s, d) => s + d.mlDosed, 0),
    secondsOn: days.reduce((s, d) => s + d.secondsOn, 0),
    dayCount: days.length,
  };
}

module.exports = {
  recordDosingState,
  getTodayTotals,
  getMonthSummary,
  getMonthHistory,
  flushNow,
  DOSING_RATE_ML_PER_SEC,
};