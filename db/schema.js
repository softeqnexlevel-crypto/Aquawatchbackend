// db/schema.js
'use strict';

const {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  doublePrecision,
  jsonb,
  index,
} = require('drizzle-orm/pg-core');

/* ============================================================
   USERS
   ============================================================ */
const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  phone: varchar('phone', { length: 30 }),
  role: varchar('role', { length: 50 }).default('operator'),
  organizationId: uuid('organization_id'),
  permissions: jsonb('permissions').default([]),
  preferences: jsonb('preferences').default({}),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/* ============================================================
   REFRESH TOKENS
   ============================================================ */
const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  deviceId: varchar('device_id', { length: 255 }),
  deviceName: varchar('device_name', { length: 255 }),
  deviceType: varchar('device_type', { length: 50 }),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
  location: varchar('location', { length: 255 }),
  revoked: boolean('revoked').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ============================================================
   MEASUREMENTS
   NOTE: uses "parameter" (matches the currently-active saveMeasurement()
   which does data.parameter, not data.tagId). If you're running the
   fuller tagId-based postgres.js instead, swap `parameter` below for a
   `tagId: uuid('tag_id')` column and update the indexes accordingly.
   ============================================================ */
const measurements = pgTable('measurements', {
  id: uuid('id').primaryKey(),
  time: timestamp('time', { withTimezone: true }).notNull().defaultNow(),
  parameter: varchar('parameter', { length: 255 }).notNull(),
  value: doublePrecision('value'),
  unit: varchar('unit', { length: 50 }).default(''),
  topic: text('topic').default(''),
  simulated: boolean('simulated').default(false),
  quality: integer('quality').default(100),
  metadata: jsonb('metadata').default({}),
}, (table) => ({
  parameterTimeIdx: index('measurements_parameter_time_idx').on(table.parameter, table.time),
  timeIdx: index('measurements_time_idx').on(table.time),
}));

/* ============================================================
   ALERTS
   ============================================================ */
const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey(),
  ruleId: uuid('rule_id'),
  tagId: uuid('tag_id'),
  organizationId: uuid('organization_id'),
  severity: varchar('severity', { length: 20 }),
  message: text('message'),
  value: doublePrecision('value'),
  threshold: doublePrecision('threshold'),
  resolved: boolean('resolved').default(false),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedNote: text('resolved_note'),
  acknowledged: boolean('acknowledged').default(false),
  acknowledgedBy: uuid('acknowledged_by'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedNote: text('acknowledged_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ============================================================
   DEVICES
   ============================================================ */
const devices = pgTable('devices', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id'),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  deviceType: varchar('device_type', { length: 100 }),
  protocol: varchar('protocol', { length: 50 }).default('mqtt'),
  topicPattern: varchar('topic_pattern', { length: 255 }),
  ipAddress: varchar('ip_address', { length: 64 }),
  port: integer('port'),
  credentials: jsonb('credentials'),
  config: jsonb('config'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ============================================================
   TAGS
   ============================================================ */
const tags = pgTable('tags', {
  id: uuid('id').primaryKey(),
  deviceId: uuid('device_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  description: text('description'),
  unit: varchar('unit', { length: 50 }),
  dataType: varchar('data_type', { length: 20 }).default('float'),
  address: varchar('address', { length: 255 }),
  scaleFactor: doublePrecision('scale_factor').default(1.0),
  offset: doublePrecision('offset').default(0.0),
  minValue: doublePrecision('min_value'),
  maxValue: doublePrecision('max_value'),
  isCritical: boolean('is_critical').default(false),
  group: varchar('group', { length: 100 }),
  order: integer('order').default(0),
  isActive: boolean('is_active').default(true),
  metadata: jsonb('metadata'),
});

/* ============================================================
   AUDIT LOGS
   ============================================================ */
const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id'),
  organizationId: uuid('organization_id'),
  action: varchar('action', { length: 100 }),
  resource: varchar('resource', { length: 100 }),
  resourceId: uuid('resource_id'),
  details: jsonb('details').default({}),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ============================================================
   ALERT RULES
   ============================================================ */
const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id'),
  tagId: uuid('tag_id'),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  conditionType: varchar('condition_type', { length: 50 }),
  conditionConfig: jsonb('condition_config'),
  severity: varchar('severity', { length: 20 }).default('warning'),
  priority: integer('priority').default(1),
  cooldownMinutes: integer('cooldown_minutes').default(5),
  escalationMinutes: integer('escalation_minutes').default(15),
  actions: jsonb('actions').default([]),
  createdBy: uuid('created_by'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

module.exports = {
  users,
  refreshTokens,
  measurements,
  alerts,
  devices,
  tags,
  auditLogs,
  alertRules,
};