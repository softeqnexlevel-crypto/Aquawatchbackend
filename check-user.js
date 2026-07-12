// check-users.js
// Run from your backend folder: node check-users.js
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    const result = await pool.query('SELECT id, email, role, is_active, created_at FROM users ORDER BY created_at');
    console.log(`\nFound ${result.rows.length} user(s) in the database:\n`);
    if (result.rows.length === 0) {
      console.log('(none — the users table is still empty)');
    } else {
      result.rows.forEach(row => {
        console.log(`  ${row.email.padEnd(30)} role=${row.role.padEnd(10)} active=${row.is_active}  id=${row.id}`);
      });
    }
  } catch (err) {
    console.error('Error querying users table:', err.message);
  } finally {
    await pool.end();
  }
}

main();