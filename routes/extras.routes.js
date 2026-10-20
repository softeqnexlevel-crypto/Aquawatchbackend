// backend/routes/extras.routes.js
// Extra endpoints for the Settings page: tank capacities, gateway status,
// email-alert preferences, SMTP status and a test email.
const express = require('express');
const router = express.Router();
const db = require('../database/postgres');
const authMiddleware = require('../middleware/auth.middleware');
const tenantContext = require('../middleware/tenantContext');
const tenants = require('../services/tenants.service');

const MAIN = 1;

const requireAuth = authMiddleware.requireAuth;
const DEFAULTS = { feedTankCapacity: 300, flushTankCapacity: 200, emailAlertsEnabled: true };

async function ensureTable() {
    await db.getPool().query(`CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
}
async function readExtra() {
    await ensureTable();
    const r = await db.getPool().query(`SELECT value FROM app_kv WHERE key = 'settings_extra'`);
    return { ...DEFAULTS, ...(r.rows[0]?.value || {}) };
}

const smtpConfigured = () => !!(process.env.SMTP_HOST || process.env.EMAIL_HOST);

// ---- tank capacities + tenant-wide email switch ----
router.get('/settings-extra', requireAuth, tenantContext, async (req, res) => {
    try {
        if (req.tenantId !== MAIN) {
            const c = tenants.mergeConfig((await tenants.getRow(req.tenantId) || {}).config);
            return res.json({ extra: { feedTankCapacity: c.feedTankCapacity, flushTankCapacity: c.flushTankCapacity, emailAlertsEnabled: false } });
        }
        res.json({ extra: await readExtra() });
    }
    catch (e) { console.error('[extras] get', e.message); res.status(500).json({ error: 'Failed to load settings' }); }
});

router.put('/settings-extra', requireAuth, tenantContext, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
        if (req.tenantId !== MAIN) {
            const row = await tenants.update(req.tenantId, { config: { feedTankCapacity: req.body.feedTankCapacity, flushTankCapacity: req.body.flushTankCapacity } });
            const c = tenants.mergeConfig(row.config);
            return res.json({ message: 'Saved', extra: { feedTankCapacity: c.feedTankCapacity, flushTankCapacity: c.flushTankCapacity, emailAlertsEnabled: false } });
        }
        const cur = await readExtra();
        const next = { ...cur };
        for (const k of ['feedTankCapacity', 'flushTankCapacity']) {
            if (req.body[k] !== undefined && req.body[k] !== '') {
                const n = Number(req.body[k]);
                if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return res.status(400).json({ error: `${k} must be a number greater than 0` });
                next[k] = n;
            }
        }
        if (typeof req.body.emailAlertsEnabled === 'boolean') next.emailAlertsEnabled = req.body.emailAlertsEnabled;
        await db.getPool().query(
            `INSERT INTO app_kv (key, value) VALUES ('settings_extra', $1::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(next)]);
        res.json({ message: 'Saved', extra: next });
    } catch (e) { console.error('[extras] put', e.message); res.status(500).json({ error: 'Failed to save' }); }
});

// ---- gateway (MQTT) status, read-only ----
router.get('/gateway/status', requireAuth, tenantContext, (req, res) => {
    try {
        const status = require('../mqtt/mqttClient').getStatus(req.tenantId);
        if (req.tenantId !== MAIN) return res.json({ status, broker: status.brokerHost || '' });
        let broker = status.brokerHost || '';
        try { broker = new URL(process.env.MQTT_URL || process.env.MQTT_BROKER_URL || '').host; } catch (_) { /* hide anything unparsable */ }
        res.json({ status, broker });
    } catch (e) { res.status(500).json({ error: 'Failed to read gateway status' }); }
});

// ---- my email-alert preference ----
router.get('/notifications/me', requireAuth, async (req, res) => {
    const extra = await readExtra().catch(() => DEFAULTS);
    res.json({ emailAlerts: req.user.emailAlerts !== false, email: req.user.email, tenantEnabled: extra.emailAlertsEnabled, smtpConfigured: smtpConfigured() });
});

router.put('/notifications/me', requireAuth, async (req, res) => {
    try {
        if (typeof req.body.emailAlerts !== 'boolean') return res.status(400).json({ error: 'emailAlerts must be true or false' });
        const full = await db.findUserById(req.user.id);
        await db.updateUser(req.user.id, { preferences: { ...(full.preferences || {}), emailAlerts: req.body.emailAlerts } });
        res.json({ message: 'Saved', emailAlerts: req.body.emailAlerts });
    } catch (e) { console.error('[extras] prefs', e.message); res.status(500).json({ error: 'Failed to save' }); }
});

router.post('/notifications/test', requireAuth, async (req, res) => {
    try {
        if (!smtpConfigured()) return res.status(400).json({ error: 'SMTP is not set up on the server, so no email can be sent.' });
        const cfg = require('../services/notifications/config').email;
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined });
        await t.sendMail({ from: cfg.from || cfg.user, to: req.user.email, subject: 'Aqua System Tech – test email', text: 'This is a test email from your Aqua System Tech platform. Alerts will arrive at this address.' });
        res.json({ message: `Test email sent to ${req.user.email}` });
    } catch (e) { console.error('[extras] test email', e.message); res.status(500).json({ error: 'Could not send: ' + e.message }); }
});

// ---- latest stored MQTT reading of one tag (exact value, not an average) ----
router.get('/last-reading/:parameter', requireAuth, tenantContext, async (req, res) => {
    try {
        const p = String(req.params.parameter || '');
        if (!/^RO5-[A-Za-z0-9]{1,60}$/.test(p)) return res.status(400).json({ error: 'Invalid parameter' });
        const r = req.tenantId === MAIN
            ? await db.getPool().query('SELECT time, value FROM measurements WHERE parameter = $1 ORDER BY time DESC LIMIT 1', [p])
            : await db.getPool().query('SELECT time, value FROM tenant_measurements WHERE tenant_id = $1 AND parameter = $2 ORDER BY time DESC LIMIT 1', [req.tenantId, p]);
        if (!r.rows.length) return res.json({ parameter: p, value: null, time: null });
        res.json({ parameter: p, value: Number(r.rows[0].value), time: r.rows[0].time });
    } catch (e) { console.error('[extras] last-reading', e.message); res.status(500).json({ error: 'Failed to read value' }); }
});

// ---- real 24 h water used per tank, computed on the raw stored readings ----
// Feed tank: feed flow (m3/h) x time. Flush tank: sum of the level drops (drops under 0.5 % are sensor noise).
// Capacities come from this client's settings, so a change in Settings applies here too.
const DAY_H = 24;
async function readingsOf(tenantId, parameter, hours) {
    const sql = tenantId === MAIN
        ? `SELECT time, value FROM measurements WHERE parameter = $1 AND time > NOW() - ($2::float * INTERVAL '1 hour') ORDER BY time`
        : `SELECT time, value FROM tenant_measurements WHERE tenant_id = ${Number(tenantId)} AND parameter = $1 AND time > NOW() - ($2::float * INTERVAL '1 hour') ORDER BY time`;
    return (await db.getPool().query(sql, [parameter, hours])).rows.map((r) => ({ t: new Date(r.time).getTime(), v: Number(r.value) })).filter((r) => Number.isFinite(r.v));
}
router.get('/tank-usage', requireAuth, tenantContext, async (req, res) => {
    try {
        const hours = Math.min(Math.max(Number(req.query.hours) || DAY_H, 1), 72);
        let feedCap = 300, flushCap = 200;
        if (req.tenantId === MAIN) { const x = await readExtra(); feedCap = Number(x.feedTankCapacity) || feedCap; flushCap = Number(x.flushTankCapacity) || flushCap; }
        else { const c = tenants.mergeConfig((await tenants.getRow(req.tenantId) || {}).config); feedCap = Number(c.feedTankCapacity) || feedCap; flushCap = Number(c.flushTankCapacity) || flushCap; }

        const [flow, flush] = await Promise.all([readingsOf(req.tenantId, 'RO5-FEEDFlow', hours), readingsOf(req.tenantId, 'RO5-FlushTank', hours)]);

        let feedUsed = 0;
        for (let i = 1; i < flow.length; i++) {
            const dt = flow[i].t - flow[i - 1].t;
            if (dt <= 0 || dt > 15 * 60 * 1000) continue;          // data outage: skipped, never guessed
            feedUsed += ((Math.max(0, flow[i - 1].v) + Math.max(0, flow[i].v)) / 2) * dt / 3600000;
        }

        const pct = (raw) => Math.min(100, Math.max(0, (raw / 126) * 100));
        let flushDrop = 0, refills = 0;
        if (flush.length > 1) {
            let ref = pct(flush[0].v), lo = ref, hi = ref, state = 'down';
            for (let i = 1; i < flush.length; i++) {
                const p = pct(flush[i].v);
                if (p > ref) ref = p; else if (ref - p >= 0.5) { flushDrop += ref - p; ref = p; }
                if (state === 'down') { if (p < lo) lo = p; else if (p - lo >= 20) { refills++; state = 'up'; hi = p; } }
                else if (p > hi) hi = p; else if (hi - p >= 20) { state = 'down'; lo = p; }
            }
        }
        const span = (a) => (a.length > 1 ? (a[a.length - 1].t - a[0].t) / 3600000 : 0);
        res.json({
            hours,
            capacities: { feed: feedCap, flush: flushCap },
            feed: { used: feedUsed, spanHours: span(flow), points: flow.length },
            flush: { used: (flushDrop / 100) * flushCap, dropPct: flushDrop, refills, spanHours: span(flush), points: flush.length },
        });
    } catch (e) { console.error('[extras] tank-usage', e.message); res.status(500).json({ error: 'Failed to compute tank usage' }); }
});

// ---- Antiscalant page: minutes of dosing per 2 h interval (last 24 h) + dose rate ----
const STEP_MS = 2 * 3600 * 1000;
router.get('/dosing-overview', requireAuth, tenantContext, async (req, res) => {
    try {
        const tid = req.tenantId;
        const now = Date.now();
        const start = now - 24 * 3600 * 1000;
        const q = tid === MAIN
            ? `SELECT time, value::text AS v FROM measurements WHERE parameter LIKE $1 AND time > $2 ORDER BY time`
            : `SELECT time, value::text AS v FROM tenant_measurements WHERE tenant_id = ${Number(tid)} AND parameter LIKE $1 AND time > $2 ORDER BY time`;
        const get = async (p, since) => (await db.getPool().query(q, [p, new Date(since)])).rows.map((r) => ({ t: new Date(r.time).getTime(), v: String(r.v) }));
        const [stateRows, mlRows] = await Promise.all([get('%AntiscalantDosingActive', start - 6 * 3600 * 1000), get('%AntiscalantDaily', start)]);

        const isOn = (v) => /^(on|1|1\.0+|true)$/i.test(v);
        const minutes = new Array(12).fill(0);
        const ml = new Array(12).fill(0);
        const bucketOf = (t) => Math.min(11, Math.max(0, Math.floor((t - start) / STEP_MS)));

        // pump ON time, split across the interval boundaries
        let on = false, since = start;
        const addOn = (a, b) => {
            a = Math.max(a, start); b = Math.min(b, now);
            while (a < b) {
                const i = bucketOf(a);
                const end = Math.min(b, start + (i + 1) * STEP_MS);
                minutes[i] += (end - a) / 60000;
                a = end;
            }
        };
        for (const r of stateRows) {
            if (r.t <= start) { on = isOn(r.v); continue; }
            if (on) addOn(since, r.t);
            on = isOn(r.v); since = r.t;
        }
        if (on) addOn(Math.max(since, start), now);
        const haveState = stateRows.length > 0;

        // ml dosed: positive steps of the PLC's daily counter (its reset to 0 is ignored)
        let totalMl = 0;
        for (let i = 1; i < mlRows.length; i++) {
            const d = Number(mlRows[i].v) - Number(mlRows[i - 1].v);
            if (Number.isFinite(d) && d > 0 && d < 5000) { ml[bucketOf(mlRows[i].t)] += d; totalMl += d; }
        }
        const totalMin = minutes.reduce((a, b) => a + b, 0);
        let rate = totalMin > 5 && totalMl > 0 ? totalMl / totalMin : null;
        if (rate === null && tid === MAIN) {
            // no pump ON/OFF history stored: use the server's dosing totals (ml per minute the pump has run)
            try {
                const t = await db.getDosingTotalsForDay(db.dosingDayKey());
                if (t && Number(t.secondsOn) > 60 && Number(t.mlDosed) > 0) rate = Number(t.mlDosed) / (Number(t.secondsOn) / 60);
                if (rate === null) {
                    const m = await db.getDosingCurrentMonthTotal();
                    if (m && Number(m.secondsOn) > 60 && Number(m.mlDosed) > 0) rate = Number(m.mlDosed) / (Number(m.secondsOn) / 60);
                }
            } catch (_) { /* none */ }
        }
        // minutes when we can: from the pump ON/OFF history, else ml / dose rate; last resort: show the ml dosed
        let out = minutes, source = 'state', unit = 'min';
        if (!haveState) {
            if (rate) { out = ml.map((m) => m / rate); source = 'counter'; }
            else { out = ml; source = 'ml'; unit = 'ml'; }
        }

        const intervals = out.map((m, i) => {
            const w = new Date(start + i * STEP_MS + 3 * 3600 * 1000);   // plant time (UTC+3)
            const maxMin = unit === 'min' ? (i === 11 ? Math.max(0.0001, (now - (start + i * STEP_MS)) / 60000) : 120) : Infinity;
            return { label: String(w.getUTCHours()).padStart(2, '0') + ':' + String(w.getUTCMinutes()).padStart(2, '0'), minutes: Math.round(Math.min(m, maxMin) * 10) / 10 };
        });
        res.json({ intervals, unit, rateMlPerMin: rate === null ? null : Math.round(rate * 100) / 100, source, debug: { stateRows: stateRows.length, mlRows: mlRows.length, totalMl: Math.round(totalMl) } });
    } catch (e) { console.error('[extras] dosing-overview', e.message); res.status(500).json({ error: 'Failed to load dosing overview' }); }
});

module.exports = router;
