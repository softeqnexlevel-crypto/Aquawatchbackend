// services/notifications/recipients.js
// Email recipients = the website's users, read through the app's own drizzle
// schema (database/postgres.js), so table/column names are never guessed.
//
//   ALERT_RECIPIENT_MODE=all        every active, non-deleted user (default)
//   ALERT_RECIPIENT_MODE=signed_in  only users holding a valid login session
//                                   (non-revoked, unexpired refresh token)
//   ALERT_RECIPIENT_ROLES=admin,operator   optional role filter
//
// A user can opt out by setting preferences.emailAlerts = false.
'use strict';

const config = require('./config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let cache = { at: 0, list: null };

async function queryUsers() {
  const { sql } = require('drizzle-orm');
  const pg = require('../../database/postgres');
  const db = pg.getDb();
  const { users, refreshTokens } = pg.schema;

  const conditions = [
    sql`${users.deletedAt} IS NULL`,
    sql`${users.isActive} = true`,
  ];

  if (config.recipients.mode === 'signed_in') {
    conditions.push(sql`${users.id} IN (
      SELECT ${refreshTokens.userId} FROM ${refreshTokens}
      WHERE ${refreshTokens.revoked} = false AND ${refreshTokens.expiresAt} > NOW()
    )`);
  }

  return db.select().from(users).where(sql.join(conditions, sql` AND `));
}

async function getEmailRecipients(logger = console) {
  if (cache.list && Date.now() - cache.at < config.recipients.cacheMs) return cache.list;

  let list;
  try {
    const rows = await queryUsers();
    const roles = config.recipients.roles;

    list = rows
      .filter((u) => !roles.length || roles.includes(String(u.role || '').toLowerCase()))
      .filter((u) => !(u.preferences && u.preferences.emailAlerts === false))
      .map((u) => String(u.email || '').trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e));
    list = [...new Set(list)];

    if (!list.length) {
      logger.warn?.(`[alert-notifier] no ${config.recipients.mode === 'signed_in' ? 'signed-in ' : ''}users to email — using ALERT_EMAIL_TO fallback`);
      list = config.email.to;
    }
    cache = { at: Date.now(), list };
  } catch (err) {
    // DB hiccup: reuse the last good list, else the env fallback.
    logger.error?.(`[alert-notifier] recipients lookup failed: ${err.message}`);
    list = cache.list || config.email.to;
  }
  return list;
}

module.exports = { getEmailRecipients };