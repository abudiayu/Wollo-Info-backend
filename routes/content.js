const express        = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const makeAdminOnly  = require('../middleware/adminOnly');

// Basic HTML sanitiser — strips dangerous tags/attrs without a heavy dep.
// If you install sanitize-html, replace this function with sanitizeHtml(body, opts).
function sanitizeBody(raw) {
  if (!raw) return '';
  // Remove script/style/iframe/object/embed tags and on* attributes
  return raw
    .replace(/<(script|style|iframe|object|embed|base|form|input|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|base|input)[^>]*\/>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

module.exports = function contentRouter(pool) {
  const router    = express.Router();
  const adminOnly = makeAdminOnly(pool);
  const auth      = [authMiddleware, adminOnly];

  /* ── GET /api/content?section_id=&status= ── */
  router.get('/', auth, async (req, res) => {
    const { section_id, status, search } = req.query;
    const where  = [];
    const params = [];

    if (section_id) { where.push('ci.section_id = ?'); params.push(parseInt(section_id, 10)); }
    if (status)     { where.push('ci.status = ?');     params.push(status); }
    if (search)     { where.push('ci.title LIKE ?');   params.push(`%${search}%`); }

    const sql = `
      SELECT ci.*, s.slug AS section_slug, s.title AS section_title,
             u.full_name AS author_name,
             m.url AS cover_url
        FROM content_items ci
        JOIN sections s ON s.id = ci.section_id
        JOIN users u    ON u.id = ci.created_by
        LEFT JOIN media m ON m.id = ci.cover_media_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ci.sort_order ASC, ci.updated_at DESC
    `;
    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  });

  /* ── GET /api/content/:id ── */
  router.get('/:id', auth, async (req, res) => {
    const [[row]] = await pool.query(
      `SELECT ci.*, s.slug AS section_slug, m.url AS cover_url
         FROM content_items ci
         JOIN sections s ON s.id = ci.section_id
         LEFT JOIN media m ON m.id = ci.cover_media_id
         WHERE ci.id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Content not found.' });

    // gallery
    const [gallery] = await pool.query(
      `SELECT m.* FROM content_media cm JOIN media m ON m.id = cm.media_id
        WHERE cm.content_id = ? ORDER BY cm.sort_order`,
      [row.id]
    );
    row.gallery = gallery;
    return res.json(row);
  });

  /* ── POST /api/content ── */
  router.post('/', auth, async (req, res) => {
    const { section_id, title, body, status = 'draft', cover_media_id, sort_order = 0, gallery } = req.body;
    if (!section_id) return res.status(400).json({ error: 'section_id is required.' });
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });

    const safeBody = sanitizeBody(body);

    const [r] = await pool.query(
      `INSERT INTO content_items (section_id, title, body, status, cover_media_id, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [section_id, title.trim(), safeBody, status, cover_media_id || null, sort_order, req.user.id]
    );
    const id = r.insertId;

    // save version snapshot
    await pool.query(
      'INSERT INTO content_versions (content_id, title, body, edited_by) VALUES (?, ?, ?, ?)',
      [id, title.trim(), safeBody, req.user.id]
    );

    // gallery items
    if (Array.isArray(gallery)) {
      for (let i = 0; i < gallery.length; i++) {
        await pool.query(
          'INSERT IGNORE INTO content_media (content_id, media_id, sort_order) VALUES (?, ?, ?)',
          [id, gallery[i], i]
        );
      }
    }

    const [[created]] = await pool.query('SELECT * FROM content_items WHERE id = ? LIMIT 1', [id]);
    return res.status(201).json(created);
  });

  /* ── PUT /api/content/:id ── */
  router.put('/:id', auth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const [[existing]] = await pool.query('SELECT id FROM content_items WHERE id = ? LIMIT 1', [id]);
    if (!existing) return res.status(404).json({ error: 'Content not found.' });

    const { title, body, status, cover_media_id, sort_order, gallery } = req.body;
    const safeBody = sanitizeBody(body);

    const fields  = [];
    const values  = [];
    if (title !== undefined)          { fields.push('title = ?');          values.push(title.trim()); }
    if (body  !== undefined)          { fields.push('body = ?');            values.push(safeBody); }
    if (status !== undefined)         { fields.push('status = ?');          values.push(status); }
    if (cover_media_id !== undefined) { fields.push('cover_media_id = ?');  values.push(cover_media_id || null); }
    if (sort_order !== undefined)     { fields.push('sort_order = ?');      values.push(sort_order); }

    if (fields.length) {
      values.push(id);
      await pool.query(`UPDATE content_items SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    // version snapshot on every save
    const snap = title ?? (await pool.query('SELECT title, body FROM content_items WHERE id=? LIMIT 1', [id]))[0][0].title;
    await pool.query(
      'INSERT INTO content_versions (content_id, title, body, edited_by) VALUES (?, ?, ?, ?)',
      [id, snap, safeBody ?? '', req.user.id]
    );

    // replace gallery
    if (Array.isArray(gallery)) {
      await pool.query('DELETE FROM content_media WHERE content_id = ?', [id]);
      for (let i = 0; i < gallery.length; i++) {
        await pool.query(
          'INSERT IGNORE INTO content_media (content_id, media_id, sort_order) VALUES (?, ?, ?)',
          [id, gallery[i], i]
        );
      }
    }

    const [[updated]] = await pool.query('SELECT * FROM content_items WHERE id = ? LIMIT 1', [id]);
    return res.json(updated);
  });

  /* ── PATCH /api/content/:id/publish ── */
  router.patch('/:id/publish', auth, async (req, res) => {
    await pool.query(
      "UPDATE content_items SET status = 'published', published_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    return res.json({ success: true, status: 'published' });
  });

  /* ── PATCH /api/content/:id/unpublish ── */
  router.patch('/:id/unpublish', auth, async (req, res) => {
    await pool.query(
      "UPDATE content_items SET status = 'draft', published_at = NULL WHERE id = ?",
      [req.params.id]
    );
    return res.json({ success: true, status: 'draft' });
  });

  /* ── DELETE /api/content/:id ── */
  router.delete('/:id', auth, async (req, res) => {
    const [r] = await pool.query('DELETE FROM content_items WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Content not found.' });
    return res.json({ success: true });
  });

  /* ── GET /api/content/:id/versions ── */
  router.get('/:id/versions', auth, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT cv.*, u.full_name AS editor_name
         FROM content_versions cv
         JOIN users u ON u.id = cv.edited_by
         WHERE cv.content_id = ?
         ORDER BY cv.created_at DESC`,
      [req.params.id]
    );
    return res.json(rows);
  });

  /* ── POST /api/content/:id/restore/:versionId ── */
  router.post('/:id/restore/:versionId', auth, async (req, res) => {
    const [[ver]] = await pool.query(
      'SELECT * FROM content_versions WHERE id = ? AND content_id = ? LIMIT 1',
      [req.params.versionId, req.params.id]
    );
    if (!ver) return res.status(404).json({ error: 'Version not found.' });

    await pool.query(
      "UPDATE content_items SET title = ?, body = ?, status = 'draft' WHERE id = ?",
      [ver.title, ver.body, req.params.id]
    );
    return res.json({ success: true, restored: ver });
  });

  return router;
};
