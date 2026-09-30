const express        = require('express');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const authMiddleware = require('../middleware/authMiddleware');

module.exports = function authRouter(pool) {
  const router = express.Router();

  /* ── helpers ── */
  const sign = (user) =>
    jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

  const safe = (row) => ({
    id:         row.id,
    full_name:  row.full_name,
    email:      row.email,
    avatar_url: row.avatar_url || null,
    role:       row.role || 'user',
    created_at: row.created_at,
  });

  /* ── POST /api/auth/register ── */
  router.post('/register', async (req, res) => {
    try {
      const { full_name, email, password } = req.body;

      if (!full_name?.trim())  return res.status(400).json({ error: 'Full name is required.' });
      if (!email?.trim())      return res.status(400).json({ error: 'Email is required.' });
      if (!password)           return res.status(400).json({ error: 'Password is required.' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      const normalEmail = email.trim().toLowerCase();

      const [[existing]] = await pool.query(
        'SELECT id FROM users WHERE email = ? LIMIT 1', [normalEmail]
      );
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const password_hash = await bcrypt.hash(password, 12);
      const [result] = await pool.query(
        'INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)',
        [full_name.trim(), normalEmail, password_hash]
      );

      const [[row]] = await pool.query(
        'SELECT * FROM users WHERE id = ? LIMIT 1', [result.insertId]
      );

      return res.status(201).json({ token: sign(row), user: safe(row) });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      console.error('Register error:', err);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  });

  /* ── POST /api/auth/login ── */
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email?.trim()) return res.status(400).json({ error: 'Email is required.' });
      if (!password)      return res.status(400).json({ error: 'Password is required.' });

      const [[row]] = await pool.query(
        'SELECT * FROM users WHERE email = ? LIMIT 1',
        [email.trim().toLowerCase()]
      );
      if (!row) return res.status(401).json({ error: 'Invalid email or password.' });

      const match = await bcrypt.compare(password, row.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[login] ${row.email} → role="${row.role}" id=${row.id}`);
      }

      return res.json({ token: sign(row), user: safe(row) });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  });

  /* ── GET /api/auth/me ── */
  router.get('/me', authMiddleware, async (req, res) => {
    try {
      const [[row]] = await pool.query(
        'SELECT * FROM users WHERE id = ? LIMIT 1', [req.user.id]
      );
      if (!row) return res.status(404).json({ error: 'Account not found.' });
      return res.json(safe(row));
    } catch (err) {
      console.error('Me error:', err);
      return res.status(500).json({ error: 'Could not fetch user.' });
    }
  });

  return router;
};
