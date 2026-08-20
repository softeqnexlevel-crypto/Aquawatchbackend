// backend/services/paseto.service.js
const { V3 } = require('paseto');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class PasetoService {
    constructor() {
        const keyFile = path.join(__dirname, '..', '.paseto-key');
        
        if (fs.existsSync(keyFile)) {
            const keyBase64 = fs.readFileSync(keyFile, 'utf8').trim();
            this.key = Buffer.from(keyBase64, 'base64');
        } else {
            this.key = crypto.randomBytes(32);
            fs.writeFileSync(keyFile, this.key.toString('base64'));
        }
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
            if (payload.type !== 'access') return null;
            if (new Date(payload.exp) < new Date()) return null;
            return payload;
        } catch (error) {
            return null;
        }
    }

    async verifyRefreshToken(token) {
        try {
            const payload = await V3.decrypt(token, this.key);
            if (payload.type !== 'refresh') return null;
            if (new Date(payload.exp) < new Date()) return null;
            return payload;
        } catch (error) {
            return null;
        }
    }
}

module.exports = new PasetoService();