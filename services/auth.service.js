// backend/services/auth.service.js
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pasetoService = require('./paseto.service');
const db = require('../database/postgres');

/* ============================================================
   DEFAULT SEED USERS
   ============================================================ */

const DEFAULT_USERS = [
    { email: 'softeqnexlevel@gmail.com', password: 'admin123', firstName: 'Softeq', lastName: 'NexLevel', role: 'admin', phone: '+254700000000' },
    { email: 'aquasystemtech.co.ke@gmail.com', password: 'admin123', firstName: 'David', lastName: 'Admin', role: 'admin', phone: '+254728536124' },
    { email: 'operator@aquaops.co.ke', password: 'operator123', firstName: 'Grace', lastName: 'Wanjiku', role: 'operator', phone: '+254712345678' },
    { email: 'client@aquaops.co.ke', password: 'client123', firstName: 'Peter', lastName: 'Kamau', role: 'client', phone: '+254798765432' },
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
                phone: u.phone,
            });
        }
        console.log('[auth] Default users seeded into database');
    } catch (err) {
        console.error('[auth] Failed to seed default users:', err.message);
    }
}

/* ============================================================
   HELPERS
   ============================================================ */

function toPublicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
        isActive: user.isActive,
        phone: user.phone,
        createdAt: user.createdAt,
    };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* ============================================================
   AUTH SERVICE
   ============================================================ */

class AuthService {
    async _issueSession(user, deviceInfo = {}) {
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

    // Login with email/password
    async login(email, password, deviceInfo = {}) {
        const user = await db.findUserByEmail(email);
        if (!user) throw new Error('Invalid credentials');
        if (!user.isActive) throw new Error('Account disabled');

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) throw new Error('Invalid credentials');

        return this._issueSession(user, deviceInfo);
    }

    // Refresh token
    async refreshToken(token) {
        const payload = await pasetoService.verifyRefreshToken(token);
        if (!payload) throw new Error('Invalid refresh token');

        const hash = hashToken(token);
        const stored = await db.findRefreshTokenByHash(hash);
        if (!stored) throw new Error('Invalid refresh token');

        const user = await db.findUserById(payload.sub);
        if (!user || !user.isActive) throw new Error('User not found');

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

    // Get user by ID
    async getUserById(id) {
        const user = await db.findUserById(id);
        return toPublicUser(user);
    }

    // Get all users
    async getAllUsers() {
        const users = await db.getAllUsers();
        return users.map(toPublicUser);
    }

    // Register new user
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
            phone: userData.phone || '',
            permissions: Array.isArray(userData.permissions) ? userData.permissions : [],
        });

        return toPublicUser(user);
    }

    // Update user
    async updateUser(id, updates) {
        const patch = {};
        if (typeof updates.firstName !== 'undefined') patch.firstName = updates.firstName;
        if (typeof updates.lastName !== 'undefined') patch.lastName = updates.lastName;
        if (typeof updates.role !== 'undefined') patch.role = updates.role;
        if (typeof updates.isActive !== 'undefined') patch.isActive = updates.isActive;
        if (typeof updates.phone !== 'undefined') patch.phone = updates.phone;
        if (Array.isArray(updates.permissions)) patch.permissions = updates.permissions;

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

    // Delete user
    async deleteUser(id) {
        const result = await db.deleteUser(id, false);
        if (!result) throw new Error('User not found');
        return true;
    }

    // Change password
    async changePassword(userId, currentPassword, newPassword) {
        const user = await db.findUserById(userId);
        if (!user) throw new Error('User not found');

        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) throw new Error('Current password is incorrect');

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await db.updateUser(userId, { passwordHash });
        await db.revokeAllUserRefreshTokens(userId);

        return true;
    }

    // Logout
    async logout(userId, refreshToken) {
        if (refreshToken) {
            await db.revokeRefreshToken(hashToken(refreshToken));
        } else {
            await db.revokeAllUserRefreshTokens(userId);
        }
        return true;
    }

    // Log action
    async logAction(userId, action, resource, resourceId = null, details = {}, ip = null, userAgent = null) {
        return db.logAction(userId, action, resource, resourceId, details, ip, userAgent);
    }

    // Get audit logs
    async getAuditLogs(userId, limit = 50) {
        return db.getAuditLogs(null, limit);
    }
}

const authService = new AuthService();
authService.initUsers = initUsers;

module.exports = authService;