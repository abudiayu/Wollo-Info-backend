/**
 * Public read-only routes — no auth required.
 * Only returns published content.
 */
const express = require('express');

module.exports = function publicRouter(pool) {
  const router = express.Router();

  /* GET /api/public/sections/:slug */
  router.get('/sections/:slug', async (req, res) => {
    const { slug } = req.params;

    const [[section]] = await pool.query(
      'SELECT * FROM sections WHERE slug = ? LIMIT 1', [slug]
    );
    if (!section) return res.status(404).json({ error: `Section "${slug}" not found.` });

    const [items] = await pool.query(
      `SELECT ci.id, ci.title, ci.body, ci.published_at, ci.sort_order,
              m.url AS cover_url, m.original_name AS cover_name
         FROM content_items ci
         LEFT JOIN media m ON m.id = ci.cover_media_id
         WHERE ci.section_id = ? AND ci.status = 'published'
         ORDER BY ci.sort_order ASC, ci.published_at DESC`,
      [section.id]
    );

    // attach gallery to each item
    for (const item of items) {
      const [gallery] = await pool.query(
        `SELECT m.id, m.url, m.original_name, m.mime_type, m.type
           FROM content_media cm
           JOIN media m ON m.id = cm.media_id
           WHERE cm.content_id = ?
           ORDER BY cm.sort_order`,
        [item.id]
      );
      item.gallery = gallery;
    }

    return res.json({ section, items });
  });

  return router;
};
