// backend/services/auth.service.js
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pasetoService = require('./paseto.service');
const db = require('../database/postgres');

/* ============================================================
   DEFAULT SEED USERS
   Only created once, the first time the users table is empty.
   Unlike the old in-memory version, this does NOT run on every
   startup — otherwise it would try to re-insert users that
   already exist and throw on the unique email constraint.
   ============================================================ */

const DEFAULT_USERS = [
    { email: 'aquasystemtech.co.ke@gmail.com', password: 'admin123', firstName: 'David', lastName: '', role: 'admin' },
    { email: 'operator@aquaops.co.ke', password: 'operator123', firstName: 'Grace', lastName: 'Wanjiku', role: 'operator' },
    { email: 'client@aquaops.co.ke', password: 'client123', firstName: 'Peter', lastName: 'Kamau', role: 'client' },
];

async function initUsers() {
    try {
        const existing = await db.getAllUsers();
        if (existing && existing.length > 0) {
            console.log(`[auth] ${existing.length} user(s) already in database — skipping default seed`);
            return;
        }

        for (const u of DEFAULT_USERS) {
            const passwordHash = await bcrypt.hash(u.password, 10);
            await db.createUser({
                email: u.email,
                passwordHash,
                firstName: u.firstName,
                lastName: u.lastName,
                role: u.role,
            });
        }
        console.log('[auth] Default users seeded into database');
    } catch (err) {
        // Don't crash the server if seeding fails (e.g. DB not ready yet) —
        // log it clearly so it's not silently swallowed like past bugs were.
        console.error('[auth] Failed to seed default users:', err.message);
    }
}

/* ============================================================
   HELPERS
   ============================================================ */

// Shape a DB user row into the safe, camelCase object sent to clients —
// never leak passwordHash outward.
function toPublicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
    };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ============================================================
   AUTH SERVICE
   ============================================================ */

class AuthService {
    async login(email, password, deviceInfo = {}) {
        const user = await db.findUserByEmail(email);
        if (!user) throw new Error('Invalid credentials');
        if (!user.isActive) throw new Error('Account disabled');

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) throw new Error('Invalid credentials');

        const accessToken = await pasetoService.generateAccessToken(user);
        const refreshToken = await pasetoService.generateRefreshToken(user);

        await db.saveRefreshToken({
            userId: user.id,
            tokenHash: hashToken(refreshToken),
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            ipAddress: deviceInfo.ip || null,
            userAgent: deviceInfo.userAgent || null,
            deviceId: deviceInfo.deviceId || null,
            deviceName: deviceInfo.deviceName || null,
            deviceType: deviceInfo.deviceType || null,
            location: deviceInfo.location || null,
        });

        return {
            user: toPublicUser(user),
            accessToken,
            refreshToken,
            expiresIn: 900,
        };
    }

    async refreshToken(token) {
        const payload = await pasetoService.verifyRefreshToken(token);
        if (!payload) throw new Error('Invalid refresh token');

        const hash = hashToken(token);
        const stored = await db.findRefreshTokenByHash(hash);
        if (!stored) throw new Error('Invalid refresh token');

        const user = await db.findUserById(payload.sub);
        if (!user || !user.isActive) throw new Error('User not found');

        // Rotate: revoke the old refresh token, issue a new pair
        await db.revokeRefreshToken(hash);

        const accessToken = await pasetoService.generateAccessToken(user);
        const newRefreshToken = await pasetoService.generateRefreshToken(user);

        await db.saveRefreshToken({
            userId: user.id,
            tokenHash: hashToken(newRefreshToken),
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        });

        return {
            accessToken,
            refreshToken: newRefreshToken,
            expiresIn: 900,
        };
    }

    async getUserById(id) {
        const user = await db.findUserById(id);
        return toPublicUser(user);
    }

    async getAllUsers() {
        const users = await db.getAllUsers();
        return users.map(toPublicUser);
    }

    async register(userData) {
        const exists = await db.findUserByEmail(userData.email);
        if (exists) throw new Error('User already exists');

        const passwordHash = await bcrypt.hash(userData.password, 10);
        const user = await db.createUser({
            email: userData.email,
            passwordHash,
            firstName: userData.firstName,
            lastName: userData.lastName || '',
            role: userData.role || 'operator',
        });

        return toPublicUser(user);
    }

    async updateUser(id, updates) {
        const patch = {};
        if (typeof updates.firstName !== 'undefined') patch.firstName = updates.firstName;
        if (typeof updates.lastName !== 'undefined') patch.lastName = updates.lastName;
        if (typeof updates.role !== 'undefined') patch.role = updates.role;
        if (typeof updates.isActive !== 'undefined') patch.isActive = updates.isActive;

        // Email updates: guard against colliding with another account before
        // writing, since email is the unique login identifier.
        if (typeof updates.email !== 'undefined') {
            const existing = await db.findUserByEmail(updates.email);
            if (existing && existing.id !== id) {
                throw new Error('Email already in use by another account');
            }
            patch.email = updates.email;
        }

        const user = await db.updateUser(id, patch);
        if (!user) throw new Error('User not found');
        return toPublicUser(user);
    }

    async deleteUser(id) {
        // Soft delete by default — matches postgres.js's deleteUser(id, hardDelete=false)
        const result = await db.deleteUser(id, false);
        if (!result) throw new Error('User not found');
        return true;
    }

    async changePassword(userId, currentPassword, newPassword) {
        const user = await db.findUserById(userId);
        if (!user) throw new Error('User not found');

        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) throw new Error('Current password is incorrect');

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await db.updateUser(userId, { passwordHash });

        // Invalidate existing sessions so the old password can't keep being used elsewhere
        await db.revokeAllUserRefreshTokens(userId);

        return true;
    }

    async logout(userId, refreshToken) {
        if (refreshToken) {
            await db.revokeRefreshToken(hashToken(refreshToken));
        } else {
            await db.revokeAllUserRefreshTokens(userId);
        }
        return true;
    }

    async getAuditLogs(userId, limit = 50) {
        // organizationId scoping intentionally left null here — wire in once
        // multi-tenant organizationId is threaded through the auth middleware.
        return db.getAuditLogs(null, limit);
    }
}

const authService = new AuthService();

// Seed default users once, on module load (mirrors the old behavior of
// running at startup), but now idempotently against the real database.
authService.initUsers = initUsers;

module.exports = authService;