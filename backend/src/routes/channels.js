const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { canViewCustomer } = require('../middleware/role-policy');

const router = express.Router();
const isFullRole = role => ['admin', 'super_admin', 'operations'].includes(role);

router.use(authMiddleware, (req, res, next) => {
  if (['presales', 'fde', 'fde_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: '技术角色不可查看渠道及分成数据' });
  }
  if (req.user.role === 'operations' && req.method !== 'GET') {
    return res.status(403).json({ error: '运营角色只能查看渠道数据' });
  }
  next();
});

const VALID_TYPES = {
  agent: '代理商',
  integrator: '集成商',
  referral: '转介绍',
  online: '线上',
  alliance: '行业联盟',
  other: '其他'
};

// ==================== 权限检查辅助函数 ====================

function canViewChannel(userId, userRole, channelId) {
  if (isFullRole(userRole)) return true;
  return db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId) !== undefined;
}

function canEditChannel(userId, userRole, channelId) {
  if (isFullRole(userRole)) return true;
  return db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId) !== undefined;
}

function canDeleteChannel(userId, userRole, channelId) {
  if (isFullRole(userRole)) return true;
  const member = db.prepare('SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
  return member && member.role === 'primary';
}

function getChannelCondition(userRole, userId) {
  if (isFullRole(userRole)) return '';
  return ` AND ch.id IN (SELECT channel_id FROM channel_members WHERE user_id = '${userId}') `;
}

// ==================== 渠道类型 ====================

router.get('/types', authMiddleware, (req, res) => {
  res.json({ data: Object.entries(VALID_TYPES).map(([key, label]) => ({ key, label })) });
});

// ==================== 渠道列表 ====================

router.get('/', authMiddleware, (req, res) => {
  try {
    const { page = 1, limit = 10, name, type, status } = req.query;
    const offset = (page - 1) * limit;
    const userRole = req.user.role;
    const userId = req.user.id;

    let whereClause = '1=1';
    const params = [];
    const chCondition = getChannelCondition(userRole, userId);
    if (chCondition) whereClause += chCondition;
    if (name) { whereClause += ' AND ch.name LIKE ?'; params.push(`%${name}%`); }
    if (type) { whereClause += ' AND ch.type = ?'; params.push(type); }
    if (status) { whereClause += ' AND ch.status = ?'; params.push(status); }

    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM channels ch WHERE ${whereClause}
    `).get(...params);

    // 非 admin 需要按客户 owner_id/secondary_owner_id 过滤数据
    const customerFilter = !isFullRole(userRole)
      ? `AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}')`
      : '';

    const channels = db.prepare(`
      SELECT ch.*, u.name as creator_name,
        (SELECT COUNT(*) FROM channel_customers cc
         INNER JOIN customers cu ON cc.customer_id = cu.id
         WHERE cc.channel_id = ch.id ${customerFilter}) as customer_count,
        (SELECT COALESCE(SUM(c.amount), 0) FROM channel_customers cc
         INNER JOIN customers cu ON cc.customer_id = cu.id
         LEFT JOIN contracts c ON c.customer_id = cu.id AND c.status = 'active'
         WHERE cc.channel_id = ch.id ${customerFilter}) as contract_amount
      FROM channels ch
      LEFT JOIN users u ON ch.creator_id = u.id
      WHERE ${whereClause}
      ORDER BY ch.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    channels.forEach(ch => {
      ch.type_label = VALID_TYPES[ch.type] || ch.type;
      ch.commission_amount = Math.round(ch.contract_amount * (ch.commission_rate || 0) / 100);
      // 获取当前用户的角色
      if (!isFullRole(userRole)) {
        const m = db.prepare('SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ch.id, userId);
        ch.my_role = m ? m.role : null;
      }
    });

    res.json({
      data: channels,
      pagination: { total: parseInt(total), page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('获取渠道列表错误:', error);
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 我的渠道统计 ====================
router.get('/my-stats', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // 渠道成员条件
    const memberCondition = isFullRole(userRole)
      ? '1=1'
      : `cm.user_id = '${userId}'`;

    // 渠道客户数（只统计属于当前用户的客户，含共享客户）
    const customerOwnerFilter = isFullRole(userRole)
      ? ''
      : `AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}')`;
    // 合同按创建者过滤
    const contractCreatorFilter = isFullRole(userRole)
      ? ''
      : `AND c.creator_id = '${userId}'`;

    const { customerCount } = db.prepare(`
      SELECT COUNT(DISTINCT cc.customer_id) as customerCount
      FROM channel_customers cc
      INNER JOIN channel_members cm ON cm.channel_id = cc.channel_id
      INNER JOIN customers cu ON cc.customer_id = cu.id ${customerOwnerFilter}
      WHERE ${memberCondition}
    `).get();

    // 合同金额（活跃合同，按客户 owner + 合同创建者过滤）
    const { contractAmount } = db.prepare(`
      SELECT COALESCE(SUM(c.amount), 0) as contractAmount
      FROM channel_customers cc
      INNER JOIN channel_members cm ON cm.channel_id = cc.channel_id
      INNER JOIN customers cu ON cc.customer_id = cu.id ${customerOwnerFilter}
      INNER JOIN contracts c ON c.customer_id = cu.id AND c.status = 'active' ${contractCreatorFilter}
      WHERE ${memberCondition}
    `).get();

    // 渠道分成（逐渠道计算再求和，按客户 owner + 合同创建者过滤）
    const channelList = db.prepare(`
      SELECT ch.id, ch.commission_rate
      FROM channels ch
      INNER JOIN channel_members cm ON cm.channel_id = ch.id
      WHERE ch.status = 'active' AND ${memberCondition}
    `).all();

    let channelCommission = 0;
    channelList.forEach(ch => {
      const { amt } = db.prepare(`
        SELECT COALESCE(SUM(c.amount), 0) as amt
        FROM channel_customers cc
        INNER JOIN customers cu ON cc.customer_id = cu.id ${customerOwnerFilter}
        INNER JOIN contracts c ON c.customer_id = cu.id AND c.status = 'active' ${contractCreatorFilter}
        WHERE cc.channel_id = ?
      `).get(ch.id);
      channelCommission += Math.round((amt || 0) * (ch.commission_rate || 0) / 100);
    });

    res.json({
      customerCount: customerCount || 0,
      contractAmount: contractAmount || 0,
      channelCommission: channelCommission
    });
  } catch (error) {
    console.error('获取我的渠道统计错误:', error);
    res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 我的成本 ====================
router.get('/my-costs', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;

    const costs = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM channel_costs
      WHERE user_id = ?
      GROUP BY category
    `).all(userId);

    const result = { travel: 0, entertainment: 0, other: 0 };
    costs.forEach(c => {
      if (c.category === 'travel') result.travel = c.total;
      else if (c.category === 'entertainment') result.entertainment = c.total;
      else if (c.category === 'other') result.other = c.total;
    });
    result.total = result.travel + result.entertainment + result.other;

    res.json(result);
  } catch (error) {
    console.error('获取我的成本错误:', error);
    res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 我的渠道（销售快捷获取） ====================

router.get('/my', authMiddleware, (req, res) => {
  try {
    if (isFullRole(req.user.role)) {
      const channels = db.prepare(`
        SELECT ch.*, ch.commission_rate,
          (SELECT COUNT(*) FROM channel_customers cc WHERE cc.channel_id = ch.id) as customer_count
        FROM channels ch WHERE ch.status = 'active' ORDER BY ch.name
      `).all();
      return res.json({ data: channels });
    }
    const channels = db.prepare(`
      SELECT ch.*, cm.role as my_role, ch.commission_rate,
        (SELECT COUNT(*) FROM channel_customers cc WHERE cc.channel_id = ch.id) as customer_count
      FROM channels ch
      INNER JOIN channel_members cm ON cm.channel_id = ch.id
      WHERE ch.status = 'active' AND cm.user_id = ?
      ORDER BY ch.name
    `).all(req.user.id);
    res.json({ data: channels });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 所有渠道（下拉用） ====================

router.get('/all', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    let sql;
    if (isFullRole(userRole)) {
      sql = `SELECT id, name, code, type, commission_rate, status FROM channels WHERE status = 'active' ORDER BY name`;
    } else {
      sql = `SELECT ch.id, ch.name, ch.code, ch.type, ch.commission_rate, ch.status
        FROM channels ch INNER JOIN channel_members cm ON cm.channel_id = ch.id
        WHERE ch.status = 'active' AND cm.user_id = ? ORDER BY ch.name`;
    }
    const channels = db.prepare(sql).all(isFullRole(userRole) ? [] : [userId]);
    res.json({ data: channels });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 渠道详情 ====================

router.get('/:id', authMiddleware, (req, res) => {
  try {
    const channelId = req.params.id;
    const userRole = req.user.role;
    const userId = req.user.id;
    if (!canViewChannel(req.user.id, req.user.role, channelId)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const channel = db.prepare(`
      SELECT ch.*, u.name as creator_name
      FROM channels ch LEFT JOIN users u ON ch.creator_id = u.id
      WHERE ch.id = ?
    `).get(channelId);
    if (!channel) return res.status(404).json({ error: '渠道不存在' });
    channel.type_label = VALID_TYPES[channel.type] || channel.type;

    // 非 admin/member 只看到自己负责的客户（含共享客户）
    const customerFilter = !isFullRole(userRole)
      ? `AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}')`
      : '';
    // 商机只看到自己的
    const oppOwnerFilter = !isFullRole(userRole)
      ? `AND o.owner_id = '${userId}'`
      : '';

    const oppItems = db.prepare(`
      SELECT
        o.id as opp_id,
        o.name as opp_name,
        CASE WHEN o.status = 'signed' THEN 0 ELSE o.amount END as opp_amount,
        o.status as opp_status,
        o.channel_commission_rate as opp_commission_rate,
        cu.name as customer_name,
        cc.commission_rate as customer_commission_rate,
        COALESCE((
          SELECT SUM(c.amount) FROM contracts c
          WHERE c.opportunity_id = o.id AND c.status = 'active'
        ), 0) as contract_amount
      FROM channel_customers cc
      INNER JOIN customers cu ON cc.customer_id = cu.id ${customerFilter}
      LEFT JOIN opportunities o ON o.customer_id = cu.id ${oppOwnerFilter}
      WHERE cc.channel_id = ?
      ORDER BY cc.created_at DESC, o.created_at DESC
    `).all(channelId);

    oppItems.forEach(item => {
      // 优先级：商机自身分成比率 > 客户级别分成比率 > 渠道默认分成比率
      const rate = item.opp_commission_rate !== null && item.opp_commission_rate !== undefined
        ? item.opp_commission_rate
        : (item.customer_commission_rate !== null && item.customer_commission_rate !== undefined
          ? item.customer_commission_rate
          : channel.commission_rate);
      item.commission_rate = rate;
      item.channel_commission = Math.round((item.contract_amount || 0) * rate / 100);
    });

    // 兼容前端字段名
    const customers = oppItems;

    // 渠道成员
    const members = db.prepare(`
      SELECT cm.user_id, cm.role, cm.assigned_at, u.name as user_name
      FROM channel_members cm INNER JOIN users u ON cm.user_id = u.id
      WHERE cm.channel_id = ? ORDER BY cm.role DESC, cm.assigned_at
    `).all(channelId);

    // 统计汇总 — 每个指标独立查询，避免笛卡尔积膨胀
    const statsCustomerFilter = !isFullRole(userRole)
      ? `AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}')`
      : '';
    const statsOppFilter = !isFullRole(userRole)
      ? `AND o.owner_id = '${userId}'`
      : '';
    const statsContractFilter = !isFullRole(userRole)
      ? `AND c.creator_id = '${userId}'`
      : '';

    // 1. 客户数
    const { customer_count } = db.prepare(`
      SELECT COUNT(DISTINCT cc.customer_id) as customer_count
      FROM channel_customers cc
      INNER JOIN customers cu ON cc.customer_id = cu.id
      WHERE cc.channel_id = ? AND cu.is_deleted = 0 ${statsCustomerFilter}
    `).get(channelId);

    // 2. 商机数
    const { opp_count } = db.prepare(`
      SELECT COUNT(o.id) as opp_count
      FROM opportunities o
      INNER JOIN customers cu ON o.customer_id = cu.id
      INNER JOIN channel_customers cc ON cc.customer_id = cu.id
      WHERE cc.channel_id = ? AND cu.is_deleted = 0 ${statsOppFilter}
    `).get(channelId);

    // 3. 已签商机数
    const { signed_count } = db.prepare(`
      SELECT COUNT(o.id) as signed_count
      FROM opportunities o
      INNER JOIN customers cu ON o.customer_id = cu.id
      INNER JOIN channel_customers cc ON cc.customer_id = cu.id
      WHERE cc.channel_id = ? AND o.status = 'signed' AND cu.is_deleted = 0 ${statsOppFilter}
    `).get(channelId);

    // 4. 合同金额（仅执行中）
    const { contract_amount } = db.prepare(`
      SELECT COALESCE(SUM(c.amount), 0) as contract_amount
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      INNER JOIN channel_customers cc ON cc.customer_id = cu.id
      WHERE cc.channel_id = ? AND c.status = 'active' AND cu.is_deleted = 0 ${statsContractFilter}
    `).get(channelId);

    const stats = {
      customer_count: customer_count || 0,
      opp_count: opp_count || 0,
      signed_count: signed_count || 0,
      contract_amount: contract_amount || 0
    };
    stats.commission_amount = Math.round(stats.contract_amount * (channel.commission_rate || 0) / 100);

    // 变更日志
    const changeLogs = db.prepare(`
      SELECT * FROM channel_change_logs
      WHERE channel_id = ?
      ORDER BY changed_at DESC
      LIMIT 50
    `).all(channelId);

    res.json({ channel, customers, members, stats, changeLogs });
  } catch (error) {
    console.error('获取渠道详情错误:', error);
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 创建渠道 ====================

router.post('/', authMiddleware, (req, res) => {
  try {
    const data = req.body;
    if (!data.name || !data.code) {
      return res.status(400).json({ error: '渠道名称和编号不能为空' });
    }
    if (!VALID_TYPES[data.type]) {
      return res.status(400).json({ error: '无效的渠道类型' });
    }

    const existing = db.prepare('SELECT id FROM channels WHERE code = ?').get(data.code);
    if (existing) return res.status(400).json({ error: '渠道编号已存在' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO channels (id, name, code, type, status, contact_person, contact_phone, contact_email, region, commission_rate, creator_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.code, data.type, data.status || 'active',
      data.contact_person || null, data.contact_phone || null, data.contact_email || null,
      data.region || null, data.commission_rate || 0, req.user.id, data.description || null);

    // 自动将创建者加入 channel_members
    db.prepare(`
      INSERT INTO channel_members (id, channel_id, user_id, role, assigned_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), id, req.user.id, 'primary', req.user.id);

    res.status(201).json({ message: '渠道创建成功', id });
  } catch (error) {
    console.error('创建渠道错误:', error);
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 更新渠道 ====================

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const channelId = req.params.id;
    if (!canEditChannel(req.user.id, req.user.role, channelId)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) return res.status(404).json({ error: '渠道不存在' });

    const data = req.body;
    if (data.type && !VALID_TYPES[data.type]) {
      return res.status(400).json({ error: '无效的渠道类型' });
    }

    // member 不能修改统一的 commission_rate
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      const member = db.prepare('SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, req.user.id);
      if (member && member.role === 'member') {
        if (data.commission_rate !== undefined) {
          return res.status(403).json({ error: 'member 角色不能修改渠道统一分成比例' });
        }
      }
    }

    const fieldLabels = {
      name: '渠道名称', type: '渠道类型', status: '状态',
      contact_person: '联系人', contact_phone: '电话', contact_email: '邮箱',
      region: '负责区域', commission_rate: '分成比例', description: '备注'
    };

    const fields = ['name', 'type', 'status', 'contact_person', 'contact_phone', 'contact_email', 'region', 'commission_rate', 'description'];
    const updates = [];
    const values = [];
    const changeLogInsert = db.prepare(
      'INSERT INTO channel_change_logs (id, channel_id, changed_by, changed_by_name, field_name, old_value) VALUES (?, ?, ?, ?, ?, ?)'
    );

    for (const f of fields) {
      if (data[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(data[f]);

        const oldVal = channel[f];
        const oldStr = oldVal === null || oldVal === undefined ? '' : String(oldVal);
        const newStr = data[f] === null || data[f] === undefined ? '' : String(data[f]);
        if (oldStr !== newStr) {
          changeLogInsert.run(
            uuidv4(), channelId, req.user.id,
            req.user.name || req.user.username,
            fieldLabels[f] || f,
            oldStr
          );
        }
      }
    }
    if (updates.length === 0) return res.json({ message: '无更新内容' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(channelId);
    db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ message: '渠道更新成功' });
  } catch (error) {
    console.error('更新渠道错误:', error);
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 删除渠道 ====================

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const channelId = req.params.id;
    if (!canDeleteChannel(req.user.id, req.user.role, channelId)) {
      return res.status(403).json({ error: '权限不足，仅创建人或管理员可删除' });
    }
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    res.json({ message: '渠道删除成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 渠道成员管理 ====================

// 获取成员
router.get('/:id/members', authMiddleware, (req, res) => {
  try {
    if (!canViewChannel(req.user.id, req.user.role, req.params.id)) {
      return res.status(403).json({ error: '权限不足' });
    }
    const members = db.prepare(`
      SELECT cm.id, cm.channel_id, cm.user_id, cm.role, cm.assigned_by, cm.assigned_at,
        u.name as user_name
      FROM channel_members cm INNER JOIN users u ON cm.user_id = u.id
      WHERE cm.channel_id = ? ORDER BY cm.role DESC, cm.assigned_at
    `).all(req.params.id);
    res.json({ data: members });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// 添加成员（仅 admin/运营）
router.post('/:id/members', authMiddleware, (req, res) => {
  try {
    const { role } = req.user;
    if (!isFullRole(role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    const { user_id, member_role } = req.body;
    if (!user_id) return res.status(400).json({ error: '用户ID不能为空' });

    const existing = db.prepare('SELECT id FROM channel_members WHERE channel_id = ? AND user_id = ?').get(req.params.id, user_id);
    if (existing) return res.status(400).json({ error: '该用户已在渠道中' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO channel_members (id, channel_id, user_id, role, assigned_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, user_id, member_role || 'member', req.user.id);

    res.status(201).json({ message: '渠道成员添加成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// 修改成员角色（仅 admin/运营）
router.put('/:id/members/:userId/role', authMiddleware, (req, res) => {
  try {
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    const { role } = req.body;
    if (!['primary', 'member'].includes(role)) {
      return res.status(400).json({ error: '角色必须为 primary 或 member' });
    }
    db.prepare('UPDATE channel_members SET role = ? WHERE channel_id = ? AND user_id = ?').run(role, req.params.id, req.params.userId);
    res.json({ message: '角色更新成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// 移除成员（仅 admin/运营）
router.delete('/:id/members/:userId', authMiddleware, (req, res) => {
  try {
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
    res.json({ message: '渠道成员移除成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 渠道客户分配 ====================

router.post('/:id/assign', authMiddleware, (req, res) => {
  try {
    if (!canEditChannel(req.user.id, req.user.role, req.params.id)) {
      return res.status(403).json({ error: '权限不足' });
    }
    const { customer_id, commission_rate } = req.body;
    if (!customer_id) return res.status(400).json({ error: '客户ID不能为空' });

    const existing = db.prepare('SELECT id FROM channel_customers WHERE customer_id = ?').get(customer_id);
    if (existing) return res.status(400).json({ error: '该客户已关联其他渠道' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO channel_customers (id, channel_id, customer_id, commission_rate)
      VALUES (?, ?, ?, ?)
    `).run(id, req.params.id, customer_id, commission_rate || null);

    db.prepare('UPDATE customers SET channel_id = ? WHERE id = ?').run(req.params.id, customer_id);
    res.status(201).json({ message: '渠道客户分配成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

router.delete('/:id/assign/:customerId', authMiddleware, (req, res) => {
  try {
    if (!canEditChannel(req.user.id, req.user.role, req.params.id)) {
      return res.status(403).json({ error: '权限不足' });
    }
    db.prepare('DELETE FROM channel_customers WHERE channel_id = ? AND customer_id = ?').run(req.params.id, req.params.customerId);
    db.prepare('UPDATE customers SET channel_id = NULL WHERE id = ? AND channel_id = ?').run(req.params.customerId, req.params.id);
    res.json({ message: '渠道客户移除成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 销售修改渠道客户分成比例 ====================

router.put('/:id/customer/:customerId/commission', authMiddleware, (req, res) => {
  try {
    if (!canEditChannel(req.user.id, req.user.role, req.params.id)) {
      return res.status(403).json({ error: '权限不足' });
    }
    const { commission_rate } = req.body;
    if (commission_rate === undefined || commission_rate === null || commission_rate < 0 || commission_rate > 100) {
      return res.status(400).json({ error: '分成比例必须为 0-100 之间的数值' });
    }
    db.prepare('UPDATE channel_customers SET commission_rate = ? WHERE channel_id = ? AND customer_id = ?').run(commission_rate, req.params.id, req.params.customerId);
    res.json({ message: '分成比例更新成功' });
  } catch (error) {
    console.error(error); res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 渠道客户商机详情 ====================
router.get('/customers/:customerId/opportunities', authMiddleware, (req, res) => {
  try {
    const customerId = req.params.customerId;
    if (!canViewCustomer(req.user, customerId)) {
      return res.status(403).json({ error: '无权限查看该客户商机' });
    }
    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    const opportunities = db.prepare(`
      SELECT o.id, o.name, o.amount, o.status, o.created_at, u.name as sales_name
      FROM opportunities o
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.customer_id = ?
      ORDER BY o.created_at DESC
    `).all(customerId);

    res.json({ customer, opportunities });
  } catch (error) {
    console.error('获取商机详情错误:', error);
    res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

// ==================== 渠道客户合同详情 ====================
router.get('/customers/:customerId/contracts', authMiddleware, (req, res) => {
  try {
    const customerId = req.params.customerId;
    if (!canViewCustomer(req.user, customerId)) {
      return res.status(403).json({ error: '无权限查看该客户合同' });
    }
    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    const contracts = db.prepare(`
      SELECT c.id, c.contract_no as code, c.title as name, c.amount, c.status, c.sign_date, c.effective_date as start_date, c.expire_date as end_date, u.name as sales_name
      FROM contracts c
      LEFT JOIN users u ON c.creator_id = u.id
      WHERE c.customer_id = ?
      ORDER BY c.created_at DESC
    `).all(customerId);

    res.json({ customer, contracts });
  } catch (error) {
    console.error('获取合同详情错误:', error);
    res.status(500).json({ error: '服务器错误', detail: error.message });
  }
});

module.exports = router;
