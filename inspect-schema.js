// inspect-schema.js
// Run from your backend folder: node inspect-schema.js
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set in your .env file.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // List all tables in the public schema
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tableNames = tablesResult.rows.map(r => r.table_name);
    console.log('\n=== TABLES FOUND IN DATABASE ===');
    console.log(tableNames.length ? tableNames.join(', ') : '(none found)');

    if (tableNames.length === 0) {
      console.log('\nNo tables exist yet — you can run a fresh migration/push without worrying about conflicts.');
      return;
    }

    // For each table, print its columns and types
    for (const table of tableNames) {
      const columnsResult = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `, [table]);

      console.log(`\n--- ${table} ---`);
      columnsResult.rows.forEach(col => {
        console.log(
          `  ${col.column_name.padEnd(25)} ${col.data_type.padEnd(30)} ` +
          `${col.is_nullable === 'NO' ? 'NOT NULL' : 'nullable'}` +
          `${col.column_default ? '  default: ' + col.column_default : ''}`
        );
      });
    }
  } catch (err) {
    console.error('Error inspecting database:', err.message);
  } finally {
    await pool.end();
  }
}

main();