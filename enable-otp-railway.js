// scripts/enable-otp-railway.js
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // First, check if the user exists
    const userCheck = await pool.query(
      'SELECT id, email, otp_enabled FROM users WHERE email = $1',
      ['aquasystemtech.co.ke@gmail.com']
    );

    if (userCheck.rows.length === 0) {
      console.log('❌ User not found!');
      return;
    }

    const user = userCheck.rows[0];
    console.log('📋 User found:', user.email);
    console.log(`   Current OTP status: ${user.otp_enabled ? '✅ Enabled' : '❌ Disabled'}`);

    // Enable OTP
    const result = await pool.query(
      `UPDATE users 
       SET otp_enabled = true 
       WHERE email = $1
       RETURNING id, email, otp_enabled`,
      ['aquasystemtech.co.ke@gmail.com']
    );

    console.log('\n✅ OTP enabled successfully!');
    console.log(`   User: ${result.rows[0].email}`);
    console.log(`   OTP Enabled: ${result.rows[0].otp_enabled ? '✅ Yes' : '❌ No'}`);
    
    console.log('\n📝 When testing login:');
    console.log('   1. Email: aquasystemtech.co.ke@gmail.com');
    console.log('   2. Password: admin123');
    console.log('   3. Check server console for the OTP code');
    console.log('   4. Enter the 6-digit code in the OTP screen');

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();