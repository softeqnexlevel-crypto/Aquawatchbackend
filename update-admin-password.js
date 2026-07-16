// backend/scripts/update-admin-password.js
//
// One-off script: Updates the password for the admin user (after email/name migration).
// Run this once against your live database.

'use strict';

require('dotenv').config();

const db = require('./database/postgres');
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = 'aquasystemtech.co.ke@gmail.com';
const NEW_PASSWORD = 'aquasystem@2026.co';   // ← Change this if you want a different one

async function run() {
    // Initialize DB (same as the identity update script)
    if (typeof db.initDb === 'function') {
        await db.initDb();
    }

    const user = await db.findUserByEmail(ADMIN_EMAIL);

    if (!user) {
        console.error(`[migration] Admin user with email "${ADMIN_EMAIL}" not found!`);
        console.error('Make sure the identity update script has already been run.');
        process.exit(1);
    }

    const passwordHash = await bcrypt.hash(NEW_PASSWORD, 10);

    await db.updateUser(user.id, { passwordHash });

    // Invalidate all existing sessions
    await db.revokeAllUserRefreshTokens(user.id);

    console.log('✅ Admin password updated successfully!');
    console.log(`Email: ${ADMIN_EMAIL}`);
    console.log(`New password: ${NEW_PASSWORD}`);
    console.log('All existing sessions have been invalidated.');
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[migration] Failed:', err.message);
        process.exit(1);
    });