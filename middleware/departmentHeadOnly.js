const jwt = require('jsonwebtoken');

// Verifies the Bearer token and allows only department heads.
// Sets req.head = { id, department_id, role }.
module.exports = function departmentHeadOnly(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Please log in.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'department_head') {
      return res.status(403).json({ message: 'Department head access required.' });
    }
    req.head = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
};
