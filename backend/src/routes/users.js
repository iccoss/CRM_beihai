const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { VALID_ROLES } = require('../middleware/role-policy');

const router = express.Router();
const ROLE_ALIASES = {
  'fde-admin': 'fde_admin',
  fdeAdmin: 'fde_admin',
  'FDE管理员': 'fde_admin'
};

function normalizeRole(role) {
  const value = typeof role === 'string' ? role.trim() : role;
  return ROLE_ALIASES[value] || value;
}

// FDE管理员可管理的角色范围：FDE 以及与自身平权的 FDE管理员
const FDE_ADMIN_MANAGED_ROLES = ['fde', 'fde_admin'];

// 获取当前用户信息
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare(`
      SELECT id, username, name, role, email, phone, department_id, status, created_at, last_login_at
      FROM users WHERE id = ?
    `).get(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ user });
  } catch (error) {
    console.error('获取当前用户信息错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户列表
router.get('/', authMiddleware, (req, res) => {
  try {
    const { page = 1, limit = 10, username, name, role, status } = req.query;
    const offset = (page - 1) * limit;
    const userRole = req.user.role;

    let whereClause = '1=1';
    const params = [];

    if (username) {
      whereClause += ` AND username LIKE ?`;
      params.push(`%${username}%`);
    }
    if (name) {
      whereClause += ` AND name LIKE ?`;
      params.push(`%${name}%`);
    }
    if (role) {
      whereClause += ` AND role = ?`;
      params.push(role);
    }
    if (status) {
      whereClause += ` AND status = ?`;
      params.push(status);
    }

    // 未显式传 role 参数的查询，视为"用户管理"页面的全量列表查询；
    // 传了 role 参数的查询，是其它页面（客户/商机指派下拉框等）按角色筛选的场景，需保持原有行为不变
    const isUserManageQuery = !role;
    // FDE管理员在"用户管理"页面中只能查看FDE角色用户，以及与自己平权的FDE管理员用户，
    // 强制追加过滤条件，防止越权查看其它角色用户
    if (userRole === 'fde_admin' && isUserManageQuery) {
      whereClause += ` AND role IN (?, ?)`;
      params.push('fde', 'fde_admin');
    }

    const { total } = db.prepare(`SELECT COUNT(*) as total FROM users WHERE ${whereClause}`).get(...params);

    // 根据角色决定返回哪些字段
    const isAdmin = userRole === 'admin' || userRole === 'super_admin';
    // FDE管理员在"用户管理"页面场景下也需要看到完整字段（数据已被限制为仅FDE与FDE管理员角色用户）
    const isFdeAdminManageQuery = userRole === 'fde_admin' && isUserManageQuery;
    let selectFields = (isAdmin || isFdeAdminManageQuery)
      ? 'id, username, name, role, email, phone, department_id, status, created_at, last_login_at, quarter_target, renew_contract_amount, new_contract_amount, payment_amount, profit_rate, customer_quota'
      : 'id, name, role, department_id, status';

    const users = db.prepare(`
      SELECT ${selectFields}
      FROM users
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
      data: users,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建用户
router.post('/', authMiddleware, requireRole('admin', 'super_admin', 'fde_admin'), (req, res) => {
  try {
    const { username, password, name, email, phone, department_id, renew_contract_amount, new_contract_amount, payment_amount, profit_rate, quarter_target, customer_quota } = req.body;
    const role = normalizeRole(req.body.role);

    if (!username || !password || !name || !role) {
      return res.status(400).json({ error: '必填字段不能为空' });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '用户角色无效' });
    // FDE管理员只能创建FDE角色用户，以及与自己平权的FDE管理员用户，不能创建其它角色的用户
    if (req.user.role === 'fde_admin' && !FDE_ADMIN_MANAGED_ROLES.includes(role)) {
      return res.status(403).json({ error: 'FDE管理员只能创建FDE或FDE管理员角色用户' });
    }

    // 检查用户名是否已存在
    const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUsername) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    // 检查姓名是否已存在
    const existingName = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
    if (existingName) {
      return res.status(400).json({ error: '用户姓名已存在，请使用不同的姓名' });
    }

    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);

    db.prepare(`
      INSERT INTO users (id, username, password, name, role, email, phone, department_id, status, renew_contract_amount, new_contract_amount, payment_amount, profit_rate, quarter_target, customer_quota)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(id, username, hashedPassword, name, role, email || null, phone || null, department_id || null, renew_contract_amount || 0, new_contract_amount || 0, payment_amount || 0, profit_rate || 0, quarter_target || 0, customer_quota || 30);

    res.status(201).json({ message: '用户创建成功', id });
  } catch (error) {
    console.error('创建用户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新用户
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, department_id, status, remark, renew_contract_amount, new_contract_amount, payment_amount, profit_rate, quarter_target, customer_quota } = req.body;
    const role = normalizeRole(req.body.role);
    const userRole = req.user.role;

    // 权限检查：用户只能更新自己的信息，管理员可以更新任何人，FDE管理员只能更新FDE或FDE管理员角色用户
    if (req.user.id !== id) {
      if (userRole !== 'admin' && userRole !== 'super_admin' && userRole !== 'fde_admin') {
        return res.status(403).json({ error: '无权限修改他人信息' });
      }
      // FDE管理员只能修改FDE角色用户，以及与自己平权的FDE管理员用户，不能修改其它角色的用户
      if (userRole === 'fde_admin') {
        const targetUser = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
        if (!targetUser || !FDE_ADMIN_MANAGED_ROLES.includes(targetUser.role)) {
          return res.status(403).json({ error: 'FDE管理员只能修改FDE或FDE管理员角色用户' });
        }
      }
    }

    // 检查姓名是否已被其他用户使用
    if (name) {
      const existingName = db.prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(name, id);
      if (existingName) {
        return res.status(400).json({ error: '用户姓名已存在，请使用不同的姓名' });
      }
    }

    const updateFields = [];
    const updateValues = [];

    // 普通用户只能更新基本信息
    if (name) { updateFields.push('name = ?'); updateValues.push(name); }
    if (email !== undefined) { updateFields.push('email = ?'); updateValues.push(email || null); }
    if (phone !== undefined) { updateFields.push('phone = ?'); updateValues.push(phone || null); }
    
    // 管理员/FDE管理员可以更新更多字段（FDE管理员的目标用户已在上方校验为FDE或FDE管理员角色）
    if (userRole === 'admin' || userRole === 'super_admin' || userRole === 'fde_admin') {
      if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: '用户角色无效' });
      // FDE管理员不能把用户改成FDE体系之外的其它角色（允许 fde 与 fde_admin 之间互转）
      if (role && userRole === 'fde_admin' && !FDE_ADMIN_MANAGED_ROLES.includes(role)) {
        return res.status(403).json({ error: 'FDE管理员只能管理FDE或FDE管理员角色用户，不能修改为其它角色' });
      }
      if (role) { updateFields.push('role = ?'); updateValues.push(role); }
      if (department_id !== undefined) { updateFields.push('department_id = ?'); updateValues.push(department_id || null); }
      if (status) { updateFields.push('status = ?'); updateValues.push(status); }
      if (remark !== undefined) { updateFields.push('remark = ?'); updateValues.push(remark || null); }
      if (renew_contract_amount !== undefined) { updateFields.push('renew_contract_amount = ?'); updateValues.push(renew_contract_amount || 0); }
      if (new_contract_amount !== undefined) { updateFields.push('new_contract_amount = ?'); updateValues.push(new_contract_amount || 0); }
      if (payment_amount !== undefined) { updateFields.push('payment_amount = ?'); updateValues.push(payment_amount || 0); }
      if (profit_rate !== undefined) { updateFields.push('profit_rate = ?'); updateValues.push(profit_rate || 0); }
      if (quarter_target !== undefined) { updateFields.push('quarter_target = ?'); updateValues.push(quarter_target || 0); }
      if (customer_quota !== undefined) { updateFields.push('customer_quota = ?'); updateValues.push(customer_quota || 30); }
    }
    
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.prepare(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    res.json({ message: '用户更新成功' });
  } catch (error) {
    console.error('更新用户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除用户
router.delete('/:id', authMiddleware, requireRole('admin', 'super_admin', 'fde_admin'), (req, res) => {
  try {
    const { id } = req.params;
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // FDE管理员只能删除FDE角色用户，不能删除其它角色的用户（与自己平权的FDE管理员账号同样不可删除）
    if (req.user.role === 'fde_admin' && user.role !== 'fde') {
      return res.status(403).json({ error: 'FDE管理员只能删除FDE角色用户' });
    }

    if (user.username === 'admin') {
      return res.status(400).json({ error: '管理员账号不可删除' });
    }

    // 删除前清理关联数据：
    // 1) 可空的归属字段（owner_id / manager_id / released_by 等）置空，释放归属关系（沿用原有逻辑）；
    // 2) 创建人(creator_id)以及 opportunities.owner_id、followups.user_id、contracts.creator_id、
    //    customer_tags.creator_id 等 NOT NULL 字段保留原值，不再置空（置空会触发 NOT NULL 约束错误）；
    // 3) 删除用户时临时解除外键约束，使这些保留原值的引用不阻塞删除。
    db.prepare('UPDATE customers SET owner_id = NULL, secondary_owner_id = NULL WHERE owner_id = ? OR secondary_owner_id = ?').run(id, id);
    db.prepare('UPDATE contacts SET owner_id = NULL WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM followup_reminders WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM payment_reminders WHERE user_id = ?').run(id);
    db.prepare('UPDATE departments SET manager_id = NULL WHERE manager_id = ?').run(id);
    db.prepare('UPDATE customer_pool SET released_by = NULL WHERE released_by = ?').run(id);
    db.prepare('DELETE FROM operation_logs WHERE user_id = ?').run(id);

    // 临时关闭外键强制后删除用户，保留 creator_id 等引用字段的原值，仅解除外键约束
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    res.json({ message: '用户删除成功' });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 重置密码（管理员重置他人密码）
router.post('/:id/reset-password', authMiddleware, requireRole('admin', 'super_admin', 'fde_admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    // FDE管理员只能重置FDE角色用户，以及与自己平权的FDE管理员用户的密码，不能重置其它角色用户的密码
    if (req.user.role === 'fde_admin') {
      const targetUser = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
      if (!targetUser || !FDE_ADMIN_MANAGED_ROLES.includes(targetUser.role)) {
        return res.status(403).json({ error: 'FDE管理员只能重置FDE或FDE管理员角色用户的密码' });
      }
    }

    if (!password || password.length < 6 || password.length > 18) {
      return res.status(400).json({ error: '密码长度必须在 6-18 位之间' });
    }
    let types = 0;
    if (/[a-z]/.test(password)) types++;
    if (/[A-Z]/.test(password)) types++;
    if (/[0-9]/.test(password)) types++;
    if (/[^a-zA-Z0-9]/.test(password)) types++;
    if (types < 3) {
      return res.status(400).json({ error: '密码必须包含小写字母、大写字母、数字、特殊字符中的至少 3 种' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, id);

    res.json({ message: '密码重置成功' });
  } catch (error) {
    console.error('重置密码错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 修改密码（用户自己修改密码）
router.put('/:id/change-password', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { oldPassword, newPassword } = req.body;

    // 验证当前用户只能修改自己的密码
    if (req.user.id !== id) {
      return res.status(403).json({ error: '无权限修改他人密码' });
    }

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请输入当前密码和新密码' });
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

    // 验证旧密码
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    if (!bcrypt.compareSync(oldPassword, user.password)) {
      return res.status(400).json({ error: '当前密码错误' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, id);

    res.json({ message: '密码修改成功' });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
