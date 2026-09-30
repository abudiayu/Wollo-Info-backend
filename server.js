require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const mysql          = require('mysql2/promise');
const authMiddleware = require('./middleware/authMiddleware');
const authRouter     = require('./routes/auth');
const adminRouter    = require('./routes/admin');

const {
  PORT        = 5000,
  DB_HOST     = 'localhost',
  DB_PORT     = 3306,
  DB_USER     = 'root',
  DB_PASSWORD = 'root',
  DB_NAME     = 'wollo-info-hub',
  CORS_ORIGIN = '*',
} = process.env;

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '2mb' }));

// ── Pool ────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: DB_HOST, port: Number(DB_PORT),
  user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  waitForConnections: true, connectionLimit: 10, queueLimit: 0,
  dateStrings: true,
});

// ── Ensure all three account tables exist ───────────────────
async function ensureTables() {
  // Single users table — role column holds 'user' or 'admin'
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT          NOT NULL AUTO_INCREMENT,
      full_name     VARCHAR(120) NOT NULL,
      email         VARCHAR(180) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      avatar_url    VARCHAR(255)     NULL DEFAULT NULL,
      role          VARCHAR(20)  NOT NULL DEFAULT 'user',
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Ensure avatar_url column exists (backward compat)
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'avatar_url'`,
    [DB_NAME]
  );
  if (!cols.length) {
    await pool.query(`ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL DEFAULT NULL`);
    console.log('Migration: added avatar_url to users.');
  }

  // Ensure role column exists (backward compat)
  const [roleCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`,
    [DB_NAME]
  );
  if (!roleCols.length) {
    await pool.query(`ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user'`);
    console.log('Migration: added role column to users.');
  }
}

// ── Schema introspection ────────────────────────────────────
let schema = {};

async function loadSchema() {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_KEY, EXTRA
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [DB_NAME]
  );
  const next = {};
  for (const r of rows) {
    const t = r.TABLE_NAME;
    if (!next[t]) next[t] = { columns: new Set(), primaryKey: null, pkCount: 0, autoIncrement: new Set() };
    next[t].columns.add(r.COLUMN_NAME);
    if (r.COLUMN_KEY === 'PRI') { next[t].pkCount++; if (!next[t].primaryKey) next[t].primaryKey = r.COLUMN_NAME; }
    if (String(r.EXTRA).includes('auto_increment')) next[t].autoIncrement.add(r.COLUMN_NAME);
  }
  schema = next;
  return Object.keys(schema);
}

// ── Helpers ─────────────────────────────────────────────────
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// These tables are never accessible via the generic /api/:table routes
const BLOCKED_TABLES = new Set(['users']);

function getTable(name) {
  if (BLOCKED_TABLES.has(name)) throw new HttpError(403, `Table "${name}" is not accessible.`);
  const t = schema[name];
  if (!t) throw new HttpError(404, `Table "${name}" not found`);
  return t;
}

function requireSinglePk(table, name) {
  if (!table.primaryKey || table.pkCount !== 1)
    throw new HttpError(400, `Table "${name}" needs exactly one primary key`);
  return table.primaryKey;
}

function pickColumns(table, body) {
  const data = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (k === 'password_hash') continue;  // never writable via generic routes
    if (table.columns.has(k)) data[k] = v;
  }
  return data;
}

// ── Mount auth + admin routers ───────────────────────────────
app.use('/api/auth',  authRouter(pool));
app.use('/api/admin', adminRouter(pool));

// ── Health ───────────────────────────────────────────────────
app.get('/api/health', asyncHandler(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: DB_NAME, time: new Date().toISOString() });
}));

app.get('/api/tables', (_req, res) => {
  res.json(
    Object.entries(schema)
      .filter(([n]) => !BLOCKED_TABLES.has(n))
      .map(([n, t]) => ({ name: n, primaryKey: t.primaryKey, columns: [...t.columns] }))
  );
});

app.post('/api/schema/refresh', asyncHandler(async (_req, res) => {
  const tables = await loadSchema();
  res.json({ tables: tables.filter((t) => !BLOCKED_TABLES.has(t)) });
}));

// ── Generic read (public) ────────────────────────────────────
app.get('/api/:table', asyncHandler(async (req, res) => {
  const name  = req.params.table;
  const table = getTable(name);
  const { limit = 50, offset = 0, sort, order = 'asc', search, ...filters } = req.query;
  const safeLimit  = Math.min(Math.max(parseInt(limit, 10)  || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const where = []; const params = [];
  for (const [col, val] of Object.entries(filters))
    if (table.columns.has(col)) { where.push(`${pool.escapeId(col)} = ?`); params.push(val); }
  if (search) {
    const like = [...table.columns].map((c) => `${pool.escapeId(c)} LIKE ?`);
    if (like.length) { where.push(`(${like.join(' OR ')})`); like.forEach(() => params.push(`%${search}%`)); }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = sort && table.columns.has(sort)
    ? `ORDER BY ${pool.escapeId(sort)} ${String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`
    : '';
  const tSql = pool.escapeId(name);
  const [rows] = await pool.query(`SELECT * FROM ${tSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, [...params, safeLimit, safeOffset]);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${tSql} ${whereSql}`, params);
  res.json({ data: rows, total, limit: safeLimit, offset: safeOffset });
}));

app.get('/api/:table/:id', asyncHandler(async (req, res) => {
  const name  = req.params.table;
  const table = getTable(name);
  const pk    = requireSinglePk(table, name);
  const [rows] = await pool.query(
    `SELECT * FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(pk)} = ? LIMIT 1`, [req.params.id]
  );
  if (!rows.length) throw new HttpError(404, 'Record not found');
  res.json(rows[0]);
}));

// ── Generic write (protected) ────────────────────────────────
app.post('/api/:table', authMiddleware, asyncHandler(async (req, res) => {
  const name  = req.params.table;
  const table = getTable(name);
  const data  = pickColumns(table, req.body);
  if (!Object.keys(data).length) throw new HttpError(400, 'No valid columns provided');
  const [result] = await pool.query(`INSERT INTO ${pool.escapeId(name)} SET ?`, [data]);
  let created = { ...data };
  if (table.primaryKey && table.pkCount === 1) {
    const id = data[table.primaryKey] ?? result.insertId;
    const [rows] = await pool.query(`SELECT * FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(table.primaryKey)} = ? LIMIT 1`, [id]);
    if (rows.length) created = rows[0];
  }
  res.status(201).json(created);
}));

app.put('/api/:table/:id', authMiddleware, asyncHandler(async (req, res) => {
  const name  = req.params.table;
  const table = getTable(name);
  const pk    = requireSinglePk(table, name);
  const data  = pickColumns(table, req.body);
  delete data[pk];
  if (!Object.keys(data).length) throw new HttpError(400, 'No valid columns provided');
  const [result] = await pool.query(`UPDATE ${pool.escapeId(name)} SET ? WHERE ${pool.escapeId(pk)} = ?`, [data, req.params.id]);
  if (!result.affectedRows) throw new HttpError(404, 'Record not found');
  const [rows] = await pool.query(`SELECT * FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(pk)} = ? LIMIT 1`, [req.params.id]);
  res.json(rows[0]);
}));

app.delete('/api/:table/:id', authMiddleware, asyncHandler(async (req, res) => {
  const name  = req.params.table;
  const table = getTable(name);
  const pk    = requireSinglePk(table, name);
  const [result] = await pool.query(`DELETE FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(pk)} = ?`, [req.params.id]);
  if (!result.affectedRows) throw new HttpError(404, 'Record not found');
  res.json({ success: true });
}));

// ── Error handlers ───────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'ER_DUP_ENTRY' ? 409 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    error: err.status ? err.message : err.code === 'ER_DUP_ENTRY' ? 'Duplicate entry' : 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && status === 500 ? { detail: err.message } : {}),
  });
});

// ── Start ────────────────────────────────────────────────────
(async () => {
  try {
    await ensureTables();
    const tables = await loadSchema();
    console.log(`✓ MySQL "${DB_NAME}" @ ${DB_HOST}:${DB_PORT}`);
    console.log(`✓ Tables (${tables.length}): ${tables.join(', ') || 'none'}`);
    app.listen(PORT, () => console.log(`✓ Server → http://localhost:${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
})();

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
