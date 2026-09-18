const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isSystemAdmin } = require('../middleware/role-policy');

const router = express.Router();

const RECEIVED_STATUS_SQL = "('已回款', 'received')";

const normalizePaymentStatus = (status) => {
  if (status === undefined || status === null || status === '') return status;
  if (['已回款', 'received', 'paid'].includes(status)) return '已回款';
  if (['待回款', 'pending', 'unpaid'].includes(status)) return '待回款';
  return status;
};

const canAccessCustomer = (user, customerId) => {
  if (user.role !== 'sales') return true;
  return Boolean(db.prepare(`
    SELECT id FROM customers
    WHERE id = ? AND is_deleted = 0
      AND (owner_id = ? OR secondary_owner_id = ? OR EXISTS (
        SELECT 1 FROM customer_members cm WHERE cm.customer_id = customers.id AND cm.user_id = ?
      ))
  `).get(customerId, user.id, user.id, user.id));
};

const recalculateContractPaymentTotals = (contractId) => {
  const contract = db.prepare('SELECT amount FROM contracts WHERE id = ?').get(contractId);
  if (!contract) return null;

  const totalReceived = Number(db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE contract_id = ? AND status IN ${RECEIVED_STATUS_SQL}
  `).get(contractId).total || 0);
  const unpaidAmount = Math.max(0, Number(contract.amount || 0) - totalReceived);

  db.prepare(`
    UPDATE contracts SET
      total_received = ?,
      unpaid_amount = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(totalReceived, unpaidAmount, contractId);

  return { contractAmount: Number(contract.amount || 0), totalReceived, unpaidAmount };
};

const recalculatePaymentPlan = (paymentPlanId) => {
  if (!paymentPlanId) return;
  const plan = db.prepare('SELECT payment_amount FROM contract_payment_plans WHERE id = ?').get(paymentPlanId);
  if (!plan) return;
  const summary = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS actual_amount, MAX(actual_date) AS actual_date
    FROM payments WHERE payment_plan_id = ? AND status IN ${RECEIVED_STATUS_SQL}
  `).get(paymentPlanId);
  const actualAmount = Number(summary.actual_amount || 0);
  const paymentStatus = actualAmount <= 0 ? 'unpaid' : actualAmount + 0.01 < Number(plan.payment_amount) ? 'partial' : 'paid';
  db.prepare(`
    UPDATE contract_payment_plans SET payment_status = ?, actual_amount = ?, actual_payment_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(paymentStatus, actualAmount || null, actualAmount ? summary.actual_date : null, paymentPlanId);
};

router.use(authMiddleware, (req, res, next) => {
  if (['presales', 'fde', 'fde_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: '技术角色不可访问回款数据' });
  }
  if (req.user.role === 'operations' && req.method !== 'GET') {
    return res.status(403).json({ error: '运营角色只能查看回款数据' });
  }
  next();
});

// =====================================================
// 获取回款列表(支持多条件筛选)
// =====================================================
router.get('/', authMiddleware, (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      contract_id,
      contract_no,
      customer_name,
      status,
      customer_id,
      start_date,
      end_date
    } = req.query;

    // 前端 → 后端状态值映射（兼容前端旧值）
    const statusMap = {
      'received': '已回款',
      '已回款': '已回款',
      'pending': 'pending',
      '待回款': 'pending',
      'overdue': 'overdue',
      '已逾期': 'overdue'
    };
    const mappedStatus = statusMap[status] || status;

    const offset = (page - 1) * limit;
    const userRole = req.user.role;
    const userId = req.user.id;

    // 客户转移后，当前客户负责人仍应看到该客户完整的回款历史。
    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }

    // 如果筛选状态为 pending(待回款/未回款),从付款计划表中查询
    if (mappedStatus === 'pending') {
      const pendingOwnerCondition = userRole === 'sales'
        ? ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`
        : '';
      let planWhereClause = "1=1" + pendingOwnerCondition;
      const planParams = [];

      if (contract_id) {
        planWhereClause += ` AND pp.contract_id = ?`;
        planParams.push(contract_id);
      }
      if (contract_no) {
        planWhereClause += ` AND c.contract_no LIKE ?`;
        planParams.push(`%${contract_no}%`);
      }
      if (customer_name) {
        planWhereClause += ` AND cu.name LIKE ?`;
        planParams.push(`%${customer_name}%`);
      }
      if (customer_id) {
        planWhereClause += ` AND c.customer_id = ?`;
        planParams.push(customer_id);
      }
      if (start_date) {
        planWhereClause += ` AND DATE(pp.payment_date) >= ?`;
        planParams.push(start_date);
      }
      if (end_date) {
        planWhereClause += ` AND DATE(pp.payment_date) <= ?`;
        planParams.push(end_date);
      }

      const { total } = db.prepare(`
        SELECT COUNT(*) as total FROM contract_payment_plans pp
        INNER JOIN contracts c ON pp.contract_id = c.id
        INNER JOIN customers cu ON c.customer_id = cu.id
        WHERE cu.is_deleted = 0 AND pp.payment_status IN ('unpaid', 'partial') AND ${planWhereClause}
      `).get(...planParams);

      const payments = db.prepare(`
        SELECT 
          pp.id,
          NULL as payment_no,
          pp.contract_id,
          pp.payment_no as plan_payment_no,
          (pp.payment_amount - COALESCE(pp.actual_amount, 0)) as amount,
          pp.payment_date as actual_date,
          pp.payment_date as planned_date,
          CASE WHEN pp.payment_status = 'partial' THEN 'partial' ELSE 'pending' END as status,
          NULL as method,
          NULL as notes,
          NULL as creator_id,
          c.contract_no,
          c.title as contract_title,
          c.amount as contract_amount,
          cu.name as customer_name,
          NULL as creator_name
        FROM contract_payment_plans pp
        INNER JOIN contracts c ON pp.contract_id = c.id
        INNER JOIN customers cu ON c.customer_id = cu.id
        WHERE cu.is_deleted = 0 AND pp.payment_status IN ('unpaid', 'partial') AND ${planWhereClause}
        ORDER BY cu.name ASC, c.title ASC, pp.payment_date DESC
        LIMIT ? OFFSET ?
      `).all(...planParams, parseInt(limit), offset);

      return res.json({
        data: payments,
        pagination: {
          total: parseInt(total),
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      });
    }

    // 已回款或其他状态,从 payments 表查询
    let whereClause = '1=1' + ownerCondition;
    const params = [];

    if (contract_id) {
      whereClause += ` AND p.contract_id = ?`;
      params.push(contract_id);
    }
    if (contract_no) {
      whereClause += ` AND c.contract_no LIKE ?`;
      params.push(`%${contract_no}%`);
    }
    if (customer_name) {
      whereClause += ` AND cu.name LIKE ?`;
      params.push(`%${customer_name}%`);
    }
    if (customer_id) {
      whereClause += ` AND p.customer_id = ?`;
      params.push(customer_id);
    }
    if (mappedStatus === '已回款') {
      whereClause += ` AND p.status IN ${RECEIVED_STATUS_SQL}`;
    } else if (status) {
      whereClause += ` AND p.status = ?`;
      params.push(mappedStatus);
    }
    if (start_date) {
      whereClause += ` AND DATE(p.actual_date) >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ` AND DATE(p.actual_date) <= ?`;
      params.push(end_date);
    }

    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND ${whereClause}
    `).get(...params);

    const payments = db.prepare(`
      SELECT
        p.*,
        c.contract_no,
        c.title as contract_title,
        c.amount as contract_amount,
        cu.name as customer_name,
        u.name as creator_name
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      LEFT JOIN users u ON p.creator_id = u.id
      WHERE cu.is_deleted = 0 AND ${whereClause}
      ORDER BY cu.name ASC, c.title ASC, p.actual_date DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
      data: payments,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取回款列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取即将到期回款(未来 30 天)
// =====================================================
router.get('/upcoming', authMiddleware, (req, res) => {
  try {
    const { days = 30 } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }

    // 从付款计划中获取待付款记录
    const upcomingPayments = db.prepare(`
      SELECT
        pp.id,
        pp.contract_id,
        c.customer_id,
        pp.payment_no,
        (pp.payment_amount - COALESCE(pp.actual_amount, 0)) AS payment_amount,
        pp.payment_date,
        pp.payment_status,
        c.contract_no,
        c.title as contract_title,
        cu.name as customer_name,
        julianday(pp.payment_date) - julianday('now') as days_until_due
      FROM contract_payment_plans pp
      INNER JOIN contracts c ON pp.contract_id = c.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE pp.payment_status IN ('unpaid', 'partial')
        AND pp.payment_date IS NOT NULL
        AND pp.payment_date >= date('now')
        AND pp.payment_date <= date('now', ? || ' days')
        AND cu.is_deleted = 0
        ${ownerCondition}
      ORDER BY pp.payment_date ASC
    `).all(days);

    res.json({
      data: upcomingPayments,
      total: upcomingPayments.length
    });
  } catch (error) {
    console.error('获取到期回款错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({ error: '服务器错误:' + error.message });
  }
});

// =====================================================
// 获取回款详情(支持实际回款和待回款计划)
// =====================================================
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    // 首先尝试获取实际回款记录
    let payment = db.prepare(`
      SELECT
        p.*,
        c.contract_no,
        c.title as contract_title,
        cu.name as customer_name,
        u.name as creator_name
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      LEFT JOIN users u ON p.creator_id = u.id
      WHERE p.id = ? AND cu.is_deleted = 0
    `).get(id);

    if (payment) {
      if (!canAccessCustomer(req.user, payment.customer_id)) {
        return res.status(403).json({ error: '无权限查看该回款记录' });
      }
      // 获取变更日志
      const changeLogs = db.prepare(`
        SELECT * FROM payment_change_logs
        WHERE payment_id = ?
        ORDER BY changed_at DESC
      `).all(id);

      res.json({ payment, changeLogs });
      return;
    }

    // 如果在payments表中没找到,尝试获取待回款计划
    const plan = db.prepare(`
      SELECT
        pp.id,
        pp.contract_id,
        c.customer_id,
        pp.payment_no as plan_payment_no,
        pp.payment_amount as amount,
        pp.payment_date as planned_date,
        'pending' as status,
        pp.payment_status,
        pp.payment_remark as notes,
        pp.actual_payment_date as actual_date,
        'pending' as type,
        NULL as method,
        NULL as creator_id,
        c.contract_no,
        c.title as contract_title,
        cu.name as customer_name,
        u.name as creator_name
      FROM contract_payment_plans pp
      INNER JOIN contracts c ON pp.contract_id = c.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN users u ON cu.owner_id = u.id
      WHERE pp.id = ? AND cu.is_deleted = 0
    `).get(id);

    if (plan) {
      const planContract = db.prepare('SELECT customer_id FROM contracts WHERE id = ?').get(plan.contract_id);
      if (!planContract || !canAccessCustomer(req.user, planContract.customer_id)) {
        return res.status(403).json({ error: '无权限查看该付款计划' });
      }
      // 返回待回款计划信息
      res.json({
        payment: plan,
        changeLogs: [],
        isPendingPaymentPlan: true
      });
      return;
    }

    // 两个表都没找到
    return res.status(404).json({ error: '回款记录或待回款计划不存在' });
  } catch (error) {
    console.error('获取回款详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 创建回款记录
// =====================================================
router.post('/', authMiddleware, (req, res) => {
  try {
    const {
      contract_id,
      customer_id,
      type,
      amount,
      planned_date,
      actual_date,
      status,
      method,
      notes,
      payment_plan_id
    } = req.body;

    const userRole = req.user.role;
    const userId = req.user.id;

    const paymentAmount = Number(amount);
    const normalizedStatus = normalizePaymentStatus(status || '已回款');

    if (!contract_id || !customer_id || !Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: '必填字段不能为空' });
    }
    if (normalizedStatus !== '已回款') {
      return res.status(400).json({ error: '新增回款只能录入已实际到账的记录，待回款请维护付款计划' });
    }

    // 权限检查:验证客户归属(含共享客户)
    const customer = db.prepare('SELECT owner_id, secondary_owner_id FROM customers WHERE id = ? AND is_deleted = 0').get(customer_id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    if (userRole === 'sales') {
      if (!customer.owner_id || (customer.owner_id !== userId && customer.secondary_owner_id !== userId)) {
        return res.status(403).json({ error: '无权限为该客户创建回款记录,该客户不属于您或未共享给您' });
      }
    }

    const contract = db.prepare('SELECT amount, payment_times, customer_id FROM contracts WHERE id = ?').get(contract_id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (contract.customer_id !== customer_id) {
      return res.status(400).json({ error: '合同与客户不匹配' });
    }
    // 校验回款金额：单笔回款金额不能超过剩余可回款金额
    const currentTotalReceived = Number(db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments
      WHERE contract_id = ? AND status IN ${RECEIVED_STATUS_SQL}
    `).get(contract_id).total || 0);
    const remainingAmount = contract.amount - currentTotalReceived;
    if (paymentAmount > remainingAmount + 0.01) {
      return res.status(400).json({
        error: `回款金额超出合同剩余可回款金额。合同金额${contract.amount}元，已回款${currentTotalReceived}元，最多还能回款${remainingAmount.toFixed(2)}元`
      });
    }

    const id = uuidv4();
    const paymentNo = `PAY${Date.now()}`;

    if (payment_plan_id) {
      const plan = db.prepare(`
        SELECT id, payment_amount, actual_amount FROM contract_payment_plans
        WHERE id = ? AND contract_id = ? AND payment_status IN ('unpaid', 'partial')
      `).get(payment_plan_id, contract_id);
      if (!plan) return res.status(400).json({ error: '付款计划不存在、已回款或不属于所选合同' });
      const planRemaining = Number(plan.payment_amount) - Number(plan.actual_amount || 0);
      if (paymentAmount > planRemaining + 0.01) {
        return res.status(400).json({ error: `本期最多还能回款${Math.max(0, planRemaining).toFixed(2)}元` });
      }
    }

    const paymentDate = actual_date || new Date().toISOString().split('T')[0];
    db.transaction(() => {
      db.prepare(`
        INSERT INTO payments (
          id, payment_no, contract_id, customer_id, type, amount,
          planned_date, actual_date, status, method, notes, payment_plan_id, creator_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, paymentNo, contract_id, customer_id, type || '回款', paymentAmount,
        planned_date, paymentDate, normalizedStatus, method, notes, payment_plan_id || null, req.user.id
      );

      if (payment_plan_id) recalculatePaymentPlan(payment_plan_id);

      recalculateContractPaymentTotals(contract_id);
    })();

    res.status(201).json({
      message: '回款记录创建成功',
      id,
      paymentNo
    });
  } catch (error) {
    console.error('创建回款记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 更新回款记录
// =====================================================
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      notes,
      actual_date,
      method,
      amount
    } = req.body;

    const oldPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!oldPayment) {
      return res.status(404).json({ error: '回款记录不存在' });
    }
    if (!canAccessCustomer(req.user, oldPayment.customer_id)) {
      return res.status(403).json({ error: '无权限编辑该回款记录' });
    }

    const fieldLabels = {
      status: '回款状态',
      notes: '备注',
      actual_date: '回款日期',
      method: '回款方式',
      amount: '回款金额'
    };

    const nextStatus = normalizePaymentStatus(status ?? oldPayment.status);
    const nextAmount = amount === undefined ? Number(oldPayment.amount) : Number(amount);
    if (nextStatus !== '已回款') {
      return res.status(400).json({ error: '实际回款记录不能改为待回款，请维护对应付款计划' });
    }
    if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
      return res.status(400).json({ error: '回款金额必须大于0' });
    }

    const contractId = oldPayment.contract_id;
    const contract = db.prepare('SELECT amount FROM contracts WHERE id = ?').get(contractId);
    const otherReceived = Number(db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments
      WHERE contract_id = ? AND id <> ? AND status IN ${RECEIVED_STATUS_SQL}
    `).get(contractId, id).total || 0);
    const currentTotalReceived = otherReceived + Number(oldPayment.amount || 0);
    const nextTotalReceived = otherReceived + nextAmount;
    if (
      contract
      && nextTotalReceived > Number(contract.amount) + 0.01
      && nextTotalReceived > currentTotalReceived + 0.01
    ) {
      return res.status(400).json({
        error: `回款金额修改后，累计回款超出合同金额。合同金额${contract.amount}元，修改后累计回款${nextTotalReceived}元`
      });
    }

    const fieldMap = { status: nextStatus, notes, actual_date, method, amount: nextAmount };

    const updateFields = [];
    const updateValues = [];
    const changeLogs = [];

    for (const [field, value] of Object.entries(fieldMap)) {
      if (value !== undefined) {
        const oldValue = oldPayment[field];
        const oldStr = oldValue === null || oldValue === undefined ? '' : String(oldValue);
        const newStr = value === null || value === undefined ? '' : String(value);

        if (oldStr !== newStr) {
          changeLogs.push({ field, oldStr });
        }

        updateFields.push(`${field} = ?`);
        updateValues.push(value);
      }
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.transaction(() => {
      const changeLogInsert = db.prepare('INSERT INTO payment_change_logs (id, payment_id, changed_by, changed_by_name, changed_at, field_name, old_value) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)');
      changeLogs.forEach(({ field, oldStr }) => {
        changeLogInsert.run(uuidv4(), id, req.user.id, req.user.name || req.user.username, fieldLabels[field] || field, oldStr);
      });

      db.prepare(`UPDATE payments SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

      recalculatePaymentPlan(oldPayment.payment_plan_id);
      recalculateContractPaymentTotals(contractId);
    })();

    res.json({ message: '回款记录更新成功' });
  } catch (error) {
    console.error('更新回款记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取回款统计
// =====================================================
router.get('/stats/overview', authMiddleware, (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    // 默认本年度
    const currentYear = new Date().getFullYear();
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    let whereClause = 'cu.is_deleted = 0';
    const params = [];

    // 优先使用前端传入的日期范围,否则默认本年度
    if (start_date && end_date) {
      whereClause += ` AND DATE(p.actual_date) >= ? AND DATE(p.actual_date) <= ?`;
      params.push(start_date, end_date);
    } else {
      whereClause += ` AND DATE(p.actual_date) >= ? AND DATE(p.actual_date) <= ?`;
      params.push(yearStart, yearEnd);
    }

    // 权限控制:销售只能看到自己的回款
    if (userRole === 'sales') {
      whereClause += ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }

    // 回款总数
    const { total_count } = db.prepare(`
      SELECT COUNT(*) as total_count FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      WHERE ${whereClause} AND p.status IN ${RECEIVED_STATUS_SQL}
    `).get(...params);

    // 回款总金额
    const { total_amount } = db.prepare(`
      SELECT SUM(p.amount) as total_amount FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      WHERE ${whereClause} AND p.status IN ${RECEIVED_STATUS_SQL}
    `).get(...params);

    // 按回款方式统计
    const by_method = db.prepare(`
      SELECT p.method, COUNT(*) as count, SUM(p.amount) as total_amount
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      WHERE ${whereClause} AND p.status IN ${RECEIVED_STATUS_SQL} AND p.method IS NOT NULL
      GROUP BY p.method
    `).all(...params);

    // 按月统计(最近 12 个月)
    const by_month = db.prepare(`
      SELECT
        strftime('%Y-%m', p.actual_date) as month,
        COUNT(*) as count,
        SUM(p.amount) as total_amount
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      WHERE ${whereClause} AND p.status IN ${RECEIVED_STATUS_SQL}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `).all(...params);

    // 去年已回款数据
    const lastYear = String(new Date().getFullYear() - 1);
    const lastYearStart = `${lastYear}-01-01`;
    const lastYearEnd = `${lastYear}-12-31`;

    let lastYearWhere = 'cu.is_deleted = 0';
    lastYearWhere += ` AND DATE(p.actual_date) >= ? AND DATE(p.actual_date) <= ?`;
    if (userRole === 'sales') {
      lastYearWhere += ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }

    const { last_year_received_count, last_year_received_amount } = db.prepare(`
      SELECT COUNT(*) as last_year_received_count, COALESCE(SUM(p.amount), 0) as last_year_received_amount
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      WHERE ${lastYearWhere}
        AND p.status IN ${RECEIVED_STATUS_SQL}
    `).get(lastYearStart, lastYearEnd);

    // 去年待回款数据(从付款计划表中查询)
    // 注意:付款计划表使用 pp 别名,权限条件需适配
    let pendingOwnerCondition = '';
    if (userRole === 'sales') {
      pendingOwnerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }

    const { last_year_pending_count, last_year_pending_amount } = db.prepare(`
      SELECT COUNT(*) as last_year_pending_count, COALESCE(SUM(pp.payment_amount - COALESCE(pp.actual_amount, 0)), 0) as last_year_pending_amount
      FROM contract_payment_plans pp
      INNER JOIN contracts c ON pp.contract_id = c.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE cu.is_deleted = 0 ${pendingOwnerCondition}
        AND pp.payment_status IN ('unpaid', 'partial')
        AND strftime('%Y', pp.payment_date) = ?
    `).get(lastYear);

    const { pending_count, pending_amount } = db.prepare(`
      SELECT COUNT(*) as pending_count, COALESCE(SUM(pp.payment_amount - COALESCE(pp.actual_amount, 0)), 0) as pending_amount
      FROM contract_payment_plans pp
      INNER JOIN contracts c ON pp.contract_id = c.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE cu.is_deleted = 0 ${pendingOwnerCondition}
        AND pp.payment_status IN ('unpaid', 'partial')
        AND DATE(pp.payment_date) >= ? AND DATE(pp.payment_date) <= ?
    `).get(start_date && end_date ? start_date : yearStart, start_date && end_date ? end_date : yearEnd);

    res.json({
      total_count: total_count || 0,
      total_amount: total_amount || 0,
      pending_count: pending_count || 0,
      pending_amount: pending_amount || 0,
      by_method,
      by_month,
      last_year_received_count: last_year_received_count || 0,
      last_year_received_amount: last_year_received_amount || 0,
      last_year_pending_count: last_year_pending_count || 0,
      last_year_pending_amount: last_year_pending_amount || 0
    });
  } catch (error) {
    console.error('获取回款统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 更新付款计划(待回款记录编辑)
// =====================================================
router.put('/plan/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { payment_date, payment_amount, notes, status, actual_amount, actual_date, method } = req.body;

    // 统一金额字段：前端可能传 payment_amount 或 actual_amount，合并为一个
    const amount = actual_amount ?? payment_amount;

    // 查询付款计划（需 JOIN contracts 获取 customer_id）
    const plan = db.prepare(`
      SELECT pp.*, c.customer_id
      FROM contract_payment_plans pp
      INNER JOIN contracts c ON pp.contract_id = c.id
      WHERE pp.id = ? AND pp.payment_status IN ('unpaid', 'partial')
    `).get(id);
    if (!plan) {
      return res.status(404).json({ error: '付款计划不存在或已回款' });
    }
    if (!canAccessCustomer(req.user, plan.customer_id)) {
      return res.status(403).json({ error: '无权限编辑该付款计划' });
    }

    // ========== 场景1：用户将状态改为"已回款" → 创建实际回款记录 ==========
    if (normalizePaymentStatus(status) === '已回款') {
      const contract = db.prepare('SELECT amount, payment_times FROM contracts WHERE id = ?').get(plan.contract_id);
      if (!contract) {
        return res.status(404).json({ error: '合同不存在' });
      }

      // 实际回款金额：用户传了则用用户值，否则用计划金额
      const planRemaining = Math.max(0, Number(plan.payment_amount) - Number(plan.actual_amount || 0));
      const finalAmount = Number(amount ?? planRemaining);
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
        return res.status(400).json({ error: '回款金额必须大于0' });
      }

      // 校验回款金额：单笔回款金额不能超过剩余可回款金额
      const totalReceived = Number(db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM payments
        WHERE contract_id = ? AND status IN ${RECEIVED_STATUS_SQL}
      `).get(plan.contract_id).total || 0);
      const remainingAmount = contract.amount - totalReceived;
      if (finalAmount > remainingAmount + 0.01) {
        return res.status(400).json({
          error: `回款金额超出合同剩余可回款金额。合同金额${contract.amount}元，已回款${totalReceived}元，最多还能回款${remainingAmount.toFixed(2)}元`
        });
      }
      if (finalAmount > planRemaining + 0.01) {
        return res.status(400).json({ error: `本期最多还能回款${planRemaining.toFixed(2)}元` });
      }
      const finalDate = actual_date || plan.payment_date || new Date().toISOString().split('T')[0];

      const tx = db.transaction(() => {
        // 1. 创建实际回款记录
        const paymentId = uuidv4();
        const paymentNo = `PAY${Date.now()}`;
        db.prepare(`
          INSERT INTO payments (
            id, payment_no, contract_id, customer_id, type, amount,
            planned_date, actual_date, status, method, notes, payment_plan_id, creator_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          paymentId, paymentNo, plan.contract_id, plan.customer_id, '回款', finalAmount,
          plan.payment_date, finalDate, '已回款', method || null, notes || null, id, req.user.id
        );

        // 2. 更新付款计划状态
        recalculatePaymentPlan(id);
        recalculateContractPaymentTotals(plan.contract_id);
      });

      tx();

      return res.json({ message: '回款记录已更新，状态已转为已回款' });
    }

    // ========== 场景2：仅编辑待回款计划（不改状态） ==========
    const updateFields = [];
    const updateValues = [];

    if (payment_date !== undefined) {
      updateFields.push('payment_date = ?');
      updateValues.push(payment_date);
    }
    if (payment_amount !== undefined) {
      const nextPlanAmount = Number(payment_amount);
      if (!Number.isFinite(nextPlanAmount) || nextPlanAmount <= 0) {
        return res.status(400).json({ error: '计划回款金额必须大于0' });
      }
      if (nextPlanAmount + 0.01 < Number(plan.actual_amount || 0)) {
        return res.status(400).json({ error: '计划回款金额不能小于本期已到账金额' });
      }
      const contract = db.prepare('SELECT amount FROM contracts WHERE id = ?').get(plan.contract_id);
      const otherPlanTotal = Number(db.prepare(`
        SELECT COALESCE(SUM(payment_amount), 0) AS total
        FROM contract_payment_plans WHERE contract_id = ? AND id != ?
      `).get(plan.contract_id, id).total || 0);
      if (contract && Math.abs(otherPlanTotal + nextPlanAmount - Number(contract.amount)) > 0.01) {
        return res.status(400).json({ error: '修改后付款计划总额必须与合同金额一致' });
      }
      updateFields.push('payment_amount = ?');
      updateValues.push(nextPlanAmount);
    }
    if (notes !== undefined) {
      updateFields.push('payment_remark = ?');
      updateValues.push(notes);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.prepare(`UPDATE contract_payment_plans SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    res.json({ message: '付款计划更新成功' });
  } catch (error) {
    console.error('更新付款计划错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 从付款计划创建回款记录
// =====================================================
router.post('/from-plan', authMiddleware, (req, res) => {
  try {
    const { payment_plan_id, actual_date, method, notes, actual_amount } = req.body;
    const userId = req.user.id;

    console.log('从付款计划创建回款:', { payment_plan_id, actual_date, method, notes, actual_amount });

    if (!payment_plan_id) {
      return res.status(400).json({ error: '请选择付款计划' });
    }

    // 获取付款计划信息
    const plan = db.prepare(`
      SELECT pp.*, c.customer_id, pp.contract_id
      FROM contract_payment_plans pp
      INNER JOIN contracts c ON pp.contract_id = c.id
      WHERE pp.id = ? AND pp.payment_status IN ('unpaid', 'partial')
    `).get(payment_plan_id);

    console.log('付款计划信息:', plan);

    if (!plan) {
      return res.status(404).json({ error: '付款计划不存在或已付款' });
    }
    if (!canAccessCustomer(req.user, plan.customer_id)) {
      return res.status(403).json({ error: '无权限操作该付款计划' });
    }

    const contract = db.prepare('SELECT amount, payment_times FROM contracts WHERE id = ?').get(plan.contract_id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    const id = uuidv4();
    const paymentNo = `PAY${Date.now()}`;
    // 实际回款金额：可自定义，否则使用计划金额
    const planRemaining = Math.max(0, Number(plan.payment_amount) - Number(plan.actual_amount || 0));
    const finalAmount = Number((actual_amount !== undefined && actual_amount !== null) ? actual_amount : planRemaining);
    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ error: '回款金额必须大于0' });
    }
    const receivedBefore = Number(db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments
      WHERE contract_id = ? AND status IN ${RECEIVED_STATUS_SQL}
    `).get(plan.contract_id).total || 0);
    if (receivedBefore + finalAmount > Number(contract.amount) + 0.01) {
      return res.status(400).json({ error: '回款金额超出合同剩余可回款金额' });
    }
    if (finalAmount > planRemaining + 0.01) {
      return res.status(400).json({ error: `本期最多还能回款${planRemaining.toFixed(2)}元` });
    }

    const paymentDate = actual_date || new Date().toISOString().split('T')[0];
    db.transaction(() => {
      db.prepare(`
          INSERT INTO payments (
            id, payment_no, contract_id, customer_id, type, amount,
            planned_date, actual_date, status, method, notes, payment_plan_id, creator_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, paymentNo, plan.contract_id, plan.customer_id, '回款', finalAmount,
          plan.payment_date, paymentDate, '已回款', method || null, notes || null, payment_plan_id, userId
      );

      recalculatePaymentPlan(payment_plan_id);
      recalculateContractPaymentTotals(plan.contract_id);
    })();

    res.status(201).json({
      message: '回款记录创建成功',
      id,
      paymentNo
    });
  } catch (error) {
    console.error('从付款计划创建回款错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({ error: '服务器错误:' + error.message });
  }
});

// =====================================================
// 校验付款计划总额
// =====================================================
router.post('/validate-plan', authMiddleware, (req, res) => {
  try {
    const { contract_id, payment_plans } = req.body;

    if (!contract_id) {
      return res.status(400).json({ error: '请选择合同' });
    }

    if (!payment_plans || !Array.isArray(payment_plans)) {
      return res.status(400).json({ error: '付款计划数据格式错误' });
    }

    const contract = db.prepare('SELECT amount FROM contracts WHERE id = ?').get(contract_id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }

    const planTotal = payment_plans.reduce((sum, p) => sum + (p.amount || 0), 0);
    const diff = planTotal - contract.amount;
    const valid = Math.abs(diff) <= 0.01;

    res.json({
      valid,
      contractAmount: contract.amount,
      planTotal,
      diff: parseFloat(diff.toFixed(2)),
      message: valid ? '校验通过' : `差额${diff.toFixed(2)}元`
    });
  } catch (error) {
    console.error('校验付款计划错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 删除回款记录
// =====================================================
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;

    // 权限校验：删除回款属于高危操作，仅管理员（admin）与超级管理员（super_admin）可执行
    if (!isSystemAdmin(userRole)) {
      return res.status(403).json({ error: '仅管理员可删除回款记录' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!payment) {
      return res.status(404).json({ error: '回款记录不存在' });
    }

    // 审计日志所需的客户、合同、创建人信息（回款记录删除后无法再查到）
    const auditInfo = db.prepare(`
      SELECT cu.name AS customer_name, c.contract_no, c.title AS contract_title, u.name AS creator_name
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON p.customer_id = cu.id
      LEFT JOIN users u ON p.creator_id = u.id
      WHERE p.id = ?
    `).get(id) || {};

    const tx = db.transaction(() => {
      // payment_change_logs 外键指向 payments 且未设置级联删除，需先清理，否则删除会触发外键约束失败
      db.prepare('DELETE FROM payment_change_logs WHERE payment_id = ?').run(id);

      // 写入操作审计日志，保留删除痕迹
      db.prepare(`
        INSERT INTO operation_logs (id, user_id, module, action, content, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        req.user.id,
        'payments',
        'delete',
        `删除回款记录：${payment.payment_no || id}，客户${auditInfo.customer_name || '-'}，合同${auditInfo.contract_no || '-'}（${auditInfo.contract_title || '-'}），金额${payment.amount}元，回款日期${payment.actual_date || '-'}，原创建人${auditInfo.creator_name || '-'}`,
        req.ip || ''
      );

      // 删除回款记录
      db.prepare('DELETE FROM payments WHERE id = ?').run(id);

      // 仅回退与当前回款明确关联的付款计划，避免同日多期时误改其他期次。
      recalculatePaymentPlan(payment.payment_plan_id);
      recalculateContractPaymentTotals(payment.contract_id);
    });

    tx();

    res.json({ message: '回款记录删除成功' });
  } catch (error) {
    console.error('删除回款记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 回款金额异常检测（笔数一致但金额不符）
// =====================================================
router.get('/stats/amount-mismatch', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }

    const mismatchContracts = db.prepare(`
      SELECT
        c.id AS contract_id,
        c.contract_no,
        c.title AS contract_title,
        c.amount AS contract_amount,
        COALESCE((
          SELECT SUM(p2.amount) FROM payments p2
          WHERE p2.contract_id = c.id AND p2.status IN ${RECEIVED_STATUS_SQL}
        ), 0) AS total_received,
        (SELECT COUNT(*) FROM payments p3
         WHERE p3.contract_id = c.id AND p3.status IN ${RECEIVED_STATUS_SQL}) AS payment_count,
        (SELECT COUNT(*) FROM contract_payment_plans pp
         WHERE pp.contract_id = c.id) AS plan_count,
        c.amount - COALESCE((
          SELECT SUM(p4.amount) FROM payments p4
          WHERE p4.contract_id = c.id AND p4.status IN ${RECEIVED_STATUS_SQL}
        ), 0) AS diff,
        cu.name AS customer_name
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE cu.is_deleted = 0 ${ownerCondition}
      GROUP BY c.id
      HAVING
        payment_count = plan_count
        AND payment_count > 0
        AND ABS(diff) > 0.01
      ORDER BY diff ASC
    `).all();

    let totalUnpaid = 0;
    let totalOverpaid = 0;
    mismatchContracts.forEach(row => {
      if (row.diff > 0) totalUnpaid += row.diff;
      else totalOverpaid += row.diff;
    });

    res.json({
      data: mismatchContracts,
      total: mismatchContracts.length,
      summary: {
        total_unpaid: parseFloat(totalUnpaid.toFixed(2)),
        total_overpaid: parseFloat(totalOverpaid.toFixed(2))
      }
    });
  } catch (error) {
    console.error('回款金额异常检测错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
