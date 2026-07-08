// database/postgres.js
const { drizzle } = require('drizzle-orm/node-postgres');
const { Pool } = require('pg');
const { sql } = require('drizzle-orm');
const { v4: uuidv4 } = require('uuid');
const schema = require('../db/schema');

let db = null;
let pool = null;
let initialized = false;

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
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            ssl: process.env.NODE_ENV === 'production' 
                ? { rejectUnauthorized: false } 
                : false,
        });

        // Test connection
        await pool.query('SELECT 1');
        console.log('[DB] Connected to PostgreSQL');

        // Initialize drizzle with schema
        db = drizzle(pool, { 
            schema,
            logger: process.env.NODE_ENV !== 'production'
        });

        initialized = true;
    } catch (error) {
        console.error('[DB] Failed to initialize:', error.message);
        throw error;
    }
}

function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return db;
}

function generateUUID() {
    return uuidv4();
}

// ============================================================
// USERS - SIMPLIFIED VERSION
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
        role: data.role || 'operator',
    }).returning();
    return result[0];
}

// ============================================================
// MEASUREMENTS
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

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    initDb,
    getDb,
    generateUUID,
    findUserByEmail,
    findUserById,
    createUser,
    saveMeasurement,
    schema,
};