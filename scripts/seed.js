// scripts/seed.js
const bcrypt = require('bcryptjs');
const { initDb, createUser, findUserByEmail, getDb } = require('../database/postgres');
require('dotenv').config();

async function seed() {
    console.log('🌱 Seeding database...');

    try {
        // Initialize database
        await initDb();
        console.log('✅ Database initialized');

        const users = [
            {
                email: 'admin@aquaops.co.ke',
                password: 'admin123',
                firstName: 'John',
                lastName: 'Mwangi',
                role: 'admin',
            },
            {
                email: 'operator@aquaops.co.ke',
                password: 'operator123',
                firstName: 'Grace',
                lastName: 'Wanjiku',
                role: 'operator',
            },
            {
                email: 'client@aquaops.co.ke',
                password: 'client123',
                firstName: 'Peter',
                lastName: 'Kamau',
                role: 'client',
            },
        ];

        for (const user of users) {
            try {
                const existing = await findUserByEmail(user.email);
                if (!existing) {
                    const hashed = await bcrypt.hash(user.password, 12);
                    await createUser({
                        email: user.email,
                        passwordHash: hashed,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        role: user.role,
                    });
                    console.log(`✅ Created user: ${user.email}`);
                } else {
                    console.log(`⏭️ User already exists: ${user.email}`);
                }
            } catch (error) {
                console.error(`❌ Error creating user ${user.email}:`, error.message);
            }
        }

        console.log('✅ Seeding completed!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
}

seed();