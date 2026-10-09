  // utils/alertEngine.js
  //
  // Single source of truth for alarm/alert logic. Plain functions only —
  // no React, no state of its own. Callers (AlertsContext) own the state
  // and pass in whatever "previous" info the engine needs (previous active
  // rule IDs for hysteresis, previous alert list for merge/acknowledgment).
  //
  // Why this exists: Dashboard.jsx, AntiscalantDosing.jsx, and
  // AlertsCenter.jsx each used to define their own threshold numbers and
  // their own alert-generation logic. They drifted (e.g. RO pressure
  // critical at >16 bar in one place, >15 bar in another) and every
  // re-render threw away acknowledgment state. This file fixes both.

  // ==================== VALUE NORMALIZATION ====================

  export const isActive = (value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
      const normalized = value.toLowerCase().trim();
      return ['1', 'true', 'on', 'active', 'yes', 'running', 'enabled', 'online'].includes(normalized);
    }
    return !!value;
  };

  export const toNumber = (value, fallback = 0) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number') return isFinite(value) ? value : fallback;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? fallback : parsed;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return fallback;
  };

  export const toDisplayString = (value, decimals = 1) => {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
    if (typeof value === 'number') return value.toFixed(decimals);
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && String(parsed) !== value.trim().toUpperCase()) return parsed.toFixed(decimals);
      return value;
    }
    return String(value);
  };

  // Normalizes the PLC SystemOperation signal into one canonical value.
  // Mirrors normalizeSystemOperation() in Dashboard.jsx so the dashboard and
  // the alert emails always agree on what mode the plant is in.
  // Returns: 'FILTER' | 'BACKWASH' | 'STANDBY' | 'OFF' | 'UNKNOWN'
  export const normalizeOperation = (raw) => {
    if (raw === undefined || raw === null || raw === '') return 'UNKNOWN';
    const v = String(raw).trim().toUpperCase();
    if (v.includes('FILTER')) return 'FILTER';
    if (v.includes('BACKWASH') || v.includes('BACK WASH')) return 'BACKWASH';
    if (v.includes('STANDBY') || v.includes('STAND BY')) return 'STANDBY';
    if (v === 'OFF' || v === 'STOP' || v === 'STOPPED') return 'OFF';
    return 'UNKNOWN';
  };

  // ==================== CANONICAL THRESHOLD TABLE ====================
  // `value`  = trigger point
  // `clear`  = the point it must cross back past before the alert clears
  //            (the hysteresis buffer — prevents flicker when a reading
  //            sits right on the trigger line)
  // direction 'high'  -> alert fires when value > trigger, clears when value <= clear (clear < trigger)
  // direction 'low'   -> alert fires when value < trigger, clears when value >= clear (clear > trigger)
  //
  // ✅ UPDATED per client request (2026-08-19 forwarded message):
  //   - Stage 1 Delta P  -> single trigger at 2.0 bar (was 0.50/0.60 two-tier)
  //   - Stage 2 Delta P  -> single trigger at 2.0 bar (was 0.55)
  //   - System Recovery  -> single trigger below 70% (was 68/72 two-tier)
  //   - Interstage Pressure alarm -> removed entirely (client asked to drop it)
  //   - Concentrate Pressure alarm -> removed entirely (client asked to drop it)
  //
  // ✅ UPDATED again per client request (2026-08-29):
  //   - System Recovery critical trigger moved from < 70% to < 50%. Clear
  //     point moved from 71.5% to 51.5% to keep the same ~1.5-point
  //     hysteresis buffer above the new trigger.
  //
  // Note: RO5-S1DeltaHigh / RO5-S2DeltaHigh PLC bits are also evaluated
  // separately below in BIT_ALARMS. If the PLC's own internal threshold for
  // those bits differs from 2.0 bar, both this numeric rule and the PLC bit
  // can fire independently at different points — worth confirming with the
  // client what the PLC-side threshold is set to so the two stay in sync.

  export const THRESHOLDS = {
    'RO5-ROPressure': {
      equipment: 'RO5 - ROPressure',
      rules: [
        { type: 'critical', direction: 'high', value: 16, clear: 15.5, severity: 'Critical', message: 'High RO Pressure' },
        { type: 'low', direction: 'low', value: 10, clear: 10.5, severity: 'High', message: 'Low RO Pressure' },
      ],
    },
    'RO5-Stage1Delta': {
      equipment: 'RO5 - Stage1Delta',
      rules: [
        { type: 'critical', direction: 'high', value: 2.0, clear: 1.9, severity: 'Critical', message: 'High Differential Pressure - Stage 1' },
      ],
    },
    'RO5-Stage2Delta': {
      equipment: 'RO5 - Stage2Delta',
      rules: [
        { type: 'critical', direction: 'high', value: 2.0, clear: 1.9, severity: 'Critical', message: 'High Differential Pressure - Stage 2' },
      ],
    },
    'RO5-MediaFilterDeltaP': {
      equipment: 'RO5 - MediaFilterDeltaP',
      rules: [
        { type: 'critical', direction: 'high', value: 2.0, clear: 0.35, severity: 'Critical', message: 'High Filter Delta P' },
        // { type: 'critical', direction: 'high', value: 2.0, clear: 0.26, severity: 'Critical', message: 'High Filter Delta P' },
      ],
    },
    'RO5-SystemRecovery': {
      equipment: 'RO5 - SystemRecovery',
      rules: [
        // FIX: critical trigger moved from < 70% to < 50% per client
        // request (2026-08-29). Clear point kept at ~1.5 points above the
        // trigger to preserve the same hysteresis behavior.
        { type: 'critical', direction: 'low', value: 50, clear: 51.5, severity: 'Critical', message: 'Low System Recovery' },
      ],
    },
    'RO5-FeedTankLevel': {
      equipment: 'RO5 - FeedTankLevel',
      rules: [
        { type: 'critical', direction: 'low', value: 20, clear: 23, severity: 'Critical', message: 'Low Feed Tank Level' },
        { type: 'warning', direction: 'low', value: 30, clear: 33, severity: 'Medium', message: 'Low Feed Tank Level' },
      ],
    },
    'RO5-FEEDFlow': {
      equipment: 'RO5 - FEEDFlow',
      rules: [
        { type: 'low', direction: 'low', value: 50, clear: 53, severity: 'High', message: 'Low Feed Flow' },
      ],
    },
    'RO5-PureWaterEc': {
      equipment: 'RO5 - PureWaterEc',
      rules: [
        { type: 'high', direction: 'high', value: 50, clear: 45, severity: 'Medium', message: 'High Product Water EC' },
      ],
    },
    'RO5-ConcetrateFlow': {
      equipment: 'RO5 - ConcetrateFlow',
      rules: [
        { type: 'low', direction: 'low', value: 10, clear: 11, severity: 'Medium', message: 'Low Concentrate Flow' },
      ],
    },
    // ✅ REMOVED per client request: RO5-InterstagePress (High Interstage Pressure)
    // ✅ REMOVED per client request: RO5-ConcetratePress (High Concentrate Pressure)
  };


  const BIT_ALARMS = [
    { key: 'RO5-HighPrefilterDeltaP', message: 'High Prefilter Delta P', equipment: 'RO5 - Prefilter', severity: 'High', description: 'Prefilter is clogged and needs backwashing or replacement.' },
    { key: 'RO5-PowerProblem', message: 'Power Problem', equipment: 'RO5 - Power Supply', severity: 'Critical', description: 'PLC reports a power supply fault. Check incoming power and control panel.' },
    { key: 'RO5-HighMediaDeltaP', message: 'High Media Filter Delta P', equipment: 'RO5 - Media Filter', severity: 'High', description: 'Media filter differential pressure is high — filter may need backwashing.' },
    { key: 'RO5-S2DeltaHigh', message: 'High Differential Pressure - Stage 2', equipment: 'RO5 - Stage 2', severity: 'High', description: 'Stage 2 membrane differential pressure has exceeded the PLC-set limit.' },
    { key: 'RO5-S1DeltaHigh', message: 'High Differential Pressure - Stage 1', equipment: 'RO5 - Stage 1', severity: 'Critical', description: 'Stage 1 membrane differential pressure has exceeded the PLC-set limit.' },
    { key: 'RO5-HighROPressure', message: 'High RO Pressure', equipment: 'RO5 - RO Pressure', severity: 'Critical', description: 'RO system pressure has exceeded the PLC-set limit.' },
    { key: 'RO5-FeedTankLow', message: 'Feed Tank Low Signal', equipment: 'RO5 - Feed Tank', severity: 'Critical', description: 'PLC reports the feed tank low bit is ON. Feed pump may stop soon to prevent dry-run.' },
    // { key: 'RO5-FeedTankLow', message: 'Low Feed Tank Level', equipment: 'RO5 - Feed Tank', severity: 'Critical', description: 'Feed tank level is low — feed pump may stop soon to prevent dry-run.' },
  ];

  // ✅ Exported for AlertsCenter.jsx — maps each PLC bit alarm's candidate
  // id (as generated by the `push(`${key}:bit`, ...)` call below) to a
  // human-readable description, and marks it as PLC-sourced so the UI can
  // badge it correctly and show the description line under each alert.
  export const MQTT_ALARMS = BIT_ALARMS.map(({ key, description }) => ({
    id: `${key}:bit`,
    description,
  }));

  // ==================== CORE EVALUATION ====================

  /**
   * Evaluate every canonical sensor-threshold rule and the standing binary
   * status rules against the current live readings.
   *
   * @param {(key: string) => any} getValue - from DataContext
   * @param {Set<string>} previousActiveIds - rule IDs that were active last
   *   time this ran, used for hysteresis (so a value sitting right on the
   *   line doesn't flicker in and out).
   * @returns {Array<Candidate>} every rule's current state (active or not)
   */
  export function evaluateSensorAlerts(getValue, previousActiveIds = new Set()) {
    const candidates = [];

    const push = (id, active, meta) => candidates.push({ id, active, source: 'sensor', ...meta });

    // -------------------- Binary / status rules --------------------
    const systemOperation = getValue('RO5-SystemOperation');
    const isSystemOn = isActive(systemOperation);

    // ⚠️ TEMPORARILY DISABLED — this rule was firing "Power Problem - System
    // Offline" permanently because the raw backend key for system status
    // wasn't matching any alias in DataContext.jsx's KEY_MAPPING. That's now
    // fixed (RO5-SystemActive is mapped to RO5-SystemOperation), and the real
    // PLC PowerProblem bit is now covered directly via BIT_ALARMS below, so
    // this derived rule is left disabled to avoid a duplicate/competing
    // "power problem" signal. Re-enable only if you want a *second*,
    // independently-derived check on top of the PLC's own bit.
    //
    // push('RO5-SystemOperation:offline', !isSystemOn, {
    //   sensorKey: 'RO5-SystemOperation',
    //   severity: 'Critical',
    //   message: 'Power Problem - System Offline',
    //   equipment: 'RO5 - SystemOperation',
    //   value: toDisplayString(systemOperation),
    //   threshold: 'ON required',
    //   isPowerProblem: true,
    // });

    // ❌ REMOVED per client request: System in Manual Mode alert
    // The following block has been removed:
    // const systemMode = getValue('RO5-SystemMode');
    // const isAutoMode = isActive(systemMode);
    // push('RO5-SystemMode:manual', isSystemOn && !isAutoMode, {
    //   sensorKey: 'RO5-SystemMode',
    //   severity: 'High',
    //   message: 'System in Manual Mode',
    //   equipment: 'RO5 - SystemMode',
    //   value: toDisplayString(systemMode),
    //   threshold: 'Auto mode required',
    // });

    const dosingActive = getValue('RO5-AntiscalantDosingActive');
    const isDosingActive = isActive(dosingActive);
    push('RO5-AntiscalantDosingActive:stopped', isSystemOn && !isDosingActive, {
      sensorKey: 'RO5-AntiscalantDosingActive',
      severity: 'High',
      message: 'Antiscalant Dosing Stopped',
      equipment: 'RO5 - AntiscalantDosingActive',
      value: toDisplayString(dosingActive),
      threshold: 'Running required',
    });

    // -------------------- Backwash mode (informational) --------------------
    // ✅ NEW: fires when the plant enters BACKWASH, clears when it leaves.
    //
    // Same priority as the dashboard: SystemOperation is authoritative when it
    // reports a recognised mode; the PrefilterBackwash bit is only used when
    // SystemOperation is missing or unrecognised.
    //
    // Skipped (no candidate pushed) only when BOTH tags have never reported,
    // so a missing tag can never produce a false alert.
    const backwashBit = getValue('RO5-PrefilterBackwash');
    const operationMode = normalizeOperation(systemOperation);
    const hasBackwashSignal =
      operationMode !== 'UNKNOWN' ||
      (backwashBit !== undefined && backwashBit !== null);

    if (hasBackwashSignal) {
      const inBackwash =
        operationMode !== 'UNKNOWN'
          ? operationMode === 'BACKWASH'
          : isActive(backwashBit);

      push('RO5-SystemOperation:backwash', inBackwash, {
        sensorKey: 'RO5-SystemOperation',
        severity: 'Info',
        message: 'System in Backwash Mode',
        equipment: 'RO5 - Prefilter',
        value: 'BACKWASH',
        threshold: 'Informational',
        description: 'The plant has entered backwash mode. Filtering is paused until the cycle finishes.',
      });
    }

    // -------------------- PLC bit alarms --------------------
    BIT_ALARMS.forEach(({ key, message, equipment, severity, description }) => {
      const raw = getValue(key);
      if (raw === undefined || raw === null) return; // no reading yet — skip, don't false-alarm
      push(`${key}:bit`, isActive(raw), {
        sensorKey: key,
        severity,
        message,
        equipment,
        value: toDisplayString(raw),
        threshold: 'OFF required',
        source: 'PLC',
        description,
      });
    });

    // -------------------- Numeric threshold rules (with hysteresis) --------------------
    Object.entries(THRESHOLDS).forEach(([sensorKey, config]) => {
      const raw = getValue(sensorKey);
      if (raw === undefined || raw === null) return;
      const value = toNumber(raw);

      config.rules.forEach((rule) => {
        const id = `${sensorKey}:${rule.type}`;
        const wasActive = previousActiveIds.has(id);
        const isHigh = rule.direction === 'high';

        const nowActive = wasActive
          ? (isHigh ? value > rule.clear : value < rule.clear)   // needs to cross the buffer to clear
          : (isHigh ? value > rule.value : value < rule.value);  // needs to cross the trigger to fire

        push(id, nowActive, {
          sensorKey,
          severity: rule.severity,
          message: rule.message,
          equipment: config.equipment,
          value: toDisplayString(value, sensorKey === 'RO5-PureWaterEc' ? 0 : sensorKey.includes('Delta') ? 2 : 1),
          threshold: `${isHigh ? '>' : '<'} ${rule.value}`,
        });
      });
    });

    // -------------------- Calculated rules (combine multiple sensors) --------------------
    const feedFlow = toNumber(getValue('RO5-FEEDFlow'));
    const permeateFlow = toNumber(getValue('RO5-Permeateflow'));
    const concentrateFlow = toNumber(getValue('RO5-ConcetrateFlow'));
    const massBalance = Math.abs(feedFlow - (permeateFlow + concentrateFlow));
    push('calc-mass-balance', feedFlow > 0 && massBalance > 5, {
      sensorKey: 'calc-mass-balance',
      severity: 'Medium',
      message: 'Mass Balance Error',
      equipment: 'RO5 - Mass Balance',
      value: toDisplayString(massBalance),
      threshold: '< 5 m³/h',
    });

    push('RO5-Permeateflow:low-production', isSystemOn && permeateFlow > 0 && permeateFlow < 20, {
      sensorKey: 'RO5-Permeateflow',
      severity: 'Medium',
      message: 'Low Permeate Production',
      equipment: 'RO5 - Permeateflow',
      value: toDisplayString(permeateFlow),
      threshold: '> 20 m³/h',
    });

    return candidates;
  }

  // ==================== MERGE / ACKNOWLEDGMENT-PRESERVING LOGIC ====================

  /**
   * Merge freshly-evaluated candidates against the previous alert list.
   * - A candidate that's newly active becomes a new 'Active' alert.
   * - A candidate that's still active and already existed keeps whatever
   *   status it had (so 'Acknowledged' survives re-evaluation instead of
   *   getting stomped back to 'Active' every tick).
   * - A candidate that's no longer active is dropped from the live list,
   *   and a 'cleared' event is recorded if it had been active before.
   *
   * @param {Array<Candidate>} candidates
   * @param {Array<Alert>} previousAlerts
   * @returns {{ alerts: Array<Alert>, events: Array<HistoryEvent> }}
   */
  export function mergeAlerts(candidates, previousAlerts = []) {
    const prevById = new Map(previousAlerts.map((a) => [a.id, a]));
    const nowIso = new Date().toISOString();
    const merged = [];
    const events = [];

    candidates.forEach((c) => {
      const prev = prevById.get(c.id);

      if (c.active) {
        if (prev) {
          // Still firing — keep its status (Active or Acknowledged) intact.
          merged.push({ ...prev, value: c.value, threshold: c.threshold, lastSeen: nowIso });
        } else {
          // Brand new trigger (first time, or re-triggered after clearing).
          const alert = {
            id: c.id,
            type: c.message,
            severity: c.severity,
            status: 'Active',
            equipment: c.equipment,
            value: c.value,
            threshold: c.threshold,
            source: c.source,
            description: c.description || '',
            isPLCAlarm: c.source === 'PLC',
            isPowerProblem: !!c.isPowerProblem,
            firstTriggered: nowIso,
            lastSeen: nowIso,
            date: new Date().toLocaleDateString(),
            time: new Date().toLocaleTimeString(),
          };
          merged.push(alert);
          events.push({ id: `${c.id}-trig-${Date.now()}`, alertId: c.id, kind: 'triggered', type: c.message, severity: c.severity, time: nowIso });
        }
      } else if (prev) {
        // Was active, now cleared — drop from the live list, log it.
        events.push({ id: `${c.id}-clear-${Date.now()}`, alertId: c.id, kind: 'cleared', type: c.message, severity: c.severity, time: nowIso });
      }
    });

    return { alerts: merged, events };
  }