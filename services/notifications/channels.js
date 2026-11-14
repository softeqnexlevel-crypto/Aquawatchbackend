// services/notifications/channels.js
// One function per delivery channel. Each throws on failure.

const crypto = require('crypto');
const config = require('./config');
const { rank, esc, withRetry, actionFor, slug } = require('./util');

const fmtTime = (d) => d.toLocaleString('en-GB', { timeZone: config.calendar.timeZone });

// ───────────────────────── Email layout ─────────────────────────
// One professional layout for every alert email.
// item = { title, message, rows: [[label, value], ...], action, reminder }
function renderEmail(items) {
  const rowsOf = (it) => (it.rows || []).filter(([, v]) => v !== undefined && v !== null && v !== '');

  const text =
    items
      .map((it) =>
        [
          `${it.title}${it.reminder ? ' (Reminder: this alert is still active)' : ''}`,
          '',
          it.message || '',
          '',
          ...(it.summary ? [it.summary] : []),
          ...(it.summary ? rowsOf(it).map(([k, v]) => `${k}: ${v}`) : rowsOf(it).map(([k, v]) => `${k}: ${v}`)),
          ...(it.action ? ['', `Recommended action: ${it.action}`] : []),
        ].join('\n')
      )
      .join('\n\n----------------------------------------\n\n');

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;max-width:600px">${items
    .map(
      (it) => `
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin-bottom:14px">
  <div style="font-size:16px;font-weight:600;color:#111827">${esc(it.title)}</div>
  ${it.reminder ? '<div style="font-size:12px;color:#b45309;margin-top:2px">Reminder: this alert is still active</div>' : ''}
  ${it.message ? `<div style="margin-top:10px;line-height:1.5;color:#374151">${esc(it.message)}</div>` : ''}
  ${it.summary ? `<div style="margin-top:12px;font-size:14px;color:#111827">${esc(it.summary)}</div>` : ''}
  <table style="margin-top:${it.summary ? 4 : 12}px;font-size:13px;color:#374151;border-collapse:collapse">
    ${rowsOf(it)
      .map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`)
      .join('')}
  </table>
  ${it.action ? `<div style="margin-top:12px;font-size:13px"><b>Recommended action</b><br>${esc(it.action)}</div>` : ''}
</div>`
    )
    .join('')}
</div>`;

  return { text, html };
}

// ───────────────────────── Email (nodemailer) ─────────────────────────
let mailer;
function getMailer() {
  if (!mailer) {
    const nodemailer = require('nodemailer');
    const { host, port, secure, user, pass } = config.email;
    mailer = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined });
  }
  return mailer;
}

const EMAIL_BATCH_SIZE = Math.max(1, Number(process.env.EMAIL_BATCH_SIZE) || 50);

// Resolves the recipient list.
// Priority: explicit recipients argument → DB users (via recipients.js) →
// ALERT_EMAIL_TO fallback.
async function resolveRecipients(explicit) {
  if (Array.isArray(explicit) && explicit.length) return explicit;

  // Generic alert emails go to staff only (operators/admins).
  try {
    const { getRecipientsByTier } = require('./recipients');
    const tiers = await getRecipientsByTier(console);
    if (tiers && tiers.staff && tiers.staff.length) return tiers.staff;
  } catch (err) {
    console.error(`[channels] recipients lookup failed: ${err.message}`);
  }

  return config.email.to || [];
}

// ───────────────── Tiered delivery: staff vs clients ─────────────────
// Staff (operators/admins): every email.
// Clients: at most CLIENT_MAX_EMAILS_PER_DAY emails per calendar day
// (plant time zone). The counter lives in the database, so restarts and
// deploys cannot reset it.
const CLIENT_MAX_PER_DAY = Math.max(0, Number(process.env.CLIENT_MAX_EMAILS_PER_DAY ?? 2));
let counterTableReady = false;

const clientDayKey = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: config.calendar.timeZone });

function getDbPool() {
  return require('../../database/postgres').getPool();
}

async function ensureCounterTable() {
  if (counterTableReady) return;
  await getDbPool().query(`
    CREATE TABLE IF NOT EXISTS client_email_counter (
      day  TEXT PRIMARY KEY,
      sent INTEGER NOT NULL DEFAULT 0
    )
  `);
  counterTableReady = true;
}

// Atomically takes one of today's client email slots.
// Fails closed: if the database is unreachable, clients get no email.
async function claimClientEmailSlot() {
  if (CLIENT_MAX_PER_DAY <= 0) return { ok: false, used: 0 };
  try {
    await ensureCounterTable();
    const r = await getDbPool().query(
      `INSERT INTO client_email_counter (day, sent) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET sent = client_email_counter.sent + 1
       WHERE client_email_counter.sent < $2
       RETURNING sent`,
      [clientDayKey(), CLIENT_MAX_PER_DAY]
    );
    if (r.rows.length) return { ok: true, used: r.rows[0].sent };
    return { ok: false, used: CLIENT_MAX_PER_DAY };
  } catch (err) {
    console.error(`[channels] client email counter failed: ${err.message}`);
    return { ok: false, used: 0 };
  }
}

async function releaseClientEmailSlot() {
  try {
    await getDbPool().query(
      `UPDATE client_email_counter SET sent = GREATEST(sent - 1, 0) WHERE day = $1`,
      [clientDayKey()]
    );
  } catch (err) {
    console.error(`[channels] could not release client email slot: ${err.message}`);
  }
}

async function resolveTiers() {
  try {
    const { getRecipientsByTier } = require('./recipients');
    const tiers = await getRecipientsByTier(console);
    return { staff: tiers.staff || [], clients: tiers.clients || [] };
  } catch (err) {
    console.error(`[channels] tiered recipients lookup failed: ${err.message}`);
    return { staff: config.email.to || [], clients: [] };
  }
}

// Sends one prepared email to staff (always) and to clients (if under the
// daily limit).
async function sendTiered({ subject, text, html, label }, tiers) {
  const { from } = config.email;
  const errors = [];

  if (tiers.staff.length) {
    try {
      await withRetry(() => getMailer().sendMail({ from, to: config.email.mainTo || from, bcc: tiers.staff, subject, text, html }));
      console.log(`[channels] ${label} email sent to ${tiers.staff.length} staff recipient(s)`);
    } catch (err) {
      errors.push(err);
      console.error(`[channels] ${label} staff email failed: ${err.message}`);
    }
  }

  if (tiers.clients.length) {
    const slot = await claimClientEmailSlot();
    if (slot.ok) {
      try {
        await withRetry(() => getMailer().sendMail({ from, to: config.email.mainTo || from, bcc: tiers.clients, subject, text, html }));
        console.log(`[channels] ${label} email sent to ${tiers.clients.length} client(s) (${slot.used}/${CLIENT_MAX_PER_DAY} today)`);
      } catch (err) {
        await releaseClientEmailSlot();
        errors.push(err);
        console.error(`[channels] ${label} client email failed: ${err.message}`);
      }
    } else {
      console.log(`[channels] ${label} email NOT sent to clients — daily limit reached (${CLIENT_MAX_PER_DAY}/day)`);
    }
  }

  if (errors.length) throw errors[0];
}

// Alert types clients may be emailed about (still subject to the daily cap).
const CLIENT_EMAIL_TYPES = (process.env.CLIENT_EMAIL_TYPES || 'Low Feed Tank Level')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function buildEmailContent(sorted) {
  const top = sorted[0];
  const isReminder = sorted.every((t) => t.reminder);

  const subject = isReminder
    ? `${config.plantName} Plant Reminder: ${top.title}`
    : sorted.length === 1
      ? `${config.plantName} Plant Alert: ${top.title}`
      : `${config.plantName} Plant Alert: ${sorted.length} new alerts`;

  const { text, html } = renderEmail(
    sorted.map((t) => ({
      title: t.title,
      message: t.message || '',
      reminder: !!t.reminder,
      summary:
        `${config.plantName} ` +
        `${String(t.equipment || '').replace(new RegExp(`^${config.plantName}\\s*-\\s*`, 'i'), '') || 'plant'}` +
        `${t.value !== undefined ? ` reading ${t.value}` : ''}, ` +
        `${t.reminder ? 'active since' : 'raised'} ${fmtTime(t.startedAt)}.`,
      rows: [['Reference', t.cycleId]],
      action: t.action,
    }))
  );

  return { subject, text, html };
}

async function sendInBatches(list, content) {
  const { from } = config.email;
  const { subject, text, html } = content;
  const batches = [];
  for (let i = 0; i < list.length; i += EMAIL_BATCH_SIZE) {
    batches.push(list.slice(i, i + EMAIL_BATCH_SIZE));
  }

  let failed = 0;
  for (const bcc of batches) {
    try {
      // "to" is the sender; the real recipients are all in BCC.
      await withRetry(() => getMailer().sendMail({ from, to: config.email.mainTo || from, bcc, subject, text, html }));
    } catch (err) {
      failed += 1;
      console.error(`[channels] email batch of ${bcc.length} failed: ${err.message}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${batches.length} email batch(es) failed`);
}

// Alert emails.
//   Staff (operators/admins): every alert, plus reminders.
//   Clients: only CLIENT_EMAIL_TYPES, never reminders, and at most
//            CLIENT_MAX_EMAILS_PER_DAY emails per day.
// `recipients` (explicit list) overrides the tiers and goes to staff only.
async function sendEmail(tasks, recipients = null) {
  const tiers =
    Array.isArray(recipients) && recipients.length
      ? { staff: recipients, clients: [] }
      : await resolveTiers();

  if (!tiers.staff.length && !tiers.clients.length) {
    throw new Error('No email recipients: no DB users and ALERT_EMAIL_TO is empty.');
  }

  const rank_ = (t) => rank(t.severity);
  const sortTasks = (ts) => [...ts].sort((a, b) => rank_(b) - rank_(a));
  const errors = [];

  // Staff: everything.
  if (tiers.staff.length) {
    try {
      await sendInBatches(tiers.staff, buildEmailContent(sortTasks(tasks)));
    } catch (err) {
      errors.push(err);
    }
  }

  // Clients: limited types, no reminders, daily cap.
  const clientTasks = tasks.filter(
    (t) => !t.reminder && CLIENT_EMAIL_TYPES.includes(String(t.title || '').trim().toLowerCase())
  );

  if (tiers.clients.length && clientTasks.length) {
    const slot = await claimClientEmailSlot();
    if (slot.ok) {
      try {
        await sendInBatches(tiers.clients, buildEmailContent(sortTasks(clientTasks)));
        console.log(`[channels] alert email sent to ${tiers.clients.length} client(s) (${slot.used}/${CLIENT_MAX_PER_DAY} today)`);
      } catch (err) {
        await releaseClientEmailSlot();
        errors.push(err);
      }
    } else {
      console.log(`[channels] alert email NOT sent to clients — daily limit reached (${CLIENT_MAX_PER_DAY}/day)`);
    }
  }

  if (errors.length) throw errors[0];
}

// "Alarm cleared" email: staff only.
async function sendClearedEmail(info) {
  const tiers = await resolveTiers();
  if (!tiers.staff.length) return;

  const { title, severity, equipment, startedAt, clearedAt, minutes } = info;
  const subject = `${config.plantName} Plant Resolved: ${title}`;
  const { text, html } = renderEmail([
    {
      title: `${title} - Resolved`,
      message: 'This alert has cleared and the plant is back to normal.',
      rows: [
        ['Plant', config.plantName],
        ['Equipment', equipment],
        ['Raised', fmtTime(new Date(startedAt))],
        ['Cleared', fmtTime(new Date(clearedAt))],
        ['Duration', minutes ? `${minutes} min` : undefined],
      ],
    },
  ]);

  await sendInBatches(tiers.staff, { subject, text, html });
}

// ───────────────────────── Slack (Web API) ─────────────────────────
async function slackCall(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
}

const SLACK_EMOJI = { Critical: ':rotating_light:', High: ':red_circle:', Medium: ':large_orange_circle:', Low: ':large_yellow_circle:', Info: ':information_source:' };

async function postSlackAlert(t) {
  const data = await slackCall('chat.postMessage', {
    channel: config.slack.channel,
    text: `${SLACK_EMOJI[t.severity] || ':warning:'} [${t.severity}] ${t.title}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${t.severity}: ${t.title}`.slice(0, 150) } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Details*\n${t.message || t.equipment || '—'}` },
          { type: 'mrkdwn', text: `*Value*\n${t.value !== undefined ? t.value : '—'}` },
          { type: 'mrkdwn', text: `*Maintenance task*\n${t.action}` },
          { type: 'mrkdwn', text: `*Reference*\n${t.cycleId}` },
        ],
      },
    ],
  });
  return data.ts;
}

async function postSlackText(text, threadTs) {
  await slackCall('chat.postMessage', { channel: config.slack.channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
}

// ───────────────────────── Google Calendar ─────────────────────────
let calendarClient;
async function getCalendar() {
  if (!calendarClient) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: config.calendar.serviceAccountFile,
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });
    calendarClient = google.calendar({ version: 'v3', auth });
  }
  return calendarClient;
}

function nextSlot(now = new Date()) {
  const { timeZone, eventHour, durationMin, minLeadMin } = config.calendar;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((x) => [x.type, x.value])
  );
  const nowMin = Number(p.hour) * 60 + Number(p.minute);
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 12));
  if (nowMin + minLeadMin > eventHour * 60) day.setUTCDate(day.getUTCDate() + 1);

  const ymd = day.toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  const endMin = eventHour * 60 + durationMin;
  return {
    start: `${ymd}T${pad(eventHour)}:00:00`,
    end: `${ymd}T${pad(Math.floor(endMin / 60) % 24)}:${pad(endMin % 60)}:00`,
    timeZone,
  };
}

async function createCalendarEvent(t) {
  const calendar = await getCalendar();
  const slot = nextSlot();
  const id = 'al' + crypto.createHash('sha1').update(t.cycleId).digest('hex').slice(0, 30);

  try {
    await calendar.events.insert({
      calendarId: config.calendar.calendarId,
      requestBody: {
        id,
        summary: `Maintenance [${t.severity}]: ${t.action}`.slice(0, 200),
        description:
`Auto-created from RO plant alert "${t.title}" (${t.severity}).
Details: ${t.message || t.equipment || '—'}
Value at alert: ${t.value !== undefined ? t.value : '—'}
Raised: ${fmtTime(t.startedAt)}
Reference: ${t.cycleId}`,
        start: { dateTime: slot.start, timeZone: slot.timeZone },
        end: { dateTime: slot.end, timeZone: slot.timeZone },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
      },
    });
  } catch (err) {
    if (err?.code === 409) return;
    throw err;
  }
}

// ───────────────────────── Tank Empty Notification ─────────────────────────
// Fired once when the feed tank reaches the empty threshold while
// the RO plant is in standby mode.
async function sendTankEmptyNotification(info) {
  const { startedAt, tankLevel, currentMode } = info;
  const timeStr = fmtTime(startedAt);

  const title = 'Water Tank Low — System on Standby mode';
  const emailMessage =
    `The ${config.plantName} plant is on standby and the feed tank level is low. ` +
    `Please check the water supply.`;
  const message =
    emailMessage +
    (tankLevel !== undefined ? ` Current tank level: ${Number(tankLevel).toFixed(1)}%.` : '') +
    (currentMode ? ` Current mode: ${currentMode}.` : '');

   const tiers = await resolveTiers();
  const { from } = config.email;

  const action = actionFor('Low Feed Tank Level');
  const ref =
    `${slug('RO5-FeedTankLevel')}-standby-` +
    startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  if ((tiers.staff.length || tiers.clients.length) && config.email.enabled !== false) {
    const subject = `${config.plantName} Plant Alert: Feed Tank Low`;

    const { text, html } = renderEmail([
      {
        title: 'Feed Tank Low',
        message: emailMessage,
        rows: [
          ['Plant', config.plantName],
          ['Equipment', 'Feed Tank'],
          ['Tank level', tankLevel !== undefined ? `${Number(tankLevel).toFixed(1)}%` : undefined],
          ['Raised', timeStr],
          ['Reference', ref],
        ],
        action,
      },
    ]);

    await sendTiered({ subject, text, html, label: 'tank-empty' }, tiers);
  } else {
    console.warn('[channels] tank-empty email skipped — no recipients');
  }

  if (config.slack.botToken && config.slack.channel) {
    await slackCall('chat.postMessage', {
      channel: config.slack.channel,
      text: `:warning: ${title} — ${message} (${timeStr})`,
    });
  }
}

// ───────────────────────── Backwash Notification ─────────────────────────
async function sendBackwashNotification(info) {
  const { startedAt, mediaPressure, previousMode } = info;
  const timeStr = fmtTime(startedAt);

  const title = 'System in Backwash Mode';
  const emailMessage =
    `The ${config.plantName} plant has switched to backwash mode. ` +
    `The media filter pressure is high, so the system is cleaning the filter.`;
  const message =
    `The ${config.plantName} plant has switched to backwash mode. ` +
    `The media filter pressure is high, so the system is cleaning the filter` +
    (mediaPressure !== undefined ? ` (${Number(mediaPressure).toFixed(2)} bar)` : '') +
    (previousMode ? `. Previous mode: ${previousMode}.` : '.');

   const tiers = await resolveTiers();
  const { from } = config.email;

  const action = actionFor('High Media Filter Differential Pressure');
  const ref =
    `${slug('RO5-Backwash')}-` +
    startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  if ((tiers.staff.length || tiers.clients.length) && config.email.enabled !== false) {
    const subject = `${config.plantName} Plant: ${title}`;

    const { text, html } = renderEmail([
      {
        title,
        message: emailMessage,
        rows: [
          ['Plant', config.plantName],
          ['Equipment', 'Media Filter'],
          ['Filter pressure', mediaPressure !== undefined ? `${Number(mediaPressure).toFixed(2)} bar` : undefined],
          ['Previous mode', previousMode],
          ['Raised', timeStr],
          ['Reference', ref],
        ],
        action,
      },
    ]);

    await sendTiered({ subject, text, html, label: 'backwash' }, tiers);
  } else {
    console.warn('[channels] backwash email skipped — no recipients');
  }

  if (config.slack.botToken && config.slack.channel) {
    await slackCall('chat.postMessage', {
      channel: config.slack.channel,
      text: `:recycle: ${title} — ${message} (${timeStr})`,
    });
  }
}

module.exports = {
  sendEmail,
  sendClearedEmail,
  postSlackAlert,
  postSlackText,
  createCalendarEvent,
  sendTankEmptyNotification,
  sendBackwashNotification,
};