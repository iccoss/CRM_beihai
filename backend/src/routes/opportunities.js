const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isSystemAdmin, canViewAll, isTechnicalRole, isCustomerMember, presalesCanAccessOpportunity, userCanAccessOpportunity } = require('../middleware/role-policy');
const { sendCsv } = require('../utils/csv');

const router = express.Router();

router.use(authMiddleware, (req, res, next) => {
  const isFdeAssignment = req.user.role === 'fde_admin' && req.method === 'POST' && req.path.endsWith('/assignments');
  if (['operations', 'presales', 'fde'].includes(req.user.role) && req.method !== 'GET') {
    return res.status(403).json({ error: '当前角色只能查看或填写授权范围内的技术协作数据' });
  }
  if (req.user.role === 'fde_admin' && req.method !== 'GET' && !isFdeAssignment && !req.path.includes('/assignments/')) {
    return res.status(403).json({ error: 'FDE管理员只能管理FDE指派' });
  }
  next();
});

// 辅助:记录商机状态变更日志
function logOpportunityStatusChange(opportunityId, fromStatus, toStatus, userId, followupId) {
  try {
    db.prepare(`
      INSERT INTO opportunity_change_logs (opportunity_id, from_status, to_status, changed_by, followup_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(opportunityId, fromStatus || null, toStatus, userId || null, followupId || null);
  } catch (e) {
    console.error('记录商机状态变更日志失败:', e.message);
  }
}

function getAssignmentSummary(opportunityId) {
  // 商机级活跃指派
  const opportunityAssignments = db.prepare(`
    SELECT oa.*, u.name, u.username, u.role, assigner.name AS assigned_by_name
    FROM opportunity_assignments oa INNER JOIN users u ON u.id = oa.user_id
    LEFT JOIN users assigner ON assigner.id = oa.assigned_by
    WHERE oa.opportunity_id = ? AND oa.status = 'active'
    ORDER BY oa.assignment_type, oa.assigned_at
  `).all(opportunityId).map(row => ({ ...row, source: 'opportunity' }));

  // 合并客户级活跃指派（已有商机级指派的人员不重复展示），与可见性规则保持同一数据源
  const opportunity = db.prepare('SELECT customer_id FROM opportunities WHERE id = ?').get(opportunityId);
  const customerAssignments = [];
  if (opportunity) {
    const assignedKeys = new Set(opportunityAssignments.map(a => `${a.assignment_type}:${a.user_id}`));
    const customerSources = [
      { type: 'presales', table: 'customer_presales_assignments' },
      { type: 'fde', table: 'customer_fde_assignments' }
    ];
    for (const { type, table } of customerSources) {
      const rows = db.prepare(`
        SELECT ca.user_id, ca.assigned_by, ca.assigned_at, ca.remark, ca.status,
               u.name, u.username, u.role, assigner.name AS assigned_by_name
        FROM ${table} ca
        INNER JOIN users u ON u.id = ca.user_id
        LEFT JOIN users assigner ON assigner.id = ca.assigned_by
        WHERE ca.customer_id = ? AND ca.status = 'active'
        ORDER BY ca.assigned_at
      `).all(opportunity.customer_id);
      for (const row of rows) {
        if (assignedKeys.has(`${type}:${row.user_id}`)) continue;
        customerAssignments.push({
          id: null,
          opportunity_id: opportunityId,
          user_id: row.user_id,
          assignment_type: type,
          assigned_by: row.assigned_by,
          remark: row.remark,
          assigned_at: row.assigned_at,
          status: row.status,
          name: row.name,
          username: row.username,
          role: row.role,
          assigned_by_name: row.assigned_by_name,
          source: 'customer'
        });
      }
    }
  }

  return [...opportunityAssignments, ...customerAssignments]
    .sort((a, b) => a.assignment_type.localeCompare(b.assignment_type) || (a.assigned_at || '').localeCompare(b.assigned_at || ''));
}

// 客户默认售前：售前已统一收敛到「商机管理」按商机指派，
// 因此默认售前改为取该客户其他在跟商机中最近一次的商机级售前，用于新建商机时自动带入。
function getCustomerDefaultPresalesId(customerId) {
  const fromOpportunity = db.prepare(`
    SELECT oa.user_id
    FROM opportunity_assignments oa
    INNER JOIN opportunities o ON o.id = oa.opportunity_id
    INNER JOIN users u ON u.id = oa.user_id
    WHERE o.customer_id = ? AND o.status NOT IN ('signed', 'lost')
      AND oa.assignment_type = 'presales' AND oa.status = 'active'
      AND u.role = 'presales' AND u.status = 'active'
    ORDER BY oa.assigned_at DESC LIMIT 1
  `).get(customerId)?.user_id;
  if (fromOpportunity) return fromOpportunity;

  // 兜底：保留原有的客户级售前查询（存量客户级记录已作废，通常不会命中）
  return db.prepare(`
    SELECT cpa.user_id
    FROM customer_presales_assignments cpa
    INNER JOIN users u ON u.id = cpa.user_id
    WHERE cpa.customer_id = ? AND cpa.status = 'active'
      AND u.role = 'presales' AND u.status = 'active'
    ORDER BY cpa.assigned_at DESC LIMIT 1
  `).get(customerId)?.user_id || null;
}

function validatePresalesUser(userId) {
  if (!userId) return null;
  return db.prepare("SELECT id FROM users WHERE id = ? AND role = 'presales' AND status = 'active'").get(userId);
}

function replaceOpportunityPresales(opportunityId, userId, assignedBy, remark) {
  db.prepare(`
    UPDATE opportunity_assignments
    SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
    WHERE opportunity_id = ? AND assignment_type = 'presales' AND status = 'active'
  `).run(opportunityId);
  if (!userId) return;

  const previous = db.prepare(`
    SELECT id FROM opportunity_assignments
    WHERE opportunity_id = ? AND user_id = ? AND assignment_type = 'presales' AND status = 'cancelled'
    ORDER BY assigned_at DESC LIMIT 1
  `).get(opportunityId, userId);
  if (previous) {
    db.prepare(`
      UPDATE opportunity_assignments
      SET status = 'active', assigned_by = ?, remark = ?, assigned_at = CURRENT_TIMESTAMP, cancelled_at = NULL
      WHERE id = ?
    `).run(assignedBy, remark || null, previous.id);
  } else {
    db.prepare(`
      INSERT INTO opportunity_assignments
        (id, opportunity_id, user_id, assignment_type, assigned_by, remark)
      VALUES (?, ?, ?, 'presales', ?, ?)
    `).run(uuidv4(), opportunityId, userId, assignedBy, remark || null);
  }
}

// 获取商机列表
router.get('/', authMiddleware, (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      name,
      customer_id,
      customer_name,
      type,
      status,
      products,
      owner_id
    } = req.query;

    const offset = (page - 1) * limit;
    const userRole = req.user.role;
    const userId = req.user.id;

    // 构建查询条件
    let whereClause = '1=1';
    const params = [];

    // 权限控制:
    // 1. 每个销售只能看到自己创建的商机
    // 2. 主销售可以看到共享出去的客户的**所有商机**(包括副销售创建的)
    if (userRole === 'sales') {
      whereClause += ` AND o.owner_id = '${userId}'`;
    } else if (userRole === 'presales') {
      // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.user_id = '${userId}' AND oa.assignment_type = 'presales' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_presales_assignments cpa
        WHERE cpa.customer_id = o.customer_id AND cpa.user_id = '${userId}' AND cpa.status = 'active'))`;
    } else if (userRole === 'fde') {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.user_id = '${userId}' AND oa.assignment_type = 'fde' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_fde_assignments cfa
        WHERE cfa.customer_id = o.customer_id AND cfa.user_id = '${userId}' AND cfa.status = 'active'))`;
    }

    if (name) {
      whereClause += ` AND o.name LIKE ?`;
      params.push(`%${name}%`);
    }
    if (customer_id) {
      whereClause += ` AND o.customer_id = ?`;
      params.push(customer_id);
    }
    if (customer_name) {
      whereClause += ` AND c.name LIKE ?`;
      params.push(`%${customer_name}%`);
    }
    if (type) {
      whereClause += ` AND o.type = ?`;
      params.push(type);
    }
    if (status) {
      const statusList = status.split(',').filter(Boolean);
      if (statusList.length > 0) {
        const placeholders = statusList.map(() => '?').join(',');
        whereClause += ` AND o.status IN (${placeholders})`;
        params.push(...statusList);
      }
    } else {
      // 默认不显示已丢失的数据,保留已签的数据(因为已签的商机也需要跟进)
      whereClause += ` AND o.status != 'lost'`;
    }
    // 意向产品筛选(支持多选):products 存的是产品名称,按去空格+忽略大小写做精确匹配
    if (products) {
      const productFilters = String(products).split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
      if (productFilters.length > 0) {
        const placeholders = productFilters.map(() => '?').join(',');
        whereClause += ` AND LOWER(TRIM(o.products)) IN (${placeholders})`;
        params.push(...productFilters);
      }
    }
    if (owner_id) {
      whereClause += ` AND o.owner_id = ?`;
      params.push(owner_id);
    }

    // 查询总数
    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND ${whereClause}
    `).get(...params);

    // 查询数据
    const opportunities = db.prepare(`
      SELECT
        o.*,
        c.name as customer_name,
        c.customer_short_name,
        c.owner_id as customer_owner_id,
        c.secondary_owner_id,
        c.owner_share_percent,
        cont.name as contact_name,
        u.name as owner_name,
        u2.name as creator_name,
        cu.name as customer_secondary_owner_name,
        (SELECT TRIM(COALESCE((SELECT GROUP_CONCAT(u3.name, ', ') FROM opportunity_assignments oa3 INNER JOIN users u3 ON u3.id = oa3.user_id WHERE oa3.opportunity_id = o.id AND oa3.assignment_type = 'presales' AND oa3.status = 'active'), '') || ', ' || COALESCE((SELECT GROUP_CONCAT(u3.name, ', ') FROM customer_presales_assignments cpa3 INNER JOIN users u3 ON u3.id = cpa3.user_id WHERE cpa3.customer_id = o.customer_id AND cpa3.status = 'active' AND NOT EXISTS (SELECT 1 FROM opportunity_assignments x3 WHERE x3.opportunity_id = o.id AND x3.assignment_type = 'presales' AND x3.status = 'active' AND x3.user_id = cpa3.user_id)), ''), ', ')) as presales_names,
        (SELECT TRIM(COALESCE((SELECT GROUP_CONCAT(u4.name, ', ') FROM opportunity_assignments oa4 INNER JOIN users u4 ON u4.id = oa4.user_id WHERE oa4.opportunity_id = o.id AND oa4.assignment_type = 'fde' AND oa4.status = 'active'), '') || ', ' || COALESCE((SELECT GROUP_CONCAT(u4.name, ', ') FROM customer_fde_assignments cfa4 INNER JOIN users u4 ON u4.id = cfa4.user_id WHERE cfa4.customer_id = o.customer_id AND cfa4.status = 'active' AND NOT EXISTS (SELECT 1 FROM opportunity_assignments x4 WHERE x4.opportunity_id = o.id AND x4.assignment_type = 'fde' AND x4.status = 'active' AND x4.user_id = cfa4.user_id)), ''), ', ')) as fde_names,
        COALESCE(fc.followup_count, 0) as followup_count
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN contacts cont ON o.contact_id = cont.id
      LEFT JOIN users u ON o.owner_id = u.id
      LEFT JOIN users u2 ON o.creator_id = u2.id
      LEFT JOIN users cu ON c.secondary_owner_id = cu.id
      LEFT JOIN (SELECT opportunity_id, COUNT(*) as followup_count FROM followups WHERE opportunity_id IS NOT NULL GROUP BY opportunity_id) fc ON fc.opportunity_id = o.id
      WHERE c.is_deleted = 0 AND ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // 计算分成比例
    const currentUserId = userId;
    opportunities.forEach(opp => {
      if (isTechnicalRole(req.user.role)) {
        opp.amount = null;
        opp.channel_commission_rate = null;
        opp.share_percent = null;
        opp.commercial_hidden = true;
        return;
      }
      // 分成比例 = 渠道商分走的比率：使用商机上填写的渠道分成比例，未填写则视为无渠道商分成，显示0
      opp.share_percent = (opp.channel_commission_rate !== null && opp.channel_commission_rate !== undefined)
        ? Number(opp.channel_commission_rate)
        : 0;
      opp.commercial_hidden = false;
    });

    // 计算总金额(当前页所有商机的金额求和)
    const totalAmount = isTechnicalRole(req.user.role) ? null : opportunities.reduce((sum, opp) => sum + (opp.amount || 0), 0);

    res.json({
      data: opportunities,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      },
      totalAmount
    });
  } catch (error) {
    console.error('获取商机列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 导出与当前列表相同权限范围、相同筛选条件下的全部商机。
router.get('/export', authMiddleware, (req, res) => {
  try {
    const { name, customer_id, customer_name, type, status, products, owner_id } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;
    let whereClause = '1=1';
    const params = [];

    if (userRole === 'sales') {
      whereClause += ' AND o.owner_id = ?';
      params.push(userId);
    } else if (userRole === 'presales') {
      // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.user_id = ? AND oa.assignment_type = 'presales' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_presales_assignments cpa
        WHERE cpa.customer_id = o.customer_id AND cpa.user_id = ? AND cpa.status = 'active'))`;
      params.push(userId, userId);
    } else if (userRole === 'fde') {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.user_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_fde_assignments cfa
        WHERE cfa.customer_id = o.customer_id AND cfa.user_id = ? AND cfa.status = 'active'))`;
      params.push(userId, userId);
    } else if (userRole === 'fde_admin') {
      // FDE管理员可见范围：存在商机级或客户级FDE指派的商机
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'fde' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_fde_assignments cfa
        WHERE cfa.customer_id = o.customer_id AND cfa.status = 'active'))`;
    }
    if (name) { whereClause += ' AND o.name LIKE ?'; params.push(`%${name}%`); }
    if (customer_id) { whereClause += ' AND o.customer_id = ?'; params.push(customer_id); }
    if (customer_name) { whereClause += ' AND c.name LIKE ?'; params.push(`%${customer_name}%`); }
    if (type) { whereClause += ' AND o.type = ?'; params.push(type); }
    if (status) {
      const statusList = String(status).split(',').filter(Boolean);
      if (statusList.length) {
        whereClause += ` AND o.status IN (${statusList.map(() => '?').join(',')})`;
        params.push(...statusList);
      }
    } else {
      whereClause += " AND o.status != 'lost'";
    }
    // 意向产品筛选(支持多选),与列表接口保持一致的匹配规则
    if (products) {
      const productFilters = String(products).split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
      if (productFilters.length) {
        whereClause += ` AND LOWER(TRIM(o.products)) IN (${productFilters.map(() => '?').join(',')})`;
        params.push(...productFilters);
      }
    }
    if (owner_id) { whereClause += ' AND o.owner_id = ?'; params.push(owner_id); }

    const rows = db.prepare(`
      SELECT o.name, c.name AS customer_name, o.type, o.products, o.status,
        owner.name AS owner_name,
        (SELECT GROUP_CONCAT(u.name, '、') FROM opportunity_assignments oa
          INNER JOIN users u ON u.id = oa.user_id
          WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'presales' AND oa.status = 'active') AS presales_names,
        (SELECT GROUP_CONCAT(u.name, '、') FROM opportunity_assignments oa
          INNER JOIN users u ON u.id = oa.user_id
          WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'fde' AND oa.status = 'active') AS fde_names,
        o.expected_sign_date, o.amount, o.channel_commission_rate,
        (SELECT COUNT(*) FROM followups f WHERE f.opportunity_id = o.id) AS followup_count,
        o.created_at
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users owner ON owner.id = o.owner_id
      WHERE c.is_deleted = 0 AND ${whereClause}
      ORDER BY o.created_at DESC
    `).all(...params).map(row => ({
      ...row,
      type: ({ new_project: '新项目', renewal: '续签', maintenance: '维保' })[row.type] || row.type,
      status: ({ potential: '潜在', technical: '技术交流', poc: 'POC', project: '立项', bidding: '招投标', contracting: '合同中', signed: '已签', lost: '已丢失' })[row.status] || row.status,
      presales_names: row.presales_names || '未指派',
      fde_names: row.fde_names || '未指派'
    }));

    const headers = [
      { key: 'name', label: '商机名称' }, { key: 'customer_name', label: '客户名称' },
      { key: 'type', label: '商机类型' }, { key: 'products', label: '意向产品' },
      { key: 'status', label: '商机状态' }, { key: 'owner_name', label: '负责销售' },
      { key: 'presales_names', label: '售前' }, { key: 'fde_names', label: 'FDE' },
      { key: 'expected_sign_date', label: '预计签约时间' }, { key: 'followup_count', label: '跟进次数' }
    ];
    if (!isTechnicalRole(userRole)) {
      headers.push({ key: 'amount', label: '商机金额' }, { key: 'channel_commission_rate', label: '渠道分成比例(%)' });
    }
    headers.push({ key: 'created_at', label: '创建时间' });
    sendCsv(res, `opportunities_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  } catch (error) {
    console.error('导出商机错误:', error);
    res.status(500).json({ error: '商机导出失败' });
  }
});

// 获取「意向产品」下拉选项:取自商机表实际出现过的产品名,可覆盖已改名/停用的历史产品。
// 注意:该路由必须注册在 /:id 之前,否则会被商机详情路由当成 id 匹配。
router.get('/product-options', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    // 与列表接口保持同一套可见范围,避免下拉泄露当前用户无权查看的商机产品名
    let whereClause = '1=1';
    const params = [];
    if (userRole === 'sales') {
      whereClause += ' AND o.owner_id = ?';
      params.push(userId);
    } else if (userRole === 'presales') {
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.user_id = ? AND oa.assignment_type = 'presales' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_presales_assignments cpa
        WHERE cpa.customer_id = o.customer_id AND cpa.user_id = ? AND cpa.status = 'active'))`;
      params.push(userId, userId);
    } else if (userRole === 'fde') {
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = o.id AND oa.user_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_fde_assignments cfa
        WHERE cfa.customer_id = o.customer_id AND cfa.user_id = ? AND cfa.status = 'active'))`;
      params.push(userId, userId);
    }

    const rows = db.prepare(`
      SELECT DISTINCT TRIM(o.products) AS product_name
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
        AND o.products IS NOT NULL AND TRIM(o.products) <> ''
        AND ${whereClause}
      ORDER BY product_name
    `).all(...params);

    res.json({ data: rows.map(row => row.product_name) });
  } catch (error) {
    console.error('获取商机意向产品选项错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取商机详情
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const opportunity = db.prepare(`
      SELECT
        o.*,
        c.name as customer_name,
        c.customer_short_name,
        c.channel_id as customer_channel_id,
        cont.name as contact_name,
        cont.phone as contact_phone,
        cont.email as contact_email,
        u.name as owner_name,
        u2.name as creator_name,
        ch.name as channel_name,
        ch.commission_rate as channel_default_commission_rate
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN contacts cont ON o.contact_id = cont.id
      LEFT JOIN users u ON o.owner_id = u.id
      LEFT JOIN users u2 ON o.creator_id = u2.id
      LEFT JOIN channel_customers cch ON cch.customer_id = c.id
      LEFT JOIN channels ch ON ch.id = cch.channel_id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!opportunity) {
      return res.status(404).json({ error: '商机不存在' });
    }

    // 权限检查
    const userRole = req.user.role;
    const userId = req.user.id;

    if (userRole === 'sales' && opportunity.owner_id !== userId) {
      return res.status(403).json({ error: '无权限查看该商机' });
    }
    if (userRole === 'presales' && !presalesCanAccessOpportunity(userId, opportunity.id)) {
      return res.status(403).json({ error: '该商机未指派给您' });
    }
    if (userRole === 'fde' && !userCanAccessOpportunity(userId, opportunity.id, 'fde')) {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      return res.status(403).json({ error: '该商机未指派给您' });
    }
    // fde_admin 与 admin/运营一致，可查看所有商机详情（包括未分配FDE的商机）

    // 获取该商机的跟进记录(按 created_at 降序)
    const followups = db.prepare(`
      SELECT f.id, f.customer_id, f.contact_id, f.opportunity_id, f.user_id, f.followup_time,
             f.type, f.content, f.stage, f.result, f.next_followup_at, f.next_followup_content,
             f.created_at, f.updated_at,
             u.name as user_name,
             u.role as user_role,
             cont.name as contact_name
      FROM followups f
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN contacts cont ON f.contact_id = cont.id
      WHERE f.opportunity_id = ?
      ORDER BY f.created_at DESC
    `).all(req.params.id);

    // 格式化跟进时间
    followups.forEach(f => {
      f.followup_time_formatted = f.followup_time ? new Date(f.followup_time).toLocaleString('zh-CN', { hour12: false }) : null;
    });

    const assignments = getAssignmentSummary(req.params.id);
    if (isTechnicalRole(userRole)) {
      opportunity.amount = null;
      opportunity.channel_commission_rate = null;
      opportunity.channel_default_commission_rate = null;
      opportunity.commercial_hidden = true;
    }
    res.json({ opportunity, followups, assignments });
  } catch (error) {
    console.error('获取商机详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取商机技术协作指派
router.get('/:id/assignments', authMiddleware, (req, res) => {
  try {
    const opportunity = db.prepare('SELECT id, owner_id FROM opportunities WHERE id = ?').get(req.params.id);
    if (!opportunity) return res.status(404).json({ error: '商机不存在' });
    const role = req.user.role;
    const allowed = isSystemAdmin(role) || canViewAll(role) ||
      (role === 'sales' && opportunity.owner_id === req.user.id) ||
      (role === 'presales' && presalesCanAccessOpportunity(req.user.id, opportunity.id)) ||
      (role === 'fde' && userCanAccessOpportunity(req.user.id, opportunity.id, 'fde')) ||
      role === 'fde_admin';
    if (!allowed) return res.status(403).json({ error: '无权限查看指派信息' });
    // 合并商机级与客户级指派，与详情接口保持一致（客户级行 source='customer'、id=null）
    const assignments = getAssignmentSummary(req.params.id);
    res.json({ data: assignments });
  } catch (error) {
    console.error('获取商机指派错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 指派售前或 FDE。FDE 只能从技术交流阶段开始参与，且支持一次指派多人（人数不限）。
router.post('/:id/assignments', authMiddleware, (req, res) => {
  try {
    const { user_id, user_ids, assignment_type, remark } = req.body;
    const opportunity = db.prepare('SELECT id, owner_id, status FROM opportunities WHERE id = ?').get(req.params.id);
    if (!opportunity) return res.status(404).json({ error: '商机不存在' });
    if (!['presales', 'fde'].includes(assignment_type)) return res.status(400).json({ error: '指派类型无效' });

    const role = req.user.role;
    const isOwner = role === 'sales' && opportunity.owner_id === req.user.id;
    const canAssignPresales = assignment_type === 'presales' && (isOwner || isSystemAdmin(role));
    const canAssignFde = assignment_type === 'fde' && (isOwner || isSystemAdmin(role) || role === 'fde_admin');
    if (!canAssignPresales && !canAssignFde) return res.status(403).json({ error: '无权限执行该指派' });

    // 兼容单人 user_id 与批量 user_ids（FDE 多人指派），去重去空后统一按数组处理
    const rawIds = Array.isArray(user_ids) && user_ids.length > 0 ? user_ids : (user_id ? [user_id] : []);
    const targetIds = [...new Set(rawIds.filter(Boolean))];
    if (targetIds.length === 0) return res.status(400).json({ error: '请选择被指派人员' });

    const targetRole = assignment_type === 'presales' ? 'presales' : 'fde';
    const targetLabel = assignment_type === 'presales' ? '售前' : 'FDE';
    // 售前保留一名当前负责人，因此一次只允许指派一人；FDE 不限人数
    if (assignment_type === 'presales' && targetIds.length > 1) {
      return res.status(400).json({ error: '售前只能指派一名人员' });
    }
    // 逐个校验被指派人身份，任一不合法则整批拒绝
    for (const targetId of targetIds) {
      const target = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = ? AND status = 'active'").get(targetId, targetRole);
      if (!target) return res.status(400).json({ error: `被指派人员必须是启用的${targetLabel}用户` });
    }
    const technicalStatuses = ['technical', 'poc', 'project', 'bidding', 'contracting', 'signed'];
    if (assignment_type === 'fde' && !technicalStatuses.includes(opportunity.status)) {
      return res.status(400).json({ error: '商机进入技术交流后才可以指派FDE' });
    }

    const assign = db.transaction(() => {
      // 售前保留一名当前负责人；FDE支持多个成员。
      if (assignment_type === 'presales') {
        db.prepare("UPDATE opportunity_assignments SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE opportunity_id = ? AND assignment_type = 'presales' AND status = 'active'").run(opportunity.id);
      }
      let assignedCount = 0;
      let skippedCount = 0;
      for (const targetId of targetIds) {
        const existing = db.prepare('SELECT id FROM opportunity_assignments WHERE opportunity_id = ? AND user_id = ? AND assignment_type = ? AND status = \'active\'').get(opportunity.id, targetId, assignment_type);
        if (existing) {
          // 已处于指派状态，跳过（不重复写入）
          skippedCount += 1;
          continue;
        }
        const previous = db.prepare('SELECT id FROM opportunity_assignments WHERE opportunity_id = ? AND user_id = ? AND assignment_type = ? AND status = \'cancelled\'').get(opportunity.id, targetId, assignment_type);
        if (previous) {
          db.prepare(`UPDATE opportunity_assignments SET status = 'active', assigned_by = ?, remark = ?, assigned_at = CURRENT_TIMESTAMP, cancelled_at = NULL WHERE id = ?`)
            .run(req.user.id, remark || null, previous.id);
        } else {
          db.prepare(`
            INSERT INTO opportunity_assignments (id, opportunity_id, user_id, assignment_type, assigned_by, remark)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(uuidv4(), opportunity.id, targetId, assignment_type, req.user.id, remark || null);
        }
        assignedCount += 1;
      }
      return { assignedCount, skippedCount };
    });
    const { assignedCount, skippedCount } = assign();
    const extra = targetIds.length > 1
      ? `（本次指派${assignedCount}人${skippedCount > 0 ? `，${skippedCount}人已在指派中` : ''}）`
      : '';
    res.status(201).json({ message: `${targetLabel}指派成功${extra}`, assigned_count: assignedCount, skipped_count: skippedCount });
  } catch (error) {
    console.error('指派商机协作人员错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.delete('/:id/assignments/:assignmentId', authMiddleware, (req, res) => {
  try {
    const assignment = db.prepare('SELECT oa.*, o.owner_id FROM opportunity_assignments oa INNER JOIN opportunities o ON o.id = oa.opportunity_id WHERE oa.id = ? AND oa.opportunity_id = ?').get(req.params.assignmentId, req.params.id);
    if (!assignment) return res.status(404).json({ error: '指派记录不存在' });
    const role = req.user.role;
    const allowed = isSystemAdmin(role) || (role === 'sales' && assignment.owner_id === req.user.id) || (role === 'fde_admin' && assignment.assignment_type === 'fde');
    if (!allowed) return res.status(403).json({ error: '无权限取消该指派' });
    db.prepare("UPDATE opportunity_assignments SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").run(assignment.id);
    res.json({ message: '指派已取消' });
  } catch (error) {
    console.error('取消商机指派错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建商机
router.post('/', authMiddleware, (req, res) => {
  try {
    const data = req.body;
    const userId = req.user.id;

    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '只有销售或管理员可以创建商机' });
    }

    // 必填字段验证
    if (!data.name) {
      return res.status(400).json({ error: '商机名称不能为空' });
    }
    if (!data.customer_id) {
      return res.status(400).json({ error: '关联客户不能为空' });
    }
    if (!data.contact_id) {
      return res.status(400).json({ error: '客户联系人不能为空' });
    }
    if (!data.type) {
      return res.status(400).json({ error: '商机类型不能为空' });
    }
    if (!data.products) {
      return res.status(400).json({ error: '意向产品不能为空' });
    }
    if (!data.expected_sign_date) {
      return res.status(400).json({ error: '预计签约时间不能为空' });
    }
    if (!data.amount && data.amount !== 0) {
      return res.status(400).json({ error: '商机金额不能为空' });
    }

    // 商机金额验证
    if (data.amount < 0) {
      return res.status(400).json({ error: '商机金额不能为负数' });
    }

    // 商机类型验证
    const validTypes = ['new_project', 'renewal', 'maintenance'];
    if (!validTypes.includes(data.type)) {
      return res.status(400).json({ error: '商机类型必须为:新项目、续签、维保 之一' });
    }

    // 状态验证(使用跟进阶段的状态值)
    const validStatuses = ['potential', 'technical', 'poc', 'project', 'bidding', 'contracting', 'signed'];
    if (data.status && !validStatuses.includes(data.status)) {
      return res.status(400).json({ error: '商机状态必须为:潜在、技术交流、POC、立项、招投标、合同中、已签 之一' });
    }

    // 客户可以多人协作，但商机必须明确指定一名销售负责人。
    const customer = db.prepare(`
      SELECT id, owner_id FROM customers
      WHERE id = ? AND is_deleted = 0 AND (
        owner_id = ? OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = customers.id AND cm.user_id = ?) OR
        ? IN ('admin', 'super_admin')
      )
    `).get(data.customer_id, userId, userId, req.user.role);

    if (!customer) {
      return res.status(400).json({ error: '无权限为该客户创建商机,该客户不属于您或未共享给您' });
    }

    const ownerId = req.user.role === 'sales' ? req.user.id : data.owner_id;
    const owner = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active'").get(ownerId);
    if (!owner) return res.status(400).json({ error: '请选择一名启用的销售人员负责该商机' });

    const hasPresalesSelection = Object.prototype.hasOwnProperty.call(data, 'presales_user_id');
    const presalesUserId = hasPresalesSelection
      ? (data.presales_user_id || null)
      : getCustomerDefaultPresalesId(data.customer_id);
    if (presalesUserId && !validatePresalesUser(presalesUserId)) {
      return res.status(400).json({ error: '请选择一名启用的售前人员' });
    }

    // 同一客户、同一产品、同一预计签约年度只能存在一个商机。
    const duplicate = db.prepare(`
      SELECT id FROM opportunities
      WHERE customer_id = ? AND LOWER(TRIM(products)) = LOWER(TRIM(?))
        AND strftime('%Y', expected_sign_date) = strftime('%Y', ?)
    `).get(data.customer_id, data.products, data.expected_sign_date);

    if (duplicate) {
      return res.status(400).json({ error: '该客户在同一年度已存在相同产品的商机，不允许重复添加' });
    }

    // 检查联系人是否存在(如果提供了)
    if (data.contact_id) {
      const contact = db.prepare('SELECT id FROM contacts WHERE id = ? AND customer_id = ?').get(data.contact_id, data.customer_id);
      if (!contact) {
        return res.status(400).json({ error: '客户联系人不存在或不属于所选客户' });
      }
    }

    const id = uuidv4();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO opportunities (
          id, name, customer_id, contact_id, type, description, products,
          expected_sign_date, competitors, amount,
          owner_id, status, creator_id, channel_commission_rate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.name,
        data.customer_id,
        data.contact_id || null,
        data.type,
        data.description || null,
        data.products,
        data.expected_sign_date,
        data.competitors || null,
        data.amount,
        ownerId,
        data.status || 'potential',
        req.user.id,
        data.channel_commission_rate !== undefined ? data.channel_commission_rate : null
      );
      if (!customer.owner_id) {
        db.prepare(`
          UPDATE customers
          SET owner_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND owner_id IS NULL
        `).run(ownerId, customer.id);
      }
      db.prepare(`
        INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        customer.id,
        ownerId,
        !customer.owner_id || customer.owner_id === ownerId ? 'owner' : 'collaborator',
        req.user.id
      );
      if (presalesUserId) {
        replaceOpportunityPresales(
          id,
          presalesUserId,
          req.user.id,
          hasPresalesSelection ? '创建商机时指派' : '继承客户级默认售前'
        );
      }
    })();

    res.status(201).json({ message: '商机创建成功', id, presales_user_id: presalesUserId });
  } catch (error) {
    console.error('创建商机错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新商机
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    if (!opportunity) {
      return res.status(404).json({ error: '商机不存在' });
    }

    // 权限检查
    const userRole = req.user.role;
    const userId = req.user.id;

    if (userRole === 'sales' && opportunity.owner_id !== userId) {
      return res.status(403).json({ error: '无权限编辑该商机' });
    }
    if (!['sales', 'admin', 'super_admin'].includes(userRole)) {
      return res.status(403).json({ error: '只有销售或管理员可以编辑商机' });
    }

    // 字段验证
    if (data.amount !== undefined && data.amount < 0) {
      return res.status(400).json({ error: '商机金额不能为负数' });
    }

    // 商机类型验证
    if (data.type) {
      const validTypes = ['new_project', 'renewal', 'maintenance'];
      if (!validTypes.includes(data.type)) {
        return res.status(400).json({ error: '商机类型必须为:新项目、续签、维保 之一' });
      }
    }

    // 状态验证(使用跟进阶段的状态值)
    if (data.status) {
      const validStatuses = ['potential', 'technical', 'poc', 'project', 'bidding', 'contracting', 'signed', 'lost'];
      if (!validStatuses.includes(data.status)) {
        return res.status(400).json({ error: '商机状态无效' });
      }
    }

    // 检查客户是否存在
    if (data.customer_id) {
      const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND is_deleted = 0').get(data.customer_id);
      if (!customer) {
        return res.status(400).json({ error: '关联客户不存在' });
      }
      if (userRole === 'sales' && !isCustomerMember(data.customer_id, userId)) {
        return res.status(403).json({ error: '无权限将商机关联到该客户' });
      }
    }

    // 检查联系人是否存在
    const targetCustomerIdForContact = data.customer_id || opportunity.customer_id;
    const targetContactId = data.contact_id !== undefined ? data.contact_id : opportunity.contact_id;
    if (targetContactId) {
      const contact = db.prepare('SELECT id FROM contacts WHERE id = ? AND customer_id = ?').get(targetContactId, targetCustomerIdForContact);
      if (!contact) {
        return res.status(400).json({ error: '客户联系人不存在或不属于所选客户' });
      }
    }

    const targetCustomerId = data.customer_id || opportunity.customer_id;
    const targetProducts = data.products || opportunity.products;
    const targetDate = data.expected_sign_date || opportunity.expected_sign_date;
    if (targetCustomerId && targetProducts && targetDate) {
      const duplicate = db.prepare(`
        SELECT id FROM opportunities WHERE id != ? AND customer_id = ?
          AND LOWER(TRIM(products)) = LOWER(TRIM(?))
          AND strftime('%Y', expected_sign_date) = strftime('%Y', ?)
      `).get(id, targetCustomerId, targetProducts, targetDate);
      if (duplicate) return res.status(400).json({ error: '该客户在同一年度已存在相同产品的商机' });
    }

    if (data.owner_id && userRole === 'sales' && data.owner_id !== userId) {
      return res.status(403).json({ error: '销售不能转移商机负责人，请由管理员操作' });
    }
    if (data.owner_id) {
      const owner = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active'").get(data.owner_id);
      if (!owner) return res.status(400).json({ error: '商机负责人必须是启用的销售人员' });
    }

    const shouldUpdatePresales = Object.prototype.hasOwnProperty.call(data, 'presales_user_id');
    const nextPresalesUserId = shouldUpdatePresales ? (data.presales_user_id || null) : null;
    if (nextPresalesUserId && !validatePresalesUser(nextPresalesUserId)) {
      return res.status(400).json({ error: '请选择一名启用的售前人员' });
    }

    const updateFields = [];
    const updateValues = [];

    // 可更新字段
    const allowedFields = [
      'name', 'customer_id', 'contact_id', 'type', 'description',
      'products', 'expected_sign_date', 'competitors',
      'amount', 'status', 'channel_commission_rate'
    ];
    if (isSystemAdmin(userRole)) allowedFields.push('owner_id');

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateFields.push(`${field} = ?`);
        updateValues.push(data[field]);
      }
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.transaction(() => {
      db.prepare(`UPDATE opportunities SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

      if (shouldUpdatePresales) {
        replaceOpportunityPresales(id, nextPresalesUserId, req.user.id, '编辑商机时调整');
      }

      // 商机状态变更为已签时,同步更新关联的销售跟进状态
      if (data.status === 'signed') {
        db.prepare(`UPDATE followups SET stage = 'signed', result = 'success', updated_at = CURRENT_TIMESTAMP WHERE opportunity_id = ?`).run(id);
      }

      if (data.status && data.status !== opportunity.status) {
        logOpportunityStatusChange(id, opportunity.status, data.status, req.user.id, null);
      }
    })();

    res.json({ message: '商机更新成功' });
  } catch (error) {
    console.error('更新商机错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除商机
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    if (!opportunity) {
      return res.status(404).json({ error: '商机不存在' });
    }

    // 权限检查
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!['sales', 'admin', 'super_admin'].includes(userRole)) {
      return res.status(403).json({ error: '当前角色无权限删除商机' });
    }
    if (userRole === 'sales' && opportunity.owner_id !== userId) {
      return res.status(403).json({ error: '无权限删除该商机' });
    }

    db.prepare('DELETE FROM opportunities WHERE id = ?').run(id);

    res.json({ message: '商机删除成功' });
  } catch (error) {
    console.error('删除商机错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取客户的联系人列表
router.get('/customers/:customerId/contacts', authMiddleware, (req, res) => {
  try {
    const { canViewCustomer } = require('../middleware/role-policy');
    if (!canViewCustomer(req.user, req.params.customerId)) {
      return res.status(403).json({ error: '无权限查看该客户联系人' });
    }
    const contacts = db.prepare(`
      SELECT id, name, position, phone, email, is_kp, is_primary
      FROM contacts
      WHERE customer_id = ?
      ORDER BY is_primary DESC, name ASC
    `).all(req.params.customerId);

    res.json({ contacts });
  } catch (error) {
    console.error('获取客户联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取客户的渠道信息
router.get('/customers/:customerId/channel-info', authMiddleware, (req, res) => {
  try {
    const { customerId } = req.params;
    const { canViewCustomer, canSeeCommercial } = require('../middleware/role-policy');
    if (!canSeeCommercial(req.user.role) || !canViewCustomer(req.user, customerId)) {
      return res.status(403).json({ error: '无权限查看渠道分成信息' });
    }
    const result = db.prepare(`
      SELECT ch.id as channel_id, ch.name as channel_name, ch.commission_rate,
             cc.commission_rate as customer_commission_rate
      FROM channel_customers cc
      INNER JOIN channels ch ON ch.id = cc.channel_id
      WHERE cc.customer_id = ?
    `).get(customerId);

    if (!result) {
      return res.json({ channel_id: null, channel_name: null, commission_rate: null });
    }

    // 优先使用客户级别的分成比例,其次用渠道默认比例
    const effectiveRate = result.customer_commission_rate !== null ? result.customer_commission_rate : result.commission_rate;

    res.json({
      channel_id: result.channel_id,
      channel_name: result.channel_name,
      commission_rate: effectiveRate
    });
  } catch (error) {
    console.error('获取客户渠道信息错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
