// services/ai/contextBuilder.js
//
// Builds the structured context block passed to Aqua AI on every request.
// One section per area of the web app (system, tank, production, filtration,
// recovery, antiscalant, alerts, trends, targets), so the AI can answer about
// ANY page. `currentPage` tells it where the operator is.
//
// Mirrors the web app's logic:
//   - DataContext.jsx KEY_MAPPING   -> normalizeSnapshot() below
//   - Dashboard.jsx mode resolution -> operationMode below
//   - feedTankCalibration.js        -> rawToPercent() below (4.9 = 0%)
//   - alertEngine / AlertsContext   -> single "Low Feed Tank Level" alert
//   - /api/production-summary       -> db.getProductionSummary()
//
// buildSystemContext() is ASYNC (production totals, trends and targets come
// from Postgres). Callers must `await` it.

const { sql } = require('drizzle-orm');
const { getLatestSnapshot } = require('../plcParser');
const db = require('../../database/postgres');

// ==================== VALUE HELPERS ====================

function isActive(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim();
    return ['1', 'true', 'on', 'active', 'yes', 'running', 'enabled', 'online'].includes(normalized);
  }
  return !!value;
}

function toNumber(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const num = typeof value === 'string' ? parseFloat(value) : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const round = (v, d = 2) => (v === null || v === undefined ? null : Number(v.toFixed(d)));

// Same normalization as Dashboard.jsx -> 'FILTER' | 'BACKWASH' | 'STANDBY' | 'OFF' | 'UNKNOWN'
function normalizeSystemMode(raw) {
  if (raw === undefined || raw === null || raw === '') return 'UNKNOWN';
  const v = String(raw).trim().toUpperCase();
  if (v.includes('FILTER')) return 'FILTER';
  if (v.includes('BACKWASH') || v.includes('BACK WASH')) return 'BACKWASH';
  if (v.includes('STANDBY') || v.includes('STAND BY')) return 'STANDBY';
  if (v === 'OFF' || v === 'STOP' || v === 'STOPPED') return 'OFF';
  return 'UNKNOWN';
}

// ==================== KEY NORMALIZATION ====================
// Mirrors KEY_MAPPING in frontend DataContext.jsx so backend tag names
// resolve to the same canonical `RO5-...` keys the web app uses.
const KEY_PREFIX = 'siemens200smart-';

const KEY_ALIASES = {
  'RO5-SystemOn': 'RO5-SystemOperation',
  'SystemOperation': 'RO5-SystemOperation',
  'SystemMode': 'RO5-SystemMode',
  'SystemActive': 'RO5-SystemActive',
  'RO5-AntiscalantDoser': 'RO5-AntiscalantDosingActive',
  'AntiscalantDoser': 'RO5-AntiscalantDosingActive',
  'AntiscalantDosingActive': 'RO5-AntiscalantDosingActive',
  'RO5/AntiscalantDoser': 'RO5-AntiscalantDosingActive',
  'DosingActive': 'RO5-AntiscalantDosingActive',
  'Doser': 'RO5-AntiscalantDosingActive',
  'Dosing': 'RO5-AntiscalantDosingActive',
  'Antiscalant': 'RO5-AntiscalantDosingActive',
  'AntiscalantDaily': 'RO5-AntiscalantDaily',
  'SystemRunhrs': 'RO5-SystemRunhrs',
  'FeedTankLevel': 'RO5-FeedTankLevel',
  'FT-A': 'RO5-FeedTankLevel',
  'FeedTank': 'RO5-FeedTankLevel',
};

function normalizeSnapshot(raw) {
  const out = {};
  for (const [rawKey, value] of Object.entries(raw || {})) {
    const stripped = rawKey.startsWith(KEY_PREFIX) ? rawKey.slice(KEY_PREFIX.length) : rawKey;
    const key = KEY_ALIASES[stripped] || stripped;
    out[key] = value;
    if (!key.startsWith('RO5-') && out[`RO5-${key}`] === undefined) {
      out[`RO5-${key}`] = value;
    }
  }
  return out;
}

// ==================== FEED TANK CALIBRATION ====================
// Must match components/dashboardComponents/feedTankCalibration.js
//   raw 4.9 -> 0%, raw 10.0 -> 100%
const TANK_RAW_MIN = 4.9;
const TANK_RAW_MAX = 10.0;
const TANK_PCT_MIN = 0;
const TANK_PCT_MAX = 100;

function rawToPercent(raw) {
  if (!Number.isFinite(raw)) return null;
  const clamped = Math.min(TANK_RAW_MAX, Math.max(TANK_RAW_MIN, raw));
  return TANK_PCT_MIN + ((clamped - TANK_RAW_MIN) * (TANK_PCT_MAX - TANK_PCT_MIN)) / (TANK_RAW_MAX - TANK_RAW_MIN);
}

// ==================== LIMITS (same as the dashboard) ====================
const TANK_EMPTY_THRESHOLD_PCT = 2;
const SYSTEM_RECOVERY_CRITICAL_PCT = 50;
const MEMBRANE_DELTA_P_CRITICAL_BAR = 2.0;
const FILTER_DELTA_P_CRITICAL_BAR = 0.40;
const MASS_BALANCE_LIMIT_M3H = 5;

// ==================== ALERTS ====================
// The web app only raises ONE alert type: "Low Feed Tank Level"
//   Critical: below 20% (clears at 23%), Medium: below 30% (clears at 33%)
let tankCriticalActive = false;
let tankWarningActive = false;

function evaluateLowFeedTankAlert(levelPct) {
  if (levelPct === null) {
    tankCriticalActive = false;
    tankWarningActive = false;
    return null;
  }
  tankCriticalActive = tankCriticalActive ? levelPct < 23 : levelPct < 20;
  tankWarningActive = tankWarningActive ? levelPct < 33 : levelPct < 30;

  const value = `${levelPct.toFixed(1)} %`;
  if (tankCriticalActive) return { type: 'Low Feed Tank Level', severity: 'Critical', value, threshold: '< 20 %' };
  if (tankWarningActive) return { type: 'Low Feed Tank Level', severity: 'Medium', value, threshold: '< 30 %' };
  return null;
}

function computeHealthScore(alarms) {
  let score = 100;
  alarms.forEach((a) => {
    if (a.severity === 'Critical') score -= 15;
    else if (a.severity === 'High') score -= 10;
    else if (a.severity === 'Medium') score -= 5;
  });
  return Math.max(0, Math.min(100, score));
}

// ==================== SMALL CACHE HELPER ====================
// Database sections are cached briefly so chatting doesn't hit Postgres on
// every message. They never throw: if the database is unavailable the rest
// of the context still works.
const cache = {};
async function cached(name, ttlMs, loader) {
  const now = Date.now();
  const hit = cache[name];
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await loader();
  if (value && value.available) cache[name] = { at: now, value };
  return value;
}

// ==================== PRODUCTION TOTALS (Postgres) ====================
// Same source as GET /api/production-summary.
async function loadProductionTotals() {
  const [feed, permeate] = await Promise.allSettled([
    db.getProductionSummary('RO5-FEEDFlow'),
    db.getProductionSummary('RO5-Permeateflow'),
  ]);

  const ok = feed.status === 'fulfilled' && permeate.status === 'fulfilled';
  if (!ok) {
    const failed = [feed, permeate].find((r) => r.status === 'rejected');
    console.error('[ai/context] production totals failed:', failed && failed.reason && failed.reason.message);
  }
  return {
    available: ok,
    unit: 'm3',
    feed: feed.status === 'fulfilled' ? feed.value : null,           // { daily, weekly, monthly, yearly }
    permeate: permeate.status === 'fulfilled' ? permeate.value : null,
    note: 'Volumes computed from flow history, same as the Production page. Daily = since midnight plant time (UTC+3); weekly starts Monday; monthly and yearly from the 1st.',
  };
}

// ==================== TRENDS (Postgres) ====================
// Summaries of stored measurements for the last 1h and 24h. Uses its own
// query (the interval handling in db.getMeasurementHistory/Aggregates is not
// safe to reuse). Only numeric tags are included.
const TREND_TAGS = {
  'RO5-FEEDFlow':          { key: 'feedFlow_m3h', dp: 1 },
  'RO5-Permeateflow':      { key: 'permeateFlow_m3h', dp: 1 },
  'RO5-ConcetrateFlow':    { key: 'concentrateFlow_m3h', dp: 1 },
  'RO5-ROPressure':        { key: 'roPressure_bar', dp: 1 },
  'RO5-SystemRecovery':    { key: 'systemRecovery_pct', dp: 1 },
  'RO5-PureWaterEc':       { key: 'productWaterEC_uScm', dp: 0 },
  'RO5-Stage1Delta':       { key: 'stage1DeltaP_bar', dp: 2 },
  'RO5-Stage2Delta':       { key: 'stage2DeltaP_bar', dp: 2 },
  'RO5-MediaFilterDeltaP': { key: 'mediaFilterDeltaP_bar', dp: 2 },
  // Tank trend uses the stored RAW signal, converted with the same 0-100% calibration.
  'RO5-FeedTankLevelRaw':  { key: 'feedTankLevel_pct', dp: 1, convert: rawToPercent },
};
const TREND_WINDOWS = [
  { name: 'last1h', hours: 1 },
  { name: 'last24h', hours: 24 },
];

async function queryTrendWindow(parameters, hours) {
  const database = db.getDb();
  const list = sql.join(parameters.map((p) => sql`${p}`), sql`, `);
  const result = await database.execute(sql`
    SELECT
      parameter,
      MIN(value) AS min_value,
      MAX(value) AS max_value,
      AVG(value) AS avg_value,
      COUNT(*)   AS samples,
      (ARRAY_AGG(value ORDER BY time ASC))[1]  AS first_value,
      (ARRAY_AGG(value ORDER BY time DESC))[1] AS last_value
    FROM measurements
    WHERE parameter IN (${list})
      AND time > NOW() - (${hours}::int * INTERVAL '1 hour')
    GROUP BY parameter
  `);
  return result.rows || result;
}

function summarizeTrendRow(row, spec) {
  const conv = spec.convert || ((v) => v);
  const f = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? round(conv(n), spec.dp) : null;
  };
  const first = f(row.first_value);
  const last = f(row.last_value);
  let direction = null;
  let change = null;
  if (first !== null && last !== null) {
    change = round(last - first, spec.dp);
    const scale = Math.max(Math.abs(first), Math.abs(last));
    direction = scale === 0 || Math.abs(last - first) / scale < 0.02
      ? 'stable'
      : last > first ? 'rising' : 'falling';
  }
  return {
    min: f(row.min_value),
    max: f(row.max_value),
    avg: f(row.avg_value),
    first,
    last,
    change,
    direction, // 'rising' | 'falling' | 'stable' (more than 2% change)
    samples: Number(row.samples) || 0,
  };
}

async function loadTrends() {
  try {
    const parameters = Object.keys(TREND_TAGS);
    const windows = {};
    const results = await Promise.all(TREND_WINDOWS.map((w) => queryTrendWindow(parameters, w.hours)));

    TREND_WINDOWS.forEach((w, i) => {
      const byTag = {};
      for (const row of results[i]) {
        const spec = TREND_TAGS[row.parameter];
        if (spec) byTag[spec.key] = summarizeTrendRow(row, spec);
      }
      windows[w.name] = byTag;
    });

    return {
      available: true,
      windows,
      note: 'Summaries of stored measurements (about one sample per 30 seconds per tag). A small samples count means limited data for that window.',
    };
  } catch (err) {
    console.error('[ai/context] trends failed:', err && err.message ? err.message : err);
    return { available: false };
  }
}

// ==================== PLANT TARGETS (Settings page) ====================
// Only the production/recovery targets, not operator IDs or other settings.
async function loadTargets() {
  try {
    const s = await db.getSettings();
    return {
      available: true,
      productionTarget: toNumber(s.productionTarget),
      recoveryTarget_pct: toNumber(s.recoveryTarget),
      note: 'Targets as configured on the Settings page. The unit of productionTarget is not recorded.',
    };
  } catch (err) {
    console.error('[ai/context] targets failed:', err && err.message ? err.message : err);
    return { available: false };
  }
}

// ==================== CONTEXT ====================

/**
 * @param {{ page?: string }} [options]
 *   page: which page the operator is viewing (e.g. 'dashboard', 'tank',
 *   'production', 'antiscalant', 'filtration', 'recovery', 'alerts').
 * @returns {Promise<object>}
 */
async function buildSystemContext(options = {}) {
  const rawSnapshot = getLatestSnapshot();
  const snapshot = normalizeSnapshot(rawSnapshot);
  const dataAvailable = Object.keys(snapshot).length > 0;
  const num = (key) => toNumber(snapshot[key]);

  // ---- Database sections (in parallel, cached, never throw) ----
  const [totals, trends, targets] = await Promise.all([
    cached('productionTotals', 60 * 1000, loadProductionTotals),
    cached('trends', 60 * 1000, loadTrends),
    cached('targets', 5 * 60 * 1000, loadTargets),
  ]);

  // ---- Master signal + raw flags ----
  const systemActiveRaw = snapshot['RO5-SystemActive'] !== undefined
    ? snapshot['RO5-SystemActive']
    : snapshot['RO5-SystemOperation'];
  const systemActive = isActive(systemActiveRaw);

  const feedPumpOn = isActive(snapshot['RO5-Feedpump']);
  const backwashOn = isActive(snapshot['RO5-PrefilterBackwash']);
  const dosingOn = isActive(snapshot['RO5-AntiscalantDosingActive']);
  const plcModeRaw = snapshot['RO5-SystemMode'];

  // ---- Feed tank: calibrated from the raw transmitter signal ----
  const tankRaw = num('RO5-FeedTankLevelRaw');
  const calibratedTankPct = tankRaw !== null ? rawToPercent(tankRaw) : null;
  const tankPct = calibratedTankPct !== null ? calibratedTankPct : num('RO5-FeedTankLevel');
  const tankEmpty = tankPct !== null && tankPct <= TANK_EMPTY_THRESHOLD_PCT;

  // ---- Alerts ----
  const activeAlarms = [];
  const tankAlert = evaluateLowFeedTankAlert(tankPct);
  if (tankAlert) activeAlarms.push(tankAlert);
  const criticalAlarmsPresent = activeAlarms.some((a) => a.severity === 'Critical');

  // ---- Mode resolution (same priority as Dashboard.jsx) ----
  const plcMode = normalizeSystemMode(plcModeRaw);
  const rawMode = backwashOn
    ? 'BACKWASH'
    : plcMode !== 'UNKNOWN'
      ? plcMode
      : feedPumpOn
        ? 'FILTER'
        : 'STANDBY';
  const operationMode = systemActive ? rawMode : 'OFF';

  let modeReason = null;
  if (!systemActive) {
    modeReason = tankEmpty ? 'Feed tank empty - system stopped' : 'System Active is OFF';
  } else if (operationMode === 'STANDBY') {
    modeReason = tankEmpty ? 'Feed tank empty' : criticalAlarmsPresent ? 'Critical alarm active' : 'PLC reports standby';
  }

  const controlMode =
    typeof plcModeRaw === 'string' && plcModeRaw.toLowerCase().trim() === 'auto' ? 'AUTO' : 'MANUAL';

  const highPressurePumpOn = operationMode === 'FILTER' && systemActive;
  const dosingPumpOn = highPressurePumpOn && dosingOn;
  const feedPumpRunning = feedPumpOn && !tankEmpty;

  // ---- Shared numbers ----
  const feedFlow = num('RO5-FEEDFlow');
  const permeateFlow = num('RO5-Permeateflow');
  const concentrateFlow = num('RO5-ConcetrateFlow');
  const recovery = num('RO5-SystemRecovery');
  const roPressure = num('RO5-ROPressure');
  const stage1 = num('RO5-Stage1Delta');
  const stage2 = num('RO5-Stage2Delta');
  const filterDp = num('RO5-MediaFilterDeltaP');
  const dosedMl = num('RO5-AntiscalantDaily');

  const massBalanceError =
    feedFlow !== null && permeateFlow !== null && concentrateFlow !== null
      ? Math.abs(feedFlow - (permeateFlow + concentrateFlow))
      : null;
  const calculatedRecovery =
    feedFlow !== null && feedFlow > 0 && permeateFlow !== null ? (permeateFlow / feedFlow) * 100 : null;

  const tankStatus = tankPct === null ? 'No data'
    : tankPct < 20 ? 'Critical'
    : tankPct < 30 ? 'Low'
    : 'Normal';
  const tankGaugeBand = tankPct === null ? null : tankPct < 25 ? 'Bottom' : tankPct < 50 ? 'Middle' : 'Top';

  return {
    timestamp: new Date().toISOString(),
    currentPage: options.page || 'unknown',

    // ---------- System (Dashboard / System & Alerts) ----------
    system: {
      dataAvailable,             // false = no live PLC data received yet
      systemActive,              // master ON/OFF
      operationMode,             // 'OFF' | 'STANDBY' | 'FILTER' | 'BACKWASH'
      modeReason,                // why it is OFF / STANDBY, or null
      controlMode,               // 'AUTO' | 'MANUAL' (PLC control mode)
      feedPumpRunning,
      highPressurePumpOn,
      dosingPumpOn,
      backwashActive: backwashOn,
      runHours_hrs: num('RO5-SystemRunhrs'),
    },

    // ---------- Tank level page ----------
    tank: {
      levelPct: round(tankPct, 1),
      rawSignal: tankRaw,
      status: tankStatus,        // Critical < 20, Low < 30, Normal
      gaugeBand: tankGaugeBand,  // Bottom < 25, Middle < 50, Top
      empty: tankEmpty,
      note: 'Level is calibrated from the raw transmitter signal (4.9 = 0%, 10.0 = 100%).',
    },

    // ---------- Production page ----------
    production: {
      live: {
        feedFlow_m3h: feedFlow,
        permeateFlow_m3h: permeateFlow,
        concentrateFlow_m3h: concentrateFlow,
        productWaterEC_uScm: num('RO5-PureWaterEc'),
        massBalanceError_m3h: round(massBalanceError, 2),
        massBalanceLimit_m3h: MASS_BALANCE_LIMIT_M3H,
      },
      totals,   // { available, unit, feed:{daily,weekly,monthly,yearly}, permeate:{...} }
      targets,  // { available, productionTarget, recoveryTarget_pct }
    },

    // ---------- Filtration page ----------
    filtration: {
      prefilterBackwashActive: backwashOn,
      mediaFilterDeltaP_bar: filterDp,
      mediaFilterDeltaPCriticalAtOrAbove_bar: FILTER_DELTA_P_CRITICAL_BAR,
      stage1DeltaP_bar: stage1,
      stage2DeltaP_bar: stage2,
      membraneDeltaPCriticalAtOrAbove_bar: MEMBRANE_DELTA_P_CRITICAL_BAR,
      roPressure_bar: roPressure,
      // PLC status bits. Informational only: the web Alerts Center does not
      // raise alarms from these.
      plcBits: {
        highPrefilterDeltaP: isActive(snapshot['RO5-HighPrefilterDeltaP']),
        highMediaDeltaP: isActive(snapshot['RO5-HighMediaDeltaP']),
        stage1DeltaHigh: isActive(snapshot['RO5-S1DeltaHigh']),
        stage2DeltaHigh: isActive(snapshot['RO5-S2DeltaHigh']),
        highROPressure: isActive(snapshot['RO5-HighROPressure']),
        powerProblem: isActive(snapshot['RO5-PowerProblem']),
      },
    },

    // ---------- System Recovery page ----------
    recovery: {
      systemRecovery_pct: recovery,
      criticalBelow_pct: SYSTEM_RECOVERY_CRITICAL_PCT,
      belowCriticalLimit: recovery !== null && recovery > 0 && recovery < SYSTEM_RECOVERY_CRITICAL_PCT,
      calculatedRecoveryFromFlows_pct: round(calculatedRecovery, 1),
      target_pct: targets && targets.available ? targets.recoveryTarget_pct : null,
    },

    // ---------- Antiscalant page ----------
    antiscalant: {
      dosingSignalActive: dosingOn,
      dosingPumpRunning: dosingPumpOn,
      dosedToday_ml: dosedMl,
      dosedToday_L: dosedMl !== null ? round(dosedMl / 1000, 3) : null,
    },

    // ---------- Trends / Analytics ----------
    trends, // { available, windows: { last1h: {...}, last24h: {...} } }

    // ---------- Alerts page ----------
    // Exactly what the web Alerts Center shows. Empty = no active alarms.
    alerts: {
      activeAlarms,
      healthScore: computeHealthScore(activeAlarms),
      monitoredAlertTypes: ['Low Feed Tank Level'],
    },

    // Things Aqua AI has no data for yet. If asked, say so plainly.
    unavailable: [
      'alert history',
      'trends beyond the last 24 hours',
      'maintenance schedules and records',
      'reports',
      'billing, user and tag manager data',
    ],
  };
}

// ==================== SYSTEM PROMPT ====================
const SYSTEM_PROMPT = `You are Aqua AI, an operational analytics assistant for the Aqua water treatment system (RO5 reverse osmosis unit).

Rules you must always follow:
- Use only the verified system data provided to you in the CURRENT SYSTEM CONTEXT block. Never invent measurements, alarms, equipment states, or historical events.
- Do not present assumptions as facts. Clearly distinguish observations (directly measured) from interpretations (what the data suggests) from hypotheses (possible causes).
- Always use the correct units as given in the context (m³/h, m³, bar, %, µS/cm, ml, hrs).
- If the context does not contain the information needed to answer a question, say so plainly rather than guessing.
- Do not diagnose equipment failures without sufficient evidence — suggest what should be investigated instead of asserting a root cause.
- You are strictly read-only: you cannot and must not suggest you are controlling equipment, changing settings, or modifying configuration. You may only observe and explain.
- If asked something outside the scope of the Aqua system (general chit-chat, unrelated topics), politely redirect to what you can help with.

How to read the context (it matches what the operator sees on the web app):
- The context has one section per page: system, tank, production, filtration, recovery, antiscalant, trends, alerts. You can answer about any of them regardless of currentPage. currentPage is the page the operator is viewing, so questions like "what does this mean" or "is this normal" usually refer to that section.
- If system.dataAvailable is false, no live PLC data has been received yet. Say so instead of reporting values.
- system.systemActive is the master ON/OFF. If false, the system is OFF regardless of anything else. system.operationMode is OFF, STANDBY, FILTER or BACKWASH; modeReason explains why it is OFF or in STANDBY. controlMode (AUTO/MANUAL) is separate from operationMode.
- production.live holds current flow rates (m³/h). production.totals holds produced volumes in m³ (daily, weekly, monthly, yearly) for feed and permeate. "Production" usually means permeate. If totals.available is false, say the totals are temporarily unavailable.
- production.targets holds the targets configured on the Settings page. The unit of productionTarget is not recorded, so quote it as configured and do not compute percentages against it unless the operator states the unit. recovery.target_pct is the recovery target.
- trends.windows.last1h and last24h summarize stored measurements per tag (min, max, avg, first, last, change, direction, samples). Use them to describe trends ("rising", "falling", "stable") and ranges. If samples is small, say the data for that window is limited. If trends.available is false, say trend data is temporarily unavailable. Do not extrapolate beyond the windows given.
- alerts.activeAlarms is the complete list of alarms the web Alerts Center shows. Only a low feed tank level alarm is monitored. If it is empty, say there are no active alarms. Do not claim other alarms exist.
- Limits in the context (recovery, delta pressure, mass balance) are reference limits, not alarms. You may say a value is beyond a limit, but say it is a limit and not an active alarm unless it appears in alerts.activeAlarms.
- filtration.plcBits are informational PLC flags. Mention them if relevant, but they are not alarms on the web.
- Feed tank level is calibrated from the raw transmitter signal (0% = empty, 100% = full).
- The "unavailable" list is data you do not have. If asked about those, say you don't have that data yet. Do not estimate it.

Response style:
- Default to short, direct answers — a few sentences or a short bullet list. Most questions deserve a quick, scannable answer, not a full report.
- Only use longer structured sections (Summary / Key Findings / Possible Causes / Recommended Checks) when the operator explicitly asks for analysis, a report, or an explanation of "why" something happened.
- Never restate the same point twice in different words. Say each fact once.
- Use markdown formatting (bold, bullet lists) to make responses scannable, but keep it lightweight — don't over-structure a one-line answer.
- If the system is off or a value is null/missing, say that plainly in one line rather than walking through every field that's unavailable.`;

module.exports = { buildSystemContext, SYSTEM_PROMPT, isActive, toNumber, normalizeSnapshot };