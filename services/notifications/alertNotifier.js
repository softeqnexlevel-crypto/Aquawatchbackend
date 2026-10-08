// services/notifications/alertNotifier.js
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const channels = require('./channels');
const { getEmailRecipients } = require('./recipients');
const { evaluateBackwashFilterDpAlert, AlertRules } = require('./rules');
const { slug, withRetry, actionFor, channelAllows } = require('./util');
const { rawKeysFor } = require('./keyMap');

const CHANNELS = ['email', 'slack', 'calendar'];

const AUDIT_KEYS = [
  'RO5-SystemOperation',
  'RO5-SystemActive',
  'RO5-SystemMode',
  'RO5-Feedpump',
  'RO5-PrefilterBackwash',
  'RO5-ROPressure',
  'RO5-Stage1Delta',
  'RO5-Stage2Delta',
  'RO5-MediaFilterDeltaP',
  'RO5-SystemRecovery',
  'RO5-FeedTankLevel',
  'RO5-FEEDFlow',
  'RO5-Permeateflow',
  'RO5-ConcetrateFlow',
  'RO5-PureWaterEc',
];

class AlertNotifier {
  constructor({ evaluateSensorAlerts, getValue, logger = console }) {
    if (typeof evaluateSensorAlerts !== 'function') {
      throw new Error('evaluateSensorAlerts is required');
    }
    if (typeof getValue !== 'function') {
      throw new Error('getValue is required');
    }

    this.evaluateSensorAlerts = evaluateSensorAlerts;
    this.rawGet = getValue;
    this.log = logger;

    this.getValue = (key) => this.resolve(key);

    this.rules = new AlertRules(this.getValue, () => this.evaluate());

    this.activeIds = new Set();
    this.confirmTimers = new Map();
    this.pending = [];
    this.evalTimer = null;
    this.flushTimer = null;
    this.tick = null;
    this.audited = false;
    this.startedAt = Date.now();
    this.lastMessageAt = Date.now();

    // Rising-edge latches for the "simple" notifications.
    this._tankEmptyLatched = false;
    this._backwashLatched = false;
    this._lastBackwashMode = null;

    this.state = this.loadState();
  }

  resolve(key) {
    const tries = rawKeysFor(key);
    for (const k of tries) {
      const v = this.rawGet(k);
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  start() {
    this.tick = setInterval(() => this.evaluate(), config.tickMs);
    this.tick.unref?.();
  }

  stop() {
    [this.evalTimer, this.flushTimer, this.tick, ...this.confirmTimers.values()]
      .forEach((t) => t && clearTimeout(t));
    clearInterval(this.tick);
    this.rules.stop();
  }

  onTag() {
    this.lastMessageAt = Date.now();
    if (!this.evalTimer) {
      this.evalTimer = setTimeout(() => {
        this.evalTimer = null;
        this.evaluate();
      }, config.evalIntervalMs);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Evaluation
  // ─────────────────────────────────────────────────────────────────────────

  dataLostCandidate(stale) {
    const secs = Math.round((Date.now() - this.lastMessageAt) / 1000);
    return {
      id: 'derived-plc-data-lost',
      active: stale,
      source: 'derived',
      severity: 'Critical',
      message: 'PLC Data Lost',
      equipment: 'RO5 - MQTT Link',
      value: `${secs}s since last data`,
      threshold: `> ${Math.round(config.staleMs / 1000)}s`,
      description:
        'No data received from the PLC/ABox over MQTT. ' +
        'Other alerts are paused until data resumes.',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Simple Tank Empty Notification (independent of the alert engine)
  // Fires ONE plain email/Slack the moment the tank hits empty in STANDBY.
  // ─────────────────────────────────────────────────────────────────────────

  maybeNotifyTankEmpty() {
    const tankLevelRaw = this.getValue('RO5-FeedTankLevel');
    const systemOperationRaw = this.getValue('RO5-SystemOperation');

    const tankLevel = Number(tankLevelRaw);

    const operation = String(systemOperationRaw ?? '')
      .trim()
      .toUpperCase();

    const isStandby =
      operation.includes('STANDBY') ||
      operation.includes('STAND BY');

    const isEmpty =
      Number.isFinite(tankLevel) && tankLevel <= 10;

    const shouldFire = isStandby && isEmpty;

    if (shouldFire && !this._tankEmptyLatched) {
      this._tankEmptyLatched = true;

      channels
        .sendTankEmptyNotification({
          startedAt: new Date(),
          tankLevel,
          currentMode: operation || undefined,
        })
        .catch((err) =>
          this.log.error?.(
            `[alert-notifier] tank-empty notification failed: ${err.message}`
          )
        );
    }

    if (!shouldFire && this._tankEmptyLatched) {
      this._tankEmptyLatched = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Simple Backwash Notification (independent of the alert engine)
  // Fires ONE plain email/Slack on the rising edge into BACKWASH.
  // ─────────────────────────────────────────────────────────────────────────

  maybeNotifyBackwash() {
    const opRaw = this.getValue('RO5-SystemOperation');
    const modeRaw = this.getValue('RO5-SystemMode');
    const bwBitRaw = this.getValue('RO5-PrefilterBackwash');

    const normalize = (raw) => {
      if (raw === undefined || raw === null || raw === '') return 'UNKNOWN';
      const v = String(raw).trim().toUpperCase();
      if (v.includes('BACKWASH') || v.includes('BACK WASH')) return 'BACKWASH';
      if (v.includes('FILTER')) return 'FILTER';
      if (v.includes('STANDBY') || v.includes('STAND BY')) return 'STANDBY';
      if (v === 'OFF' || v === 'STOP' || v === 'STOPPED') return 'OFF';
      return 'UNKNOWN';
    };

    const isOn = (raw) => {
      if (raw === undefined || raw === null) return false;
      const v = String(raw).trim().toUpperCase();
      return v === 'ON' || v === 'TRUE' || v === '1' || v === 'YES';
    };

    let currentMode =
      normalize(opRaw) !== 'UNKNOWN' ? normalize(opRaw) :
      normalize(modeRaw) !== 'UNKNOWN' ? normalize(modeRaw) :
      isOn(bwBitRaw) ? 'BACKWASH' : 'UNKNOWN';

    if (currentMode !== 'BACKWASH' && isOn(bwBitRaw)) currentMode = 'BACKWASH';

    const enteredBackwash =
      currentMode === 'BACKWASH' && this._lastBackwashMode !== 'BACKWASH';

    if (enteredBackwash && !this._backwashLatched) {
      this._backwashLatched = true;

      // Grab the active high-pressure media reading for the message.
      const mediaPressureRaw =
        this.getValue('RO5-MediaFilterInPress') ??
        this.getValue('RO5-ROPressure');

      const mediaPressure = Number(mediaPressureRaw);

      channels
        .sendBackwashNotification({
          startedAt: new Date(),
          mediaPressure: Number.isFinite(mediaPressure) ? mediaPressure : undefined,
          previousMode: this._lastBackwashMode || undefined,
        })
        .catch((err) =>
          this.log.error?.(
            `[alert-notifier] backwash notification failed: ${err.message}`
          )
        );
    }

    if (currentMode !== 'BACKWASH') {
      this._backwashLatched = false;
    }

    this._lastBackwashMode = currentMode;
  }

  evaluate() {
    const stale = Date.now() - this.lastMessageAt > config.staleMs;

    let candidates = [this.dataLostCandidate(stale)];

    if (!stale) {
      try {
        const engine = this.rules.apply([
          // Existing sensor/threshold alerts
          ...this.evaluateSensorAlerts(this.getValue, this.activeIds),

          // Backwash filter DP alert
          evaluateBackwashFilterDpAlert(this.getValue),

          // NOTE: `tankEmptyCandidate()` was REMOVED so the verbose
          // sendEmail() does NOT fire for the tank-empty case.
          // The simple `maybeNotifyTankEmpty()` below handles it instead.
        ]);

        this.activeIds = new Set(engine.filter((c) => c.active).map((c) => c.id));
        candidates = [...candidates, ...engine];
      } catch (err) {
        this.log.error?.(`[alert-notifier] engine error: ${err.message}`);
        return;
      }
    }

    if (Date.now() - this.startedAt < config.startupGraceMs) {
      return;
    }

    this.auditOnce();

    // Simple, dedicated notifications (fire once on rising edge).
    this.maybeNotifyTankEmpty();
    this.maybeNotifyBackwash();

    for (const c of candidates) {
      const st = this.state[c.id];

      if (c.active) {
        if (!st?.active && !this.confirmTimers.has(c.id)) {
          this.scheduleConfirm(c);
        }
      } else {
        const t = this.confirmTimers.get(c.id);
        if (t) {
          clearTimeout(t);
          this.confirmTimers.delete(c.id);
        }
        if (st?.active) {
          this.onCleared(c.id);
        }
      }
    }
  }

  auditOnce() {
    if (this.audited) return;
    this.audited = true;

    const missing = AUDIT_KEYS.filter((k) => this.getValue(k) === undefined);
    if (missing.length) {
      this.log.warn?.(
        `[alert-notifier] tags never received ` +
        `(rules depending on them stay silent): ${missing.join(', ')}`
      );
    }
  }

  scheduleConfirm(c) {
    this.confirmTimers.set(
      c.id,
      setTimeout(() => {
        this.confirmTimers.delete(c.id);

        const stillActive =
          c.id === 'derived-plc-data-lost'
            ? Date.now() - this.lastMessageAt > config.staleMs
            : this.activeIds.has(c.id);

        if (stillActive && !this.state[c.id]?.active) {
          this.onRaised(c);
        }
      }, config.confirmMs)
    );
  }

  lastSent(prev, channel) {
    return prev?.sent?.[channel] || prev?.lastNotifiedAt || null;
  }

  inCooldown(prev, channel, now) {
    const last = this.lastSent(prev, channel);
    return Boolean(last) && now - new Date(last) < config.cooldownMs;
  }

  onRaised(c) {
    const now = new Date();
    const prev = this.state[c.id];

    const task = {
      id: c.id,
      cycleId: `${slug(c.id)}-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
      title: c.message,
      severity: c.severity,
      equipment: c.equipment,
      message: c.description || '',
      value:
        c.value !== undefined
          ? c.threshold
            ? `${c.value} (limit ${c.threshold})`
            : String(c.value)
          : undefined,
      source: c.source,
      action: actionFor(c.message),
      startedAt: now,
    };

    task.channels = CHANNELS.filter(
      (ch) => channelAllows(ch, task) && !this.inCooldown(prev, ch, now)
    );

    const sent = { ...(prev?.sent || {}) };
    if (prev?.lastNotifiedAt && !prev.sent) {
      CHANNELS.forEach((ch) => { sent[ch] = prev.lastNotifiedAt; });
    }

    this.state[c.id] = {
      active: true,
      startedAt: now.toISOString(),
      cycleId: task.cycleId,
      slackTs: null,
      sent,
    };

    this.saveState();

    if (!task.channels.length) {
      this.log.info?.(
        `[alert-notifier] "${c.message}" raised but no channel will send it`
      );
      return;
    }

    this.pending.push(task);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), config.batchWindowMs);
    }
  }

  markSent(channel, ids) {
    if (!ids.length) return;
    const stamp = new Date().toISOString();
    ids.forEach((id) => {
      if (this.state[id]) {
        this.state[id].sent = { ...(this.state[id].sent || {}), [channel]: stamp };
      }
    });
    this.saveState();
  }

  async flush() {
    this.flushTimer = null;
    const tasks = this.pending.splice(0);
    if (!tasks.length) return;

    const forChannel = (ch) => tasks.filter((t) => t.channels.includes(ch));
    const forEmail = forChannel('email');
    const forSlack = forChannel('slack');
    const forCal = forChannel('calendar');

    if (config.dryRun) {
      const lines = (ts) =>
        ts.map((t) => `    - [${t.severity}] ${t.title} (${t.equipment || '—'}) ${t.value || ''}`).join('\n');

      if (forEmail.length) {
        const recipients = await getEmailRecipients(this.log);
        this.log.info?.(`[alert-notifier][DRY RUN] EMAIL → ${recipients.length} user(s):\n${lines(forEmail)}`);
      }
      if (forSlack.length) this.log.info?.(`[alert-notifier][DRY RUN] SLACK:\n${lines(forSlack)}`);
      if (forCal.length) this.log.info?.(`[alert-notifier][DRY RUN] CALENDAR:\n${lines(forCal)}`);

      CHANNELS.forEach((ch) => this.markSent(ch, forChannel(ch).map((t) => t.id)));
      return;
    }

    await Promise.allSettled([
      forEmail.length && this.runEmail(forEmail).then((ids) => this.markSent('email', ids)),
      forSlack.length && this.runSlack(forSlack).then((ids) => this.markSent('slack', ids)),
      forCal.length && this.runCalendar(forCal).then((ids) => this.markSent('calendar', ids)),
    ].filter(Boolean));
  }

  async runEmail(tasks) {
    try {
      const recipients = await getEmailRecipients(this.log);
      await withRetry(() => channels.sendEmail(tasks, recipients));
      this.log.info?.(`[alert-notifier] email sent to ${recipients.length} user(s) (${tasks.length} alert(s))`);
      return tasks.map((t) => t.id);
    } catch (err) {
      this.log.error?.(`[alert-notifier] email failed: ${err.message}`);
      return [];
    }
  }

  async runSlack(tasks) {
    const delivered = [];
    const shown = tasks.slice(0, config.maxSlackPerBatch);

    for (const t of shown) {
      try {
        const ts = await withRetry(() => channels.postSlackAlert(t));
        if (this.state[t.id]) {
          this.state[t.id].slackTs = ts;
          this.saveState();
        }
        delivered.push(t.id);
      } catch (err) {
        this.log.error?.(`[alert-notifier] slack failed for "${t.title}": ${err.message}`);
      }
    }

    if (tasks.length > shown.length) {
      try {
        await withRetry(() =>
          channels.postSlackText(`:warning: …and ${tasks.length - shown.length} more new alerts. Check the dashboard.`)
        );
      } catch (err) {
        this.log.error?.(`[alert-notifier] slack overflow note failed: ${err.message}`);
      }
    }
    return delivered;
  }

  async runCalendar(tasks) {
    const delivered = [];
    const shown = tasks.slice(0, config.maxCalendarPerBatch);

    for (const t of shown) {
      try {
        await withRetry(() => channels.createCalendarEvent(t));
        delivered.push(t.id);
      } catch (err) {
        this.log.error?.(`[alert-notifier] calendar failed for "${t.title}": ${err.message}`);
      }
    }

    if (tasks.length > shown.length) {
      this.log.warn?.(`[alert-notifier] ${tasks.length - shown.length} calendar events skipped (batch cap)`);
    }
    return delivered;
  }

  async onCleared(id) {
    const st = this.state[id];
    this.state[id] = { ...st, active: false, slackTs: null };
    this.saveState();

    if (st.slackTs && config.slack.enabled && !config.dryRun) {
      const minutes = Math.max(1, Math.round((Date.now() - new Date(st.startedAt).getTime()) / 60000));
      try {
        await withRetry(() => channels.postSlackText(`:white_check_mark: Cleared after ${minutes} min.`, st.slackTs));
      } catch (err) {
        this.log.error?.(`[alert-notifier] slack clear note failed: ${err.message}`);
      }
    }
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveState() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [id, s] of Object.entries(this.state)) {
      const stamps = [...Object.values(s.sent || {}), s.lastNotifiedAt]
        .filter(Boolean)
        .map((x) => new Date(x).getTime());
      const lastActivity = stamps.length ? Math.max(...stamps) : 0;
      if (!s.active && lastActivity < cutoff) delete this.state[id];
    }

    try {
      fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
      fs.writeFileSync(config.stateFile, JSON.stringify(this.state));
    } catch (err) {
      this.log.error?.(`[alert-notifier] could not save state: ${err.message}`);
    }
  }
}

module.exports = { AlertNotifier };