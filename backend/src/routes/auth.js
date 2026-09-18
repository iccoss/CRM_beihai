const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../database');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// 用户注册
router.post('/register', (req, res) => {
  res.status(403).json({ error: '系统不开放自助注册，请联系系统管理员创建账号' });
});

// 用户登录
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 更新最后登录时间
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    // 生成 token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        email: user.email,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取当前用户信息
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, name, role, email, phone, department_id, status FROM users WHERE id = ?').get(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ user });
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 修改密码
router.post('/change-password', authMiddleware, (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '旧密码和新密码不能为空' });
    }

    if (newPassword.length < 6 || newPassword.length > 18) {
      return res.status(400).json({ error: '密码长度必须在 6-18 位之间' });
    }
    let types = 0;
    if (/[a-z]/.test(newPassword)) types++;
    if (/[A-Z]/.test(newPassword)) types++;
    if (/[0-9]/.test(newPassword)) types++;
    if (/[^a-zA-Z0-9]/.test(newPassword)) types++;
    if (types < 3) {
      return res.status(400).json({ error: '密码必须包含小写字母、大写字母、数字、特殊字符中的至少 3 种' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    
    const validPassword = bcrypt.compareSync(oldPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: '旧密码错误' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, req.user.id);

    res.json({ message: '密码修改成功' });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登出（客户端删除 token 即可）
router.post('/logout', authMiddleware, (req, res) => {
  res.json({ message: '登出成功' });
});

module.exports = router;
