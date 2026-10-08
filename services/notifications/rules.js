// services/notifications/rules.js
// Server-side copies of logic that lives in the frontend AlertsContext:
//   • evaluateBackwashFilterDpAlert  ← utils/backwashAlert.js
//   • AlertRules.apply               ← applyAlertRules in AlertsContext.jsx
// Candidates use the SAME shape as alertEngine.js:
//   { id, active, source, severity, message (= the alert title), equipment, value, threshold, description }
'use strict';

const config = require('./config');

const ON_VALUES = ['1', 'true', 'on', 'active', 'yes', 'running', 'enabled', 'online'];
const isOn = (raw) => {
  if (raw === true) return true;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') return ON_VALUES.includes(raw.trim().toLowerCase());
  return false;
};
const norm = (s) => String(s ?? '').trim().toLowerCase();

// ── Derived: backwash → high media filter ΔP ─────────────────────────────
function isBackwashMode(get) {
  if (!isOn(get('RO5-SystemActive'))) return false;
  const mode = String(get('RO5-SystemMode') ?? '').trim().toUpperCase();
  if (mode.includes('BACKWASH') || mode.includes('BACK WASH')) return true;
  const plcKnown =
    mode.includes('FILTER') || mode.includes('STANDBY') || mode.includes('STAND BY') ||
    mode === 'OFF' || mode === 'STOP' || mode === 'STOPPED';
  if (plcKnown) return false;
  return isOn(get('RO5-Feedpump')) && isOn(get('RO5-PrefilterBackwash'));
}

function evaluateBackwashFilterDpAlert(get) {
  const active = isBackwashMode(get);
  const raw = get('RO5-MediaFilterDeltaP');
  const dp = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  const dpKnown = Number.isFinite(dp);
  const plcBit = isOn(get('RO5-HighPrefilterDeltaP'));
  const dpHigh = dpKnown && dp >= config.filterDpLimitBar;

  const trigger = plcBit
    ? 'PLC high filter ΔP bit is set'
    : dpHigh
      ? `Filter ΔP at or above ${config.filterDpLimitBar.toFixed(2)} bar`
      : 'Backwash cycle running';

  return {
    id: 'derived-backwash-high-filter-dp',
    type: 'High Media Filter Differential Pressure',
    message: 'High Media Filter Differential Pressure',
    severity: 'Medium',
    active,
    source: 'derived',
    equipment: 'RO5 - Media Filter',
    description: `System in backwash mode — ${trigger}`,
    // Only show a reading when it is actually high ("exceeded limit" wording in the UI)
    value: (plcBit || dpHigh) && dpKnown ? `${dp.toFixed(2)} bar` : undefined,
    threshold: `≥ ${config.filterDpLimitBar.toFixed(2)} bar`,
  };
}

// ── Removal / gating / delay rules (same table as AlertsContext) ─────────
const REMOVED_ALERT_TYPES = ['Antiscalant Dosing Stopped'];

const GATED_ALERTS = [
  { type: 'Low RO Pressure',      skipSources: ['plc'], requirePumpsRunning: true, delayMs: 0 },
  { type: 'Low System Recovery',  skipSources: ['plc'], requirePumpsRunning: true, delayMs: 60 * 1000 },
  { type: 'Low Feed Flow',        skipSources: ['plc'], requirePumpsRunning: true, delayMs: 0 },
  { type: 'Low Concentrate Flow', skipSources: ['plc'], requirePumpsRunning: true, delayMs: 0 },
];

class AlertRules {
  constructor(getValue, onDeadline) {
    this.getValue = getValue;
    this.onDeadline = onDeadline;
    this.pendingSince = {};
    this.timer = null;
  }

  apply(candidates) {
    const now = Date.now();
    const pumpsRunning = isOn(this.getValue('RO5-Feedpump')) && !isOn(this.getValue('RO5-PrefilterBackwash'));
    const removed = new Set(REMOVED_ALERT_TYPES.map(norm));
    let soonest = null;
    const out = [];

    for (const c of candidates) {
      // Engine candidates carry their title in `message`, not `type`.
      const title = norm(c.type ?? c.message);
      if (removed.has(title)) continue;

      const rule = GATED_ALERTS.find(
        (r) => norm(r.type) === title && !(r.skipSources || []).map(norm).includes(norm(c.source))
      );
      if (!rule) { out.push(c); continue; }

      if (!c.active || (rule.requirePumpsRunning && !pumpsRunning)) {
        delete this.pendingSince[c.id];
        out.push(c.active ? { ...c, active: false } : c);
        continue;
      }

      if (rule.delayMs > 0) {
        if (this.pendingSince[c.id] === undefined) this.pendingSince[c.id] = now;
        const remaining = rule.delayMs - (now - this.pendingSince[c.id]);
        if (remaining > 0) {
          out.push({ ...c, active: false });
          soonest = soonest === null ? remaining : Math.min(soonest, remaining);
          continue;
        }
      }
      out.push(c);
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = soonest === null ? null : setTimeout(() => this.onDeadline?.(), soonest + 50);
    return out;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}

module.exports = { evaluateBackwashFilterDpAlert, AlertRules };