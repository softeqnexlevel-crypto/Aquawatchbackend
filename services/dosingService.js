/**
 * services/dosingService.js
 */

const {
  getDosingTotalsForDay,
  upsertDosingTotals,
} = require('../database/postgres');

const DOSING_RATE_ML_PER_SEC = 2.7 / 60;
const MAX_GAP_SEC = 65;
const FLUSH_INTERVAL_MS = 5000;
const PLANT_UTC_OFFSET_MINUTES = 3 * 60;

const state = {
  id: null,
  day: null,
  month: null,
  secondsOn: 0,
  mlDosed: 0,
  primedToday: false,
  lastOnState: false,
  lastOnAt: null,
  lastFlushedAt: 0,
  hydrated: false,
};

let hydrationPromise = null;

function dosingDayKey(timestampMs = Date.now()) {
  const date = new Date(timestampMs);
  const localMs = date.getTime() + PLANT_UTC_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMs);

  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function dosingMonthKey(timestampMs = Date.now()) {
  return dosingDayKey(timestampMs).slice(0, 7);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toTimestampMs(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function hydrate() {
  const today = dosingDayKey();
  const month = today.slice(0, 7);

  try {
    const row = await getDosingTotalsForDay(today);

    if (row) {
      state.id = row.id ?? null;
      state.day = row.day ?? today;
      state.month = row.month ?? month;
      state.secondsOn = toNumber(row.secondsOn);
      state.mlDosed = toNumber(row.mlDosed);
      state.primedToday = Boolean(row.primedToday);
      state.lastOnState = Boolean(row.lastOnState);
      state.lastOnAt = toTimestampMs(row.lastOnAt);
    } else {
      state.id = null;
      state.day = today;
      state.month = month;
      state.secondsOn = 0;
      state.mlDosed = 0;
      state.primedToday = false;
      state.lastOnState = false;
      state.lastOnAt = null;
    }

    state.lastFlushedAt = Date.now();
    state.hydrated = true;

    console.log(
      `[dosing] hydrated day=${state.day} ` +
      `secondsOn=${state.secondsOn.toFixed(2)} ` +
      `mlDosed=${state.mlDosed.toFixed(3)} ` +
      `primedToday=${state.primedToday} ` +
      `lastOnState=${state.lastOnState}`
    );

    return state;
  } catch (error) {
    console.error('[dosing] failed to hydrate dosing totals:', error);
    throw error;
  }
}

async function ensureHydrated() {
  if (state.hydrated) {
    return state;
  }

  if (!hydrationPromise) {
    hydrationPromise = hydrate().catch((error) => {
      hydrationPromise = null;
      throw error;
    });
  }

  await hydrationPromise;
  return state;
}

function rolloverIfNeeded(timestampMs = Date.now()) {
  const today = dosingDayKey(timestampMs);
  const month = today.slice(0, 7);

  if (!state.day) {
    state.day = today;
    state.month = month;
    return false;
  }

  if (state.day === today) {
    return false;
  }

  console.log(`[dosing] day rollover ${state.day} -> ${today}; resetting today's counters`);

  state.id = null;
  state.day = today;
  state.month = month;
  state.secondsOn = 0;
  state.mlDosed = 0;
  state.primedToday = false;

  return true;
}

let flushInProgress = false;
let flushQueued = false;

async function flush() {
  if (!state.hydrated) return;
  if (!state.day) return;

  if (flushInProgress) {
    flushQueued = true;
    return;
  }

  flushInProgress = true;

  try {
    await upsertDosingTotals({
      id: state.id,
      day: state.day,
      month: state.month,
      secondsOn: state.secondsOn,
      mlDosed: state.mlDosed,
      primedToday: state.primedToday,
      lastOnState: state.lastOnState,
      lastOnAt: state.lastOnAt ? new Date(state.lastOnAt) : null,
    });

    state.lastFlushedAt = Date.now();

    console.log(
      `[dosing] persisted day=${state.day} ` +
      `secondsOn=${state.secondsOn.toFixed(2)} ` +
      `mlDosed=${state.mlDosed.toFixed(3)}`
    );
  } catch (error) {
    console.error('[dosing] failed to persist dosing totals:', error);
  } finally {
    flushInProgress = false;

    if (flushQueued) {
      flushQueued = false;
      setImmediate(() => {
        flush().catch((error) => {
          console.error('[dosing] queued flush failed:', error);
        });
      });
    }
  }
}

function shouldFlush(force = false) {
  if (force) return true;
  if (!state.lastFlushedAt) return true;
  return Date.now() - state.lastFlushedAt >= FLUSH_INTERVAL_MS;
}

function normalizeOnState(rawValue) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (typeof rawValue === 'number') return rawValue !== 0;

  if (typeof rawValue === 'string') {
    const value = rawValue.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
    if (value === '0' || value === 'false' || value === 'off' || value === 'no' || value === '') return false;
  }

  return false;
}

async function recordDosingState(rawValue, timestampMs = Date.now()) {
  try {
    await ensureHydrated();

    const rolled = rolloverIfNeeded(timestampMs);
    const isOn = normalizeOnState(rawValue);
    const risingEdge = !state.lastOnState && isOn;

    if (risingEdge) {
      if (!state.primedToday) {
        state.secondsOn += 1;
        state.mlDosed += DOSING_RATE_ML_PER_SEC;
        state.primedToday = true;
        console.log(`[dosing] prime counted: ${DOSING_RATE_ML_PER_SEC.toFixed(3)} ml`);
      }
      state.lastOnAt = timestampMs;
    }

    if (isOn) {
      if (!risingEdge && state.lastOnAt !== null) {
        let elapsedSec = (timestampMs - state.lastOnAt) / 1000;

        if (!Number.isFinite(elapsedSec)) elapsedSec = 0;
        elapsedSec = Math.max(0, elapsedSec);
        elapsedSec = Math.min(elapsedSec, MAX_GAP_SEC);

        if (elapsedSec > 0) {
          state.secondsOn += elapsedSec;
          state.mlDosed += elapsedSec * DOSING_RATE_ML_PER_SEC;
        }
      }
      state.lastOnAt = timestampMs;
    } else {
      state.lastOnAt = null;
    }

    state.lastOnState = isOn;

    const forceFlush = rolled || !isOn;
    if (forceFlush || shouldFlush()) {
      await flush();
    }

    return getStateSnapshot();
  } catch (error) {
    console.error('[dosing] recordDosingState failed:', error);
    return getStateSnapshot();
  }
}

function getStateSnapshot() {
  return {
    id: state.id,
    day: state.day,
    month: state.month,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
    primedToday: state.primedToday,
    lastOnState: state.lastOnState,
    lastOnAt: state.lastOnAt ? new Date(state.lastOnAt).toISOString() : null,
    hydrated: state.hydrated,
  };
}

async function getTodayTotals() {
  await ensureHydrated();
  rolloverIfNeeded();
  return getStateSnapshot();
}

async function getMonthSummary() {
  await ensureHydrated();
  return getMonthSummaryFromDatabase();
}

async function getMonthSummaryFromDatabase() {
  const postgres = require('../database/postgres');

  if (typeof postgres.getDosingCurrentMonthTotal === 'function') {
    return postgres.getDosingCurrentMonthTotal();
  }

  return {
    month: state.month,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
  };
}

module.exports = {
  DOSING_RATE_ML_PER_SEC,
  MAX_GAP_SEC,
  recordDosingState,
  getTodayTotals,
  getMonthSummary,
  ensureHydrated,
  hydrate,
  getStateSnapshot,
};