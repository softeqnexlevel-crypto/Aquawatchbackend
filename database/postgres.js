// database/postgres.js
const { drizzle } = require('drizzle-orm/node-postgres');
const { Pool } = require('pg');
const { sql } = require('drizzle-orm');
const { v4: uuidv4 } = require('uuid');
const schema = require('../db/schema');

let db = null;
let pool = null;
let initialized = false;

// ============================================================
// INITIALIZATION
// ============================================================

async function initDb() {
    if (initialized) {
        console.log('[DB] Already initialized');
        return;
    }

    try {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL environment variable is not set');
        }

        pool = new Pool({
            connectionString,
            max: parseInt(process.env.DB_POOL_MAX) || 10,
            min: parseInt(process.env.DB_POOL_MIN) || 2,
            idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
            connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000,
            statement_timeout: 30000,
            query_timeout: 30000,
        });

        await pool.query('SELECT 1');
        console.log('[DB] Connected to PostgreSQL');

        pool.on('error', (err) => {
            console.error('[DB] Pool error:', err.message);
        });

        pool.on('connect', () => {
            console.log('[DB] New connection established');
        });

        db = drizzle(pool, {
            schema,
            logger: process.env.NODE_ENV !== 'production'
        });

        initialized = true;

        if (process.env.NODE_ENV === 'production') {
            setInterval(async () => {
                try {
                    await pool.query('SELECT 1');
                } catch (err) {
                    console.error('[DB] Keep-alive failed:', err.message);
                }
            }, 60000);
        }

    } catch (error) {
        console.error('[DB] Failed to initialize:', error.message);
        initialized = false;
        throw error;
    }
}

function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return db;
}

function getPool() {
    if (!pool) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return pool;
}

function generateUUID() {
    return uuidv4();
}

// ============================================================
// HEALTH CHECK
// ============================================================

async function healthCheck() {
    try {
        const result = await pool.query('SELECT NOW() as time, version() as version');
        return {
            status: 'healthy',
            time: result.rows[0].time,
            version: result.rows[0].version,
            pool: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
            }
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            error: error.message,
        };
    }
}

// ============================================================
// REPOSITORY: USERS
// ============================================================

async function findUserByEmail(email) {
    const db = getDb();
    const result = await db.select()
        .from(schema.users)
        .where(sql`${schema.users.email} = ${email.toLowerCase()}`)
        .limit(1);
    return result[0] || null;
}

async function findUserById(id) {
    const db = getDb();
    const result = await db.select()
        .from(schema.users)
        .where(sql`${schema.users.id} = ${id}`)
        .limit(1);
    return result[0] || null;
}

async function createUser(data) {
    const db = getDb();
    const result = await db.insert(schema.users).values({
        id: generateUUID(),
        email: data.email.toLowerCase(),
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        role: data.role || 'operator',
        organizationId: data.organizationId,
        permissions: data.permissions || [],
        preferences: data.preferences || {},
    }).returning();
    return result[0];
}

async function updateUser(id, data) {
    const db = getDb();
    const result = await db.update(schema.users)
        .set({
            ...data,
            updatedAt: new Date(),
            ...(data.passwordHash ? { passwordHash: data.passwordHash } : {})
        })
        .where(sql`${schema.users.id} = ${id}`)
        .returning();
    return result[0];
}

async function deleteUser(id, hardDelete = false) {
    const db = getDb();
    if (hardDelete) {
        await db.delete(schema.users).where(sql`${schema.users.id} = ${id}`);
        return { success: true };
    }
    const result = await db.update(schema.users)
        .set({ deletedAt: new Date(), isActive: false })
        .where(sql`${schema.users.id} = ${id}`)
        .returning();
    return result[0];
}

async function getAllUsers(organizationId = null) {
    const db = getDb();
    let query = db.select()
        .from(schema.users)
        .where(sql`${schema.users.deletedAt} IS NULL`)
        .orderBy(schema.users.createdAt, 'desc');

    if (organizationId) {
        query = query.where(sql`${schema.users.organizationId} = ${organizationId}`);
    }

    return query;
}

// ============================================================
// REPOSITORY: REFRESH TOKENS
// ============================================================

async function saveRefreshToken(data) {
    const db = getDb();
    const result = await db.insert(schema.refreshTokens).values({
        id: generateUUID(),
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        deviceId: data.deviceId,
        deviceName: data.deviceName,
        deviceType: data.deviceType,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
        location: data.location,
    }).returning();
    return result[0];
}

async function findRefreshTokenByHash(tokenHash) {
    const db = getDb();
    const result = await db.select()
        .from(schema.refreshTokens)
        .where(sql`${schema.refreshTokens.tokenHash} = ${tokenHash} AND ${schema.refreshTokens.revoked} = false AND ${schema.refreshTokens.expiresAt} > NOW()`)
        .limit(1);
    return result[0] || null;
}

async function revokeRefreshToken(tokenHash) {
    const db = getDb();
    await db.update(schema.refreshTokens)
        .set({ revoked: true })
        .where(sql`${schema.refreshTokens.tokenHash} = ${tokenHash}`);
}

async function revokeAllUserRefreshTokens(userId) {
    const db = getDb();
    await db.update(schema.refreshTokens)
        .set({ revoked: true })
        .where(sql`${schema.refreshTokens.userId} = ${userId}`);
}

// ============================================================
// REPOSITORY: MEASUREMENTS
// ============================================================

async function saveMeasurement(data) {
    const db = getDb();
    const result = await db.insert(schema.measurements).values({
        id: generateUUID(),
        time: data.timestamp ? new Date(data.timestamp) : new Date(),
        parameter: data.parameter,
        value: data.value,
        unit: data.unit || '',
        topic: data.topic || '',
        simulated: data.simulated || false,
        quality: data.quality || 100,
        metadata: data.metadata || {},
    }).returning();
    return result[0];
}

async function saveBatchMeasurements(measurementsData) {
    const db = getDb();
    const values = measurementsData.map(data => ({
        id: generateUUID(),
        time: data.timestamp ? new Date(data.timestamp) : new Date(),
        parameter: data.parameter,
        value: data.value,
        unit: data.unit || '',
        topic: data.topic || '',
        simulated: data.simulated || false,
        quality: data.quality || 100,
        metadata: data.metadata || {},
    }));
    return db.insert(schema.measurements).values(values).returning();
}

async function getLatestMeasurement(parameter) {
    const db = getDb();
    const result = await db.select()
        .from(schema.measurements)
        .where(sql`${schema.measurements.parameter} = ${parameter}`)
        .orderBy(schema.measurements.time, 'desc')
        .limit(1);
    return result[0] || null;
}

async function getMeasurementHistory(parameter, hours = 24, limit = 1000) {
    const db = getDb();
    return db.select()
        .from(schema.measurements)
        .where(sql`${schema.measurements.parameter} = ${parameter} AND ${schema.measurements.time} > NOW() - INTERVAL '${hours} hours'`)
        .orderBy(schema.measurements.time, 'asc')
        .limit(limit);
}

async function getMeasurementAggregates(parameter, bucket = '1 hour', hours = 24) {
    const db = getDb();
    return db.execute(sql`
        SELECT
            time_bucket(${bucket}, time) AS bucket,
            AVG(value) AS avg_value,
            MIN(value) AS min_value,
            MAX(value) AS max_value,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median_value,
            COUNT(*) AS sample_count
        FROM measurements
        WHERE parameter = ${parameter}
            AND time > NOW() - INTERVAL ${hours + ' hours'}
        GROUP BY bucket
        ORDER BY bucket DESC
    `);
}

const PLANT_UTC_OFFSET_MS = 3 * 60 * 60 * 1000; // Africa/Nairobi = UTC+3, no DST

function toPlantWallClock(utcDate) {
    return new Date(utcDate.getTime() + PLANT_UTC_OFFSET_MS);
}

function fromPlantWallClock(wallClockDate) {
    return new Date(wallClockDate.getTime() - PLANT_UTC_OFFSET_MS);
}

async function getProductionVolume(parameter, startTime, endTime = new Date()) {
    const db = getDb();
    const result = await db.execute(sql`
        WITH ordered AS (
            SELECT
                time,
                value,
                LAG(time) OVER (ORDER BY time) AS prev_time,
                LAG(value) OVER (ORDER BY time) AS prev_value
            FROM measurements
            WHERE parameter = ${parameter}
                AND time <= ${endTime}
        ),
        production_intervals AS (
            SELECT
                GREATEST(prev_time, ${startTime}) AS interval_start,
                time AS interval_end,
                value,
                prev_value
            FROM ordered
            WHERE prev_time IS NOT NULL
                AND time > ${startTime}
                AND time <= ${endTime}
        )
        SELECT COALESCE(
            SUM(
                ((value + prev_value) / 2.0)
                * (EXTRACT(EPOCH FROM (interval_end - interval_start)) / 3600.0)
            ),
            0
        ) AS total_volume
        FROM production_intervals;
    `);
    const row = result.rows ? result.rows[0] : result[0];
    return Number(row?.total_volume) || 0;
}

async function getProductionSummary(parameter = 'RO5-Permeateflow') {
    const nowUTC = new Date();
    const wall = toPlantWallClock(nowUTC);

    const startOfToday = fromPlantWallClock(
        new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()))
    );

    const dow = wall.getUTCDay();
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    const startOfWeek = fromPlantWallClock(
        new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - daysSinceMonday))
    );

    const startOfMonth = fromPlantWallClock(
        new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1))
    );

    const startOfYear = fromPlantWallClock(
        new Date(Date.UTC(wall.getUTCFullYear(), 0, 1))
    );

    const [daily, weekly, monthly, yearly] = await Promise.all([
        getProductionVolume(parameter, startOfToday, nowUTC),
        getProductionVolume(parameter, startOfWeek, nowUTC),
        getProductionVolume(parameter, startOfMonth, nowUTC),
        getProductionVolume(parameter, startOfYear, nowUTC),
    ]);

    return { daily, weekly, monthly, yearly };
}

// ============================================================
// REPOSITORY: ALERTS
// ============================================================

async function createAlert(data) {
    const db = getDb();
    const result = await db.insert(schema.alerts).values({
        id: generateUUID(),
        ruleId: data.ruleId,
        tagId: data.tagId,
        organizationId: data.organizationId,
        severity: data.severity,
        message: data.message,
        value: data.value,
        threshold: data.threshold,
    }).returning();
    return result[0];
}

async function getActiveAlerts(organizationId = null) {
    const db = getDb();
    let query = db.select()
        .from(schema.alerts)
        .where(sql`${schema.alerts.resolved} = false`)
        .orderBy(schema.alerts.createdAt, 'desc');

    if (organizationId) {
        query = query.where(sql`${schema.alerts.organizationId} = ${organizationId}`);
    }

    return query;
}

async function acknowledgeAlert(id, userId, note = null) {
    const db = getDb();
    const result = await db.update(schema.alerts)
        .set({
            acknowledged: true,
            acknowledgedBy: userId,
            acknowledgedAt: new Date(),
            acknowledgedNote: note,
        })
        .where(sql`${schema.alerts.id} = ${id}`)
        .returning();
    return result[0];
}

async function resolveAlert(id, userId, note = null) {
    const db = getDb();
    const result = await db.update(schema.alerts)
        .set({
            resolved: true,
            resolvedBy: userId,
            resolvedAt: new Date(),
            resolvedNote: note,
        })
        .where(sql`${schema.alerts.id} = ${id}`)
        .returning();
    return result[0];
}

// ============================================================
// REPOSITORY: DEVICES & TAGS
// ============================================================

async function createDevice(data) {
    const db = getDb();
    const result = await db.insert(schema.devices).values({
        id: generateUUID(),
        organizationId: data.organizationId,
        name: data.name,
        description: data.description,
        deviceType: data.deviceType,
        protocol: data.protocol || 'mqtt',
        topicPattern: data.topicPattern,
        ipAddress: data.ipAddress,
        port: data.port,
        credentials: data.credentials,
        config: data.config,
    }).returning();
    return result[0];
}

async function getDevice(id) {
    const db = getDb();
    const result = await db.select()
        .from(schema.devices)
        .where(sql`${schema.devices.id} = ${id}`)
        .limit(1);
    return result[0] || null;
}

async function getAllDevices(organizationId = null) {
    const db = getDb();
    let query = db.select()
        .from(schema.devices)
        .where(sql`${schema.devices.isActive} = true`)
        .orderBy(schema.devices.name);

    if (organizationId) {
        query = query.where(sql`${schema.devices.organizationId} = ${organizationId}`);
    }

    return query;
}

async function createTag(data) {
    const db = getDb();
    const result = await db.insert(schema.tags).values({
        id: generateUUID(),
        deviceId: data.deviceId,
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        unit: data.unit,
        dataType: data.dataType || 'float',
        address: data.address,
        scaleFactor: data.scaleFactor || 1.0,
        offset: data.offset || 0.0,
        minValue: data.minValue,
        maxValue: data.maxValue,
        isCritical: data.isCritical || false,
        group: data.group,
        order: data.order || 0,
        metadata: data.metadata,
    }).returning();
    return result[0];
}

async function getTagsByDevice(deviceId) {
    const db = getDb();
    return db.select()
        .from(schema.tags)
        .where(sql`${schema.tags.deviceId} = ${deviceId} AND ${schema.tags.isActive} = true`)
        .orderBy(schema.tags.order, 'asc');
}

// ============================================================
// REPOSITORY: AUDIT LOGS
// ============================================================

async function logAction(userId, action, resource, resourceId = null, details = {}, ip = null, userAgent = null, organizationId = null) {
    const db = getDb();
    await db.insert(schema.auditLogs).values({
        id: generateUUID(),
        userId: userId,
        organizationId: organizationId,
        action: action,
        resource: resource,
        resourceId: resourceId,
        details: details,
        ipAddress: ip,
        userAgent: userAgent,
    });
}

async function getAuditLogs(organizationId = null, limit = 100) {
    const db = getDb();
    let query = db.select()
        .from(schema.auditLogs)
        .orderBy(schema.auditLogs.createdAt, 'desc')
        .limit(limit);

    if (organizationId) {
        query = query.where(sql`${schema.auditLogs.organizationId} = ${organizationId}`);
    }

    return query;
}

// ============================================================
// REPOSITORY: ALERT RULES
// ============================================================

async function createAlertRule(data) {
    const db = getDb();
    const result = await db.insert(schema.alertRules).values({
        id: generateUUID(),
        organizationId: data.organizationId,
        tagId: data.tagId,
        name: data.name,
        description: data.description,
        conditionType: data.conditionType,
        conditionConfig: data.conditionConfig,
        severity: data.severity || 'warning',
        priority: data.priority || 1,
        cooldownMinutes: data.cooldownMinutes || 5,
        escalationMinutes: data.escalationMinutes || 15,
        actions: data.actions || [],
        createdBy: data.createdBy,
    }).returning();
    return result[0];
}

async function getActiveAlertRules(organizationId = null) {
    const db = getDb();
    let query = db.select()
        .from(schema.alertRules)
        .where(sql`${schema.alertRules.isActive} = true`);

    if (organizationId) {
        query = query.where(sql`${schema.alertRules.organizationId} = ${organizationId}`);
    }

    return query;
}

// ============================================================
// REPOSITORY: SETTINGS
// ============================================================

const DEFAULT_SETTINGS = {
    plantName: 'Nairobi Water Treatment Plant',
    operatorId: 'WTP-2024-NBI-001',
    productionTarget: 4200,
    recoveryTarget: 78,
    filterDpWarn: 0.50,
    filterDpCrit: 0.65,
    lowRecoveryWarn: 76,
    lowChemAlert: 20,
    minDosing: 2.0,
    maxDosing: 3.0,
};

async function getSettings() {
    const db = getDb();
    const result = await db.select()
        .from(schema.systemSettings)
        .where(sql`${schema.systemSettings.id} = 1`)
        .limit(1);
    return result[0] || { id: 1, ...DEFAULT_SETTINGS, updatedAt: null, updatedBy: null };
}

async function saveSettings(data, userId) {
    const db = getDb();
    const values = {
        id: 1,
        plantName: data.plantName,
        operatorId: data.operatorId,
        productionTarget: Number(data.productionTarget),
        recoveryTarget: Number(data.recoveryTarget),
        filterDpWarn: Number(data.filterDpWarn),
        filterDpCrit: Number(data.filterDpCrit),
        lowRecoveryWarn: Number(data.lowRecoveryWarn),
        lowChemAlert: Number(data.lowChemAlert),
        minDosing: Number(data.minDosing),
        maxDosing: Number(data.maxDosing),
        updatedAt: new Date(),
        updatedBy: userId || null,
    };

    const result = await db.insert(schema.systemSettings)
        .values(values)
        .onConflictDoUpdate({
            target: schema.systemSettings.id,
            set: values,
        })
        .returning();

    return result[0];
}

const PLANT_TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

function dosingDayKey(date = new Date()) {
  const wall = new Date(date.getTime() + PLANT_TZ_OFFSET_MS);
  const y = wall.getUTCFullYear();
  const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const d = String(wall.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function dosingMonthKey(date = new Date()) {
  const wall = new Date(date.getTime() + PLANT_TZ_OFFSET_MS);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getDosingTotalsForDay(day) {
  const db = getDb();
  const rows = await db.select()
    .from(schema.dosingTotals)
    .where(sql`${schema.dosingTotals.day} = ${day}`)
    .limit(1);
  return rows[0] || null;
}

async function upsertDosingTotals(data) {
  const db = getDb();
  const now = new Date();
  const values = {
    id: data.id || generateUUID(),
    day: data.day,
    month: data.month,
    secondsOn: data.secondsOn,
    mlDosed: data.mlDosed,
    primedToday: data.primedToday,
    lastOnState: data.lastOnState,
    lastOnAt: data.lastOnAt,
    updatedAt: now,
  };
  const result = await db.insert(schema.dosingTotals)
    .values(values)
    .onConflictDoUpdate({
      target: schema.dosingTotals.day,
      set: {
        month: values.month,
        secondsOn: values.secondsOn,
        mlDosed: values.mlDosed,
        primedToday: values.primedToday,
        lastOnState: values.lastOnState,
        lastOnAt: values.lastOnAt,
        updatedAt: now,
      },
    })
    .returning();
  return result[0];
}

async function getDosingHistoryForMonth(month) {
  const db = getDb();
  return db.select()
    .from(schema.dosingTotals)
    .where(sql`${schema.dosingTotals.month} = ${month}`)
    .orderBy(schema.dosingTotals.day, 'asc');
}

async function getDosingCurrentMonthTotal() {
  const db = getDb();
  const month = dosingMonthKey();
  const rows = await db.select()
    .from(schema.dosingTotals)
    .where(sql`${schema.dosingTotals.month} = ${month}`);
  const ml = rows.reduce((sum, r) => sum + (Number(r.mlDosed) || 0), 0);
  const sec = rows.reduce((sum, r) => sum + (Number(r.secondsOn) || 0), 0);
  return { month, mlDosed: ml, secondsOn: sec, dayCount: rows.length };
}

// ============================================================
// REPOSITORY: BILLING
// Fixed-price M-Pesa subscription. Status lifecycle everywhere in
// this app is exactly: 'processing' -> 'success' | 'failed' | 'cancelled'.
// Never write or filter on any other status string.
// ============================================================

async function createBillingHistoryEntry(data) {
    const db = getDb();
    const result = await db.insert(schema.billingHistory).values({
        id: generateUUID(),
        userId: data.userId,
        planCode: data.planCode,
        planName: data.planName,
        amountKes: data.amountKes,
        mpesaCheckoutRequestId: data.mpesaCheckoutRequestId,
        mpesaMerchantRequestId: data.mpesaMerchantRequestId,
        mpesaPhone: data.mpesaPhone,
        status: 'processing',
    }).returning();
    return result[0];
}

async function getBillingHistoryByCheckoutRequestId(checkoutRequestId) {
    const db = getDb();
    const result = await db.select()
        .from(schema.billingHistory)
        .where(sql`${schema.billingHistory.mpesaCheckoutRequestId} = ${checkoutRequestId}`)
        .limit(1);
    return result[0] || null;
}

async function updateBillingHistoryByCheckoutRequestId(checkoutRequestId, data) {
    const db = getDb();
    const result = await db.update(schema.billingHistory)
        .set(data)
        .where(sql`${schema.billingHistory.mpesaCheckoutRequestId} = ${checkoutRequestId}`)
        .returning();
    return result[0] || null;
}

async function getPendingMpesaHistoryByUser(userId) {
    const db = getDb();
    const result = await db.select()
        .from(schema.billingHistory)
        .where(sql`${schema.billingHistory.userId} = ${userId}
            AND ${schema.billingHistory.status} = 'processing'
            AND ${schema.billingHistory.purchaseDate} > NOW() - INTERVAL '3 minutes'`)
        .limit(1);
    return result[0] || null;
}

async function getBillingHistoryByUser(userId, limit = 50) {
    const db = getDb();
    return db.select()
        .from(schema.billingHistory)
        .where(sql`${schema.billingHistory.userId} = ${userId}`)
        .orderBy(schema.billingHistory.purchaseDate, 'desc')
        .limit(limit);
}

async function upsertActiveSubscription(data) {
    const db = getDb();
    await db.update(schema.billingSubscriptions)
        .set({ status: 'replaced', updatedAt: new Date() })
        .where(sql`${schema.billingSubscriptions.userId} = ${data.userId} AND ${schema.billingSubscriptions.status} = 'active'`);

    const result = await db.insert(schema.billingSubscriptions).values({
        id: generateUUID(),
        userId: data.userId,
        planCode: data.planCode,
        mpesaPhone: data.mpesaPhone || null,
        status: 'active',
        currentPeriodEnd: data.currentPeriodEnd || null,
    }).returning();
    return result[0];
}

async function getActiveSubscription(userId) {
    const db = getDb();
    const result = await db.select()
        .from(schema.billingSubscriptions)
        .where(sql`${schema.billingSubscriptions.userId} = ${userId} AND ${schema.billingSubscriptions.status} = 'active'`)
        .limit(1);
    return result[0] || null;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Init
    initDb,
    getDb,
    getPool,
    generateUUID,
    healthCheck,

    // Users
    findUserByEmail,
    findUserById,
    createUser,
    updateUser,
    deleteUser,
    getAllUsers,

    // Refresh Tokens
    saveRefreshToken,
    findRefreshTokenByHash,
    revokeRefreshToken,
    revokeAllUserRefreshTokens,

    // Measurements
    saveMeasurement,
    saveBatchMeasurements,
    getLatestMeasurement,
    getMeasurementHistory,
    getMeasurementAggregates,
    getProductionVolume,
    getProductionSummary,

    // Alerts
    createAlert,
    getActiveAlerts,
    acknowledgeAlert,
    resolveAlert,

    // Devices
    createDevice,
    getDevice,
    getAllDevices,

    // Tags
    createTag,
    getTagsByDevice,

    // Alert Rules
    createAlertRule,
    getActiveAlertRules,

    // Audit
    logAction,
    getAuditLogs,

    // Settings
    getSettings,
    saveSettings,

    // Billing
    createBillingHistoryEntry,
    getBillingHistoryByCheckoutRequestId,
    updateBillingHistoryByCheckoutRequestId,
    getPendingMpesaHistoryByUser,
    getBillingHistoryByUser,
    upsertActiveSubscription,
    getActiveSubscription,

 // Dosing totals
    getDosingTotalsForDay,
    upsertDosingTotals,
    getDosingHistoryForMonth,
    getDosingCurrentMonthTotal,
    dosingDayKey,
    dosingMonthKey,

    // Schema
    schema,
};