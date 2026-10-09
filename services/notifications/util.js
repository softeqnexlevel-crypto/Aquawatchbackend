// services/notifications/util.js
'use strict';

const config = require('./config');
const { SEVERITIES } = config;

const rank = (s) => SEVERITIES.indexOf(s);
const meets = (severity, min) => rank(severity) >= rank(min);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Single decision point: should this channel ('email' | 'slack' | 'calendar')
// handle this alert? Checks the on/off switch, minimum severity, and the
// optional ONLY/EXCLUDE type lists.
function channelAllows(channel, task) {
  const c = config[channel];
  if (!c || !c.enabled) return false;
  if (!meets(task.severity, c.minSeverity)) return false;
  const title = String(task.title || '').trim().toLowerCase();
  if (c.onlyTypes && c.onlyTypes.length && !c.onlyTypes.includes(title)) return false;
  if (c.excludeTypes && c.excludeTypes.includes(title)) return false;
  return true;
}

// Retries a flaky network call with exponential backoff.
async function withRetry(fn, { tries = 3, baseMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw lastErr;
}

// Maintenance task per alert, keyed by the alert's message (lower-case).
// These are sensible RO-plant defaults — replace with your site's procedures.
const ACTIONS = {
  'high ro pressure': 'Check concentrate valve position and membrane fouling; verify HP pump output',
  'low ro pressure': 'Check feed and high-pressure pumps, prefilter and membranes for low RO pressure',
  'high differential pressure - stage 1': 'Inspect stage 1 membranes for fouling/scaling; schedule a CIP cleaning',
  'high differential pressure - stage 2': 'Inspect stage 2 membranes for fouling/scaling; schedule a CIP cleaning',
  'high filter delta p': 'Backwash the media filter; inspect media condition if ΔP does not recover',
  'high media filter delta p': 'Backwash the media filter; inspect media condition if ΔP does not recover',
  'high media filter differential pressure': 'Inspect media filter after backwash and verify ΔP recovery',
  'high prefilter delta p': 'Backwash or replace the prefilter cartridge',
  'power problem': 'Check incoming power supply, phases and control-panel breakers',
  'low system recovery': 'Check concentrate valve setting and membrane fouling; review recovery trend',
  'low feed tank level': 'Check raw-water supply and feed tank inlet valve; refill before pumps trip on dry-run',
  'low feed flow': 'Inspect feed pump, suction line and prefilter for restriction',
  'low concentrate flow': 'Inspect concentrate valve and line for blockage',
  'low permeate production': 'Check membrane condition, feed pressure and temperature',
  'high product water ec': 'Check membrane integrity and O-rings; sample product water',
  'mass balance error': 'Verify feed, permeate and concentrate flow-meter calibration',
  'plc data lost': 'Check ABox/PLC power and network, the MQTT broker and the backend connection',
  'antiscalant dosing stopped': 'Check dosing pump, antiscalant tank level and dosing line',
  'system in backwash mode': 'No action needed — automatic backwash cycle in progress; filtering resumes when it completes',
  'feed tank low signal': 'Check raw-water supply and feed tank inlet valve; refill before pumps trip on dry-run',
};

const actionFor = (title) => ACTIONS[String(title || '').trim().toLowerCase()] || `Investigate and resolve: ${title}`;

module.exports = { rank, meets, slug, esc, withRetry, actionFor, channelAllows };