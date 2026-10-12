'use strict';
const { pool, dosingDayKey } = require('../database/postgres');

// Save (or update) the totals for a given day. Safe to call many times.
async function saveSnapshot(day, runSeconds, dosed) {
  await pool.query(
    `INSERT INTO daily_summary (day, system_run_seconds, antiscalant_dosed)
     VALUES ($1, $2, $3)
     ON CONFLICT (day) DO UPDATE
       SET system_run_seconds = GREATEST(daily_summary.system_run_seconds, EXCLUDED.system_run_seconds),
           antiscalant_dosed  = GREATEST(daily_summary.antiscalant_dosed,  EXCLUDED.antiscalant_dosed),
           updated_at = now()`,
    [day, Math.round(runSeconds || 0), dosed || 0]
  );
}

const shape = (day, r) => ({
  day,
  systemRunHours: r ? +(r.system_run_seconds / 3600).toFixed(2) : 0,
  antiscalantDosed: r ? Number(r.antiscalant_dosed) : 0,
});

function dayOffset(key, delta) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function getRange(from, to) {
  const { rows } = await pool.query(
    `SELECT * FROM daily_summary WHERE day BETWEEN $1 AND $2 ORDER BY day`, [from, to]);
  return rows.map(r => shape(r.day.toISOString?.().slice(0, 10) ?? r.day, r));
}

async function getHistory(days) {
  const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const today = dosingDayKey();
  return getRange(dayOffset(today, -n), today);
}

async function getSummary() {
  const today = dosingDayKey();
  const yKey = dayOffset(today, -1);
  const { rows } = await pool.query(
    `SELECT * FROM daily_summary WHERE day = ANY($1::date[])`, [[today, yKey]]);
  const find = k => rows.find(r => (r.day.toISOString?.().slice(0, 10) ?? r.day) === k);
  return {
    today: shape(today, find(today)),
    yesterday: shape(yKey, find(yKey)),   // "24hrs ago"
  };
}

module.exports = { saveSnapshot, getSummary, getRange, getHistory };