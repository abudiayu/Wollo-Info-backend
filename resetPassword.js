/**
 * One-off: set abudiayuu@gmail.com password hash to password123.
 * Run: node resetPassword.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  let conn;
  try {
    conn = await mysql.createConnection({
      host:     process.env.DB_HOST     || 'localhost',
      port:     Number(process.env.DB_PORT) || 3306,
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || 'root',
      database: process.env.DB_NAME     || 'wollo-info-hub',
    });

    const [result] = await conn.query(`
UPDATE users
SET password_hash = '$2b$10$tGvOrXooNAzNku3qNUpXMOUrJdUY1e8yLZJ3bdr50X2xTb4owxJhW'
WHERE email = 'abudiayuu@gmail.com'
    `);

    console.log(`Rows changed: ${result.affectedRows}`);
  } catch (err) {
    console.error('resetPassword failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
})();
