// backend/services/paseto.service.js
//
// FIX NOTES:
// - `paseto2` is not a real npm package (was unpublished in 2021). Use `paseto` instead:
//     npm uninstall paseto2
//     npm install paseto
// - The real `paseto` package does NOT implement v4.local (symmetric) encryption —
//   v4 only supports public/private signing. Only v1 and v3 support `local` mode.
//   We use v3.local here, which is fully supported and secure (AES-256-CTR + HMAC).
// - Your existing PASETO_SYMMETRIC_KEY in .env (32 random bytes, base64) works as-is.

const { V3 } = require('paseto');
const crypto = require('crypto');
const config = require('../config/config');

class PasetoService {
    constructor() {
        if (!config.paseto.symmetricKey) {
            throw new Error('PASETO_SYMMETRIC_KEY is required');
        }

        // Convert the base64 key from .env into a proper Node KeyObject
        this.key = crypto.createSecretKey(Buffer.from(config.paseto.symmetricKey, 'base64'));
    }

    /**
     * Generate an access token (short-lived)
     */
    async generateAccessToken(user) {
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            sub: user.id,
            email: user.email,
            role: user.role,
            // NOTE: your user records use snake_case (first_name/last_name),
            // not camelCase (user.firstName was always undefined before)
            name: `${user.first_name} ${user.last_name}`,
            type: 'access',
            iss: 'water-management-api',
            iat: now,
            exp: now + this.parseDuration(config.paseto.accessTokenExpiry)
        };

        try {
            return await V3.encrypt(payload, this.key);
        } catch (error) {
            throw new Error('Access token generation failed');
        }
    }

    /**
     * Generate a refresh token (long-lived)
     */
    async generateRefreshToken(user, deviceInfo = {}) {
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            sub: user.id,
            type: 'refresh',
            device: deviceInfo,
            iat: now,
            exp: now + this.parseDuration(config.paseto.refreshTokenExpiry)
        };

        try {
            return await V3.encrypt(payload, this.key);
        } catch (error) {
            throw new Error('Refresh token generation failed');
        }
    }

    /**
     * Verify and decrypt a token
     */
    async verifyToken(token) {
        try {
            const payload = await V3.decrypt(token, this.key);

            // Check expiration
            if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
                return null;
            }

            return payload;
        } catch (error) {
            return null;
        }
    }

    /**
     * Verify access token
     */
    async verifyAccessToken(token) {
        const payload = await this.verifyToken(token);
        if (!payload || payload.type !== 'access') {
            return null;
        }
        return payload;
    }

    /**
     * Verify refresh token
     */
    async verifyRefreshToken(token) {
        const payload = await this.verifyToken(token);
        if (!payload || payload.type !== 'refresh') {
            return null;
        }
        return payload;
    }

    /**
     * Parse duration string (e.g., '15m' -> 900 seconds)
     */
    parseDuration(duration) {
        const unit = duration.slice(-1);
        const value = parseInt(duration.slice(0, -1));

        switch (unit) {
            case 's': return value;
            case 'm': return value * 60;
            case 'h': return value * 60 * 60;
            case 'd': return value * 60 * 60 * 24;
            default: return parseInt(duration);
        }
    }

    /**
     * Generate random token for password reset
     */
    generateRandomToken(length = 32) {
        return crypto.randomBytes(length).toString('hex');
    }
}

module.exports = new PasetoService();