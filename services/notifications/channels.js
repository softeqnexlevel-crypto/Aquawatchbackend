// services/notifications/channels.js
// One function per delivery channel. Each throws on failure.

const crypto = require('crypto');
const config = require('./config');
const { rank, esc, withRetry } = require('./util');

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

  try {
    const { getEmailRecipients } = require('./recipients');
    const dbUsers = await getEmailRecipients(console);
    if (dbUsers && dbUsers.length) return dbUsers;
  } catch (err) {
    console.error(`[channels] recipients lookup failed: ${err.message}`);
  }

  return config.email.to || [];
}

// One email per alert batch: single alert → own subject, burst → digest.
// `recipients` overrides the DB lookup when provided.
async function sendEmail(tasks, recipients = null) {
  const { from } = config.email;

  const list = await resolveRecipients(recipients);

  if (!list.length) {
    throw new Error(
      'No email recipients: no DB users and ALERT_EMAIL_TO is empty.'
    );
  }

  const sorted = [...tasks].sort((a, b) => rank(b.severity) - rank(a.severity));
  const top = sorted[0];

  const subject =
    sorted.length === 1
      ? `[RO Plant Alert] ${top.title}`
      : `[RO Plant Alert] ${sorted.length} new alerts`;

  const text = sorted
    .map(
      (t) =>
`• [${t.severity}] ${t.title}
  ${t.message || t.equipment || ''}${t.value !== undefined ? ` (value: ${t.value})` : ''}
  Raised: ${fmtTime(t.startedAt)}
  Maintenance task: ${t.action}
  Ref: ${t.cycleId}`
    )
    .join('\n\n');

  const html = `<div style="font-family:sans-serif;font-size:14px">${sorted
    .map(
      (t) =>
`<div style="margin-bottom:14px">
  <b>[${esc(t.severity)}] ${esc(t.title)}</b><br>
  ${esc(t.message || t.equipment || '')}${t.value !== undefined ? ` <i>(value: ${esc(t.value)})</i>` : ''}<br>
  <small>Raised ${esc(fmtTime(t.startedAt))} · Ref ${esc(t.cycleId)}</small><br>
  <b>Maintenance task:</b> ${esc(t.action)}
</div>`
    )
    .join('')}</div>`;

  // Split into batches to respect SMTP provider limits.
  const batches = [];
  for (let i = 0; i < list.length; i += EMAIL_BATCH_SIZE) {
    batches.push(list.slice(i, i + EMAIL_BATCH_SIZE));
  }

  let failed = 0;
  for (const bcc of batches) {
    try {
      // "to" is the sender; the real recipients are all in BCC.
      await withRetry(() => getMailer().sendMail({ from, to: from, bcc, subject, text, html }));
    } catch (err) {
      failed += 1;
      console.error(`[channels] email batch of ${bcc.length} failed: ${err.message}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${batches.length} email batch(es) failed`);
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

  const title = 'Water Tank Low — System on Standby';
  const message =
    `The RO plant is currently in standby mode and the water tank is Low. ` +
    `Please check the tank level and water supply.` +
    (tankLevel !== undefined ? ` Current tank level: ${Number(tankLevel).toFixed(1)}%.` : '') +
    (currentMode ? ` Current mode: ${currentMode}.` : '');

  const recipients = await resolveRecipients(null);
  const { from } = config.email;

  if (recipients.length && config.email.enabled !== false) {
    const subject = '[RO Plant][ALERT] Water Tank Empty';
    const text = `${title}\n\n${message}\n\n${timeStr}`;
    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1f2937">
  <div style="font-weight:600;font-size:15px;color:#111827">${esc(title)}</div>
  <div style="color:#4b5563;margin-top:6px">${esc(message)}</div>
  <div style="font-size:12px;color:#6b7280;margin-top:8px">${esc(timeStr)}</div>
</div>`;
    await withRetry(() => getMailer().sendMail({ from, to: from, bcc: recipients, subject, text, html }));
    console.log(`[channels] tank-empty email sent to ${recipients.length} recipient(s)`);
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
    `Media filter Differential pressure is high, system is backwasing` +
    (mediaPressure !== undefined ? ` (${Number(mediaPressure).toFixed(2)} bar)` : '') +
    (previousMode ? `. Previous mode: ${previousMode}.` : '.');

  const recipients = await resolveRecipients(null);
  const { from } = config.email;

  if (recipients.length && config.email.enabled !== false) {
    const subject = `RO Plant: ${title}`;
    const text = `${title}\n\n${message}\n\n${timeStr}`;
    const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#1f2937">
  <div style="font-weight:600;font-size:15px;color:#111827">${esc(title)}</div>
  <div style="color:#4b5563">${esc(message)}</div>
  <div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(timeStr)}</div>
</div>`;
    await withRetry(() => getMailer().sendMail({ from, to: from, bcc: recipients, subject, text, html }));
    console.log(`[channels] backwash email sent to ${recipients.length} recipient(s)`);
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
  postSlackAlert,
  postSlackText,
  createCalendarEvent,
  sendTankEmptyNotification,
  sendBackwashNotification,
};