// backend/services/auth.service.js
//
// FIX NOTES:
// 1. Refresh-token hashing was using bcrypt.hash(), which generates a new random
//    salt every call — so hashing the same token twice at login vs. at refresh-time
//    produced two DIFFERENT hashes, and findRefreshTokenByHash() could never match
//    anything. Every refresh attempt failed and users got logged out after 15 min.
//    Fixed with a deterministic SHA-256 hash (safe here since refresh tokens are
//    already high-entropy PASETO tokens, not low-entropy user passwords).
// 2. All three demo users shared one bcrypt hash that didn't match ANY of the
//    documented demo passwords (admin123 / operator123 / client123). Replaced with
//    correct, distinct hashes for each.
// 3. Added logAction() so auth.controller.js (if you use it) doesn't crash — it's
//    just a thin wrapper around addAuditLog with an (ip, userAgent) friendly signature.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const pasetoService = require('./paseto.service');

// Deterministic hash for refresh tokens (do NOT use bcrypt here — see note above)
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ==================== IN-MEMORY STORAGE ====================
// This works immediately without a database.
// NOTE: data resets whenever the server restarts (expected, since there's no DB yet).
class InMemoryDB {
    constructor() {
        this.users = [];
        this.refreshTokens = [];
        this.auditLogs = [];
        this.initDefaultUsers();
    }

    initDefaultUsers() {
        // Correct, distinct bcrypt hashes for each documented demo password.
        const defaultUsers = [
            {
                id: uuidv4(),
                email: 'admin@aquaops.co.ke',
                // password: admin123
                password_hash: '$2b$12$V/5IvYgqqUB57/NpfOT/SOQGuGE5sVhddqT3XimIdZCex99Rf/ydy',
                first_name: 'John',
                last_name: 'Mwangi',
                role: 'admin',
                is_active: true,
                last_login: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: uuidv4(),
                email: 'operator@aquaops.co.ke',
                // password: operator123
                password_hash: '$2b$12$JaayglDOZGdyvSg6n73A8eba1XwhHYuTqr.WxxlJTDjA2ejeHBlGy',
                first_name: 'Grace',
                last_name: 'Wanjiku',
                role: 'operator',
                is_active: true,
                last_login: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: uuidv4(),
                email: 'client@aquaops.co.ke',
                // password: client123
                password_hash: '$2b$12$6s2SD.pawf/ZHofTCkGZ0.FjeFd7lKdKuk7eZnnvmzN7V2zV1Jgly',
                first_name: 'Peter',
                last_name: 'Kamau',
                role: 'client',
                is_active: true,
                last_login: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }
        ];

        this.users = defaultUsers;
        console.log(`[Auth] Initialized with ${this.users.length} default users`);
    }

    // User methods
    findUserByEmail(email) {
        return this.users.find(u => u.email === email.toLowerCase());
    }

    findUserById(id) {
        return this.users.find(u => u.id === id);
    }

    createUser(userData) {
        const user = {
            id: uuidv4(),
            ...userData,
            is_active: true,
            last_login: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        this.users.push(user);
        return user;
    }

    updateUser(id, updates) {
        const index = this.users.findIndex(u => u.id === id);
        if (index === -1) return null;

        this.users[index] = {
            ...this.users[index],
            ...updates,
            updated_at: new Date().toISOString()
        };
        return this.users[index];
    }

    deleteUser(id) {
        const index = this.users.findIndex(u => u.id === id);
        if (index === -1) return false;
        this.users.splice(index, 1);
        return true;
    }

    getAllUsers() {
        return this.users.map(u => ({
            id: u.id,
            email: u.email,
            first_name: u.first_name,
            last_name: u.last_name,
            role: u.role,
            is_active: u.is_active,
            last_login: u.last_login,
            created_at: u.created_at
        }));
    }

    // Refresh token methods
    saveRefreshToken(tokenData) {
        const token = {
            id: uuidv4(),
            ...tokenData,
            revoked: false,
            created_at: new Date().toISOString()
        };
        this.refreshTokens.push(token);
        return token;
    }

    findRefreshTokenByHash(tokenHash) {
        return this.refreshTokens.find(t =>
            t.token_hash === tokenHash &&
            t.revoked === false &&
            new Date(t.expires_at) > new Date()
        );
    }

    revokeRefreshToken(tokenHash) {
        const token = this.refreshTokens.find(t => t.token_hash === tokenHash);
        if (token) {
            token.revoked = true;
            return true;
        }
        return false;
    }

    revokeAllUserRefreshTokens(userId) {
        this.refreshTokens = this.refreshTokens.filter(t => t.user_id !== userId);
    }

    // Audit log methods
    addAuditLog(log) {
        const entry = {
            id: uuidv4(),
            ...log,
            created_at: new Date().toISOString()
        };
        this.auditLogs.push(entry);
        // Keep only last 1000 logs
        if (this.auditLogs.length > 1000) {
            this.auditLogs = this.auditLogs.slice(-1000);
        }
        return entry;
    }

    getAuditLogs(userId, limit = 100) {
        let logs = this.auditLogs;
        if (userId) {
            logs = logs.filter(l => l.user_id === userId);
        }
        return logs.slice(-limit).reverse();
    }
}

// ==================== AUTH SERVICE ====================
class AuthService {
    constructor() {
        this.db = new InMemoryDB();
        this.bcryptRounds = 12;
    }

    /**
     * Register a new user
     */
    async register(userData) {
        const { email, password, firstName, lastName, role = 'operator' } = userData;

        const existing = this.db.findUserByEmail(email);
        if (existing) {
            throw new Error('User already exists');
        }

        const passwordHash = await bcrypt.hash(password, this.bcryptRounds);

        const user = this.db.createUser({
            email: email.toLowerCase(),
            password_hash: passwordHash,
            first_name: firstName,
            last_name: lastName,
            role: role
        });

        this.db.addAuditLog({
            user_id: user.id,
            action: 'user_registered',
            resource: 'user',
            details: { email: user.email }
        });

        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role
        };
    }

    /**
     * Login user
     */
    async login(email, password, deviceInfo = {}) {
        const user = this.db.findUserByEmail(email);
        if (!user) {
            throw new Error('Invalid credentials');
        }

        if (!user.is_active) {
            throw new Error('Account disabled');
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            this.db.addAuditLog({
                user_id: null,
                action: 'login_failed',
                resource: 'auth',
                details: { email, reason: 'invalid_password' }
            });
            throw new Error('Invalid credentials');
        }

        this.db.updateUser(user.id, { last_login: new Date().toISOString() });

        const accessToken = await pasetoService.generateAccessToken(user);
        const refreshToken = await pasetoService.generateRefreshToken(user, deviceInfo);

        // FIX: deterministic hash instead of bcrypt.hash (see top-of-file note)
        this.db.saveRefreshToken({
            user_id: user.id,
            token_hash: hashToken(refreshToken),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            device_info: JSON.stringify(deviceInfo)
        });

        this.db.addAuditLog({
            user_id: user.id,
            action: 'login_success',
            resource: 'auth',
            details: { email: user.email, device: deviceInfo }
        });

        return {
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                role: user.role
            },
            accessToken,
            refreshToken,
            expiresIn: 900 // 15 minutes
        };
    }

    /**
     * Refresh access token
     */
    async refreshToken(refreshToken) {
        const payload = await pasetoService.verifyRefreshToken(refreshToken);
        if (!payload) {
            throw new Error('Invalid refresh token');
        }

        // FIX: deterministic hash lookup instead of bcrypt.hash
        const tokenHash = hashToken(refreshToken);
        const token = this.db.findRefreshTokenByHash(tokenHash);

        if (!token) {
            throw new Error('Invalid refresh token');
        }

        const user = this.db.findUserById(token.user_id);
        if (!user || !user.is_active) {
            throw new Error('User not found or inactive');
        }

        // Revoke old token
        this.db.revokeRefreshToken(tokenHash);

        // Generate new tokens
        const newAccessToken = await pasetoService.generateAccessToken(user);
        const newRefreshToken = await pasetoService.generateRefreshToken(user);

        // FIX: deterministic hash for the new token too
        this.db.saveRefreshToken({
            user_id: user.id,
            token_hash: hashToken(newRefreshToken),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            device_info: token.device_info
        });

        return {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresIn: 900
        };
    }

    /**
     * Logout user
     */
    async logout(userId, refreshToken) {
        if (refreshToken) {
            // FIX: deterministic hash instead of bcrypt.hash
            this.db.revokeRefreshToken(hashToken(refreshToken));
        }

        this.db.addAuditLog({
            user_id: userId,
            action: 'logout',
            resource: 'auth',
            details: {}
        });

        return { success: true };
    }

    /**
     * Change password
     */
    async changePassword(userId, currentPassword, newPassword) {
        const user = this.db.findUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const isValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValid) {
            throw new Error('Current password is incorrect');
        }

        const newHash = await bcrypt.hash(newPassword, this.bcryptRounds);
        this.db.updateUser(userId, { password_hash: newHash });

        this.db.revokeAllUserRefreshTokens(userId);

        this.db.addAuditLog({
            user_id: userId,
            action: 'password_changed',
            resource: 'user',
            details: {}
        });

        return { success: true };
    }

    /**
     * Get user by ID
     */
    async getUserById(userId) {
        const user = this.db.findUserById(userId);
        if (!user) return null;

        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            is_active: user.is_active,
            last_login: user.last_login,
            created_at: user.created_at
        };
    }

    /**
     * Get all users (admin only)
     */
    async getAllUsers() {
        return this.db.getAllUsers();
    }

    /**
     * Update user (admin only)
     */
    async updateUser(userId, updates) {
        const { firstName, lastName, role, isActive } = updates;

        const user = this.db.updateUser(userId, {
            first_name: firstName,
            last_name: lastName,
            role: role,
            is_active: isActive
        });

        if (!user) {
            throw new Error('User not found');
        }

        this.db.addAuditLog({
            user_id: userId,
            action: 'user_updated',
            resource: 'user',
            details: { updates }
        });

        return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
            is_active: user.is_active
        };
    }

    /**
     * Delete user (admin only)
     */
    async deleteUser(userId) {
        const user = this.db.findUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        this.db.deleteUser(userId);
        this.db.revokeAllUserRefreshTokens(userId);

        this.db.addAuditLog({
            user_id: userId,
            action: 'user_deleted',
            resource: 'user',
            details: { email: user.email }
        });

        return { success: true };
    }

    /**
     * Get audit logs
     */
    async getAuditLogs(userId, limit = 50) {
        return this.db.getAuditLogs(userId, limit);
    }

    /**
     * Friendly wrapper so auth.controller.js doesn't crash if you use it.
     * (Your active routes.js doesn't call this — it's here for compatibility.)
     */
    async logAction(userId, action, resource, details = {}, ip = null, userAgent = null) {
        return this.db.addAuditLog({
            user_id: userId,
            action,
            resource,
            details,
            ip,
            user_agent: userAgent
        });
    }
}

module.exports = new AuthService();