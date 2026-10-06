/**
 * makeDepartmentHead.js
 * ---------------------
 * Creates a department + department head account in the database.
 *
 * Usage:
 *   node makeDepartmentHead.js
 *
 * Edit the variables below before running.
 */

require('dotenv').config();
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const DEPT_NAME      = 'Medicine';              // must match your departments table
const HEAD_NAME      = 'Dr. Abebe Girma';
const HEAD_EMAIL     = 'head.medicine@wollo.edu.et';
const HEAD_PASSWORD  = 'WolloMed2025!';         // change this

(async () => {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME     || 'wollo-info-hub',
  });

  try {
    /* 1. Ensure the department row exists */
    await db.query(
      `INSERT IGNORE INTO departments (name) VALUES (?)`,
      [DEPT_NAME]
    );

    const [[dept]] = await db.query(
      'SELECT id FROM departments WHERE name = ? LIMIT 1',
      [DEPT_NAME]
    );

    if (!dept) {
      console.error(`Department "${DEPT_NAME}" not found even after insert.`);
      process.exit(1);
    }

    /* 2. Check for existing head with that email */
    const [[existing]] = await db.query(
      'SELECT id FROM department_heads WHERE email = ? LIMIT 1',
      [HEAD_EMAIL]
    );

    if (existing) {
      console.log(`Department head already exists with email: ${HEAD_EMAIL}`);
      console.log('To reset the password, delete the row and re-run this script.');
      await db.end();
      return;
    }

    /* 3. Create the head account */
    const hash = await bcrypt.hash(HEAD_PASSWORD, 12);
    const [r] = await db.query(
      `INSERT INTO department_heads (name, email, password_hash, department_id)
       VALUES (?, ?, ?, ?)`,
      [HEAD_NAME, HEAD_EMAIL, hash, dept.id]
    );

    console.log('');
    console.log('✅  Department head created successfully!');
    console.log('');
    console.log(`   Department : ${DEPT_NAME} (id ${dept.id})`);
    console.log(`   Name       : ${HEAD_NAME}`);
    console.log(`   Email      : ${HEAD_EMAIL}`);
    console.log(`   Password   : ${HEAD_PASSWORD}`);
    console.log(`   Head ID    : ${r.insertId}`);
    console.log('');
    console.log('Login at /department-head');
  } finally {
    await db.end();
  }
})();
