/**
 * services/dosingService.js
 *
 * Antiscalant dosing totalizer.
 *
 * IMPORTANT:
 * - The PLC is the source of ON/OFF state.
 * - The browser/dashboard is NOT involved in accumulation.
 * - PostgreSQL persists the daily total.
 * - Logging out of the dashboard must not affect dosing totals.
 * - Totals reset automatically when the plant-local calendar day changes.
 */

const {
  getDosingTotalsForDay,
  upsertDosingTotals,
} = require('../database/postgres');

// ============================================================
// CONFIGURATION
// ============================================================

/**
 * Pump dosing rate.
 *
 * Existing system:
 * 2.7 ml/min
 *
 * Therefore:
 * 2.7 / 60 = 0.045 ml/sec
 */
const DOSING_RATE_ML_PER_SEC = 2.7 / 60;

/**
 * Maximum amount of elapsed time we will credit from a single
 * PLC report gap.
 *
 * This protects against a stale PLC message / backend delay
 * causing a huge accidental dosing total.
 */
const MAX_GAP_SEC = 65;

/**
 * How frequently the accumulated total should be persisted.
 *
 * The PLC can report more frequently than this, but we don't
 * need to write to PostgreSQL on every PLC message.
 */
const FLUSH_INTERVAL_MS = 5000;

/**
 * Nairobi / Kenya is UTC+3.
 *
 * We deliberately calculate the dosing day using the plant-local
 * date rather than the Node server's local timezone.
 */
const PLANT_UTC_OFFSET_MINUTES = 3 * 60;


// ============================================================
// STATE
// ============================================================

const state = {
  id: null,

  day: null,
  month: null,

  /**
   * Total number of seconds the antiscalant pump has been
   * considered ON today.
   */
  secondsOn: 0,

  /**
   * Total millilitres dosed today.
   */
  mlDosed: 0,

  /**
   * Whether today's one-time prime has already been counted.
   */
  primedToday: false,

  /**
   * Last known PLC pump state.
   */
  lastOnState: false,

  /**
   * Timestamp associated with the last ON accounting point.
   *
   * This is used to calculate elapsed dosing time between
   * PLC reports.
   */
  lastOnAt: null,

  /**
   * Timestamp of the last successful persistence operation.
   */
  lastFlushedAt: 0,

  /**
   * Indicates whether state has successfully been restored
   * from PostgreSQL.
   */
  hydrated: false,
};


// ============================================================
// HYDRATION
// ============================================================

let hydrationPromise = null;

/**
 * Return the current plant-local date as YYYY-MM-DD.
 */
function dosingDayKey(timestampMs = Date.now()) {
  const date = new Date(timestampMs);

  // Convert UTC timestamp into plant-local time.
  const localMs =
    date.getTime() +
    PLANT_UTC_OFFSET_MINUTES * 60 * 1000;

  const localDate = new Date(localMs);

  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}


/**
 * Return the current plant-local month as YYYY-MM.
 */
function dosingMonthKey(timestampMs = Date.now()) {
  return dosingDayKey(timestampMs).slice(0, 7);
}


/**
 * Convert a DB value safely into a number.
 */
function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}


/**
 * Convert DB timestamp / timestamp-like value into milliseconds.
 */
function toTimestampMs(value) {
  if (!value) return null;

  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}


/**
 * Restore today's dosing state from PostgreSQL.
 *
 * IMPORTANT:
 * This function is called once and shared through hydrationPromise
 * so multiple PLC/API requests cannot race multiple hydrations.
 */
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
      /**
       * No row exists for today.
       *
       * This is a genuine new day / first run for today.
       */
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
    console.error(
      '[dosing] failed to hydrate dosing totals:',
      error
    );

    /**
     * Do NOT mark the state as hydrated when the database read
     * failed. This prevents a temporary DB failure from being
     * mistaken for a genuine zero-total day.
     */
    throw error;
  }
}


/**
 * Make sure hydration has completed before anyone reads or
 * modifies the dosing state.
 */
async function ensureHydrated() {
  if (state.hydrated) {
    return state;
  }

  if (!hydrationPromise) {
    hydrationPromise = hydrate()
      .catch((error) => {
        hydrationPromise = null;
        throw error;
      });
  }

  await hydrationPromise;

  return state;
}


// ============================================================
// DAY ROLLOVER
// ============================================================

/**
 * Check whether the plant-local calendar day has changed.
 *
 * The previous day's total is already persisted in PostgreSQL.
 * We therefore start the new day's counters at zero.
 *
 * We deliberately preserve the last pump state across midnight.
 *
 * Example:
 *
 * Pump ON at 23:59:58
 * Midnight occurs
 * Pump remains ON
 *
 * The next PLC report can continue accounting without requiring
 * a false OFF -> ON transition.
 */
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

  console.log(
    `[dosing] day rollover ${state.day} -> ${today}; ` +
    `resetting today's counters`
  );

  state.id = null;

  state.day = today;
  state.month = month;

  state.secondsOn = 0;
  state.mlDosed = 0;

  state.primedToday = false;

  /**
   * IMPORTANT:
   * Keep lastOnState and lastOnAt.
   *
   * If the pump is physically still ON at midnight, we don't
   * want to create a fake OFF -> ON transition.
   */
  return true;
}


// ============================================================
// DATABASE PERSISTENCE
// ============================================================

let flushInProgress = false;
let flushQueued = false;


/**
 * Persist the current state to PostgreSQL.
 *
 * Uses upsertDosingTotals(), which updates the row for the
 * current plant-local day.
 */
async function flush() {
  if (!state.hydrated) {
    return;
  }

  if (!state.day) {
    return;
  }

  /**
   * If another flush is currently running, don't start another
   * DB operation concurrently.
   *
   * Instead, remember that another flush is needed.
   */
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

      /**
       * Convert milliseconds back into a Date for PostgreSQL.
       */
      lastOnAt: state.lastOnAt
        ? new Date(state.lastOnAt)
        : null,
    });

    state.lastFlushedAt = Date.now();

    console.log(
      `[dosing] persisted day=${state.day} ` +
      `secondsOn=${state.secondsOn.toFixed(2)} ` +
      `mlDosed=${state.mlDosed.toFixed(3)}`
    );
  } catch (error) {
    /**
     * Do NOT reset the in-memory counter if persistence fails.
     *
     * The PLC can continue reporting and the service can retry
     * persistence later.
     */
    console.error(
      '[dosing] failed to persist dosing totals:',
      error
    );
  } finally {
    flushInProgress = false;

    if (flushQueued) {
      flushQueued = false;

      /**
       * Persist the latest state asynchronously.
       */
      setImmediate(() => {
        flush().catch((error) => {
          console.error(
            '[dosing] queued flush failed:',
            error
          );
        });
      });
    }
  }
}


/**
 * Decide whether the current state should be persisted.
 */
function shouldFlush(force = false) {
  if (force) {
    return true;
  }

  if (!state.lastFlushedAt) {
    return true;
  }

  return (
    Date.now() - state.lastFlushedAt >= FLUSH_INTERVAL_MS
  );
}


// ============================================================
// PLC STATE PROCESSING
// ============================================================

/**
 * Convert PLC input into a boolean pump state.
 *
 * Handles common representations:
 *
 * true / false
 * 1 / 0
 * "1" / "0"
 * "true" / "false"
 * "on" / "off"
 * "yes" / "no"
 */
function normalizeOnState(rawValue) {
  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue === 'number') {
    return rawValue !== 0;
  }

  if (typeof rawValue === 'string') {
    const value = rawValue.trim().toLowerCase();

    if (
      value === '1' ||
      value === 'true' ||
      value === 'on' ||
      value === 'yes'
    ) {
      return true;
    }

    if (
      value === '0' ||
      value === 'false' ||
      value === 'off' ||
      value === 'no' ||
      value === ''
    ) {
      return false;
    }
  }

  /**
   * Unknown values are treated as OFF.
   *
   * This is safer than counting dosing for an invalid PLC value.
   */
  return false;
}


/**
 * Record an antiscalant pump PLC state.
 *
 * This function is called by plcService.js.
 *
 * It does NOT depend on:
 * - browser connection
 * - dashboard login
 * - dashboard logout
 * - frontend polling
 *
 * The PLC is therefore able to continue accumulating totals
 * even when no user is logged into the dashboard.
 */
async function recordDosingState(
  rawValue,
  timestampMs = Date.now()
) {
  try {
    /**
     * Never process PLC state against an unhydrated zero state.
     */
    await ensureHydrated();

    /**
     * Check whether the calendar day has changed.
     */
    const rolled = rolloverIfNeeded(timestampMs);

    const isOn = normalizeOnState(rawValue);

    /**
     * If the pump has just transitioned OFF -> ON,
     * count the initial one-second prime once per day.
     */
    const risingEdge =
      !state.lastOnState &&
      isOn;

    if (risingEdge) {
      if (!state.primedToday) {
        state.secondsOn += 1;

        state.mlDosed +=
          DOSING_RATE_ML_PER_SEC;

        state.primedToday = true;

        console.log(
          `[dosing] prime counted: ` +
          `${DOSING_RATE_ML_PER_SEC.toFixed(3)} ml`
        );
      }

      /**
       * Start timing from this PLC ON event.
       */
      state.lastOnAt = timestampMs;
    }

    /**
     * Pump is ON.
     */
    if (isOn) {
      /**
       * If this is not a rising edge, calculate elapsed time
       * since the previous ON accounting point.
       */
      if (
        !risingEdge &&
        state.lastOnAt !== null
      ) {
        let elapsedSec =
          (timestampMs - state.lastOnAt) / 1000;

        /**
         * Protect against:
         * - duplicate timestamps
         * - clock changes
         * - negative elapsed values
         * - very large PLC/backend gaps
         */
        if (!Number.isFinite(elapsedSec)) {
          elapsedSec = 0;
        }

        elapsedSec = Math.max(0, elapsedSec);

        elapsedSec = Math.min(
          elapsedSec,
          MAX_GAP_SEC
        );

        if (elapsedSec > 0) {
          state.secondsOn += elapsedSec;

          state.mlDosed +=
            elapsedSec *
            DOSING_RATE_ML_PER_SEC;
        }
      }

      /**
       * Move the accounting point to this PLC report.
       */
      state.lastOnAt = timestampMs;
    }

    /**
     * Pump is OFF.
     */
    else {
      /**
       * If the pump was previously ON, the final ON interval
       * has already been accounted for by the preceding PLC
       * report. We now close the ON interval.
       */
      state.lastOnAt = null;
    }

    /**
     * Remember the latest PLC state.
     */
    state.lastOnState = isOn;

    /**
     * Persist:
     *
     * - immediately after a rollover
     * - when pump switches OFF
     * - approximately every 5 seconds while running
     */
    const forceFlush =
      rolled ||
      !isOn;

    if (forceFlush || shouldFlush()) {
      await flush();
    }

    return getStateSnapshot();
  } catch (error) {
    console.error(
      '[dosing] recordDosingState failed:',
      error
    );

    /**
     * Do not throw into the PLC polling loop unless the caller
     * specifically needs the exception.
     *
     * Returning the current state keeps the PLC service alive.
     */
    return getStateSnapshot();
  }
}


// ============================================================
// API / READ METHODS
// ============================================================

/**
 * Return a safe copy of the current state.
 *
 * This prevents callers from directly modifying the internal
 * state object.
 */
function getStateSnapshot() {
  return {
    id: state.id,

    day: state.day,
    month: state.month,

    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,

    primedToday: state.primedToday,

    lastOnState: state.lastOnState,

    lastOnAt: state.lastOnAt
      ? new Date(state.lastOnAt).toISOString()
      : null,

    hydrated: state.hydrated,
  };
}


/**
 * Return today's total.
 *
 * IMPORTANT:
 * This waits for database hydration before returning.
 *
 * This prevents a newly started Node process from answering
 * the dashboard with:
 *
 *     mlDosed: 0
 *
 * while PostgreSQL is still being read.
 */
async function getTodayTotals() {
  await ensureHydrated();

  rolloverIfNeeded();

  return getStateSnapshot();
}


/**
 * Return monthly summary from the existing database layer.
 *
 * The database function remains responsible for the monthly
 * aggregation.
 */
async function getMonthSummary() {
  await ensureHydrated();

  return getMonthSummaryFromDatabase();
}


/**
 * Wrapper kept separate so the database import can be changed
 * in one place if required by the existing postgres.js API.
 */
async function getMonthSummaryFromDatabase() {
  /**
   * The existing project already has a database function for
   * the current month total.
   *
   * We intentionally require it lazily here so that the rest of
   * the dosing service remains compatible with the existing
   * postgres.js module.
   */
  const postgres = require('../database/postgres');

  if (
    typeof postgres.getDosingCurrentMonthTotal ===
    'function'
  ) {
    return postgres.getDosingCurrentMonthTotal();
  }

  /**
   * If the existing application expects another month-summary
   * function, return the in-memory month information rather than
   * crashing the dosing service.
   */
  return {
    month: state.month,
    secondsOn: state.secondsOn,
    mlDosed: state.mlDosed,
  };
}


// ============================================================
// STARTUP
// ============================================================

/**
 * Start hydration immediately when the module loads.
 *
 * The promise is retained so API/PLC calls can await the same
 * hydration operation.
 */
hydrationPromise = hydrate()
  .catch((error) => {
    console.error(
      '[dosing] startup hydration failed:',
      error
    );

    /**
     * Allow a later API/PLC request to retry hydration.
     */
    hydrationPromise = null;

    throw error;
  });


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  DOSING_RATE_ML_PER_SEC,
  MAX_GAP_SEC,

  recordDosingState,

  getTodayTotals,
  getMonthSummary,

  /**
   * Exported mainly for diagnostics/testing.
   */
  ensureHydrated,
  hydrate,

  /**
   * Useful for debugging without exposing the mutable object.
   */
  getStateSnapshot,
};