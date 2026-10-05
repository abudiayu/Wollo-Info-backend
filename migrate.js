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

  // Adds a column only when it is missing (safe to re-run)
  async function addColumnIfMissing(table, column, definition) {
    const [found] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!found.length) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      console.log(`✓ Added ${column} to ${table}`);
    }
  }

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
      // FIX: the column list was missing `position`, so the query had 5 columns
      // but 6 values and failed with "Column count doesn't match value count".
      const [staffRows] = await conn.query(
        `SELECT full_name, email, password_hash, avatar_url, created_at
           FROM users WHERE role = 'staff'`
      );
      for (const row of staffRows) {
        await conn.query(
          `INSERT IGNORE INTO staff (full_name, email, password_hash, avatar_url, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.full_name, row.email, row.password_hash, row.avatar_url, null, row.created_at]
        );
      }
      console.log(`✓ Copied ${staffRows.length} staff member(s) → staff table`);
    } else {
      console.log('ℹ  users table has no role column — no migration needed');
    }

    // 5. Department head tables
    await conn.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id              INT          NOT NULL AUTO_INCREMENT,
        name            VARCHAR(150) NOT NULL,
        description     TEXT             NULL,
        graduates_count INT          NOT NULL DEFAULT 0,
        duration_years  INT          NOT NULL DEFAULT 4,
        PRIMARY KEY (id),
        UNIQUE KEY uq_departments_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // If a departments table already existed, make sure it has these columns
    await addColumnIfMissing('departments', 'description',     'TEXT NULL');
    await addColumnIfMissing('departments', 'graduates_count', 'INT NOT NULL DEFAULT 0');
    await addColumnIfMissing('departments', 'duration_years',  'INT NOT NULL DEFAULT 4');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS department_heads (
        id            INT          NOT NULL AUTO_INCREMENT,
        name          VARCHAR(120) NOT NULL,
        email         VARCHAR(160) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        department_id INT          NOT NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_dh_email (email),
        KEY idx_dh_department (department_id),
        CONSTRAINT fk_dh_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS department_courses (
        id            INT          NOT NULL AUTO_INCREMENT,
        department_id INT          NOT NULL,
        course_name   VARCHAR(200) NOT NULL,
        prerequisites VARCHAR(300) NOT NULL DEFAULT '',
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_dc_department (department_id),
        CONSTRAINT fk_dc_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS department_interests (
        id            INT      NOT NULL AUTO_INCREMENT,
        student_id    INT      NOT NULL,
        department_id INT      NOT NULL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_di_student_dept (student_id, department_id),
        KEY idx_di_department (department_id),
        CONSTRAINT fk_di_student    FOREIGN KEY (student_id)    REFERENCES users(id)       ON DELETE CASCADE,
        CONSTRAINT fk_di_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS department_content (
        id            INT          NOT NULL AUTO_INCREMENT,
        department_id INT          NOT NULL,
        head_id       INT          NOT NULL,
        type          ENUM('opportunity','motivation','document') NOT NULL,
        title         VARCHAR(200) NOT NULL,
        body          TEXT             NULL,
        link_url      VARCHAR(500) NOT NULL DEFAULT '',
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_dcont_department (department_id),
        CONSTRAINT fk_dcont_department FOREIGN KEY (department_id) REFERENCES departments(id)       ON DELETE CASCADE,
        CONSTRAINT fk_dcont_head       FOREIGN KEY (head_id)       REFERENCES department_heads(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✓ department tables ready (departments, department_heads, department_courses, department_interests, department_content)');

    // Summary
    const [[{ u }]]  = await conn.query(`SELECT COUNT(*) AS u  FROM users`);
    const [[{ a }]]  = await conn.query(`SELECT COUNT(*) AS a  FROM admins`);
    const [[{ s }]]  = await conn.query(`SELECT COUNT(*) AS s  FROM staff`);
    const [[{ dh }]] = await conn.query(`SELECT COUNT(*) AS dh FROM department_heads`);
    console.log(`\n✅  Migration complete.`);
    console.log(`   users            : ${u}`);
    console.log(`   admins           : ${a}`);
    console.log(`   staff            : ${s}`);
    console.log(`   department heads : ${dh}`);
    console.log(`\n→ Now run:  node makeAdmin.js   (to promote yourself)`);
    console.log(`→ Add a department head with the SQL insert, then start the server:  npm run dev`);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();