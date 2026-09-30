const jwt = require('jsonwebtoken');

/**
 * Verifies Bearer token, attaches decoded payload to req.user.
 * Returns specific 401 messages so the frontend can act on them.
 */
module.exports = function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Not logged in. Please sign in first.' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);

    if (process.env.NODE_ENV !== 'production') {
      console.log('[authMiddleware] decoded user:', {
        id:    req.user.id,
        email: req.user.email,
        role:  req.user.role,
      });
    }

    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Token expired. Please sign in again.'
      : 'Invalid token. Please sign in again.';
    return res.status(401).json({ error: msg });
  }
};
