/**
 * Media routes — uses multer (already in package.json) for multipart parsing.
 */
const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const crypto         = require('crypto');
const multer         = require('multer');
const authMiddleware = require('../middleware/authMiddleware');
const makeAdminOnly  = require('../middleware/adminOnly');

const BLOCKED_EXT = new Set([
  '.exe','.bat','.cmd','.sh','.msi','.ps1','.vbs','.jar','.com','.dll',
  '.php','.py','.rb','.pl','.cgi','.htaccess',
]);

const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/gif','image/webp','image/svg+xml']);
const MAX_IMAGE   = 5  * 1024 * 1024;  // 5 MB
const MAX_FILE    = 20 * 1024 * 1024;  // 20 MB

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ── multer storage: random filename, keep extension ── */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) return cb(new Error(`File type "${ext}" is not allowed.`));
    cb(null, true);
  },
});

module.exports = function mediaRouter(pool) {
  const router    = express.Router();
  const adminOnly = makeAdminOnly(pool);
  const auth      = [authMiddleware, adminOnly];

  const PORT     = process.env.PORT || 5000;
  const BASE_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
  const buildUrl  = (stored) => `${BASE_URL}/uploads/${stored}`;
  const guessType = (mime)   => IMAGE_TYPES.has(mime) ? 'image' : 'file';

  /* ── POST /api/media/upload ── */
  router.post('/upload', auth, (req, res) => {
    // multer processes the multipart body
    upload.array('files', 50)(req, res, async (err) => {
      if (err) {
        // multer size error
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File exceeds the 20 MB limit.' });
        }
        return res.status(400).json({ error: err.message || 'Upload failed.' });
      }

      const fileList = req.files || [];
      if (!fileList.length) {
        return res.status(400).json({ error: 'No valid files uploaded.' });
      }

      const folderId = req.body.folder_id ? parseInt(req.body.folder_id, 10) : null;
      const uploaded = [];

      try {
        for (const f of fileList) {
          const mime  = f.mimetype || '';
          const fsize = f.size     || 0;

          // Extra per-type size check for images
          if (IMAGE_TYPES.has(mime) && fsize > MAX_IMAGE) {
            fs.unlink(f.path, () => {});
            return res.status(400).json({
              error: `Image "${f.originalname}" exceeds the 5 MB limit.`,
            });
          }

          const storedName = f.filename;
          const url        = buildUrl(storedName);

          const [r] = await pool.query(
            `INSERT INTO media (original_name, stored_name, mime_type, size, type, folder_id, url, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [f.originalname, storedName, mime, fsize, guessType(mime), folderId, url, req.user.id]
          );

          uploaded.push({
            id:            r.insertId,
            original_name: f.originalname,
            stored_name:   storedName,
            mime_type:     mime,
            size:          fsize,
            type:          guessType(mime),
            folder_id:     folderId,
            url,
          });
        }
        return res.status(201).json(uploaded);
      } catch (dbErr) {
        console.error('Media upload DB error:', dbErr);
        return res.status(500).json({ error: 'Upload failed: ' + dbErr.message });
      }
    });
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
