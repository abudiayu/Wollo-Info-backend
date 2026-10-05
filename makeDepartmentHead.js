/**
 * Creates (or updates) a department head in the `department_heads` table.
 * Edit the four values below, then run once:  node makeDepartmentHead.js
 * Run it again with the same email to update that head instead of failing.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql  = require('mysql2/promise');

const HEAD_NAME       = 'Dr. Abebe';
const HEAD_EMAIL      = 'head@wollo.edu.et';
const HEAD_PASSWORD   = 'ChangeMe123';      // change this before running
const DEPARTMENT_NAME = 'Medicine';         // created automatically if missing

(async () => {
  let conn;
  let exitCode = 0;

  try {
    conn = await mysql.createConnection({
      host:     process.env.DB_HOST     || 'localhost',
      port:     Number(process.env.DB_PORT) || 3306,
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || 'root',
      database: process.env.DB_NAME     || 'wollo-info-hub',
    });

    const email = HEAD_EMAIL.trim().toLowerCase();

    // 1. Make sure the department exists
    await conn.query('INSERT IGNORE INTO departments (name) VALUES (?)', [DEPARTMENT_NAME]);
    const [[dept]] = await conn.query(
      'SELECT id, name FROM departments WHERE name = ? LIMIT 1',
      [DEPARTMENT_NAME]
    );

    // 2. Create the head, or update them if the email already exists
    const password_hash = await bcrypt.hash(HEAD_PASSWORD, 12);
    const [result] = await conn.query(
      `INSERT INTO department_heads (name, email, password_hash, department_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name          = VALUES(name),
         password_hash = VALUES(password_hash),
         department_id = VALUES(department_id)`,
      [HEAD_NAME, email, password_hash, dept.id]
    );

    console.log(result.affectedRows === 1 ? 'Department head created' : 'Department head updated');
    console.log(`   Name       : ${HEAD_NAME}`);
    console.log(`   Email      : ${email}`);
    console.log(`   Department : ${dept.name}`);
    console.log('');
    console.log('→ Sign in at http://localhost:5173/department-head');
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      console.error('❌  Tables are missing. Run "node migrate.js" or start the server once, then try again.');
    } else {
      console.error('❌  makeDepartmentHead failed:', err.message);
    }
    exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }

  process.exit(exitCode);
})();