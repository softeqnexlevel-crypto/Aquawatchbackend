// services/ai/contextBuilder.js
//
// Builds the compact, structured "current system context" block sent to
// the AI on every chat request. Per spec Section 25 ("do not send huge
// raw datasets to the LLM") this pulls only the latest values + a small
// set of derived status fields — never raw historical telemetry.
//
// Also holds the fixed SYSTEM_PROMPT enforcing spec Section 24's rules
// (no invented data, observed vs. interpretation, read-only, etc.).
//
// NOTE: adjust the require path below to match wherever your PLC
// snapshot service actually lives (this assumes backend/services/plcService.js,
// one level up from backend/services/ai/contextBuilder.js).
const { getLatestSnapshot } = require('../plcParser');

// Same ON/OFF-aware normalization used across the frontend
// (Dashboard.jsx, alertEngine.js) — bit-type values arrive as 'ON'/'OFF'
// strings, not booleans or numbers.
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

/**
 * Builds the structured context block passed to the AI for every request.
 * Phase 1 scope: current instantaneous status only — no history, no
 * alarm ledger (that lives in the frontend AlertsContext today; wiring
 * it into this backend context is a natural Phase 2/3 addition once
 * graph/anomaly analysis comes online).
 */
function buildSystemContext() {
  const snapshot = getLatestSnapshot(); // { 'RO5-FEEDFlow': 62.3, 'RO5-Feedpump': 'ON', ... }

  const feedPumpOn = isActive(snapshot['RO5-Feedpump']);
  const backwashOn = isActive(snapshot['RO5-PrefilterBackwash']);
  const operationMode = !feedPumpOn ? 'OFF' : backwashOn ? 'BACKWASH' : 'FILTER';

  return {
    timestamp: new Date().toISOString(),
    systemStatus: {
      operationMode, // 'OFF' | 'BACKWASH' | 'FILTER'
      feedPumpOn,
      backwashOn,
      antiscalantDosingOn: isActive(snapshot['RO5-AntiscalantDosingActive']),
    },
    kpis: {
      feedFlow_m3h: toNumber(snapshot['RO5-FEEDFlow']),
      permeateFlow_m3h: toNumber(snapshot['RO5-Permeateflow']),
      concentrateFlow_m3h: toNumber(snapshot['RO5-ConcetrateFlow']),
      roPressure_bar: toNumber(snapshot['RO5-ROPressure']),
      systemRecovery_pct: toNumber(snapshot['RO5-SystemRecovery']),
      pureWaterEC_uScm: toNumber(snapshot['RO5-PureWaterEc']),
      stage1DeltaP_bar: toNumber(snapshot['RO5-Stage1Delta']),
      stage2DeltaP_bar: toNumber(snapshot['RO5-Stage2Delta']),
      mediaFilterDeltaP_bar: toNumber(snapshot['RO5-MediaFilterDeltaP']),
      feedTankLevel_pct: toNumber(snapshot['RO5-FeedTankLevel']),
    },
    // PLC bit alarms — raw ON/OFF pass-through. Phase 1 keeps this simple;
    // Phase 3 (Anomaly Detection) is where this becomes a proper
    // evaluated alarm ledger shared with the frontend's alertEngine.js.
    plcAlarmBits: {
      highPrefilterDeltaP: isActive(snapshot['RO5-HighPrefilterDeltaP']),
      powerProblem: isActive(snapshot['RO5-PowerProblem']),
      highMediaDeltaP: isActive(snapshot['RO5-HighMediaDeltaP']),
      stage2DeltaHigh: isActive(snapshot['RO5-S2DeltaHigh']),
      stage1DeltaHigh: isActive(snapshot['RO5-S1DeltaHigh']),
      highROPressure: isActive(snapshot['RO5-HighROPressure']),
      feedTankLow: isActive(snapshot['RO5-FeedTankLow']),
    },
  };
}

// ==================== SYSTEM PROMPT ====================
// Enforces spec Section 24's rules. Kept as a single exported constant so
// it's easy to review/audit and reused identically by every route that
// talks to the AI (chat now; analyze/reports later).
const SYSTEM_PROMPT = `You are Aqua AI, an operational analytics assistant for the Aqua water treatment system (RO5 reverse osmosis unit).

Rules you must always follow:
- Use only the verified system data provided to you in the CURRENT SYSTEM CONTEXT block. Never invent measurements, alarms, equipment states, or historical events.
- Do not present assumptions as facts. Clearly distinguish observations (directly measured) from interpretations (what the data suggests) from hypotheses (possible causes).
- Always use the correct units as given in the context (m³/h, bar, %, µS/cm).
- If the context does not contain the information needed to answer a question, say so plainly rather than guessing.
- Do not diagnose equipment failures without sufficient evidence — suggest what should be investigated instead of asserting a root cause.
- You are strictly read-only: you cannot and must not suggest you are controlling equipment, changing settings, or modifying configuration. You may only observe and explain.
- Keep responses concise and practical — this is for a plant operator who needs a clear, actionable answer, not a lengthy report (unless they explicitly ask for a full report).
- If asked something outside the scope of the Aqua system (general chit-chat, unrelated topics), politely redirect to what you can help with.`;

module.exports = { buildSystemContext, SYSTEM_PROMPT, isActive, toNumber };