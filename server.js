require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const {
  PORT = 5000,
  DB_HOST = 'localhost',
  DB_PORT = 3306,
  DB_USER = 'root',
  DB_PASSWORD = 'root',
  DB_NAME = 'wollo-info-hub',
  CORS_ORIGIN = '*',
} = process.env;

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '2mb' }));

// ---------- Database pool ----------
const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

// ---------- Schema introspection ----------
// schema = { tableName: { columns: Set<string>, primaryKey: string|null, pkCount: number, autoIncrement: Set<string> } }
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
    if (!next[t]) {
      next[t] = { columns: new Set(), primaryKey: null, pkCount: 0, autoIncrement: new Set() };
    }
    next[t].columns.add(r.COLUMN_NAME);
    if (r.COLUMN_KEY === 'PRI') {
      next[t].pkCount += 1;
      if (!next[t].primaryKey) next[t].primaryKey = r.COLUMN_NAME;
    }
    if (String(r.EXTRA).includes('auto_increment')) next[t].autoIncrement.add(r.COLUMN_NAME);
  }
  schema = next;
  return Object.keys(schema);
}

// ---------- Helpers ----------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getTable(name) {
  const table = schema[name];
  if (!table) throw new HttpError(404, `Table "${name}" not found`);
  return table;
}

function requireSinglePk(table, name) {
  if (!table.primaryKey || table.pkCount !== 1) {
    throw new HttpError(400, `Table "${name}" needs exactly one primary key column for this operation`);
  }
  return table.primaryKey;
}

function pickColumns(table, body) {
  const data = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (table.columns.has(key)) data[key] = value;
  }
  return data;
}

// ---------- Routes ----------
app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: DB_NAME, time: new Date().toISOString() });
  })
);

app.get('/api/tables', (_req, res) => {
  const out = Object.entries(schema).map(([name, t]) => ({
    name,
    primaryKey: t.primaryKey,
    columns: [...t.columns],
  }));
  res.json(out);
});

app.post(
  '/api/schema/refresh',
  asyncHandler(async (_req, res) => {
    const tables = await loadSchema();
    res.json({ tables });
  })
);

// List (supports ?limit=&offset=&sort=&order=&<column>=<value>&search=<text>)
app.get(
  '/api/:table',
  asyncHandler(async (req, res) => {
    const name = req.params.table;
    const table = getTable(name);

    const { limit = 50, offset = 0, sort, order = 'asc', search, ...filters } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const where = [];
    const params = [];

    for (const [col, val] of Object.entries(filters)) {
      if (table.columns.has(col)) {
        where.push(`${pool.escapeId(col)} = ?`);
        params.push(val);
      }
    }

    if (search) {
      const like = [...table.columns].map((c) => `${pool.escapeId(c)} LIKE ?`);
      if (like.length) {
        where.push(`(${like.join(' OR ')})`);
        like.forEach(() => params.push(`%${search}%`));
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let orderSql = '';
    if (sort && table.columns.has(sort)) {
      orderSql = `ORDER BY ${pool.escapeId(sort)} ${String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    }

    const tableSql = pool.escapeId(name);
    const [rows] = await pool.query(
      `SELECT * FROM ${tableSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      [...params, safeLimit, safeOffset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM ${tableSql} ${whereSql}`,
      params
    );

    res.json({ data: rows, total, limit: safeLimit, offset: safeOffset });
  })
);

// Get one
app.get(
  '/api/:table/:id',
  asyncHandler(async (req, res) => {
    const name = req.params.table;
    const table = getTable(name);
    const pk = requireSinglePk(table, name);

    const [rows] = await pool.query(
      `SELECT * FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(pk)} = ? LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) throw new HttpError(404, 'Record not found');
    res.json(rows[0]);
  })
);

// Create
app.post(
  '/api/:table',
  asyncHandler(async (req, res) => {
    const name = req.params.table;
    const table = getTable(name);
    const data = pickColumns(table, req.body);

    if (!Object.keys(data).length) throw new HttpError(400, 'No valid columns provided');

    const [result] = await pool.query(`INSERT INTO ${pool.escapeId(name)} SET ?`, [data]);

    let created = { ...data };
    if (table.primaryKey && table.pkCount === 1) {
      const id = data[table.primaryKey] ?? result.insertId;
      const [rows] = await pool.query(
        `SELECT * FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(table.primaryKey)} = ? LIMIT 1`,
        [id]
      );
      if (rows.length) created = rows[0];
    }
    res.status(201).json(created);
  })
);

// Update
app.put(
  '/api/:table/:id',
  asyncHandler(async (req, res) => {
    const name = req.params.table;
    const table = getTable(name);
    const pk = requireSinglePk(table, name);
    const data = pickColumns(table, req.body);
    delete data[pk];

    if (!Object.keys(data).length) throw new HttpError(400, 'No valid columns provided');

    const [result] = await pool.query(
      `UPDATE ${pool.escapeId(name)} SET ? WHERE ${pool.escapeId(pk)} = ?`,
      [data, req.params.id]
    );
    if (!result.affectedRows) throw new HttpError(404, 'Record not found');

    const [rows] = await pool.query(
      `SELECT * FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(pk)} = ? LIMIT 1`,
      [req.params.id]
    );
    res.json(rows[0]);
  })
);

// Delete
app.delete(
  '/api/:table/:id',
  asyncHandler(async (req, res) => {
    const name = req.params.table;
    const table = getTable(name);
    const pk = requireSinglePk(table, name);

    const [result] = await pool.query(
      `DELETE FROM ${pool.escapeId(name)} WHERE ${pool.escapeId(pk)} = ?`,
      [req.params.id]
    );
    if (!result.affectedRows) throw new HttpError(404, 'Record not found');
    res.json({ success: true });
  })
);

// ---------- Errors ----------
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'ER_DUP_ENTRY' ? 409 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    error: err.status ? err.message : err.code === 'ER_DUP_ENTRY' ? 'Duplicate entry' : 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && status === 500 ? { detail: err.message } : {}),
  });
});

// ---------- Start ----------
(async () => {
  try {
    const tables = await loadSchema();
    console.log(`Connected to MySQL "${DB_NAME}" at ${DB_HOST}:${DB_PORT}`);
    console.log(`Tables found (${tables.length}): ${tables.join(', ') || 'none'}`);
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (err) {
    console.error('Failed to connect to the database:', err.message);
    console.error('Check that MAMP is running and your .env credentials are correct.');
    process.exit(1);
  }
})();

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});