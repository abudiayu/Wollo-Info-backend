
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME     || 'wollo-info-hub',
    multipleStatements: true,
  });

  try {
    console.log('Connected. Starting migration...\n');

    // 1. Create admins table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id            INT          NOT NULL AUTO_INCREMENT,
        full_name     VARCHAR(120) NOT NULL,
        email         VARCHAR(180) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url    VARCHAR(255)     NULL DEFAULT NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_admins_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✓ admins table ready');

    // 2. Create staff table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id            INT          NOT NULL AUTO_INCREMENT,
        full_name     VARCHAR(120) NOT NULL,
        email         VARCHAR(180) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url    VARCHAR(255)     NULL DEFAULT NULL,
        position      VARCHAR(120)     NULL DEFAULT NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_staff_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✓ staff table ready');

    // 3. Ensure avatar_url exists on users
    const [cols] = await conn.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'avatar_url'
    `);
    if (!cols.length) {
      await conn.query(`ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL DEFAULT NULL`);
      console.log('✓ Added avatar_url to users');
    }

    // 4. Check if users table has a role column (old schema)
    const [roleCols] = await conn.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'
    `);

    if (roleCols.length) {
      // Copy admin-role users → admins table
      const [adminRows] = await conn.query(
        `SELECT full_name, email, password_hash, avatar_url, created_at
           FROM users WHERE role = 'admin'`
      );
      for (const row of adminRows) {
        await conn.query(
          `INSERT IGNORE INTO admins (full_name, email, password_hash, avatar_url, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [row.full_name, row.email, row.password_hash, row.avatar_url, row.created_at]
        );
      }
      console.log(`✓ Copied ${adminRows.length} admin(s) → admins table`);

      // Copy staff-role users → staff table
      const [staffRows] = await conn.query(
        `SELECT full_name, email, password_hash, avatar_url, created_at
           FROM users WHERE role = 'staff'`
      );
      for (const row of staffRows) {
        await conn.query(
          `INSERT IGNORE INTO staff (full_name, email, password_hash, avatar_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.full_name, row.email, row.password_hash, row.avatar_url, null, row.created_at]
        );
      }
      console.log(`✓ Copied ${staffRows.length} staff member(s) → staff table`);
    } else {
      console.log('ℹ  users table has no role column — no migration needed');
    }

    // Summary
    const [[{ u }]] = await conn.query(`SELECT COUNT(*) AS u FROM users`);
    const [[{ a }]] = await conn.query(`SELECT COUNT(*) AS a FROM admins`);
    const [[{ s }]] = await conn.query(`SELECT COUNT(*) AS s FROM staff`);
    console.log(`\n✅  Migration complete.`);
    console.log(`   users : ${u}`);
    console.log(`   admins: ${a}`);
    console.log(`   staff : ${s}`);
    console.log(`\n→ Now run:  node makeAdmin.js   (to promote yourself)`);
    console.log(`→ Then start the server:  npm run dev`);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
