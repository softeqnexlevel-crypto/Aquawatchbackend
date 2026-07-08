// scripts/migrate.js
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { Pool } = require('pg');
require('dotenv').config();

async function main() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' 
            ? { rejectUnauthorized: false } 
            : false,
    });

    const db = drizzle(pool);

    console.log('🚀 Running migrations...');
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('✅ Migrations completed');

    await pool.end();
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});