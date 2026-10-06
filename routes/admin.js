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

  /* ──────────────────────────────────────────
     PATCH /api/admin/users/:id/role
     Promotes or demotes a user's role.
     Admins cannot demote themselves.
     ────────────────────────────────────────── */
  router.patch('/users/:id/role', async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({ error: 'Invalid user ID.' });
      }

      const { role } = req.body;
      const allowed = ['user', 'staff', 'admin'];
      if (!role || !allowed.includes(role)) {
        return res.status(400).json({ error: `Role must be one of: ${allowed.join(', ')}.` });
      }

      // Prevent admin from demoting themselves
      if (String(req.user.id) === String(userId) && role !== 'admin') {
        return res.status(403).json({ error: 'You cannot change your own role.' });
      }

      const [result] = await pool.query(
        'UPDATE users SET role = ? WHERE id = ?',
        [role, userId]
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
      console.error('Admin PATCH /users/:id/role error:', err);
      return res.status(500).json({ error: 'Failed to update role.' });
    }
  });

  /* ──────────────────────────────────────────
     DELETE /api/admin/users/:id
     Permanently deletes a user account.
     Admins cannot delete themselves.
     ────────────────────────────────────────── */
  router.delete('/users/:id', async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({ error: 'Invalid user ID.' });
      }

      // Prevent self-deletion
      if (String(req.user.id) === String(userId)) {
        return res.status(403).json({ error: 'You cannot delete your own account.' });
      }

      const [result] = await pool.query('DELETE FROM users WHERE id = ?', [userId]);

      if (!result.affectedRows) {
        return res.status(404).json({ error: 'User not found.' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE /users/:id error:', err);
      return res.status(500).json({ error: 'Failed to delete user.' });
    }
  });

  /* ──────────────────────────────────────────
     GET /api/admin/staff
     Returns a unified list of:
       • users with role = 'staff'
       • all rows from department_heads (joined with departments)
     Both are normalised into the same shape so the frontend
     can display them in one table.
     ────────────────────────────────────────── */
  router.get('/staff', async (req, res) => {
    try {
      /* Staff rows from the users table */
      const [staffUsers] = await pool.query(
        `SELECT id, full_name AS name, email, avatar_url, role,
                NULL AS department_name, created_at
           FROM users
          WHERE role = 'staff'
          ORDER BY created_at DESC`
      );

      /* Department heads from the separate table */
      const [deptHeads] = await pool.query(
        `SELECT dh.id, dh.name, dh.email, NULL AS avatar_url,
                'dept_head' AS role,
                d.name AS department_name, dh.created_at
           FROM department_heads dh
           LEFT JOIN departments d ON d.id = dh.department_id
          ORDER BY dh.created_at DESC`
      );

      /* Tag the source so the frontend can show different badges */
      const result = [
        ...staffUsers.map(r => ({ ...r, source: 'users' })),
        ...deptHeads.map(r => ({ ...r, source: 'department_heads' })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      return res.json(result);
    } catch (err) {
      console.error('Admin GET /staff error:', err);
      return res.status(500).json({ error: 'Failed to fetch staff.' });
    }
  });

  /* ──────────────────────────────────────────
     DELETE /api/admin/staff/dept-head/:id
     Removes a department head account.
     ────────────────────────────────────────── */
  router.delete('/staff/dept-head/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const [result] = await pool.query('DELETE FROM department_heads WHERE id = ?', [id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'Not found.' });
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE /staff/dept-head/:id error:', err);
      return res.status(500).json({ error: 'Failed to delete.' });
    }
  });

  return router;
};
