const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { canViewCustomer } = require('../middleware/role-policy');
const { sendCsv } = require('../utils/csv');
// 复用自动归入公海任务的计时口径，保证列表展示的倒计时与实际回收行为一致
const { getRecycleDays, getLocalDateOffset, RECYCLE_BASELINE_SQL } = require('../services/customer-recycle');

const router = express.Router();

const customerWriteRoles = ['sales', 'admin', 'super_admin'];

// 客户级售前指派总开关。
// 售前已统一收敛到「商机管理」按商机指派，客户管理/公海客户不再写入 customer_presales_assignments。
// 如需恢复客户级售前指派，把该开关改为 true 即可，下方原有实现全部保留。
const CUSTOMER_PRESALES_ASSIGN_ENABLED = false;

// 运营只允许新增公海客户；技术角色只允许填写已指派客户的售前跟进。
router.use(authMiddleware, (req, res, next) => {
  if (req.method === 'GET') return next();
  if (req.user.role === 'operations' && req.method === 'POST' && req.path === '/pool/create') return next();
  if (req.user.role === 'presales' && req.method === 'POST' && /^\/[^/]+\/presales-followups$/.test(req.path)) return next();
  // FDE管理员仅允许客户级FDE指派与取消指派，路由内另有 canAssign 校验
  if (req.user.role === 'fde_admin' && req.method === 'POST' && /^\/[^/]+\/fde(\/cancel)?$/.test(req.path)) return next();
  if (!customerWriteRoles.includes(req.user.role)) return res.status(403).json({ error: '当前角色无权修改客户数据' });
  next();
});

// 验证手机号格式
function validatePhone(phone) {
  return phone === undefined || phone === null || String(phone).trim().length > 0;
}

// 验证邮箱格式
function validateEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeOptionalId(value) {
  return value === undefined || value === null || value === '' ? null : value;
}

function normalizeTagIds(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function getCustomerCreateError(error) {
  const message = error && error.message ? error.message : '';
  if (message.includes('no such column') || message.includes('no such table')) {
    return '数据库结构未完成升级，请重启后端服务执行数据库迁移';
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return '关联数据已失效，请重新选择销售、渠道或标签后再提交';
  }
  if (message.includes('UNIQUE constraint failed')) {
    return '客户或关联记录已存在，请检查重复数据';
  }
  return '服务器错误';
}

// 获取客户列表
router.get('/', authMiddleware, (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      name,
      type,
      status,
      owner_id,
      stage,
      level,
      region,
      source,
      industry,
      exclude_public,
      sort = 'last_followup_at',
      order = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    const userRole = req.user.role;
    const userId = req.user.id;
    let opportunityMetricScope = '';
    if (userRole === 'sales') {
      opportunityMetricScope = ` AND metric_o.owner_id = '${userId}'`;
    } else if (userRole === 'presales') {
      opportunityMetricScope = ` AND EXISTS (
        SELECT 1 FROM opportunity_assignments metric_a
        WHERE metric_a.opportunity_id = metric_o.id AND metric_a.user_id = '${userId}'
          AND metric_a.assignment_type = 'presales' AND metric_a.status = 'active'
      )`;
    } else if (userRole === 'fde') {
      opportunityMetricScope = ` AND EXISTS (
        SELECT 1 FROM opportunity_assignments metric_a
        WHERE metric_a.opportunity_id = metric_o.id AND metric_a.user_id = '${userId}'
          AND metric_a.assignment_type = 'fde' AND metric_a.status = 'active'
      )`;
    }
    // fde_admin 与 admin 一致，使用全量商机范围，opportunityMetricScope 保持空字符串

    // 构建查询条件
    let whereClause = 'c.is_deleted = 0';
    const params = [];

    // 客户管理主列表只展示私有客户，公海客户统一从公海客户入口查看。
    whereClause += ` AND c.status != 'public'`

    // 销售可查看自己负责商机或作为协作成员参与的客户。
    if (userRole === 'sales') {
      whereClause += ` AND (
        c.owner_id = '${userId}' OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = c.id AND cm.user_id = '${userId}') OR
        EXISTS (SELECT 1 FROM opportunities o WHERE o.customer_id = c.id AND o.owner_id = '${userId}')
      )`;
    } else if (userRole === 'presales') {
      whereClause += ` AND (
        EXISTS (
          SELECT 1 FROM opportunities o INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
          WHERE o.customer_id = c.id AND oa.user_id = '${userId}' AND oa.assignment_type = 'presales' AND oa.status = 'active'
        ) OR EXISTS (
          SELECT 1 FROM customer_presales_assignments cpa
          WHERE cpa.customer_id = c.id AND cpa.user_id = '${userId}' AND cpa.status = 'active'
        )
      )`;
    } else if (userRole === 'fde') {
      whereClause += ` AND (
        EXISTS (SELECT 1 FROM customer_fde_assignments cfa
          WHERE cfa.customer_id = c.id AND cfa.user_id = '${userId}' AND cfa.status = 'active')
        OR EXISTS (SELECT 1 FROM opportunities o INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
          WHERE o.customer_id = c.id AND oa.user_id = '${userId}' AND oa.assignment_type = 'fde' AND oa.status = 'active')
      )`;
    }

    // 查询条件
    if (name) {
      whereClause += ` AND c.name LIKE ?`;
      params.push(`%${name}%`);
    }
    if (type) {
      whereClause += ` AND c.type = ?`;
      params.push(type);
    }
    if (status) {
      const statusList = status.split(',').filter(Boolean).filter(item => item !== 'public');
      if (statusList.length > 1) {
        const placeholders = statusList.map(() => '?').join(',');
        whereClause += ` AND c.status IN (${placeholders})`;
        params.push(...statusList);
      } else if (statusList.length === 1) {
        whereClause += ` AND c.status = ?`;
        params.push(statusList[0]);
      }
    }
    if (owner_id) {
      whereClause += ` AND c.owner_id = ?`;
      params.push(owner_id);
    }
    if (stage) {
      whereClause += ` AND c.follow_stage = ?`;
      params.push(stage);
    }
    if (level) {
      whereClause += ` AND c.level = ?`;
      params.push(level);
    }
    if (region) {
      whereClause += ` AND c.region LIKE ?`;
      params.push(`%${region}%`);
    }
    if (source) {
      whereClause += ` AND c.source = ?`;
      params.push(source);
    }
    if (industry) {
      whereClause += ` AND c.industry = ?`;
      params.push(industry);
    }

    // 查询总数
    const { total } = db.prepare(`SELECT COUNT(*) as total FROM customers c WHERE ${whereClause}`).get(...params);

    // 公海倒计时参数：与自动归入公海任务共用同一份天数配置和本地日期口径。
    // 两者均为受控数值/日期字符串，直接拼进 SQL，避免打乱下方 ? 占位符的绑定顺序。
    const recycleDays = getRecycleDays();
    const recycleToday = getLocalDateOffset(0);

    // 查询数据
    const customers = db.prepare(`
      SELECT
        c.*,
        u.name as owner_name,
        u2.name as secondary_owner_name,
        d.name as department_name,
        ch.name as channel_name,
        -- 掉入公海的截止日期与剩余天数（<=0 表示已到期，当晚 00:05 会被自动回收）
        date(${RECYCLE_BASELINE_SQL}, '+${recycleDays} days') as recycle_deadline,
        CAST(julianday(date(${RECYCLE_BASELINE_SQL}, '+${recycleDays} days'))
             - julianday('${recycleToday}') AS INTEGER) as recycle_days_left,
        -- 售前统一由「商机管理」指派，这里从该客户在跟商机的商机级售前聚合派生（去重后逗号拼接）
        COALESCE((
          SELECT GROUP_CONCAT(DISTINCT pu.name)
          FROM opportunities metric_o
          INNER JOIN opportunity_assignments metric_pa ON metric_pa.opportunity_id = metric_o.id
          INNER JOIN users pu ON pu.id = metric_pa.user_id
          WHERE metric_o.customer_id = c.id
            AND metric_o.status NOT IN ('signed', 'lost')
            AND metric_pa.assignment_type = 'presales' AND metric_pa.status = 'active'
            ${opportunityMetricScope}
        ), '') as presales_names,
        -- 默认售前取最近一次商机级售前指派，字段名保持不变，供新增商机时自动带入
        (SELECT metric_pa.user_id
          FROM opportunities metric_o
          INNER JOIN opportunity_assignments metric_pa ON metric_pa.opportunity_id = metric_o.id
          WHERE metric_o.customer_id = c.id
            AND metric_o.status NOT IN ('signed', 'lost')
            AND metric_pa.assignment_type = 'presales' AND metric_pa.status = 'active'
            ${opportunityMetricScope}
          ORDER BY metric_pa.assigned_at DESC LIMIT 1) as default_presales_id,
        (SELECT pu.name
          FROM opportunities metric_o
          INNER JOIN opportunity_assignments metric_pa ON metric_pa.opportunity_id = metric_o.id
          INNER JOIN users pu ON pu.id = metric_pa.user_id
          WHERE metric_o.customer_id = c.id
            AND metric_o.status NOT IN ('signed', 'lost')
            AND metric_pa.assignment_type = 'presales' AND metric_pa.status = 'active'
            ${opportunityMetricScope}
          ORDER BY metric_pa.assigned_at DESC LIMIT 1) as default_presales_name,
        (SELECT cfa.user_id FROM customer_fde_assignments cfa
          WHERE cfa.customer_id = c.id AND cfa.status = 'active'
          ORDER BY cfa.assigned_at DESC LIMIT 1) as customer_fde_id,
        (SELECT fu.name FROM customer_fde_assignments cfa
          INNER JOIN users fu ON fu.id = cfa.user_id
          WHERE cfa.customer_id = c.id AND cfa.status = 'active'
          ORDER BY cfa.assigned_at DESC LIMIT 1) as customer_fde_name,
        (SELECT COUNT(*) FROM opportunities metric_o
          WHERE metric_o.customer_id = c.id
            AND metric_o.status NOT IN ('signed', 'lost')${opportunityMetricScope}) as active_opportunity_count,
        (SELECT COUNT(*) FROM opportunities metric_o
          WHERE metric_o.customer_id = c.id
            AND metric_o.status NOT IN ('signed', 'lost')${opportunityMetricScope}
            AND EXISTS (
              SELECT 1 FROM opportunity_assignments metric_pa
              WHERE metric_pa.opportunity_id = metric_o.id
                AND metric_pa.assignment_type = 'presales' AND metric_pa.status = 'active'
            )) as active_opportunity_presales_count,
        (SELECT COUNT(*) FROM contacts WHERE customer_id = c.id) as contact_count,
        (SELECT COUNT(*) FROM followups WHERE customer_id = c.id) as followup_count,
        (SELECT COUNT(*) FROM contracts WHERE customer_id = c.id) as contract_count,
        (SELECT MIN(expire_date) FROM contracts WHERE customer_id = c.id AND expire_date IS NOT NULL) as contract_expire_date,
        (SELECT MIN(planned_date) FROM payments WHERE customer_id = c.id AND status != '已回款' AND planned_date IS NOT NULL) as next_payment_date,
        COALESCE(
          (SELECT GROUP_CONCAT(t.name, ',')
           FROM customer_tag_relations r
           INNER JOIN customer_tags t ON t.id = r.tag_id
           WHERE r.customer_id = c.id),
          ''
        ) as tag_names
      FROM customers c
      LEFT JOIN users u ON c.owner_id = u.id
      LEFT JOIN users u2 ON c.secondary_owner_id = u2.id
      LEFT JOIN departments d ON c.department_id = d.id
      LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE ${whereClause}
      ORDER BY c.${['name', 'created_at', 'updated_at', 'last_followup_at', 'level', 'status'].includes(sort) ? sort : 'last_followup_at'} ${String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // 解析标签字符串为数组
    customers.forEach(customer => {
      customer.tags = customer.tag_names ? customer.tag_names.split(',') : [];
      delete customer.tag_names;
      if (['presales', 'fde', 'fde_admin'].includes(userRole)) {
        customer.total_amount = null;
        customer.unpaid_amount = null;
        customer.total_received = null;
        customer.budget_range = null;
        customer.owner_share_percent = null;
      }
    });

    res.json({
      data: customers,
      // 公海倒计时使用的自动释放天数，前端提示文案据此展示，避免硬编码
      recycle_days: recycleDays,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取客户列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取客户在跟商机及其商机级售前，用于客户列表的统计明细。
router.get('/:id/opportunity-presales', authMiddleware, (req, res) => {
  try {
    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ? AND is_deleted = 0').get(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    if (!canViewCustomer(req.user, customer.id)) return res.status(403).json({ error: '无权限查看该客户商机' });

    let scope = '';
    const params = [customer.id];
    if (req.user.role === 'sales') {
      scope = ' AND o.owner_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'presales') {
      scope = ` AND EXISTS (SELECT 1 FROM opportunity_assignments own_a
        WHERE own_a.opportunity_id = o.id AND own_a.user_id = ?
          AND own_a.assignment_type = 'presales' AND own_a.status = 'active')`;
      params.push(req.user.id);
    } else if (req.user.role === 'fde') {
      scope = ` AND EXISTS (SELECT 1 FROM opportunity_assignments own_a
        WHERE own_a.opportunity_id = o.id AND own_a.user_id = ?
          AND own_a.assignment_type = 'fde' AND own_a.status = 'active')`;
      params.push(req.user.id);
    } else if (req.user.role === 'fde_admin') {
      scope = ` AND EXISTS (SELECT 1 FROM opportunity_assignments own_a
        WHERE own_a.opportunity_id = o.id
          AND own_a.assignment_type = 'fde' AND own_a.status = 'active')`;
    }

    const opportunities = db.prepare(`
      SELECT o.id, o.name, o.status, o.products, o.expected_sign_date,
        owner.name AS owner_name,
        COALESCE((SELECT GROUP_CONCAT(pu.name, '、')
          FROM opportunity_assignments pa INNER JOIN users pu ON pu.id = pa.user_id
          WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active'), '') AS presales_names
      FROM opportunities o
      LEFT JOIN users owner ON owner.id = o.owner_id
      WHERE o.customer_id = ? AND o.status NOT IN ('signed', 'lost')${scope}
        AND EXISTS (SELECT 1 FROM opportunity_assignments pa_count
          WHERE pa_count.opportunity_id = o.id
            AND pa_count.assignment_type = 'presales' AND pa_count.status = 'active')
      ORDER BY o.expected_sign_date ASC, o.created_at DESC
    `).all(...params);

    res.json({ customer, data: opportunities, total: opportunities.length });
  } catch (error) {
    console.error('获取客户商机售前明细错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置客户级 FDE。该关系只授予客户协作权限，不替代商机级 FDE 指派。
router.post('/:id/fde', authMiddleware, (req, res) => {
  try {
    const customer = db.prepare(
      "SELECT id, status FROM customers WHERE id = ? AND is_deleted = 0"
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    if (customer.status === 'public') return res.status(400).json({ error: '请在客户管理中为已领取客户指派FDE' });

    const canAssign = ['admin', 'super_admin'].includes(req.user.role)
      || (['sales', 'fde_admin'].includes(req.user.role) && canViewCustomer(req.user, customer.id));
    if (!canAssign) return res.status(403).json({ error: '无权限指派客户级FDE' });

    const { user_id, remark } = req.body;
    const fde = db.prepare(
      "SELECT id FROM users WHERE id = ? AND role = 'fde' AND status = 'active'"
    ).get(user_id);
    if (!fde) return res.status(400).json({ error: '请选择一名启用的FDE人员' });

    db.transaction(() => {
      const active = db.prepare(`
        SELECT id, user_id FROM customer_fde_assignments
        WHERE customer_id = ? AND status = 'active'
        ORDER BY assigned_at DESC LIMIT 1
      `).get(customer.id);
      if (active?.user_id === user_id) {
        db.prepare(`
          UPDATE customer_fde_assignments
          SET remark = ?, assigned_by = ?, assigned_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(remark?.trim() || null, req.user.id, active.id);
        return;
      }
      db.prepare(`
        UPDATE customer_fde_assignments
        SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
        WHERE customer_id = ? AND status = 'active'
      `).run(customer.id);
      db.prepare(`
        INSERT INTO customer_fde_assignments
          (id, customer_id, user_id, assigned_by, status, remark)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(uuidv4(), customer.id, user_id, req.user.id, remark?.trim() || null);
    })();

    res.json({ message: '客户级FDE指派成功' });
  } catch (error) {
    console.error('指派客户级FDE错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/:id/fde/cancel', authMiddleware, (req, res) => {
  try {
    const customer = db.prepare(
      "SELECT id, status FROM customers WHERE id = ? AND is_deleted = 0"
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });
    if (customer.status === 'public') return res.status(400).json({ error: '公海客户不支持客户级FDE指派' });

    const canAssign = ['admin', 'super_admin'].includes(req.user.role)
      || (['sales', 'fde_admin'].includes(req.user.role) && canViewCustomer(req.user, customer.id));
    if (!canAssign) return res.status(403).json({ error: '无权限取消客户级FDE指派' });

    const activeAssignment = db.prepare(`
      SELECT id FROM customer_fde_assignments
      WHERE customer_id = ? AND status = 'active'
      ORDER BY assigned_at DESC LIMIT 1
    `).get(customer.id);
    if (!activeAssignment) return res.status(404).json({ error: '该客户暂无客户级FDE指派' });

    db.prepare(`
      UPDATE customer_fde_assignments
      SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
      WHERE customer_id = ? AND status = 'active'
    `).run(customer.id);
    res.json({ message: '已取消客户级FDE指派' });
  } catch (error) {
    console.error('取消客户级FDE指派错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 导出与客户列表相同权限范围、相同筛选条件下的全部客户。
router.get('/export', authMiddleware, (req, res) => {
  try {
    const { name, type, status, owner_id, stage, level, region, source, industry } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;
    let whereClause = "c.is_deleted = 0 AND c.status != 'public'";
    const params = [];

    if (userRole === 'sales') {
      whereClause += ` AND (
        c.owner_id = ? OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = c.id AND cm.user_id = ?) OR
        EXISTS (SELECT 1 FROM opportunities o WHERE o.customer_id = c.id AND o.owner_id = ?)
      )`;
      params.push(userId, userId, userId);
    } else if (userRole === 'presales') {
      whereClause += ` AND (
        EXISTS (SELECT 1 FROM opportunities o INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
          WHERE o.customer_id = c.id AND oa.user_id = ? AND oa.assignment_type = 'presales' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM customer_presales_assignments cpa
          WHERE cpa.customer_id = c.id AND cpa.user_id = ? AND cpa.status = 'active')
      )`;
      params.push(userId, userId);
    } else if (userRole === 'fde') {
      whereClause += ` AND (
        EXISTS (SELECT 1 FROM customer_fde_assignments cfa WHERE cfa.customer_id = c.id AND cfa.user_id = ? AND cfa.status = 'active')
        OR EXISTS (SELECT 1 FROM opportunities o INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
          WHERE o.customer_id = c.id AND oa.user_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active')
      )`;
      params.push(userId, userId);
    }

    if (name) { whereClause += ' AND c.name LIKE ?'; params.push(`%${name}%`); }
    if (type) { whereClause += ' AND c.type = ?'; params.push(type); }
    if (status) {
      const statusList = String(status).split(',').filter(Boolean).filter(item => item !== 'public');
      if (statusList.length) {
        whereClause += ` AND c.status IN (${statusList.map(() => '?').join(',')})`;
        params.push(...statusList);
      }
    }
    if (owner_id) { whereClause += ' AND c.owner_id = ?'; params.push(owner_id); }
    if (stage) { whereClause += ' AND c.follow_stage = ?'; params.push(stage); }
    if (level) { whereClause += ' AND c.level = ?'; params.push(level); }
    if (region) { whereClause += ' AND c.region LIKE ?'; params.push(`%${region}%`); }
    if (source) { whereClause += ' AND c.source = ?'; params.push(source); }
    if (industry) { whereClause += ' AND c.industry = ?'; params.push(industry); }

    const rows = db.prepare(`
      SELECT c.name, c.customer_short_name, c.credit_code, c.type, c.industry, c.region,
        c.source, c.status, c.level, c.contact_person, c.phone, c.company_phone,
        owner.name AS owner_name, secondary.name AS secondary_owner_name,
        -- 售前统一由「商机管理」指派，导出口径与列表一致：取该客户在跟商机的商机级售前（去重）
        -- GROUP_CONCAT 的 DISTINCT 形式不支持自定义分隔符，故先按逗号聚合再替换为顿号
        COALESCE((SELECT REPLACE(GROUP_CONCAT(DISTINCT u.name), ',', '、')
          FROM opportunities o
          INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
          INNER JOIN users u ON u.id = oa.user_id
          WHERE o.customer_id = c.id AND o.status NOT IN ('signed', 'lost')
            AND oa.assignment_type = 'presales' AND oa.status = 'active'), '') AS presales_names,
        COALESCE((SELECT GROUP_CONCAT(u.name, '、') FROM customer_fde_assignments cfa
          INNER JOIN users u ON u.id = cfa.user_id
          WHERE cfa.customer_id = c.id AND cfa.status = 'active'), '') AS customer_fde_names,
        (SELECT COUNT(*) FROM contacts ct WHERE ct.customer_id = c.id) AS contact_count,
        (SELECT COUNT(*) FROM opportunities o WHERE o.customer_id = c.id) AS opportunity_count,
        (SELECT COUNT(*) FROM followups f WHERE f.customer_id = c.id) AS followup_count,
        c.last_followup_at, c.created_at
      FROM customers c
      LEFT JOIN users owner ON owner.id = c.owner_id
      LEFT JOIN users secondary ON secondary.id = c.secondary_owner_id
      WHERE ${whereClause}
      ORDER BY c.created_at DESC
    `).all(...params).map(row => ({
      ...row,
      type: ({ direct_customer: '直客', external_channel: '外部渠道客户', company_channel: '公司渠道客户', enterprise: '企业客户', individual: '个人客户' })[row.type] || row.type,
      status: ({ potential: '潜在', technical: '技术交流', poc: 'POC', project: '立项', bidding: '招投标', contracting: '合同中', signed: '已签合同', lost: '丢失', blacklist: '黑名单' })[row.status] || row.status,
      owner_name: row.owner_name || '未分配',
      secondary_owner_name: row.secondary_owner_name || '',
      presales_names: row.presales_names || '未指派'
    }));

    const headers = [
      { key: 'name', label: '客户名称' }, { key: 'customer_short_name', label: '客户简称' },
      { key: 'credit_code', label: '社会信用代码' }, { key: 'type', label: '客户类型' },
      { key: 'industry', label: '所属行业' }, { key: 'region', label: '所在地区' },
      { key: 'source', label: '客户来源' }, { key: 'status', label: '客户状态' },
      { key: 'level', label: '客户等级' }, { key: 'contact_person', label: '联系人' },
      { key: 'phone', label: '联系电话' }, { key: 'company_phone', label: '公司电话' },
      { key: 'owner_name', label: '归属销售' }, { key: 'secondary_owner_name', label: '协作销售' },
      { key: 'presales_names', label: '售前' }, { key: 'customer_fde_names', label: '客户级FDE' },
      { key: 'contact_count', label: '联系人数' },
      { key: 'opportunity_count', label: '商机数' }, { key: 'followup_count', label: '跟进次数' },
      { key: 'last_followup_at', label: '最近跟进时间' }, { key: 'created_at', label: '创建时间' }
    ];
    sendCsv(res, `customers_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  } catch (error) {
    console.error('导出客户错误:', error);
    res.status(500).json({ error: '客户导出失败' });
  }
});

// 新增公海客户：创建后不分配负责人，直接进入公海，等待销售领取。
router.post('/pool/create', authMiddleware, (req, res) => {
  try {
    if (!['sales', 'admin', 'super_admin', 'operations'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能新增公海客户' });
    }
    const data = req.body;
    if (!data.name || !data.customer_short_name || !data.industry || !data.region || !data.source || !data.contact_person || !data.phone) {
      return res.status(400).json({ error: '客户名称、简称、行业、地区、来源、联系人和联系电话不能为空' });
    }
    const creditCode = data.credit_code && data.credit_code.trim() ? data.credit_code.trim() : null;
    const validTypes = ['external_channel', 'direct_customer', 'company_channel'];
    if (!validTypes.includes(data.type)) return res.status(400).json({ error: '客户类型无效' });
    const channelId = normalizeOptionalId(data.channel_id);
    let channelName = data.channel_name || null;
    if (channelId) {
      const channel = db.prepare('SELECT id, name FROM channels WHERE id = ?').get(channelId);
      if (!channel) return res.status(400).json({ error: '渠道不存在' });
      channelName = channelName || channel.name;
    }
    if ((data.type === 'external_channel' || data.type === 'company_channel') && !channelName) {
      return res.status(400).json({ error: '渠道客户必须选择渠道' });
    }
    const validIndustries = ['互联网平台', '汽车', '智能制造', '银行', '证券', '保险', '消金', '基金', '零售', '政府', '其他'];
    if (!validIndustries.includes(data.industry)) return res.status(400).json({ error: '所属行业无效' });
    if (!validatePhone(data.phone)) return res.status(400).json({ error: '联系电话格式不正确' });
    if (db.prepare('SELECT id FROM customers WHERE name = ? AND is_deleted = 0').get(data.name)) {
      return res.status(400).json({ error: '客户名称已存在' });
    }
    if (creditCode && db.prepare('SELECT id FROM customers WHERE credit_code = ? AND is_deleted = 0').get(creditCode)) {
      return res.status(400).json({ error: '统一社会信用代码已存在' });
    }
    const presalesUserId = normalizeOptionalId(data.presales_user_id);
    if (presalesUserId) {
      if (!['sales', 'admin', 'super_admin', 'operations'].includes(req.user.role)) {
        return res.status(403).json({ error: '当前角色不能指派售前' });
      }
      const presales = db.prepare(
        "SELECT id FROM users WHERE id = ? AND role = 'presales' AND status = 'active'"
      ).get(presalesUserId);
      if (!presales) return res.status(400).json({ error: '请选择有效的售前人员' });
    }

    const id = uuidv4();
    const createPoolCustomer = db.transaction(() => {
      db.prepare(`
        INSERT INTO customers (
          id, name, customer_short_name, type, channel_name, channel_id, credit_code,
          industry, scale, region, address, website, company_phone, contact_person,
          phone, source, notes, status, public_at, public_reason, creator_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', NULL, NULL, ?)
      `).run(
        id, data.name, data.customer_short_name, data.type, channelName,
        channelId, creditCode, data.industry, data.scale || null,
        data.region, data.address || null, data.website || null, data.company_phone || null,
        data.contact_person || null, data.phone || null, data.source, data.notes || null,
        req.user.id
      );

      if (data.contact_person && data.phone) {
        db.prepare(`
          INSERT INTO contacts (id, customer_id, name, phone, is_primary, is_kp, creator_id)
          VALUES (?, ?, ?, ?, 1, 1, ?)
        `).run(uuidv4(), id, data.contact_person, data.phone, req.user.id);
      }
      if (channelId) {
        db.prepare('INSERT INTO channel_customers (id, channel_id, customer_id) VALUES (?, ?, ?)')
          .run(uuidv4(), channelId, id);
      }
      // 客户级售前已停用：新增公海客户时不再写入售前指派，售前统一在商机上设置
      if (CUSTOMER_PRESALES_ASSIGN_ENABLED && presalesUserId) {
        db.prepare(`
          INSERT INTO customer_presales_assignments
            (id, customer_id, user_id, assigned_by, status, remark)
          VALUES (?, ?, ?, ?, 'active', ?)
        `).run(uuidv4(), id, presalesUserId, req.user.id, data.presales_remark?.trim() || null);
      }
    });
    createPoolCustomer();

    res.status(201).json({ message: '公海客户创建成功', id });
  } catch (error) {
    console.error('新增公海客户错误:', error);
    res.status(500).json({ error: getCustomerCreateError(error) });
  }
});

// 编辑公海客户资料，可同时补充、更换或清除售前指派。
router.put('/pool/:id', authMiddleware, (req, res) => {
  try {
    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能编辑公海客户' });
    }
    const data = req.body;
    const customer = db.prepare(
      "SELECT * FROM customers WHERE id = ? AND status = 'public' AND is_deleted = 0"
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '公海客户不存在' });

    if (!data.name || !data.customer_short_name || !data.industry || !data.region || !data.source || !data.contact_person || !data.phone) {
      return res.status(400).json({ error: '客户名称、简称、行业、地区、来源、联系人和联系电话不能为空' });
    }
    const validTypes = ['external_channel', 'direct_customer', 'company_channel'];
    if (!validTypes.includes(data.type)) return res.status(400).json({ error: '客户类型无效' });
    if ((data.type === 'external_channel' || data.type === 'company_channel') && !data.channel_name?.trim()) {
      return res.status(400).json({ error: '渠道客户必须填写渠道名称' });
    }
    const validIndustries = ['互联网平台', '汽车', '智能制造', '银行', '证券', '保险', '消金', '基金', '零售', '政府', '其他'];
    if (!validIndustries.includes(data.industry)) return res.status(400).json({ error: '所属行业无效' });
    if (!validatePhone(data.phone)) return res.status(400).json({ error: '联系电话格式不正确' });

    const creditCode = data.credit_code && data.credit_code.trim() ? data.credit_code.trim() : null;
    if (db.prepare('SELECT id FROM customers WHERE name = ? AND id != ? AND is_deleted = 0').get(data.name, customer.id)) {
      return res.status(400).json({ error: '客户名称已存在' });
    }
    if (creditCode && db.prepare('SELECT id FROM customers WHERE credit_code = ? AND id != ? AND is_deleted = 0').get(creditCode, customer.id)) {
      return res.status(400).json({ error: '统一社会信用代码已存在' });
    }

    const presalesUserId = normalizeOptionalId(data.presales_user_id);
    if (presalesUserId) {
      const presales = db.prepare(
        "SELECT id FROM users WHERE id = ? AND role = 'presales' AND status = 'active'"
      ).get(presalesUserId);
      if (!presales) return res.status(400).json({ error: '请选择有效的售前人员' });
    }

    const updatePoolCustomer = db.transaction(() => {
      db.prepare(`
        UPDATE customers SET
          name = ?, customer_short_name = ?, credit_code = ?, type = ?, channel_name = ?,
          industry = ?, region = ?, source = ?, company_phone = ?, contact_person = ?,
          phone = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        data.name.trim(), data.customer_short_name.trim(), creditCode, data.type,
        data.type === 'direct_customer' ? null : data.channel_name.trim(),
        data.industry, data.region.trim(), data.source, data.company_phone?.trim() || null,
        data.contact_person.trim(), data.phone.trim(), data.notes?.trim() || null, customer.id
      );

      const primaryContact = db.prepare(
        'SELECT id FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1'
      ).get(customer.id);
      if (primaryContact) {
        db.prepare('UPDATE contacts SET name = ?, phone = ?, is_primary = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(data.contact_person.trim(), data.phone.trim(), primaryContact.id);
      } else {
        db.prepare(`
          INSERT INTO contacts (id, customer_id, name, phone, is_primary, is_kp, creator_id)
          VALUES (?, ?, ?, ?, 1, 1, ?)
        `).run(uuidv4(), customer.id, data.contact_person.trim(), data.phone.trim(), req.user.id);
      }

      // 客户级售前已停用：编辑公海客户时不再调整售前指派，售前统一在商机上设置。
      // 原有实现完整保留在开关内，恢复 CUSTOMER_PRESALES_ASSIGN_ENABLED 即可生效。
      if (CUSTOMER_PRESALES_ASSIGN_ENABLED) {
        const activeAssignment = db.prepare(`
          SELECT id, user_id FROM customer_presales_assignments
          WHERE customer_id = ? AND status = 'active' ORDER BY assigned_at DESC LIMIT 1
        `).get(customer.id);
        if (!presalesUserId || activeAssignment?.user_id !== presalesUserId) {
          db.prepare(`
            UPDATE customer_presales_assignments SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
            WHERE customer_id = ? AND status = 'active'
          `).run(customer.id);
          if (presalesUserId) {
            db.prepare(`
              INSERT INTO customer_presales_assignments
                (id, customer_id, user_id, assigned_by, status, remark)
              VALUES (?, ?, ?, ?, 'active', ?)
            `).run(uuidv4(), customer.id, presalesUserId, req.user.id, data.presales_remark?.trim() || null);
          }
        } else if (activeAssignment) {
          db.prepare('UPDATE customer_presales_assignments SET remark = ? WHERE id = ?')
            .run(data.presales_remark?.trim() || null, activeAssignment.id);
        }
      }
    });
    updatePoolCustomer();
    res.json({ message: '公海客户更新成功' });
  } catch (error) {
    console.error('编辑公海客户错误:', error);
    res.status(500).json({ error: getCustomerCreateError(error) });
  }
});

// 获取客户详情
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const customer = db.prepare(`
      SELECT
        c.*,
        u.name as owner_name,
        u2.name as secondary_owner_name,
        d.name as department_name,
        ch.name as channel_name,
        ch.commission_rate as channel_commission_rate
      FROM customers c
      LEFT JOIN users u ON c.owner_id = u.id
      LEFT JOIN users u2 ON c.secondary_owner_id = u2.id
      LEFT JOIN departments d ON c.department_id = d.id
      LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = ? AND c.is_deleted = 0
    `).get(req.params.id);

    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查:销售只能查看自己的客户(包括作为副销售的客户),无主客户在公海中查看
    const userRole = req.user.role;
    const userId = req.user.id;

    // fde_admin 与 admin/运营一致，可查看所有客户详情（包括未分配FDE的客户）
    if (['sales', 'presales', 'fde'].includes(userRole)) {
      const membership = db.prepare(`
        SELECT 1 AS allowed FROM customer_members WHERE customer_id = ? AND user_id = ?
        UNION SELECT 1 FROM opportunities WHERE customer_id = ? AND owner_id = ?
      `).get(customer.id, userId, customer.id, userId);
      const presalesAccess = userRole === 'presales' && db.prepare(`
        SELECT 1 AS allowed FROM opportunity_assignments WHERE opportunity_id IN (SELECT id FROM opportunities WHERE customer_id = ?)
        AND user_id = ? AND assignment_type = 'presales' AND status = 'active'
        UNION SELECT 1 FROM customer_presales_assignments
        WHERE customer_id = ? AND user_id = ? AND status = 'active' LIMIT 1
      `).get(customer.id, userId, customer.id, userId);
      const fdeAccess = userRole === 'fde' && db.prepare(`
        SELECT 1 AS allowed FROM customer_fde_assignments
        WHERE customer_id = ? AND user_id = ? AND status = 'active'
        UNION SELECT 1 FROM opportunity_assignments WHERE opportunity_id IN (SELECT id FROM opportunities WHERE customer_id = ?)
        AND user_id = ? AND assignment_type = 'fde' AND status = 'active' LIMIT 1
      `).get(customer.id, userId, customer.id, userId);
      if (customer.owner_id !== userId && !membership && !presalesAccess && !fdeAccess) {
        return res.status(403).json({ error: '无权限查看该客户,该客户属于公海客户' });
      }
    }

    // 获取关联数据
    const contacts = db.prepare('SELECT * FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, created_at DESC').all(req.params.id);
    const followups = db.prepare(`
      SELECT f.*, u.name as user_name, u.role as user_role, o.name as opportunity_name, o.status as opportunity_status
      FROM followups f
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN opportunities o ON f.opportunity_id = o.id
      WHERE f.customer_id = ?
      ORDER BY f.created_at DESC
    `).all(req.params.id);

    // 格式化跟进时间
    followups.forEach(f => {
      f.followup_time_formatted = f.followup_time ? new Date(f.followup_time).toLocaleString('zh-CN', { hour12: false }) : null;
    });
    const contracts = db.prepare(`
      SELECT * FROM contracts
      WHERE customer_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(req.params.id);
    const tags = db.prepare(`
      SELECT t.* FROM customer_tags t
      INNER JOIN customer_tag_relations r ON t.id = r.tag_id
      WHERE r.customer_id = ?
    `).all(req.params.id);

    // 获取商机信息
    const opportunities = db.prepare(`
      SELECT o.*, u.name as creator_name
      FROM opportunities o
      LEFT JOIN users u ON o.creator_id = u.id
      WHERE o.customer_id = ?
      ORDER BY o.created_at DESC
    `).all(req.params.id);

    let assignedIds = null;
    if (userRole === 'presales') {
      assignedIds = new Set(db.prepare("SELECT opportunity_id FROM opportunity_assignments WHERE user_id = ? AND assignment_type = 'presales' AND status = 'active'").all(userId).map(item => item.opportunity_id));
    } else if (userRole === 'fde') {
      assignedIds = new Set(db.prepare("SELECT opportunity_id FROM opportunity_assignments WHERE user_id = ? AND assignment_type = 'fde' AND status = 'active'").all(userId).map(item => item.opportunity_id));
    }
    // fde_admin 不做裁剪，可查看客户全部商机/跟进/合同
    if (assignedIds) {
      opportunities.splice(0, opportunities.length, ...opportunities.filter(item => assignedIds.has(item.id)));
      followups.splice(0, followups.length, ...followups.filter(item => item.opportunity_id && assignedIds.has(item.opportunity_id)).slice(0, 10));
      contracts.splice(0, contracts.length, ...contracts.filter(item => item.opportunity_id && assignedIds.has(item.opportunity_id)));
    } else if (followups.length > 10) {
      followups.splice(10);
    }

    const members = db.prepare(`
      SELECT cm.user_id, cm.member_role, cm.created_at, u.name, u.role
      FROM customer_members cm INNER JOIN users u ON u.id = cm.user_id
      WHERE cm.customer_id = ? ORDER BY CASE cm.member_role WHEN 'owner' THEN 0 ELSE 1 END, cm.created_at
    `).all(req.params.id);

    // 售前统一由「商机管理」指派，客户详情里的售前从该客户在跟商机的商机级售前聚合派生。
    // 按售前人员去重，并附带来源商机名称，便于在客户维度看清"谁在跟哪个商机"。
    const presalesAssignments = db.prepare(`
      SELECT
        oa.user_id,
        u.name,
        u.username,
        MAX(oa.assigned_at) AS assigned_at,
        (SELECT GROUP_CONCAT(o2.name, '、')
          FROM opportunities o2
          INNER JOIN opportunity_assignments oa2 ON oa2.opportunity_id = o2.id
          WHERE o2.customer_id = ? AND o2.status NOT IN ('signed', 'lost')
            AND oa2.user_id = oa.user_id
            AND oa2.assignment_type = 'presales' AND oa2.status = 'active') AS opportunity_names
      FROM opportunities o
      INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
      INNER JOIN users u ON u.id = oa.user_id
      WHERE o.customer_id = ? AND o.status NOT IN ('signed', 'lost')
        AND oa.assignment_type = 'presales' AND oa.status = 'active'
      GROUP BY oa.user_id
      ORDER BY assigned_at DESC
    `).all(req.params.id, req.params.id);

    const fdeAssignments = db.prepare(`
      SELECT cfa.id, cfa.user_id, cfa.remark, cfa.assigned_at,
        u.name, u.username, assigner.name AS assigned_by_name
      FROM customer_fde_assignments cfa
      INNER JOIN users u ON u.id = cfa.user_id
      LEFT JOIN users assigner ON assigner.id = cfa.assigned_by
      WHERE cfa.customer_id = ? AND cfa.status = 'active'
      ORDER BY cfa.assigned_at DESC
    `).all(req.params.id);

    // 获取回款信息(根据客户 ID 和合同关联获取)
    const payments = db.prepare(`
      SELECT
        p.id,
        p.payment_no,
        p.amount,
        p.actual_date,
        p.status,
        p.method,
        c.contract_no,
        c.title as contract_title
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      WHERE p.customer_id = ? AND c.customer_id = ?
      ORDER BY p.actual_date DESC
    `).all(req.params.id, req.params.id);

    // 获取变更日志
    const changeLogs = db.prepare(`
      SELECT * FROM customer_change_logs
      WHERE customer_id = ?
      ORDER BY changed_at DESC
    `).all(req.params.id);

    // 技术角色只参与技术协作，不返回商业金额字段。
    if (['presales', 'fde', 'fde_admin'].includes(userRole)) {
      customer.total_amount = null;
      customer.unpaid_amount = null;
      customer.total_received = null;
      customer.budget_range = null;
      customer.owner_share_percent = null;
      contracts.forEach(contract => {
        contract.amount = null;
        contract.total_received = null;
        contract.unpaid_amount = null;
        contract.channel_commission = null;
        contract.channel_commission_amount = null;
      });
      opportunities.forEach(opportunity => {
        opportunity.amount = null;
        opportunity.channel_commission_rate = null;
        opportunity.channel_commission_amount = null;
      });
      payments.forEach(payment => {
        payment.amount = null;
      });
      for (let i = changeLogs.length - 1; i >= 0; i -= 1) {
        if (['总金额', '未回款金额', '已回款金额', '预算范围', '分成比例'].includes(changeLogs[i].field_name)) {
          changeLogs.splice(i, 1);
        }
      }
    }

    res.json({
      customer,
      contacts,
      followups,
      contracts,
      tags,
      opportunities,
      members,
      presales_assignments: presalesAssignments,
      fde_assignments: fdeAssignments,
      payments,
      changeLogs
    });
  } catch (error) {
    console.error('获取客户详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建客户
router.post('/', authMiddleware, (req, res) => {
  try {
    const data = req.body;

    // 必填字段验证
    if (!data.name) {
      return res.status(400).json({ error: '客户名称不能为空' });
    }
    if (!data.customer_short_name) {
      return res.status(400).json({ error: '客户简称不能为空' });
    }
    if (!data.industry) {
      return res.status(400).json({ error: '所属行业不能为空' });
    }
    if (!data.region) {
      return res.status(400).json({ error: '所在地区不能为空' });
    }
    if (!data.contact_person || !data.phone) {
      return res.status(400).json({ error: '联系人和联系电话不能为空' });
    }
    const creditCode = data.credit_code && data.credit_code.trim() ? data.credit_code.trim() : null;
    // 意向产品改为可选(多选)

    // 客户类型验证(三选一,必填)
    const validTypes = ['external_channel', 'direct_customer', 'company_channel'];
    if (!data.type || !validTypes.includes(data.type)) {
      return res.status(400).json({ error: '客户类型必须为:外部渠道客户、直客、公司渠道客户 之一' });
    }

    const channelId = normalizeOptionalId(data.channel_id);
    let channelName = data.channel_name || null;
    if (channelId) {
      const channel = db.prepare('SELECT id, name FROM channels WHERE id = ?').get(channelId);
      if (!channel) {
        return res.status(400).json({ error: '渠道不存在' });
      }
      channelName = channelName || channel.name;
    }

    // 渠道客户必须有明确的渠道来源
    if ((data.type === 'external_channel' || data.type === 'company_channel') && !channelName) {
      return res.status(400).json({ error: '渠道客户必须选择渠道' });
    }

    // 行业验证
    const validIndustries = ['互联网平台', '汽车', '智能制造', '银行', '证券', '保险', '消金', '基金', '零售', '政府', '其他'];
    if (!validIndustries.includes(data.industry)) {
      return res.status(400).json({ error: '所属行业必须为:互联网平台、汽车、智能制造、银行、证券、保险、消金、基金、零售、政府、其他 之一' });
    }

    // 意向产品验证(多选,逗号分隔)
    const validProducts = ['SREAgent-产品', 'Sky DataPilot', 'Sky CostPilot', 'SREAgent-服务', '咨询', '其他'];
    if (data.intention_product) {
      const products = data.intention_product.split(',');
      for (const product of products) {
        if (!validProducts.includes(product.trim())) {
          return res.status(400).json({ error: '意向产品必须为:SREAgent-产品、Sky DataPilot、Sky CostPilot、SREAgent-服务、咨询、其他' });
        }
      }
    }

    // 联系电话校验
    if (!validatePhone(data.phone)) {
      return res.status(400).json({ error: '联系电话格式不正确' });
    }

    // 邮箱验证
    if (data.email && !validateEmail(data.email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 检查名称是否已存在
    const existing = db.prepare('SELECT id FROM customers WHERE name = ? AND is_deleted = 0').get(data.name);
    if (existing) {
      return res.status(400).json({ error: '客户名称已存在' });
    }

    // 检查统一社会信用代码是否已存在
    if (creditCode) {
      const existingCredit = db.prepare('SELECT id FROM customers WHERE credit_code = ? AND is_deleted = 0').get(creditCode);
      if (existingCredit) {
        return res.status(400).json({ error: '统一社会信用代码已存在' });
      }
    }

    const id = uuidv4();
    const ownerId = req.user.role === 'sales' ? req.user.id : normalizeOptionalId(data.owner_id);
    if (ownerId) {
      const owner = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'sales' AND status = 'active'").get(ownerId);
      if (!owner) {
        return res.status(400).json({ error: '负责人必须选择有效的在职销售' });
      }
    }

    const tagIds = normalizeTagIds(data.tag_ids);
    if (tagIds.length > 0) {
      const existingTags = db.prepare(`SELECT id FROM customer_tags WHERE id IN (${tagIds.map(() => '?').join(',')})`).all(...tagIds);
      if (existingTags.length !== tagIds.length) {
        return res.status(400).json({ error: '客户标签已失效，请重新选择标签' });
      }
    }

    const createCustomer = db.transaction(() => {
      db.prepare(`
        INSERT INTO customers (
          id, name, customer_short_name, type, channel_name, channel_id, credit_code, industry, scale, region,
          address, website, company_phone, contact_person, phone, source, owner_id,
          department_id, status, level, intention_product, budget_range, expected_sign_date,
          competitors, follow_stage, notes, internal_notes, creator_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.name,
        data.customer_short_name || null,
        data.type,
        channelName,
        channelId,
        creditCode,
        data.industry || null,
        data.scale || null,
        data.region || null,
        data.address || null,
        data.website || null,
        data.company_phone || null,
        data.contact_person || null,
        data.phone || null,
        data.source,
        ownerId,
        data.department_id || null,
        data.status || 'potential',
        data.level || null,
        data.intention_product || null,
        data.budget_range || null,
        data.expected_sign_date || null,
        data.competitors || null,
        data.follow_stage || 'potential',
        data.notes || null,
        data.internal_notes || null,
        req.user.id
      );

      if (ownerId) {
        db.prepare(`
          INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
          VALUES (?, ?, ?, 'owner', ?)
        `).run(uuidv4(), id, ownerId, req.user.id);
      }

      // 如果填写了联系人和电话,自动创建联系人记录
      if (data.contact_person && data.phone) {
        const contactId = uuidv4();
        db.prepare(`
          INSERT INTO contacts (id, customer_id, name, phone, is_primary, is_kp, creator_id)
          VALUES (?, ?, ?, ?, 1, 1, ?)
        `).run(contactId, id, data.contact_person, data.phone, req.user.id);
      }

      // 处理渠道关联:写入 channel_customers 表
      if (channelId) {
        db.prepare(`
          INSERT INTO channel_customers (id, channel_id, customer_id)
          VALUES (?, ?, ?)
        `).run(uuidv4(), channelId, id);
      }

      // 处理客户标签
      if (tagIds.length > 0) {
        const insert = db.prepare('INSERT INTO customer_tag_relations (id, customer_id, tag_id) VALUES (?, ?, ?)');
        for (const tagId of tagIds) {
          insert.run(uuidv4(), id, tagId);
        }
      }
    });
    createCustomer();

    res.status(201).json({ message: '客户创建成功', id });
  } catch (error) {
    console.error('创建客户错误:', error);
    res.status(500).json({ error: getCustomerCreateError(error) });
  }
});

// 更新客户
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查(只有主销售可以编辑)
    if (req.user.role === 'sales' && customer.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限编辑该客户,只有主销售可以编辑' });
    }

    const finalContactPerson = data.contact_person !== undefined ? data.contact_person : customer.contact_person;
    const finalPhone = data.phone !== undefined ? data.phone : customer.phone;
    if (!finalContactPerson || !finalPhone) {
      return res.status(400).json({ error: '联系人和联系电话不能为空' });
    }

    // 字段验证
    if (data.phone && !validatePhone(data.phone)) {
      return res.status(400).json({ error: '联系电话格式不正确' });
    }

    // 客户类型验证
    if (data.type) {
      const validTypes = ['external_channel', 'direct_customer', 'company_channel'];
      if (!validTypes.includes(data.type)) {
        return res.status(400).json({ error: '客户类型必须为:外部渠道客户、直客、公司渠道客户 之一' });
      }
    }

    // 渠道名称验证:渠道客户必填
    if (data.type && (data.type === 'external_channel' || data.type === 'company_channel') && !data.channel_name) {
      return res.status(400).json({ error: '渠道客户必须填写渠道名称' });
    }

    // 验证 channel_id 是否存在
    if (data.channel_id) {
      const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(data.channel_id);
      if (!channel) return res.status(400).json({ error: '渠道不存在' });
    }

    // 行业验证
    if (data.industry) {
      const validIndustries = ['互联网平台', '汽车', '智能制造', '银行', '证券', '保险', '消金', '基金', '零售', '政府', '其他'];
      if (!validIndustries.includes(data.industry)) {
        return res.status(400).json({ error: '所属行业必须为:互联网平台、汽车、智能制造、银行、证券、保险、消金、基金、零售、政府、其他 之一' });
      }
    }

    // 意向产品验证(多选,逗号分隔)
    if (data.intention_product) {
      const validProducts = ['SREAgent-产品', 'Sky DataPilot', 'Sky CostPilot', 'SREAgent-服务', '咨询', '其他'];
      const products = data.intention_product.split(',');
      for (const product of products) {
        if (!validProducts.includes(product.trim())) {
          return res.status(400).json({ error: '意向产品必须为:SREAgent-产品、Sky DataPilot、Sky CostPilot、SREAgent-服务、咨询、其他' });
        }
      }
    }

    // 检查名称是否已存在(如果修改了名称)
    if (data.name && data.name !== customer.name) {
      const existing = db.prepare('SELECT id FROM customers WHERE name = ? AND is_deleted = 0 AND id != ?').get(data.name, id);
      if (existing) {
        return res.status(400).json({ error: '客户名称已存在' });
      }
    }

    // 检查统一社会信用代码
    if (data.credit_code !== undefined) {
      const creditCode = data.credit_code && data.credit_code.trim() ? data.credit_code.trim() : null;
      if (creditCode && creditCode !== customer.credit_code) {
        const existing = db.prepare('SELECT id FROM customers WHERE credit_code = ? AND is_deleted = 0 AND id != ?').get(creditCode, id);
        if (existing) {
          return res.status(400).json({ error: '统一社会信用代码已存在' });
        }
      }
      data.credit_code = creditCode;
    }

    const updateFields = [];
    const updateValues = [];

    // 可更新字段
    const allowedFields = [
      'name', 'customer_short_name', 'type', 'channel_name', 'channel_id', 'credit_code', 'industry', 'scale',
      'region', 'address', 'website', 'company_phone', 'contact_person', 'phone',
      'source', 'status', 'level', 'intention_product', 'budget_range',
      'expected_sign_date', 'competitors', 'follow_stage', 'notes', 'internal_notes'
    ];
    if (['admin', 'super_admin'].includes(req.user.role)) allowedFields.push('owner_id', 'department_id');

    // 字段中文名映射
    const fieldLabels = {
      name: '客户名称',
      customer_short_name: '客户简称',
      type: '客户类型',
      channel_name: '渠道名称',
      credit_code: '统一社会信用代码',
      industry: '所属行业',
      scale: '客户规模',
      region: '所在地区',
      address: '详细地址',
      website: '官网',
      company_phone: '公司电话',
      contact_person: '联系人',
      phone: '联系电话',
      source: '客户来源',
      status: '客户状态',
      level: '客户等级',
      intention_product: '意向产品',
      budget_range: '预算范围',
      expected_sign_date: '预计签约时间',
      competitors: '竞争对手',
      follow_stage: '跟进阶段',
      notes: '备注',
      internal_notes: '内部备注',
      owner_id: '归属销售',
      department_id: '部门'
    };

    // 记录更改前的值
    const changeLogInsert = db.prepare('INSERT INTO customer_change_logs (id, customer_id, changed_by, changed_by_name, changed_at, field_name, old_value) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)');

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        const oldValue = customer[field];
        const newValue = data[field];

        // 比较值是否真正变化了
        const oldStr = oldValue === null || oldValue === undefined ? '' : String(oldValue);
        const newStr = newValue === null || newValue === undefined ? '' : String(newValue);

        if (oldStr !== newStr) {
          // 记录变更日志
          changeLogInsert.run(
            uuidv4(),
            id,
            req.user.id,
            req.user.name || req.user.username,
            fieldLabels[field] || field,
            oldStr
          );
        }

        updateFields.push(`${field} = ?`);
        updateValues.push(newValue);
      }
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      updateValues.push(id);
      db.prepare(`UPDATE customers SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);
    }

    // 更新客户标签
    if (data.tag_ids !== undefined) {
      // 删除旧标签
      db.prepare('DELETE FROM customer_tag_relations WHERE customer_id = ?').run(id);
      // 插入新标签(过滤掉空值)
      if (data.tag_ids && data.tag_ids.length > 0) {
        const insert = db.prepare('INSERT INTO customer_tag_relations (id, customer_id, tag_id) VALUES (?, ?, ?)');
        for (const tagId of data.tag_ids) {
          if (tagId && String(tagId).trim()) {
            insert.run(uuidv4(), id, tagId);
          }
        }
      }
    }

    // 处理渠道关联同步
    if (data.channel_id) {
      const existing = db.prepare('SELECT id FROM channel_customers WHERE customer_id = ?').get(id);
      if (!existing) {
        db.prepare(
          'INSERT INTO channel_customers (id, channel_id, customer_id) VALUES (?, ?, ?)'
        ).run(uuidv4(), data.channel_id, id);
      } else {
        db.prepare('UPDATE channel_customers SET channel_id = ? WHERE customer_id = ?').run(data.channel_id, id);
      }
    } else if (customer.channel_id) {
      db.prepare('DELETE FROM channel_customers WHERE customer_id = ?').run(id);
    }

    res.json({ message: '客户更新成功' });
  } catch (error) {
    console.error('更新客户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除客户(逻辑删除)
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查
    if (req.user.role === 'sales' && customer.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限删除该客户' });
    }

    // 检查是否有关联数据
    const contactCount = db.prepare('SELECT COUNT(*) as count FROM contacts WHERE customer_id = ?').get(id).count;
    const contractCount = db.prepare('SELECT COUNT(*) as count FROM contracts WHERE customer_id = ?').get(id).count;

    if (contactCount > 0 || contractCount > 0) {
      return res.status(400).json({ error: '该客户有关联数据,无法删除' });
    }

    db.prepare('UPDATE customers SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

    res.json({ message: '客户删除成功' });
  } catch (error) {
    console.error('删除客户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 客户分配(管理员将公海客户分配给销售)
router.post('/:id/assign', authMiddleware, requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { owner_id, department_id, protect_days = 0 } = req.body;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    if (customer.owner_id) {
      return res.status(400).json({ error: '该客户已分配给销售,不可重复分配' });
    }
    const owner = db.prepare("SELECT id, department_id FROM users WHERE id = ? AND role = 'sales' AND status = 'active'").get(owner_id);
    if (!owner) return res.status(400).json({ error: '请选择启用的销售人员' });

    // claimed_at 记录归属起点，公海倒计时与自动回收任务据此重新计时
    db.prepare(`
      UPDATE customers SET
        owner_id = ?,
        department_id = ?,
        status = 'potential',
        protect_days = ?,
        claimed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(owner_id, owner.department_id || department_id || null, Math.max(0, Number(protect_days) || 0), id);

    db.prepare(`
      INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
      VALUES (?, ?, ?, 'owner', ?)
    `).run(uuidv4(), id, owner_id, req.user.id);

    res.json({ message: '客户分配成功' });
  } catch (error) {
    console.error('客户分配错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 客户转移(管理员或销售转移客户给其他销售)
router.post('/:id/transfer', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { target_owner_id, reason } = req.body;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查
    if (req.user.role === 'sales' && customer.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限转移该客户' });
    }

    // 获取新销售的部门
    const targetUser = db.prepare("SELECT id, department_id, role FROM users WHERE id = ? AND role = 'sales' AND status = 'active'").get(target_owner_id);
    if (!targetUser) {
      return res.status(400).json({ error: '目标销售不存在、已停用或不是销售角色' });
    }

    const transfer = db.transaction(() => {
      db.prepare(`
        UPDATE customers SET owner_id = ?, department_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(target_owner_id, targetUser.department_id, id);

      db.prepare("DELETE FROM customer_members WHERE customer_id = ? AND member_role = 'owner'").run(id);
      db.prepare(`
        INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
        VALUES (?, ?, ?, 'owner', ?)
      `).run(uuidv4(), id, target_owner_id, req.user.id);

      // 完整转移客户时，未结束商机和待处理提醒交由新销售继续推进。
      db.prepare(`
        UPDATE opportunities SET owner_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE customer_id = ? AND status NOT IN ('signed', 'lost')
      `).run(target_owner_id, id);
      db.prepare(`
        UPDATE followup_reminders SET user_id = ?
        WHERE customer_id = ? AND status != 'processed'
      `).run(target_owner_id, id);
    });
    transfer();

    // 如果客户关联了渠道，自动授予新销售渠道成员权限。
    if (customer.channel_id && targetUser.role === 'sales') {
      const existing = db.prepare(
        'SELECT id FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(customer.channel_id, target_owner_id);

      if (!existing) {
        db.prepare(`
          INSERT INTO channel_members (id, channel_id, user_id, role, assigned_by)
          VALUES (?, ?, ?, 'member', ?)
        `).run(uuidv4(), customer.channel_id, target_owner_id, req.user.id);
      }
    }

    res.json({ message: '客户转移成功' });
  } catch (error) {
    console.error('客户转移错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 移入公海
router.post('/:id/public', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查
    if (req.user.role === 'sales' && customer.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限操作该客户' });
    }

    db.prepare(`
      UPDATE customers SET
        status = 'public',
        owner_id = NULL,
        secondary_owner_id = NULL,
        department_id = NULL,
        public_at = CURRENT_TIMESTAMP,
        public_reason = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason, id);

    db.prepare('DELETE FROM customer_members WHERE customer_id = ?').run(id);

    res.json({ message: '客户已移入公海' });
  } catch (error) {
    console.error('移入公海错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 指派公海客户售前。客户被领取后，该客户级协作关系继续有效。
// 【已停用】售前统一在「商机管理」中按商机指派，公海客户不再提供客户级售前指派入口。
router.post('/pool/:id/presales', authMiddleware, (req, res) => {
  try {
    // 短路返回；下方原有实现完整保留，如需恢复客户级指派删除此段即可
    return res.status(403).json({ error: '售前已统一在「商机管理」中指派，请在商机上设置售前' });

    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能指派售前' });
    }
    const customer = db.prepare(
      "SELECT id FROM customers WHERE id = ? AND status = 'public' AND is_deleted = 0"
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '公海客户不存在' });

    const { user_id, remark } = req.body;
    const presales = db.prepare(
      "SELECT id FROM users WHERE id = ? AND role = 'presales' AND status = 'active'"
    ).get(user_id);
    if (!presales) return res.status(400).json({ error: '请选择有效的售前人员' });

    const assign = db.transaction(() => {
      db.prepare(`
        UPDATE customer_presales_assignments
        SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
        WHERE customer_id = ? AND status = 'active'
      `).run(customer.id);
      db.prepare(`
        INSERT INTO customer_presales_assignments
          (id, customer_id, user_id, assigned_by, status, remark)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(uuidv4(), customer.id, user_id, req.user.id, remark?.trim() || null);
    });
    assign();
    res.json({ message: '售前指派成功' });
  } catch (error) {
    console.error('指派公海客户售前错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 【已停用】公海客户不再提供客户级售前指派入口，取消操作同样统一到「商机管理」。
router.post('/pool/:id/presales/cancel', authMiddleware, (req, res) => {
  try {
    // 短路返回；下方原有实现完整保留，如需恢复客户级指派删除此段即可
    return res.status(403).json({ error: '售前已统一在「商机管理」中指派，请在商机上取消售前' });

    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能取消售前指派' });
    }
    const result = db.prepare(`
      UPDATE customer_presales_assignments
      SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
      WHERE customer_id = ? AND status = 'active'
    `).run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: '该客户暂无售前指派' });
    res.json({ message: '已取消售前指派' });
  } catch (error) {
    console.error('取消公海客户售前指派错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 指派/更换私有客户的客户级售前。
// 与公海侧一致采用单指派覆盖模式：新指派自动取消旧的 active 记录，即完成"更换"。
// 【已停用】售前统一在「商机管理」中按商机指派，客户管理页不再提供客户级售前指派入口。
router.post('/:id/presales', authMiddleware, (req, res) => {
  try {
    // 短路返回；下方原有实现完整保留，如需恢复客户级指派删除此段即可
    return res.status(403).json({ error: '售前已统一在「商机管理」中指派，请在商机上设置售前' });

    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能指派售前' });
    }
    // 仅私有客户走此接口，公海客户仍使用 /pool/:id/presales
    const customer = db.prepare(
      "SELECT id, name FROM customers WHERE id = ? AND status != 'public' AND is_deleted = 0"
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    const { user_id, remark } = req.body;
    const presales = db.prepare(
      "SELECT id, name FROM users WHERE id = ? AND role = 'presales' AND status = 'active'"
    ).get(user_id);
    if (!presales) return res.status(400).json({ error: '请选择有效的售前人员' });

    const assign = db.transaction(() => {
      // 先取消旧的 active 指派，再插入新指派
      db.prepare(`
        UPDATE customer_presales_assignments
        SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
        WHERE customer_id = ? AND status = 'active'
      `).run(customer.id);
      db.prepare(`
        INSERT INTO customer_presales_assignments
          (id, customer_id, user_id, assigned_by, status, remark)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(uuidv4(), customer.id, user_id, req.user.id, remark?.trim() || null);
    });
    assign();
    // 返回新售前信息，便于前端直接更新列表展示
    res.json({ message: '售前指派成功', presales_id: presales.id, presales_name: presales.name });
  } catch (error) {
    console.error('指派客户级售前错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 取消私有客户的客户级售前指派，效果与取消客户级FDE一致：
// 将该客户所有 active 的客户级售前指派置为 cancelled。
// 【已停用】取消售前统一在「商机管理」中操作。
router.post('/:id/presales/cancel', authMiddleware, (req, res) => {
  try {
    // 短路返回；下方原有实现完整保留，如需恢复客户级指派删除此段即可
    return res.status(403).json({ error: '售前已统一在「商机管理」中指派，请在商机上取消售前' });

    // 角色限制与 /:id/presales 指派接口保持一致
    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能取消售前指派' });
    }
    // 仅私有客户走此接口，公海客户仍使用 /pool/:id/presales/cancel
    const customer = db.prepare(
      "SELECT id, name FROM customers WHERE id = ? AND status != 'public' AND is_deleted = 0"
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    const result = db.prepare(`
      UPDATE customer_presales_assignments
      SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
      WHERE customer_id = ? AND status = 'active'
    `).run(customer.id);
    if (!result.changes) return res.status(404).json({ error: '该客户暂无客户级售前指派' });
    res.json({ message: '已取消客户级售前指派' });
  } catch (error) {
    console.error('取消客户级售前指派错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 客户级售前跟进不强制关联商机，可用于公海阶段并在客户被领取后继续跟进。
router.post('/:id/presales-followups', authMiddleware, (req, res) => {
  try {
    if (!['presales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '当前角色不能填写客户级售前跟进' });
    }
    const customer = db.prepare(
      'SELECT id, follow_stage FROM customers WHERE id = ? AND is_deleted = 0'
    ).get(req.params.id);
    if (!customer) return res.status(404).json({ error: '客户不存在' });

    if (req.user.role === 'presales') {
      // 售前指派已统一收敛到「商机管理」：改为按商机级售前指派判定该售前是否服务于本客户。
      const opportunityAssignment = db.prepare(`
        SELECT 1 AS ok FROM opportunities o
        INNER JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
        WHERE o.customer_id = ?
          AND oa.user_id = ? AND oa.assignment_type = 'presales' AND oa.status = 'active'
        LIMIT 1
      `).get(customer.id, req.user.id);
      // 保留原有的客户级售前判定，兼容尚未迁移完成的历史数据（存量已作废时不会命中）
      const customerAssignment = opportunityAssignment ? null : db.prepare(`
        SELECT id FROM customer_presales_assignments
        WHERE customer_id = ? AND user_id = ? AND status = 'active'
      `).get(customer.id, req.user.id);
      if (!opportunityAssignment && !customerAssignment) {
        return res.status(403).json({ error: '该客户未指派给您' });
      }
    }

    const { contact_id, type, content, result, next_followup_at, next_followup_content } = req.body;
    if (!type) return res.status(400).json({ error: '请选择跟进方式' });
    if (!content || content.trim().length < 10) {
      return res.status(400).json({ error: '跟进内容至少填写10个字' });
    }
    if (contact_id) {
      const contact = db.prepare('SELECT id FROM contacts WHERE id = ? AND customer_id = ?')
        .get(contact_id, customer.id);
      if (!contact) return res.status(400).json({ error: '联系人不属于该客户' });
    }

    const id = uuidv4();
    const nowTime = new Date();
    nowTime.setMinutes(nowTime.getMinutes() - nowTime.getTimezoneOffset());
    const followupTime = nowTime.toISOString().slice(0, 19).replace('T', ' ');
    const createFollowup = db.transaction(() => {
      db.prepare(`
        INSERT INTO followups (
          id, customer_id, contact_id, opportunity_id, user_id, followup_time,
          type, work_type, content, stage, result, next_followup_at, next_followup_content
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'technical', ?, ?, ?, ?, ?)
      `).run(
        id, customer.id, contact_id || null, req.user.id, followupTime, type,
        content.trim(), customer.follow_stage || 'potential', result || 'pending',
        next_followup_at || null, next_followup_content?.trim() || null
      );
      db.prepare('UPDATE customers SET last_followup_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(customer.id);
      if (next_followup_at) {
        db.prepare(`
          INSERT INTO followup_reminders
            (id, customer_id, user_id, reminder_at, content, status, reminder_type)
          VALUES (?, ?, ?, ?, ?, 'unread', 'manual')
        `).run(uuidv4(), customer.id, req.user.id, next_followup_at, next_followup_content?.trim() || '售前跟进提醒');
      }
    });
    createFollowup();
    res.status(201).json({ message: '售前跟进记录已保存', id });
  } catch (error) {
    console.error('创建客户级售前跟进错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 领取公海客户
router.post('/pool/claim', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'sales') {
      return res.status(403).json({ error: '仅销售可以领取公海客户，管理员请使用分配功能' });
    }
    const { customer_ids } = req.body;

    if (!customer_ids || !Array.isArray(customer_ids) || customer_ids.length === 0) {
      return res.status(400).json({ error: '请选择要领取的客户' });
    }

    const userId = req.user.id;
    const userDept = db.prepare('SELECT department_id FROM users WHERE id = ?').get(userId).department_id;

    let claimedCount = 0;
    const claim = db.transaction(() => {
      for (const id of customer_ids) {
        // claimed_at 记录归属起点：领取后公海倒计时从当天重新计时，
        // 避免沿用上一任销售的旧跟进时间导致当晚立刻被自动回收
        const result = db.prepare(`
          UPDATE customers SET status = 'potential', owner_id = ?, department_id = ?,
            public_at = NULL, public_reason = NULL, claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'public' AND is_deleted = 0
            AND (protect_days IS NULL OR protect_days = 0 OR public_at IS NULL OR datetime(public_at, '+' || protect_days || ' days') <= CURRENT_TIMESTAMP)
        `).run(userId, userDept, id);
        if (!result.changes) continue;
        claimedCount += 1;
        db.prepare(`
          INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
          VALUES (?, ?, ?, 'owner', ?)
        `).run(uuidv4(), id, userId, userId);
      }
    });
    claim();

    if (!claimedCount) return res.status(409).json({ error: '所选客户已被领取或仍在保护期内' });
    res.json({ message: `成功领取${claimedCount}个客户`, claimed_count: claimedCount, skipped_count: customer_ids.length - claimedCount });
  } catch (error) {
    console.error('领取公海客户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取公海客户列表
router.get('/pool/list', authMiddleware, (req, res) => {
  try {
    const { page = 1, limit = 10, name } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = "c.status = 'public' AND c.is_deleted = 0";
    const params = [];

    if (req.user.role === 'presales') {
      whereClause += ` AND EXISTS (
        SELECT 1 FROM customer_presales_assignments cpa
        WHERE cpa.customer_id = c.id AND cpa.user_id = ? AND cpa.status = 'active'
      )`;
      params.push(req.user.id);
    }

    if (name && name.trim()) {
      whereClause += ' AND c.name LIKE ?';
      params.push(`%${name.trim()}%`);
    }

    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM customers c
      WHERE ${whereClause}
    `).get(...params);

    const customers = db.prepare(`
      SELECT c.*,
             c.public_at,
             c.public_reason,
             c.protect_days,
             COALESCE((
               SELECT GROUP_CONCAT(u.name, ',')
               FROM customer_presales_assignments cpa
               INNER JOIN users u ON u.id = cpa.user_id
               WHERE cpa.customer_id = c.id AND cpa.status = 'active'
             ), '') AS presales_names
      FROM customers c
      WHERE ${whereClause}
      ORDER BY c.public_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
      data: customers,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取公海客户列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取公海客户详情(包含跟进历史)
router.get('/pool/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    // 获取客户基本信息
    const customer = db.prepare(`
      SELECT
        c.*,
        u.name as owner_name,
        d.name as department_name
      FROM customers c
      LEFT JOIN users u ON c.owner_id = u.id
      LEFT JOIN departments d ON c.department_id = d.id
      WHERE c.id = ? AND c.status = 'public' AND c.is_deleted = 0
    `).get(id);

    if (!customer) {
      return res.status(404).json({ error: '公海客户不存在' });
    }

    if (req.user.role === 'presales') {
      const assignment = db.prepare(`
        SELECT id FROM customer_presales_assignments
        WHERE customer_id = ? AND user_id = ? AND status = 'active'
      `).get(id, req.user.id);
      if (!assignment) return res.status(403).json({ error: '该公海客户未指派给您' });
    }

    // 获取联系人列表
    const contacts = db.prepare(`
      SELECT id, name, position, phone, email, wechat, is_kp, is_primary
      FROM contacts
      WHERE customer_id = ?
      ORDER BY is_primary DESC, name ASC
    `).all(id);

    // 获取历史跟进记录(最近 10 条,按时间倒序,最新的在前,时间精确到时分秒)
    const followups = db.prepare(`
      SELECT
        f.id,
        f.followup_time,
        f.created_at,
        f.type,
        f.content,
        f.stage,
        f.result,
        f.user_id,
        u.name as user_name,
        u.role as user_role
      FROM followups f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.customer_id = ?
      ORDER BY f.created_at DESC
      LIMIT 10
    `).all(id);

    // 格式化跟进时间(精确到时分秒)
    followups.forEach(f => {
      f.followup_time_formatted = f.created_at
        ? new Date(f.created_at).toLocaleString('zh-CN', { hour12: false })
        : (f.followup_time ? new Date(f.followup_time).toLocaleString('zh-CN', { hour12: false }) : null);
    });

    const presalesAssignments = db.prepare(`
      SELECT cpa.id, cpa.user_id, cpa.remark, cpa.assigned_at,
        u.name, u.username, assigner.name AS assigned_by_name
      FROM customer_presales_assignments cpa
      INNER JOIN users u ON u.id = cpa.user_id
      LEFT JOIN users assigner ON assigner.id = cpa.assigned_by
      WHERE cpa.customer_id = ? AND cpa.status = 'active'
      ORDER BY cpa.assigned_at DESC
    `).all(id);

    res.json({
      customer,
      contacts,
      followups,
      presales_assignments: presalesAssignments
    });
  } catch (error) {
    console.error('获取公海客户详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除公海客户(物理删除,仅管理员)
router.delete('/pool/:id', authMiddleware, (req, res) => {
  try {
    // 仅管理员可删除
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '仅管理员可删除公海客户' });
    }

    const { id } = req.params;

    // 检查客户是否存在且为公海客户
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND status = ? AND is_deleted = 0').get(id, 'public');
    if (!customer) {
      return res.status(404).json({ error: '公海客户不存在' });
    }

    // 检查是否有关联数据
    const contactCount = db.prepare('SELECT COUNT(*) as count FROM contacts WHERE customer_id = ?').get(id).count;
    const contractCount = db.prepare('SELECT COUNT(*) as count FROM contracts WHERE customer_id = ?').get(id).count;
    const followupCount = db.prepare('SELECT COUNT(*) as count FROM followups WHERE customer_id = ?').get(id).count;
    const paymentCount = db.prepare('SELECT COUNT(*) as count FROM payments WHERE customer_id = ?').get(id).count;
    const tagCount = db.prepare('SELECT COUNT(*) as count FROM customer_tag_relations WHERE customer_id = ?').get(id).count;

    console.log(`删除公海客户 ${id},关联数据:联系人${contactCount},合同${contractCount},跟进${followupCount},回款${paymentCount},标签${tagCount}`);

    const archive = db.transaction(() => {
      db.prepare('UPDATE customers SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      db.prepare("UPDATE customer_presales_assignments SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE customer_id = ? AND status = 'active'").run(id);
    });
    try {
      archive();

      console.log(`公海客户 ${id} 物理删除成功,删除关联数据:联系人${contactCount},合同${contractCount},跟进${followupCount},回款${paymentCount},标签${tagCount}`);

      res.json({
        message: '公海客户已归档',
        deleted: {
          customer: 1,
          contacts: contactCount,
          contracts: contractCount,
          followups: followupCount,
          payments: paymentCount,
          tags: tagCount
        }
      });
    } catch (error) {
      throw error;
    }
  } catch (error) {
    console.error('删除公海客户错误:', error);
    res.status(500).json({ error: '删除失败:' + error.message });
  }
});

// 共享客户：支持添加多名协作销售，每名销售只负责自己的商机。
router.post('/:id/share', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { secondary_owner_id, owner_share_percent } = req.body;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查:只有主销售可以共享
    if (req.user.role === 'sales' && customer.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限共享该客户,只有主销售可以共享' });
    }

    // 检查副销售是否存在
    const secondaryOwner = db.prepare("SELECT id, role FROM users WHERE id = ? AND status = 'active'").get(secondary_owner_id);
    if (!secondaryOwner) {
      return res.status(400).json({ error: '协作销售不存在或已停用' });
    }

    // 检查副销售是否为销售角色
    if (secondaryOwner.role !== 'sales') {
      return res.status(400).json({ error: '只能共享给销售角色用户' });
    }

    // 检查副销售不能是主销售自己
    if (secondary_owner_id === customer.owner_id) {
      return res.status(400).json({ error: '不能共享给自己' });
    }

    // 验证分成比例(0-100)
    const sharePercent = owner_share_percent !== undefined ? parseInt(owner_share_percent) : 50;
    if (isNaN(sharePercent) || sharePercent < 0 || sharePercent > 100) {
      return res.status(400).json({ error: '主销售分成比例必须在 0-100 之间' });
    }

    const existingMember = db.prepare(
      'SELECT id FROM customer_members WHERE customer_id = ? AND user_id = ?'
    ).get(id, secondary_owner_id);
    if (existingMember) return res.status(400).json({ error: '该销售已是客户协作成员' });

    db.prepare(`
      INSERT INTO customer_members (id, customer_id, user_id, member_role, created_by)
      VALUES (?, ?, ?, 'collaborator', ?)
    `).run(uuidv4(), id, secondary_owner_id, req.user.id);

    // 保留旧字段用于兼容现有列表展示，首位协作销售写入副销售字段。
    if (!customer.secondary_owner_id) {
      db.prepare(`UPDATE customers SET secondary_owner_id = ?, owner_share_percent = ?,
        shared_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(secondary_owner_id, sharePercent, id);
    }

    // 如果客户关联了渠道，自动将副销售添加为该渠道的 member
    if (customer.channel_id) {
      const existing = db.prepare(
        'SELECT id FROM channel_members WHERE channel_id = ? AND user_id = ?'
      ).get(customer.channel_id, secondary_owner_id);

      if (!existing) {
        db.prepare(`
          INSERT INTO channel_members (id, channel_id, user_id, role, assigned_by)
          VALUES (?, ?, ?, 'member', ?)
        `).run(uuidv4(), customer.channel_id, secondary_owner_id, req.user.id);
      }
    }

    res.json({ message: '客户共享成功' });
  } catch (error) {
    console.error('共享客户错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 取消共享(移除副销售)
router.post('/:id/unshare', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').get(id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 权限检查:只有主销售可以取消共享
    if (req.user.role === 'sales' && customer.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限操作,只有主销售可以取消共享' });
    }

    const secondaryOwnerId = req.body.user_id || customer.secondary_owner_id;
    if (!secondaryOwnerId) return res.status(400).json({ error: '请选择要移除的协作销售' });

    db.prepare("DELETE FROM customer_members WHERE customer_id = ? AND user_id = ? AND member_role = 'collaborator'")
      .run(id, secondaryOwnerId);

    // 移除副销售
    if (customer.secondary_owner_id === secondaryOwnerId) {
      const nextMember = db.prepare(`SELECT user_id FROM customer_members
        WHERE customer_id = ? AND member_role = 'collaborator' ORDER BY created_at LIMIT 1`).get(id);
      db.prepare(`UPDATE customers SET secondary_owner_id = ?, shared_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(nextMember?.user_id || null, nextMember ? new Date().toISOString() : null, id);
    }

    // 如果客户关联了渠道，移除副销售的渠道 member 权限
    if (customer.channel_id) {
      db.prepare(
        'DELETE FROM channel_members WHERE channel_id = ? AND user_id = ? AND role = \'member\''
      ).run(customer.channel_id, secondaryOwnerId);
    }

    res.json({ message: '取消共享成功' });
  } catch (error) {
    console.error('取消共享错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
