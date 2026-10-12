// services/notifications/channels.js
// One function per delivery channel. Each throws on failure.

const crypto = require('crypto');
const config = require('./config');
const { rank, esc, withRetry, actionFor, slug } = require('./util');

const fmtTime = (d) => d.toLocaleString('en-GB', { timeZone: config.calendar.timeZone });

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
      await withRetry(() => getMailer().sendMail({ from, to: from, bcc: tiers.staff, subject, text, html }));
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
        await withRetry(() => getMailer().sendMail({ from, to: from, bcc: tiers.clients, subject, text, html }));
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
    ? `RO Plant Reminder ${top.title}`
    : sorted.length === 1
      ? `RO Plant Alert ${top.title}`
      : `RO Plant Alert ${sorted.length} new alerts`;

  const when = (t) => (t.reminder ? 'Still active since' : 'Raised');

  const text = sorted
    .map(
      (t) =>
`• [${t.severity}] ${t.title}${t.reminder ? ' (REMINDER - still active)' : ''}
  ${t.message || t.equipment || ''}${t.value !== undefined ? ` (value: ${t.value})` : ''}
  ${when(t)}: ${fmtTime(t.startedAt)}
  Maintenance task: ${t.action}
  Ref: ${t.cycleId}`
    )
    .join('\n\n');

  const html = `<div style="font-family:sans-serif;font-size:14px">${sorted
    .map(
      (t) =>
`<div style="margin-bottom:14px">
  <b>[${esc(t.severity)}] ${esc(t.title)}${t.reminder ? ' <span style="color:#b45309">(REMINDER - still active)</span>' : ''}</b><br>
  ${esc(t.message || t.equipment || '')}${t.value !== undefined ? ` <i>(value: ${esc(t.value)})</i>` : ''}<br>
  <small>${esc(when(t))} ${esc(fmtTime(t.startedAt))} · Ref ${esc(t.cycleId)}</small><br>
  <b>Maintenance task:</b> ${esc(t.action)}
</div>`
    )
    .join('')}</div>`;

  return { subject, text, html };
}

async function sendInBatches(list, content) {
  const { from } = config.email;
  const batches = [];
  for (let i = 0; i < list.length; i += EMAIL_BATCH_SIZE) {
    batches.push(list.slice(i, i + EMAIL_BATCH_SIZE));
  }

  let failed = 0;
  for (const bcc of batches) {
    try {
      // "to" is the sender; the real recipients are all in BCC.
      await withRetry(() => getMailer().sendMail({ from, to: from, bcc, ...content }));
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
  const subject = `RO Plant Cleared ${title}`;
  const text =
`[${severity || 'Info'}] ${title} has cleared.
${equipment ? `Equipment: ${equipment}\n` : ''}Raised: ${fmtTime(new Date(startedAt))}
Cleared: ${fmtTime(new Date(clearedAt))}${minutes ? ` (after ${minutes} min)` : ''}`;
  const html = `<div style="font-family:sans-serif;font-size:14px">
  <b>[${esc(severity || 'Info')}] ${esc(title)} has cleared.</b><br>
  ${equipment ? `${esc(equipment)}<br>` : ''}<small>Raised ${esc(fmtTime(new Date(startedAt)))} · Cleared ${esc(fmtTime(new Date(clearedAt)))}${minutes ? ` (after ${minutes} min)` : ''}</small>
</div>`;

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
  const message =
    `The RO plant is currently in standby mode and the water tank is Low. ` +
    `Please check the tank level and water supply.` +
    (tankLevel !== undefined ? ` Current tank level: ${Number(tankLevel).toFixed(1)}%.` : '') +
    (currentMode ? ` Current mode: ${currentMode}.` : '');

   const tiers = await resolveTiers();
  const { from } = config.email;

  const action = actionFor('Low Feed Tank Level');
  const ref =
    `${slug('RO5-FeedTankLevel')}-standby-` +
    startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  if ((tiers.staff.length || tiers.clients.length) && config.email.enabled !== false) {
    const subject = 'RO Plant Alert- Feed Tank Low';

    const text =
`${title}

${message}

Raised: ${timeStr}
Ref: ${ref}
Maintenance task: ${action}`;

    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1f2937">
  <div style="font-weight:600;font-size:15px;color:#111827">${esc(title)}</div>
  <div style="color:#4b5563;margin-top:6px">${esc(message)}</div>
  <div style="font-size:12px;color:#6b7280;margin-top:8px">Raised ${esc(timeStr)} · Ref ${esc(ref)}</div>
  <div style="margin-top:8px"><b>Maintenance task:</b> ${esc(action)}</div>
</div>`;

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
  const message =
    `The RO plant has switched to backwash Mode. ` +
    `Media filter Differential pressure is high, system is backwashing` +
    (mediaPressure !== undefined ? ` (${Number(mediaPressure).toFixed(2)} bar)` : '') +
    (previousMode ? `. Previous mode: ${previousMode}.` : '.');

   const tiers = await resolveTiers();
  const { from } = config.email;

  const action = actionFor('High Media Filter Differential Pressure');
  const ref =
    `${slug('RO5-Backwash')}-` +
    startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  if ((tiers.staff.length || tiers.clients.length) && config.email.enabled !== false) {
    const subject = `RO Plant: ${title}`;

    const text =
`${title}

${message}

Raised: ${timeStr}
Ref: ${ref}
Maintenance task: ${action}`;

    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1f2937">
  <div style="font-weight:600;font-size:15px;color:#111827">${esc(title)}</div>
  <div style="color:#4b5563;margin-top:6px">${esc(message)}</div>
  <div style="font-size:12px;color:#6b7280;margin-top:8px">Raised ${esc(timeStr)} · Ref ${esc(ref)}</div>
  <div style="margin-top:8px"><b>Maintenance task:</b> ${esc(action)}</div>
</div>`;

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