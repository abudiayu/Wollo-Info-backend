const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const departmentHeadOnly = require('../middleware/departmentHeadOnly');

// Usage in server.js:
//   app.use('/api/department-head', require('./routes/departmentHead')(db));
// `db` must be a mysql2/promise pool.
module.exports = function (db) {
  const router = express.Router();
  const CONTENT_TYPES = ['opportunity', 'motivation', 'document'];

  // ---------- Login ----------
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
      }
      const normalEmail = String(email).trim().toLowerCase();
      const [rows] = await db.query('SELECT * FROM department_heads WHERE email = ?', [normalEmail]);
      const head = rows[0];
      if (!head || !(await bcrypt.compare(password, head.password_hash))) {
        return res.status(401).json({ message: 'Wrong email or password.' });
      }
      const token = jwt.sign(
        { id: head.id, role: 'department_head', department_id: head.department_id },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );
      res.json({ token, name: head.name });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  // Everything below needs a department head token
  router.use(departmentHeadOnly);

  // ---------- Profile + department ----------
  router.get('/me', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT h.id, h.name, h.email, d.id AS department_id, d.name AS department_name,
                d.description, d.graduates_count, d.duration_years
         FROM department_heads h JOIN departments d ON d.id = h.department_id
         WHERE h.id = ?`,
        [req.head.id]
      );
      if (!rows[0]) return res.status(404).json({ message: 'Account not found.' });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  router.put('/department', async (req, res) => {
    try {
      const { description, graduates_count, duration_years } = req.body;
      await db.query(
        'UPDATE departments SET description = ?, graduates_count = ?, duration_years = ? WHERE id = ?',
        [description || '', Number(graduates_count) || 0, Number(duration_years) || 4, req.head.department_id]
      );
      res.json({ message: 'Department info saved.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  // ---------- Stats ----------
  router.get('/stats', async (req, res) => {
    try {
      const d = req.head.department_id;
      const [[s]] = await db.query('SELECT COUNT(*) AS n FROM department_interests WHERE department_id = ?', [d]);
      const [[c]] = await db.query('SELECT COUNT(*) AS n FROM department_courses WHERE department_id = ?', [d]);
      const [[o]] = await db.query('SELECT COUNT(*) AS n FROM department_content WHERE department_id = ?', [d]);
      res.json({ students: s.n, courses: c.n, content: o.n });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  // ---------- Courses ----------
  router.get('/courses', async (req, res) => {
    try {
      const [rows] = await db.query(
        'SELECT id, course_name, prerequisites FROM department_courses WHERE department_id = ? ORDER BY id',
        [req.head.department_id]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  router.post('/courses', async (req, res) => {
    try {
      const { course_name, prerequisites } = req.body;
      if (!course_name || !course_name.trim()) {
        return res.status(400).json({ message: 'Course name is required.' });
      }
      const [r] = await db.query(
        'INSERT INTO department_courses (department_id, course_name, prerequisites) VALUES (?, ?, ?)',
        [req.head.department_id, course_name.trim(), (prerequisites || '').trim()]
      );
      res.status(201).json({ id: r.insertId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  router.put('/courses/:id', async (req, res) => {
    try {
      const { course_name, prerequisites } = req.body;
      if (!course_name || !course_name.trim()) {
        return res.status(400).json({ message: 'Course name is required.' });
      }
      const [r] = await db.query(
        'UPDATE department_courses SET course_name = ?, prerequisites = ? WHERE id = ? AND department_id = ?',
        [course_name.trim(), (prerequisites || '').trim(), req.params.id, req.head.department_id]
      );
      if (!r.affectedRows) return res.status(404).json({ message: 'Course not found.' });
      res.json({ message: 'Course updated.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  router.delete('/courses/:id', async (req, res) => {
    try {
      const [r] = await db.query(
        'DELETE FROM department_courses WHERE id = ? AND department_id = ?',
        [req.params.id, req.head.department_id]
      );
      if (!r.affectedRows) return res.status(404).json({ message: 'Course not found.' });
      res.json({ message: 'Course deleted.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  // ---------- Interested students ----------
  // Assumes your students live in the `users` table (id, name, email).
  router.get('/students', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT u.id, u.full_name AS name, u.email, i.created_at
         FROM department_interests i JOIN users u ON u.id = i.student_id
         WHERE i.department_id = ? ORDER BY i.created_at DESC`,
        [req.head.department_id]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  // ---------- Content: opportunities, motivation, documents ----------
  router.get('/content', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT id, type, title, body, link_url, created_at FROM department_content
         WHERE department_id = ? ORDER BY created_at DESC`,
        [req.head.department_id]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  router.post('/content', async (req, res) => {
    try {
      const { type, title, body, link_url } = req.body;
      if (!CONTENT_TYPES.includes(type)) return res.status(400).json({ message: 'Invalid content type.' });
      if (!title || !title.trim()) return res.status(400).json({ message: 'Title is required.' });
      const [r] = await db.query(
        'INSERT INTO department_content (department_id, head_id, type, title, body, link_url) VALUES (?, ?, ?, ?, ?, ?)',
        [req.head.department_id, req.head.id, type, title.trim(), body || '', link_url || '']
      );
      res.status(201).json({ id: r.insertId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  router.delete('/content/:id', async (req, res) => {
    try {
      const [r] = await db.query(
        'DELETE FROM department_content WHERE id = ? AND department_id = ?',
        [req.params.id, req.head.department_id]
      );
      if (!r.affectedRows) return res.status(404).json({ message: 'Item not found.' });
      res.json({ message: 'Item deleted.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error.' });
    }
  });

  return router;
};