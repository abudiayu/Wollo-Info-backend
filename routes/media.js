/**
 * Media routes — uses formidable for multipart parsing.
 * formidable is a pure-JS library, no native bindings needed.
 * Install: npm install formidable
 *
 * If formidable is not yet installed, the server will show a helpful message.
 */
const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const crypto         = require('crypto');
const authMiddleware = require('../middleware/authMiddleware');
const makeAdminOnly  = require('../middleware/adminOnly');

// Try to load formidable; if missing, provide a stub that returns a clear error
let formidable;
try {
  formidable = require('formidable');
} catch {
  formidable = null;
}

const BLOCKED_EXT = new Set([
  '.exe','.bat','.cmd','.sh','.msi','.ps1','.vbs','.jar','.com','.dll',
  '.php','.py','.rb','.pl','.cgi','.htaccess',
]);

const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/gif','image/webp','image/svg+xml']);
const MAX_IMAGE   = 5  * 1024 * 1024;  // 5 MB
const MAX_FILE    = 20 * 1024 * 1024;  // 20 MB

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

module.exports = function mediaRouter(pool) {
  const router    = express.Router();
  const adminOnly = makeAdminOnly(pool);
  const auth      = [authMiddleware, adminOnly];

  const PORT     = process.env.PORT || 5000;
  const BASE_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const buildUrl  = (stored) => `${BASE_URL}/uploads/${stored}`;
  const guessType = (mime)   => IMAGE_TYPES.has(mime) ? 'image' : 'file';

  /* ── POST /api/media/upload ── */
  router.post('/upload', auth, async (req, res) => {
    // If formidable isn't installed, return a helpful error
    if (!formidable) {
      return res.status(503).json({
        error: 'File upload requires "formidable". Run: npm install formidable  (in the backend folder)',
      });
    }

    // Parse multipart with formidable
    const form = formidable({
      uploadDir:        UPLOAD_DIR,
      keepExtensions:   true,
      maxFileSize:      MAX_FILE,
      maxTotalFileSize: MAX_FILE * 20,
      filename: (_name, ext) =>
        `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`,
      filter: ({ originalFilename }) => {
        const ext = path.extname(originalFilename || '').toLowerCase();
        return !BLOCKED_EXT.has(ext);
      },
    });

    let fields, files;
    try {
      [fields, files] = await form.parse(req);
    } catch (err) {
      return res.status(400).json({ error: 'Upload parse error: ' + err.message });
    }

    // formidable wraps files in arrays
    const fileList = Object.values(files).flat();
    if (!fileList.length) return res.status(400).json({ error: 'No valid files uploaded.' });

    const folderId = fields.folder_id?.[0] ? parseInt(fields.folder_id[0], 10) : null;
    const uploaded = [];

    try {
      for (const f of fileList) {
        const mime  = f.mimetype || '';
        const fsize = f.size     || 0;

        // Extra per-type size check
        if (IMAGE_TYPES.has(mime) && fsize > MAX_IMAGE) {
          fs.unlink(f.filepath, () => {});
          return res.status(400).json({ error: `Image "${f.originalFilename}" exceeds 5 MB.` });
        }

        const storedName = path.basename(f.filepath);
        const url        = buildUrl(storedName);

        const [r] = await pool.query(
          `INSERT INTO media (original_name, stored_name, mime_type, size, type, folder_id, url, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [f.originalFilename, storedName, mime, fsize, guessType(mime), folderId, url, req.user.id]
        );

        uploaded.push({
          id:            r.insertId,
          original_name: f.originalFilename,
          stored_name:   storedName,
          mime_type:     mime,
          size:          fsize,
          type:          guessType(mime),
          folder_id:     folderId,
          url,
        });
      }
      return res.status(201).json(uploaded);
    } catch (err) {
      console.error('Media upload DB error:', err);
      return res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
  });

  /* ── POST /api/media/folder ── */
  router.post('/folder', auth, async (req, res) => {
    const { name, parent_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Folder name is required.' });
    const [r] = await pool.query(
      'INSERT INTO media_folders (name, parent_id) VALUES (?, ?)',
      [name.trim(), parent_id || null]
    );
    return res.status(201).json({ id: r.insertId, name: name.trim(), parent_id: parent_id || null });
  });

  /* ── GET /api/media ── */
  router.get('/', auth, async (req, res) => {
    const { folder_id, type, search } = req.query;
    const where  = [];
    const params = [];

    if (folder_id !== undefined) {
      where.push(folder_id ? 'folder_id = ?' : 'folder_id IS NULL');
      if (folder_id) params.push(parseInt(folder_id, 10));
    }
    if (type)   { where.push('type = ?');             params.push(type); }
    if (search) { where.push('original_name LIKE ?'); params.push(`%${search}%`); }

    const [rows]    = await pool.query(
      `SELECT m.*, u.full_name AS uploader_name FROM media m
         LEFT JOIN users u ON u.id = m.uploaded_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY m.created_at DESC`,
      params
    );
    const [folders] = await pool.query('SELECT * FROM media_folders ORDER BY name');
    return res.json({ files: rows, folders });
  });

  /* ── DELETE /api/media/:id ── */
  router.delete('/:id', auth, async (req, res) => {
    const [[row]] = await pool.query('SELECT * FROM media WHERE id = ? LIMIT 1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Media not found.' });

    const fp = path.join(UPLOAD_DIR, row.stored_name);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);

    await pool.query('DELETE FROM media WHERE id = ?', [row.id]);
    return res.json({ success: true });
  });

  return router;
};
