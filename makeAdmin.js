/**
 * Promotes abudiayuu@gmail.com to admin in the `users` table.
 * Run once:  node makeAdmin.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const TARGET_EMAIL = 'abudiayuu@gmail.com';

(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME     || 'wollo-info-hub',
  });

  try {
    const [[row]] = await conn.query(
      'SELECT id, full_name, email, role FROM users WHERE email = ? LIMIT 1',
      [TARGET_EMAIL]
    );

    if (!row) {
      console.log(`❌  No account found for: ${TARGET_EMAIL}`);
      console.log('   Register at http://localhost:5173/auth first, then run this again.');
      process.exit(1);
    }

    if (row.role === 'admin') {
      console.log(`✅  ${row.full_name} is already an admin.`);
      process.exit(0);
    }

    await conn.query(
      "UPDATE users SET role = 'admin' WHERE email = ?",
      [TARGET_EMAIL]
    );

    console.log('✅  Done!');
    console.log(`   Name  : ${row.full_name}`);
    console.log(`   Email : ${row.email}`);
    console.log(`   Role  : admin`);
    console.log('');
    console.log('→ Log OUT and log back in at http://localhost:5173/auth');
    console.log('  Use password: Abudy123');
    console.log('→ Then visit:  http://localhost:5173/admin');
  } finally {
    await conn.end();
  }
})();
