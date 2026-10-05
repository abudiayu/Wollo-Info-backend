/**
 * routes/departmentReviews.js
 *
 * Express routes for department ratings and reviews.
 *
 * Mount in server.js:
 *   const reviewsRouter = require('./routes/departmentReviews');
 *   app.use('/api/departments', reviewsRouter(pool));
 *
 * Endpoints
 * ─────────
 *   GET  /api/departments/:id/reviews
 *   POST /api/departments/:id/reviews
 *
 * DB table (create once):
 * ─────────────────────────────────────────────────────────────────
 *   CREATE TABLE IF NOT EXISTS department_reviews (
 *     id            INT          NOT NULL AUTO_INCREMENT,
 *     department_id VARCHAR(100) NOT NULL,
 *     name          VARCHAR(120) NOT NULL,
 *     role          VARCHAR(20)  NOT NULL DEFAULT 'Student',
 *     rating        TINYINT      NOT NULL,
 *     comment       TEXT         NOT NULL,
 *     created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
 *     PRIMARY KEY (id),
 *     KEY idx_dept (department_id),
 *     KEY idx_created (created_at)
 *   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
 * ─────────────────────────────────────────────────────────────────
 */

const express = require('express');

const VALID_ROLES = ['Student', 'Graduate', 'Visitor'];

module.exports = function reviewsRouter(pool) {
  const router = express.Router();

  /* ───────────────────────────────────────────────────
     GET /api/departments/:id/reviews
     Returns all reviews for a department, newest first.
  ─────────────────────────────────────────────────── */
  router.get('/:id/reviews', async (req, res) => {
    try {
      const deptId = req.params.id;

      const [rows] = await pool.query(
        `SELECT
           id,
           name,
           role,
           rating,
           comment,
           DATE_FORMAT(created_at, '%b %Y') AS date
         FROM department_reviews
         WHERE department_id = ?
         ORDER BY created_at DESC
         LIMIT 200`,
        [deptId]
      );

      return res.json({ reviews: rows });
    } catch (err) {
      console.error('[GET reviews]', err);
      return res.status(500).json({ error: 'Failed to load reviews.' });
    }
  });

  /* ───────────────────────────────────────────────────
     POST /api/departments/:id/reviews
     Body: { name, role, rating, comment }
  ─────────────────────────────────────────────────── */
  router.post('/:id/reviews', async (req, res) => {
    try {
      const deptId = req.params.id;
      const { name, role = 'Student', rating, comment } = req.body;

      /* ── Validation ── */
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Name is required.' });
      }
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}.` });
      }
      const ratingNum = Number(rating);
      if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
      }
      const trimmedComment = String(comment ?? '').trim();
      if (trimmedComment.length < 10) {
        return res.status(400).json({ error: 'Comment must be at least 10 characters.' });
      }
      if (trimmedComment.length > 1000) {
        return res.status(400).json({ error: 'Comment must be 1000 characters or fewer.' });
      }

      /* ── Insert ── */
      const [result] = await pool.query(
        `INSERT INTO department_reviews (department_id, name, role, rating, comment)
         VALUES (?, ?, ?, ?, ?)`,
        [deptId, String(name).trim().slice(0, 120), role, ratingNum, trimmedComment]
      );

      /* Return the created review so the frontend can prepend it instantly */
      const [[created]] = await pool.query(
        `SELECT
           id,
           name,
           role,
           rating,
           comment,
           DATE_FORMAT(created_at, '%b %Y') AS date
         FROM department_reviews
         WHERE id = ? LIMIT 1`,
        [result.insertId]
      );

      return res.status(201).json({ review: created });
    } catch (err) {
      console.error('[POST review]', err);
      return res.status(500).json({ error: 'Failed to save review.' });
    }
  });

  return router;
};
