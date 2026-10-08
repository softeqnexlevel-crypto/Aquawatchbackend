// services/notifications/config.js
// All settings come from environment variables (see README.md).

const SEVERITIES = ['Info', 'Low', 'Medium', 'High', 'Critical'];

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const typeList = (v) => list(v).map((s) => s.toLowerCase());
const sev = (v, d) => (SEVERITIES.includes(v) ? v : d);

module.exports = {
  SEVERITIES,

  enabled: process.env.ALERT_NOTIFIER_ENABLED !== 'false',
  // Path to the SHARED alertEngine file (absolute, or relative to the backend root).
  enginePath: process.env.ALERT_ENGINE_PATH,
  // Log what would be sent, without sending anything. Use this for the first rollout.
  dryRun: process.env.ALERT_DRY_RUN === 'true',
  staleMs: num(process.env.ALERT_DATA_STALE_MS, 120000),  // no MQTT data for this long → "PLC Data Lost"
  tickMs: num(process.env.ALERT_TICK_MS, 5000),           // periodic re-check (stale watchdog, delayed rules)

  // Evaluation / noise control
  evalIntervalMs: num(process.env.ALERT_EVAL_INTERVAL_MS, 1000),   // throttle for evaluating MQTT updates
  startupGraceMs: num(process.env.ALERT_STARTUP_GRACE_MS, 30000),  // no notifications while tags are still arriving
  confirmMs: num(process.env.ALERT_CONFIRM_MS, 3000),              // alert must stay active this long
  cooldownMs: num(process.env.ALERT_COOLDOWN_MS, 15 * 60000),      // per alert AND per channel: min gap between notifications
  batchWindowMs: num(process.env.ALERT_BATCH_WINDOW_MS, 5000),     // alerts raised together share one email
  maxSlackPerBatch: num(process.env.ALERT_MAX_SLACK_PER_BATCH, 10),
  maxCalendarPerBatch: num(process.env.ALERT_MAX_CALENDAR_PER_BATCH, 10),
  filterDpLimitBar: num(process.env.FILTER_DP_LIMIT_BAR, 0.40),    // keep in sync with the dashboard
  stateFile: process.env.NOTIFIER_STATE_FILE || './data/alert-notifier-state.json',

  // Every channel is independent: its own on/off switch, minimum severity,
  // and optional type filters. Type names are alert titles, matched
  // case-insensitively, e.g. SLACK_ONLY_TYPES="Low Feed Tank Level,PLC Data Lost"
  //   *_ONLY_TYPES    → channel handles ONLY these alerts (empty = all)
  //   *_EXCLUDE_TYPES → channel never handles these alerts
  email: {
    enabled: process.env.EMAIL_ENABLED !== 'false',
    minSeverity: sev(process.env.EMAIL_MIN_SEVERITY, 'Low'),
    onlyTypes: typeList(process.env.EMAIL_ONLY_TYPES),
    excludeTypes: typeList(process.env.EMAIL_EXCLUDE_TYPES),
    host: process.env.SMTP_HOST,
    port: num(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: list(process.env.ALERT_EMAIL_TO),
  },

  // Email goes to the website's users (active, not deleted).
  //   mode 'all'       → every such user
  //   mode 'signed_in' → only users with a valid, unexpired login session
  // roles: optional filter, e.g. "admin,operator". ALERT_EMAIL_TO is only a fallback.
  recipients: {
    mode: process.env.ALERT_RECIPIENT_MODE === 'signed_in' ? 'signed_in' : 'all',
    roles: list(process.env.ALERT_RECIPIENT_ROLES).map((r) => r.toLowerCase()),
    cacheMs: num(process.env.ALERT_RECIPIENTS_CACHE_MS, 60000),
  },

  slack: {
    enabled: process.env.SLACK_ENABLED !== 'false',
    minSeverity: sev(process.env.SLACK_MIN_SEVERITY, 'Low'),
    onlyTypes: typeList(process.env.SLACK_ONLY_TYPES),
    excludeTypes: typeList(process.env.SLACK_EXCLUDE_TYPES),
    botToken: process.env.SLACK_BOT_TOKEN,   // xoxb-..., needs chat:write
    channel: process.env.SLACK_CHANNEL_ID,   // e.g. C0123456789 (bot must be invited)
  },

  calendar: {
    enabled: process.env.CALENDAR_ENABLED !== 'false',
    minSeverity: sev(process.env.CALENDAR_MIN_SEVERITY, 'Medium'),
    onlyTypes: typeList(process.env.CALENDAR_ONLY_TYPES),
    excludeTypes: typeList(process.env.CALENDAR_EXCLUDE_TYPES),
    calendarId: process.env.GOOGLE_CALENDAR_ID, // shared team calendar
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    timeZone: process.env.MAINT_TIMEZONE || 'Africa/Nairobi',
    eventHour: num(process.env.MAINT_EVENT_HOUR, 9),
    durationMin: num(process.env.MAINT_EVENT_DURATION_MIN, 30),
    minLeadMin: num(process.env.MAINT_EVENT_MIN_LEAD_MIN, 60),
  },
};