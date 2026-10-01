/**
 * adminOnly — runs AFTER authMiddleware.
 * Reads the role directly from the users table so stale tokens are ignored.
 */
module.exports = function makeAdminOnly(pool) {
  return async function adminOnly(req, res, next) {
    try {
      const [[user]] = await pool.query(
        'SELECT id, role FROM users WHERE id = ? LIMIT 1',
        [req.user.id]
      );
      if (!user) return res.status(403).json({ error: 'Account not found.' });

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[adminOnly] id=${req.user.id} DB role="${user.role}"`);
      }

      if (user.role !== 'admin') {
        return res.status(403).json({
          error: 'Admin access required.',
          detail: `Your account role is "${user.role}".`,
        });
      }

      req.user.role = 'admin';
      next();
    } catch (err) {
      console.error('[adminOnly] DB error:', err.message);
      return res.status(500).json({ error: 'Could not verify admin role.' });
    }
  };
};
