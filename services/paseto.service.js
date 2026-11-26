// backend/services/paseto.service.js
const { V3 } = require('paseto');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The signing key must survive restarts, otherwise every login stops working after each deploy.
// Order: 1) PASETO_KEY environment variable (base64, 32 bytes)  <- use this on Render
//        2) the .paseto-key file (fine on your own computer, but Render's disk is wiped on every deploy)
//        3) a new random key (last resort; a warning is printed because everyone is signed out on restart)
let KEY_SOURCE = 'unknown';

function loadKey() {
    const fromEnv = (process.env.PASETO_KEY || '').trim();
    if (fromEnv) {
        const key = Buffer.from(fromEnv, 'base64');
        if (key.length !== 32) {
            throw new Error('PASETO_KEY must be 32 random bytes encoded as base64 (44 characters). ' +
                'Create one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
        }
        KEY_SOURCE = 'environment variable PASETO_KEY';
        return key;
    }

    const keyFile = path.join(__dirname, '..', '.paseto-key');
    try {
        if (fs.existsSync(keyFile)) {
            const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
            if (key.length === 32) { KEY_SOURCE = 'file .paseto-key'; return key; }
        }
    } catch (_) { /* fall through */ }

    const key = crypto.randomBytes(32);
    try { fs.writeFileSync(keyFile, key.toString('base64')); } catch (_) { /* read-only disk */ }
    KEY_SOURCE = 'TEMPORARY random key';
    console.warn('[auth] ⚠️ PASETO_KEY is not set: using a temporary signing key. ' +
        'Every login will stop working the next time the server restarts. Set PASETO_KEY in your hosting environment.');
    return key;
}

// Why a token was refused, without ever printing the token or the key.
// Repeated identical reasons are printed at most once a minute.
const lastLogged = new Map();
function logReject(kind, reason) {
    const k = `${kind}:${reason}`;
    const now = Date.now();
    if (now - (lastLogged.get(k) || 0) < 60000) return;
    lastLogged.set(k, now);
    console.warn(`[auth] ${kind} token refused: ${reason}`);
}

class PasetoService {
    constructor() {
        this.key = loadKey();
        console.log(`[auth] signing key source: ${KEY_SOURCE}`);
    }

    async generateAccessToken(user) {
        const now = new Date();
        const payload = {
            sub: user.id,
            email: user.email,
            role: user.role,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            type: 'access',
            iat: now.toISOString(),
            exp: new Date(Date.now() + 900000).toISOString() // STRING format
        };

        return await V3.encrypt(payload, this.key);
    }

    async generateRefreshToken(user) {
        const now = new Date();
        const payload = {
            sub: user.id,
            type: 'refresh',
            iat: now.toISOString(),
            exp: new Date(Date.now() + 604800000).toISOString() // STRING format
        };

        return await V3.encrypt(payload, this.key);
    }

    async verifyAccessToken(token) {
        try {
            const payload = await V3.decrypt(token, this.key);
            if (payload.type !== 'access') { logReject('access', 'wrong token type'); return null; }
            if (new Date(payload.exp) < new Date()) { logReject('access', 'expired'); return null; }
            return payload;
        } catch (error) {
            logReject('access', error && (error.code || error.message) || 'could not be decrypted (wrong key or damaged token)');
            return null;
        }
    }

    async verifyRefreshToken(token) {
        try {
            const payload = await V3.decrypt(token, this.key);
            if (payload.type !== 'refresh') { logReject('refresh', 'wrong token type'); return null; }
            if (new Date(payload.exp) < new Date()) { logReject('refresh', 'expired'); return null; }
            return payload;
        } catch (error) {
            logReject('refresh', error && (error.code || error.message) || 'could not be decrypted (wrong key or damaged token)');
            return null;
        }
    }
}

module.exports = new PasetoService();