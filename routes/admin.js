const express        = require('express');
const bcrypt         = require('bcryptjs');
const authMiddleware = require('../middleware/authMiddleware');
const makeAdminOnly  = require('../middleware/adminOnly');

module.exports = function adminRouter(pool) {
  const router    = express.Router();
  const adminOnly = makeAdminOnly(pool);

  // All routes: verify JWT then verify admin role from DB
  router.use(authMiddleware, adminOnly);

  /* safe row — never expose password_hash */
  const safe = (row) => ({
    id:         row.id,
    full_name:  row.full_name,
    email:      row.email,
    avatar_url: row.avatar_url || null,
    role:       row.role || 'user',
    created_at: row.created_at,
  });

  /* ──────────────────────────────────────────
     GET /api/admin/users
     Reads everything from the single `users` table.
     Supports optional ?role= filter.
     ────────────────────────────────────────── */
  router.get('/users', async (req, res) => {
    try {
      const roleFilter = req.query.role;

      let sql    = `SELECT id, full_name, email, avatar_url, role, created_at FROM users`;
      const params = [];

      if (roleFilter) {
        sql += ' WHERE role = ?';
        params.push(roleFilter);
      }

      sql += ' ORDER BY created_at DESC';

      const [rows] = await pool.query(sql, params);
      return res.json(rows.map(safe));
    } catch (err) {
      console.error('Admin GET /users error:', err);
      return res.status(500).json({ error: 'Failed to fetch users.' });
    }
  });

  /* ──────────────────────────────────────────
     PUT /api/admin/users/:id
     Updates full_name and/or password in `users`.
     ────────────────────────────────────────── */
  router.put('/users/:id', async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({ error: 'Invalid user ID.' });
      }

      const { full_name, password } = req.body;

      if (!full_name && !password) {
        return res.status(400).json({ error: 'Provide full_name and/or password.' });
      }
      if (full_name !== undefined && !String(full_name).trim()) {
        return res.status(400).json({ error: 'Name cannot be empty.' });
      }
      if (password !== undefined && String(password).length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const fields = [];
      const values = [];

      if (full_name) {
        fields.push('full_name = ?');
        values.push(String(full_name).trim());
      }
      if (password) {
        fields.push('password_hash = ?');
        values.push(await bcrypt.hash(password, 12));
      }

      values.push(userId);

      const [result] = await pool.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      if (!result.affectedRows) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const [[updated]] = await pool.query(
        `SELECT id, full_name, email, avatar_url, role, created_at
           FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );

      return res.json(safe(updated));
    } catch (err) {
      console.error('Admin PUT /users/:id error:', err);
      return res.status(500).json({ error: 'Failed to update user.' });
    }
  });

  return router;
};
