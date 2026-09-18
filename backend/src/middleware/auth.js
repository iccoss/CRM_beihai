const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../database');
const { VALID_ROLES } = require('./role-policy');

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const databasePath = process.env.CRM_DB_PATH || path.join(__dirname, '../../../database/crm.db');
  const secretPath = path.join(path.dirname(databasePath), '.jwt-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();

  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

const JWT_SECRET = loadJwtSecret();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未授权访问' });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(`
      SELECT id, username, name, role, status
      FROM users WHERE id = ?
    `).get(decoded.id);
    if (!user || user.status !== 'active' || !VALID_ROLES.includes(user.role)) {
      return res.status(401).json({ error: '账号不存在或已被禁用，请重新登录' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token 无效或已过期' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole, JWT_SECRET };
