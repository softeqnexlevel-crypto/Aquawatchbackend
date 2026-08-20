// backend/scripts/update-admin-identity.js
//
// One-off script: updates the existing seeded admin (admin@aquaops.co.ke)
// to the new name/email. Run this once against your live database — the
// DEFAULT_USERS change in auth.service.js only affects fresh installs
// where the users table is still empty, so it won't touch a row that
// already exists.
//
// Usage:
//   node backend/scripts/update-admin-identity.js

'use strict';

require('dotenv').config();

const db = require('./database/postgres');
const authService = require('./services/auth.service');

const OLD_ADMIN_EMAIL = 'admin@aquaops.co.ke';
const NEW_ADMIN_EMAIL = 'aquasystemtech.co.ke@gmail.com';
const NEW_FIRST_NAME = 'David';
const NEW_LAST_NAME = ''; // fill in if there's a surname

async function run() {
    // The normal server entrypoint calls db.initDb() during startup before
    // anything touches the database. This script runs standalone, so it
    // has to do that itself first — otherwise every db.* call throws
    // "Database not initialized."
    if (typeof db.initDb === 'function') {
        await db.initDb();
    }

    const user = await db.findUserByEmail(OLD_ADMIN_EMAIL);

    if (!user) {
        console.log(`[migration] No user found with email "${OLD_ADMIN_EMAIL}" — nothing to update.`);
        console.log('[migration] If the admin was already renamed, or seeded under a different email, this script has nothing to do.');
        return;
    }

    const updated = await authService.updateUser(user.id, {
        email: NEW_ADMIN_EMAIL,
        firstName: NEW_FIRST_NAME,
        lastName: NEW_LAST_NAME,
    });

    console.log('[migration] Admin updated successfully:');
    console.log(updated);
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[migration] Failed:', err.message);
        process.exit(1);
    });