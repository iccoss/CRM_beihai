const express = require('express');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');

const router = express.Router();
const canViewAll = role => ['admin', 'super_admin', 'operations', 'fde_admin'].includes(role);
const canViewAllDashboardData = role => canViewAll(role);
const isTechnicalDashboardRole = role => ['presales', 'fde'].includes(role);

// 开周会「未分配销售」的固定标识：商机 owner_id 指向已被删除的用户时使用
const UNASSIGNED_OWNER_KEY = '__unassigned__';

// 商机状态白名单：与 opportunities 路由的 validStatuses 保持一致
const OPPORTUNITY_STATUSES = ['potential', 'technical', 'poc', 'project', 'bidding', 'contracting', 'signed', 'lost'];
// 「在跟」口径：进行中的 6 个状态，不含已签与已终止
const ACTIVE_OPPORTUNITY_STATUSES = new Set(['potential', 'technical', 'poc', 'project', 'bidding', 'contracting']);

// 解析开周会统计周期参数，返回左闭右开的时间窗。
// 供「销售季度签约管道」与「商机数据」列表共用，确保两处按同一口径归属周期。
// 参数非法时返回 null，由调用方决定报 400 还是忽略过滤。
function resolveMeetingPeriod(query = {}) {
  const now = new Date();
  const requestedYear = Number.parseInt(query.year, 10);
  const requestedQuarter = Number.parseInt(query.quarter, 10);
  const year = Number.isInteger(requestedYear) ? requestedYear : now.getFullYear();
  const quarter = Number.isInteger(requestedQuarter) ? requestedQuarter : Math.floor(now.getMonth() / 3) + 1;
  // 统计维度：quarter（按季度，默认）| year（按年）
  const periodType = query.period_type === 'year' ? 'year' : 'quarter';

  if (year < 2000 || year > 2100) return null;
  // 仅在按季度统计时校验季度取值，按年统计忽略 quarter
  if (periodType === 'quarter' && (quarter < 1 || quarter > 4)) return null;

  let startDate;
  let endDate;
  if (periodType === 'year') {
    // 按年：[年初, 次年初)
    startDate = `${year}-01-01`;
    endDate = `${year + 1}-01-01`;
  } else {
    // 按季度：[季度首月 1 日, 下季度首月 1 日)
    const startMonth = String((quarter - 1) * 3 + 1).padStart(2, '0');
    const endYear = quarter === 4 ? year + 1 : year;
    const endMonth = String(quarter === 4 ? 1 : quarter * 3 + 1).padStart(2, '0');
    startDate = `${year}-${startMonth}-01`;
    endDate = `${endYear}-${endMonth}-01`;
  }

  return { periodType, year, quarter, startDate, endDate };
}

// =====================================================
// 商机「历史状态快照」查询辅助
// =====================================================
// 统计口径（与需求一致）：
// - 季度视图 = 累计快照：统计所有「创建时间 < 季末」的商机，状态取季末时点的快照值，
//   即该商机在 changed_at < 季末 的最后一条变更日志的 to_status；若季末前没有任何日志，
//   则回落为当前状态。这样过去季度的数字会冻结为当时的状态，后续状态变化只体现在更晚的季度。
// - 年度视图 = 仅当年新建：统计「创建时间落在当年」的商机，状态取当前最新值。
// 时区：created_at / changed_at 由 CURRENT_TIMESTAMP 写入，存的是 UTC，
// 统一用 '+8 hours' 换算成北京时间再取日期，避免凌晨创建的商机归到前一天/前一季。
// period 传 null 时表示不做周期过滤，快照状态退化为当前状态。
// 使用方式：withClause 必须拼在 SELECT 之前，withParams 也要排在所有 WHERE 参数之前。
function buildOpportunitySnapshotQuery(period) {
  if (!period) {
    return {
      isSnapshot: false,
      withClause: '',
      withParams: [],
      joinClause: '',
      statusExpr: 'o.status',
      rangeClause: '1 = 1',
      rangeParams: []
    };
  }

  if (period.periodType === 'year') {
    // 年度：仅统计当年新建的商机，状态直接用当前最新值
    return {
      isSnapshot: false,
      withClause: '',
      withParams: [],
      joinClause: '',
      statusExpr: 'o.status',
      rangeClause: "DATE(o.created_at, '+8 hours') >= DATE(?) AND DATE(o.created_at, '+8 hours') < DATE(?)",
      rangeParams: [period.startDate, period.endDate]
    };
  }

  // 季度：累计快照，状态取季末时点
  return {
    isSnapshot: true,
    // 每条商机取季末之前最后一条状态变更日志（CTE + 窗口函数）
    withClause: `WITH snapshot_log AS (
        SELECT opportunity_id, to_status,
               ROW_NUMBER() OVER (PARTITION BY opportunity_id ORDER BY changed_at DESC, id DESC) AS rn
        FROM opportunity_change_logs
        WHERE DATE(changed_at, '+8 hours') < DATE(?)
      )`,
    withParams: [period.endDate],
    joinClause: 'LEFT JOIN snapshot_log sl ON sl.opportunity_id = o.id AND sl.rn = 1',
    statusExpr: 'COALESCE(sl.to_status, o.status)',
    rangeClause: "DATE(o.created_at, '+8 hours') < DATE(?)",
    rangeParams: [period.endDate]
  };
}

router.use(authMiddleware, (req, res, next) => {
  if (['presales', 'fde'].includes(req.user.role)) {
    const safeTechnicalPaths = [
      '/overview',
      '/dashboard-period-summary',
      '/customer-opportunity-status',
      '/pipeline-stage-stats',
      '/recent-followups',
      '/opportunity-period-metrics',
      '/customers',
      '/followup-type-stats',
      '/conversion-funnel'
    ];
    if (req.method !== 'GET' || !safeTechnicalPaths.includes(req.path)) {
      return res.status(403).json({ error: '技术角色不可查看经营金额统计' });
    }
  }
  next();
});

// 辅助函数：获取角色权限条件
// 管理员、运营和 FDE 管理员在数据概览查看全量；技术角色的金额在接口层脱敏。
function getOwnerCondition(userRole, userId, alias = 'c') {
  if (canViewAllDashboardData(userRole)) return '';
  if (userRole === 'presales') return ` AND EXISTS (
    SELECT 1 FROM opportunities scope_o JOIN opportunity_assignments scope_a ON scope_a.opportunity_id = scope_o.id
    WHERE scope_o.customer_id = ${alias}.id AND scope_a.user_id = '${userId}' AND scope_a.assignment_type = 'presales' AND scope_a.status = 'active'
  )`;
  if (userRole === 'fde') return ` AND EXISTS (
    SELECT 1 FROM opportunities scope_o JOIN opportunity_assignments scope_a ON scope_a.opportunity_id = scope_o.id
    WHERE scope_o.customer_id = ${alias}.id AND scope_a.user_id = '${userId}' AND scope_a.assignment_type = 'fde' AND scope_a.status = 'active'
  )`;
  return ` AND (${alias}.owner_id = '${userId}' OR ${alias}.secondary_owner_id = '${userId}')`;
}

function getOpportunityScope(userRole, userId, alias = 'o') {
  if (canViewAllDashboardData(userRole)) return '';
  if (userRole === 'presales') return ` AND EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = ${alias}.id AND a.user_id = '${userId}' AND a.assignment_type = 'presales' AND a.status = 'active')`;
  if (userRole === 'fde') return ` AND EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = ${alias}.id AND a.user_id = '${userId}' AND a.assignment_type = 'fde' AND a.status = 'active')`;
  return ` AND ${alias}.owner_id = '${userId}'`;
}

// 合同范围权限：与「合同管理」列表保持一致
// 查询固定使用别名：ct=contracts、cu=customers、o=opportunities（通过 ct.opportunity_id 左连接）
function getContractScope(userRole, userId) {
  if (canViewAllDashboardData(userRole)) return '';
  if (['presales', 'fde', 'fde_admin'].includes(userRole)) {
    const assignmentType = userRole === 'presales' ? 'presales' : 'fde';
    return ` AND EXISTS (
      SELECT 1 FROM opportunity_assignments oa
      WHERE oa.opportunity_id = ct.opportunity_id AND oa.assignment_type = '${assignmentType}'
        AND oa.status = 'active' ${userRole === 'fde_admin' ? '' : `AND oa.user_id = '${userId}'`}
    )`;
  }
  return ` AND (o.owner_id = '${userId}' OR cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR
    EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
}

function getCreatorCondition(userRole, userId, alias = 'o') {
  if (canViewAll(userRole)) return '';
  return ` AND ${alias}.creator_id = '${userId}'`;
}

// 商机查询需过滤已删除客户
function getOppCondition(userRole, userId) {
  let cond = ' AND c.is_deleted = 0';
  if (!canViewAll(userRole)) {
    cond += ` AND o.owner_id = '${userId}'`;
  }
  return cond;
}

function getPeriodRange(query) {
  const now = new Date();
  const type = ['month', 'quarter', 'year'].includes(query.period_type) ? query.period_type : 'month';
  const requestedYear = Number.parseInt(query.year, 10);
  const year = Number.isInteger(requestedYear) ? requestedYear : now.getFullYear();
  let value;
  let startMonth;
  let monthCount;

  if (type === 'month') {
    const requestedMonth = Number.parseInt(query.month, 10);
    value = Number.isInteger(requestedMonth) ? requestedMonth : now.getMonth() + 1;
    if (value < 1 || value > 12) throw new Error('统计月份无效');
    startMonth = value;
    monthCount = 1;
  } else if (type === 'quarter') {
    const requestedQuarter = Number.parseInt(query.quarter, 10);
    value = Number.isInteger(requestedQuarter) ? requestedQuarter : Math.floor(now.getMonth() / 3) + 1;
    if (value < 1 || value > 4) throw new Error('统计季度无效');
    startMonth = (value - 1) * 3 + 1;
    monthCount = 3;
  } else {
    value = year;
    startMonth = 1;
    monthCount = 12;
  }

  if (year < 2000 || year > 2100) throw new Error('统计年份无效');
  const nextMonth = startMonth + monthCount;
  const endYear = year + Math.floor((nextMonth - 1) / 12);
  const endMonth = ((nextMonth - 1) % 12) + 1;

  return {
    type,
    year,
    value,
    startDate: `${year}-${String(startMonth).padStart(2, '0')}-01`,
    endDate: `${endYear}-${String(endMonth).padStart(2, '0')}-01`
  };
}

function shiftPeriodDate(dateString, monthOffset) {
  const [year, month, day] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + monthOffset, day));
  return shifted.toISOString().slice(0, 10);
}

function getPreviousPeriodRange(period) {
  const monthCount = period.type === 'month' ? 1 : period.type === 'quarter' ? 3 : 12;
  return {
    startDate: shiftPeriodDate(period.startDate, -monthCount),
    endDate: shiftPeriodDate(period.endDate, -monthCount)
  };
}

function createComparisonMetric(currentValue, previousValue, hidden = false) {
  if (hidden) return { value: null, previous_value: null, delta: null, change_rate: null };
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);
  return {
    value: current,
    previous_value: previous,
    delta: current - previous,
    change_rate: previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null
  };
}

// 按统计页当前标签导出经营数据，沿用统计接口的数据权限范围。
router.get('/export', authMiddleware, (req, res) => {
  try {
    const section = req.query.section || 'dashboard';
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const userId = req.user.id;
    const userRole = req.user.role;
    const ownerCond = getOwnerCondition(userRole, userId, 'cu');
    const oppCond = canViewAll(userRole) ? '' : 'AND o.owner_id = ?';
    const oppParams = canViewAll(userRole) ? [] : [userId];
    let headers = [];
    let rows = [];

    if (section === 'dashboard') {
      const summary = year => ({
        year,
        customer_count: db.prepare(`SELECT COUNT(*) AS value FROM customers cu WHERE cu.is_deleted = 0 AND strftime('%Y', cu.created_at) = ? ${ownerCond}`).get(String(year))?.value || 0,
        opportunity_count: db.prepare(`SELECT COUNT(*) AS value FROM opportunities o INNER JOIN customers c ON c.id = o.customer_id WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${oppCond}`).get(String(year), ...oppParams)?.value || 0,
        opportunity_amount: db.prepare(`SELECT COALESCE(SUM(o.amount), 0) AS value FROM opportunities o INNER JOIN customers c ON c.id = o.customer_id WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${oppCond}`).get(String(year), ...oppParams)?.value || 0,
        contract_count: db.prepare(`SELECT COUNT(*) AS value FROM contracts ct INNER JOIN customers cu ON cu.id = ct.customer_id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}`).get(String(year))?.value || 0,
        contract_amount: db.prepare(`SELECT COALESCE(SUM(ct.amount), 0) AS value FROM contracts ct INNER JOIN customers cu ON cu.id = ct.customer_id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}`).get(String(year))?.value || 0,
        payment_amount: db.prepare(`SELECT COALESCE(SUM(p.amount), 0) AS value FROM payments p INNER JOIN contracts ct ON ct.id = p.contract_id INNER JOIN customers cu ON cu.id = ct.customer_id WHERE cu.is_deleted = 0 AND p.status IN ('已回款', 'received', 'paid') AND strftime('%Y', p.actual_date) = ? ${ownerCond}`).get(String(year))?.value || 0
      });
      rows = [summary(currentYear), summary(lastYear)];
      headers = [
        { key: 'year', label: '年度' }, { key: 'customer_count', label: '新增客户数' },
        { key: 'opportunity_count', label: '新增商机数' }, { key: 'opportunity_amount', label: '商机金额' },
        { key: 'contract_count', label: '合同数' }, { key: 'contract_amount', label: '合同金额' },
        { key: 'payment_amount', label: '已回款金额' }
      ];
    } else if (section === 'timeTrend') {
      const sql = `SELECT ? AS year, CAST(strftime('%m', p.actual_date) AS INTEGER) AS month,
        COUNT(*) AS payment_count, COALESCE(SUM(p.amount), 0) AS payment_amount
        FROM payments p INNER JOIN contracts ct ON ct.id = p.contract_id
        INNER JOIN customers cu ON cu.id = ct.customer_id
        WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
        GROUP BY month ORDER BY month`;
      rows = [...db.prepare(sql).all(currentYear, String(currentYear)), ...db.prepare(sql).all(lastYear, String(lastYear))];
      headers = [{ key: 'year', label: '年度' }, { key: 'month', label: '月份' }, { key: 'payment_count', label: '回款笔数' }, { key: 'payment_amount', label: '回款金额' }];
    } else if (section === 'opportunity') {
      const sql = `SELECT ? AS year, o.status, COUNT(*) AS count, COALESCE(SUM(o.amount), 0) AS amount
        FROM opportunities o INNER JOIN customers c ON c.id = o.customer_id
        WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${oppCond}
        GROUP BY o.status ORDER BY amount DESC`;
      rows = [...db.prepare(sql).all(currentYear, String(currentYear), ...oppParams), ...db.prepare(sql).all(lastYear, String(lastYear), ...oppParams)]
        .map(row => ({ ...row, status: ({ potential:'潜在', technical:'技术交流', poc:'POC', project:'立项', bidding:'招投标', contracting:'合同中', signed:'已签', lost:'已丢失' })[row.status] || row.status }));
      headers = [{ key: 'year', label: '年度' }, { key: 'status', label: '商机状态' }, { key: 'count', label: '商机数' }, { key: 'amount', label: '商机金额' }];
    } else if (section === 'contract') {
      const sql = `SELECT ? AS year, COALESCE(o.type, '未分类') AS type, COUNT(*) AS count,
        COALESCE(SUM(ct.amount), 0) AS total_amount, COALESCE(SUM(ct.total_received), 0) AS received_amount,
        COALESCE(SUM(ct.unpaid_amount), 0) AS unpaid_amount
        FROM contracts ct INNER JOIN customers cu ON cu.id = ct.customer_id
        LEFT JOIN opportunities o ON o.id = ct.opportunity_id
        WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
        GROUP BY o.type ORDER BY total_amount DESC`;
      rows = [...db.prepare(sql).all(currentYear, String(currentYear)), ...db.prepare(sql).all(lastYear, String(lastYear))];
      headers = [{ key: 'year', label: '年度' }, { key: 'type', label: '合同类型' }, { key: 'count', label: '合同数' }, { key: 'total_amount', label: '合同金额' }, { key: 'received_amount', label: '已回款金额' }, { key: 'unpaid_amount', label: '待回款金额' }];
    } else if (section === 'payment') {
      const sql = `SELECT ? AS year, COALESCE(p.method, '未指定') AS method, COUNT(*) AS count,
        COALESCE(SUM(p.amount), 0) AS total_amount FROM payments p
        INNER JOIN contracts ct ON ct.id = p.contract_id INNER JOIN customers cu ON cu.id = ct.customer_id
        WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
        GROUP BY p.method ORDER BY total_amount DESC`;
      rows = [...db.prepare(sql).all(currentYear, String(currentYear)), ...db.prepare(sql).all(lastYear, String(lastYear))];
      headers = [{ key: 'year', label: '年度' }, { key: 'method', label: '回款方式' }, { key: 'count', label: '回款笔数' }, { key: 'total_amount', label: '回款金额' }];
    } else if (section === 'product') {
      const sql = `SELECT ? AS year, o.products AS product_name, COUNT(*) AS opportunity_count,
        COALESCE(SUM(o.amount), 0) AS opportunity_amount,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) AS signed_count
        FROM opportunities o INNER JOIN customers c ON c.id = o.customer_id
        WHERE c.is_deleted = 0 AND o.products IS NOT NULL AND o.products != ''
          AND strftime('%Y', o.created_at) = ? ${oppCond}
        GROUP BY o.products ORDER BY opportunity_amount DESC`;
      rows = [...db.prepare(sql).all(currentYear, String(currentYear), ...oppParams), ...db.prepare(sql).all(lastYear, String(lastYear), ...oppParams)];
      headers = [{ key: 'year', label: '年度' }, { key: 'product_name', label: '产品' }, { key: 'opportunity_count', label: '商机数' }, { key: 'opportunity_amount', label: '商机金额' }, { key: 'signed_count', label: '已签商机数' }];
    } else {
      return res.status(400).json({ error: '当前统计模块暂不支持导出' });
    }

    sendCsv(res, `statistics_${section}_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  } catch (error) {
    console.error('导出统计数据错误:', error);
    res.status(500).json({ error: '统计数据导出失败' });
  }
});

// =====================================================
// 商机运营周期指标（在跟按预计签约时间，转化按合同签订时间）
// =====================================================
router.get('/opportunity-period-metrics', authMiddleware, (req, res) => {
  try {
    const period = getPeriodRange(req.query);
    const opportunityScope = getOpportunityScope(req.user.role, req.user.id, 'o');

    const active = db.prepare(`
      SELECT COUNT(*) as active_count, COALESCE(SUM(o.amount), 0) as active_amount
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
        AND o.status NOT IN ('signed', 'lost')
        AND DATE(o.expected_sign_date) >= DATE(?)
        AND DATE(o.expected_sign_date) < DATE(?)
        ${opportunityScope}
    `).get(period.startDate, period.endDate);

    const converted = db.prepare(`
      SELECT COUNT(DISTINCT o.id) as converted_count, COALESCE(SUM(ct.amount), 0) as converted_amount
      FROM contracts ct
      INNER JOIN opportunities o ON o.id = ct.opportunity_id
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
        AND DATE(ct.sign_date) >= DATE(?)
        AND DATE(ct.sign_date) < DATE(?)
        ${opportunityScope}
    `).get(period.startDate, period.endDate);

    res.json({
      active_count: Number(active?.active_count || 0),
      active_amount: isTechnicalDashboardRole(req.user.role) ? null : Number(active?.active_amount || 0),
      converted_count: Number(converted?.converted_count || 0),
      converted_amount: isTechnicalDashboardRole(req.user.role) ? null : Number(converted?.converted_amount || 0),
      period: {
        type: period.type,
        year: period.year,
        value: period.value,
        start_date: period.startDate,
        end_date: period.endDate
      }
    });
  } catch (error) {
    if (error.message.includes('无效')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('获取商机周期指标错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 阶段进展统计（实时快照：POC中 / 立项中 / 合同中 / 回款中）
// =====================================================
router.get('/pipeline-stage-stats', authMiddleware, (req, res) => {
  try {
    const opportunityScope = getOpportunityScope(req.user.role, req.user.id, 'o');

    // 商机各阶段数量：按当前商机状态实时统计，排除已删除客户
    const stageCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN o.status = 'poc' THEN 1 ELSE 0 END) AS poc_count,
        SUM(CASE WHEN o.status = 'project' THEN 1 ELSE 0 END) AS project_count,
        SUM(CASE WHEN o.status = 'contracting' THEN 1 ELSE 0 END) AS contracting_count
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
        AND o.status IN ('poc', 'project', 'contracting')
        ${opportunityScope}
    `).get();

    // 回款中数量：待回款记录数（兼容旧数据中的英文状态值），沿用商机数据权限
    const paymentPending = db.prepare(`
      SELECT COUNT(*) AS total
      FROM payments p
      INNER JOIN contracts ct ON ct.id = p.contract_id
      INNER JOIN opportunities o ON o.id = ct.opportunity_id
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
        AND p.status IN ('待回款', 'pending', 'unpaid')
        ${opportunityScope}
    `).get();

    res.json({
      poc_count: Number(stageCounts?.poc_count || 0),
      project_count: Number(stageCounts?.project_count || 0),
      contracting_count: Number(stageCounts?.contracting_count || 0),
      payment_pending_count: Number(paymentPending?.total || 0)
    });
  } catch (error) {
    console.error('获取阶段进展统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 转化漏斗：线索→技术交流→POC→立项→招投标→已签合同（客户数，实时快照）
// 口径：线索=权限范围内全部客户；中间各层=至少有一个商机达到该阶段及以后的客户数；已签合同=有已签合同记录的客户数
router.get('/conversion-funnel', authMiddleware, (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const ownerCondition = getOwnerCondition(role, userId, 'c');

    // 线索层：权限范围内全部客户
    const leadRow = db.prepare(`
      SELECT COUNT(*) as count FROM customers c
      WHERE c.is_deleted = 0 ${ownerCondition}
    `).get();

    const stages = [{ key: 'lead', label: '线索', count: leadRow.count }];

    // 中间各层：至少有一个商机处于该阶段及以后的客户数（累计嵌套，逐层递减）
    const stageLayers = [
      { key: 'technical', label: '技术交流', statuses: ['technical', 'poc', 'project', 'bidding', 'contracting', 'signed'] },
      { key: 'poc', label: 'POC', statuses: ['poc', 'project', 'bidding', 'contracting', 'signed'] },
      { key: 'project', label: '立项', statuses: ['project', 'bidding', 'contracting', 'signed'] },
      { key: 'bidding', label: '招投标', statuses: ['bidding', 'contracting', 'signed'] }
    ];
    for (const layer of stageLayers) {
      const placeholders = layer.statuses.map(() => '?').join(',');
      const row = db.prepare(`
        SELECT COUNT(*) as count FROM customers c
        WHERE c.is_deleted = 0 ${ownerCondition}
          AND EXISTS (
            SELECT 1 FROM opportunities o
            WHERE o.customer_id = c.id AND o.status IN (${placeholders})
          )
      `).get(...layer.statuses);
      stages.push({ key: layer.key, label: layer.label, count: row.count });
    }

    // 已签合同层：有已签合同记录的客户数（与现有统计口径一致，按签订日期判定）
    const signedRow = db.prepare(`
      SELECT COUNT(*) as count FROM customers c
      WHERE c.is_deleted = 0 ${ownerCondition}
        AND EXISTS (
          SELECT 1 FROM contracts ct
          WHERE ct.customer_id = c.id AND ct.sign_date IS NOT NULL AND ct.sign_date != ''
        )
    `).get();
    stages.push({ key: 'signed', label: '已签合同', count: signedRow.count });

    // 各层平均转化时间：基于商机状态变更日志，统计转化到该阶段的平均耗时（天）
    // 起点取上一次变更时间，若无则取商机创建时间（与阶段停留时间统计口径一致）
    const durationRows = db.prepare(`
      SELECT cl.to_status,
        ROUND(AVG(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at),
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as avg_days
      FROM opportunity_change_logs cl
      INNER JOIN opportunities o ON cl.opportunity_id = o.id
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN opportunity_change_logs cl2 ON cl2.opportunity_id = cl.opportunity_id
        AND cl2.changed_at = (
          SELECT MAX(cl3.changed_at) FROM opportunity_change_logs cl3
          WHERE cl3.opportunity_id = cl.opportunity_id AND cl3.changed_at < cl.changed_at
        )
      WHERE c.is_deleted = 0 ${ownerCondition}
        AND cl.from_status IS NOT NULL
        AND cl.to_status IN ('technical', 'poc', 'project', 'bidding', 'signed')
      GROUP BY cl.to_status
    `).all();
    const durationMap = {};
    for (const row of durationRows) durationMap[row.to_status] = row.avg_days;
    // 漏斗层 key 与商机状态的对应关系（线索层为起点，无转化时间）
    const stageStatusMap = { technical: 'technical', poc: 'poc', project: 'project', bidding: 'bidding', signed: 'signed' };
    for (const stage of stages) {
      const status = stageStatusMap[stage.key];
      stage.avg_days = status ? (durationMap[status] ?? null) : null;
    }

    res.json({ success: true, data: { stages } });
  } catch (error) {
    console.error('获取转化漏斗失败:', error);
    res.status(500).json({ success: false, message: '获取转化漏斗失败' });
  }
});

// =====================================================
// 商机阶段月度趋势：
// 1) 技术交流/POC/立项/招投标 —— 取自「商机管理」（opportunities 表），
//    按商机当前状态分组，按商机创建时间 created_at 归月
// 2) 已签合同 —— 取自「合同管理」（contracts 表）的全部合同（不限合同状态），
//    按合同签订日期 sign_date 归月
// =====================================================
router.get('/opportunity-stage-monthly', authMiddleware, (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const now = new Date();
    const requestedYear = Number.parseInt(req.query.year, 10);
    const year = Number.isInteger(requestedYear) ? requestedYear : now.getFullYear();
    if (year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: '统计年份参数无效' });
    }

    // 阶段定义：前 4 个阶段来自商机管理，已签合同来自合同管理
    const stageDefs = [
      { key: 'technical', label: '技术交流' },
      { key: 'poc', label: 'POC' },
      { key: 'project', label: '立项' },
      { key: 'bidding', label: '招投标' },
      { key: 'signed', label: '已签合同' }
    ];

    // 商机范围权限：管理员/运营看全部，其他角色只看授权范围（与商机管理列表一致）
    const scopeCondition = getOpportunityScope(role, userId, 'o');

    // 商机阶段：按当前状态 + 创建时间归月计数
    const oppRows = db.prepare(`
      SELECT o.status AS stage,
             CAST(strftime('%m', o.created_at) AS INTEGER) AS month,
             COUNT(*) AS count
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0
        AND o.status IN ('technical', 'poc', 'project', 'bidding')
        AND CAST(strftime('%Y', o.created_at) AS INTEGER) = ?
        ${scopeCondition}
      GROUP BY o.status, month
    `).all(year);

    // 已签合同：合同管理的全部合同按签订日期归月计数（权限与合同管理列表一致）
    const contractRows = db.prepare(`
      SELECT CAST(strftime('%m', ct.sign_date) AS INTEGER) AS month,
             COUNT(*) AS count
      FROM contracts ct
      INNER JOIN customers cu ON ct.customer_id = cu.id
      LEFT JOIN opportunities o ON ct.opportunity_id = o.id
      WHERE cu.is_deleted = 0
        AND ct.sign_date IS NOT NULL
        AND CAST(strftime('%Y', ct.sign_date) AS INTEGER) = ?
        ${getContractScope(role, userId)}
      GROUP BY month
    `).all(year);

    // 组装 12 个月 × 各阶段 的计数
    const countMap = { signed: {} };
    for (const row of oppRows) {
      if (!countMap[row.stage]) countMap[row.stage] = {};
      countMap[row.stage][row.month] = row.count;
    }
    for (const row of contractRows) {
      countMap.signed[row.month] = row.count;
    }
    const stages = stageDefs.map(def => ({
      key: def.key,
      label: def.label,
      monthly: Array.from({ length: 12 }, (_, i) => countMap[def.key]?.[i + 1] || 0)
    }));

    res.json({ success: true, data: { year, stages } });
  } catch (error) {
    console.error('获取商机阶段月度趋势失败:', error);
    res.status(500).json({ success: false, message: '获取商机阶段月度趋势失败' });
  }
});

// =====================================================
// 数据概览周期摘要（统一月 / 季度 / 年度口径）
// =====================================================
router.get('/dashboard-period-summary', authMiddleware, (req, res) => {
  try {
    const period = getPeriodRange(req.query);
    const previousPeriod = getPreviousPeriodRange(period);
    const userId = req.user.id;
    const userRole = req.user.role;
    const isTechnical = isTechnicalDashboardRole(userRole);
    const customerScope = getOwnerCondition(userRole, userId, 'c');
    const opportunityScope = getOpportunityScope(userRole, userId, 'o');
    const financialScope = canViewAll(userRole) ? '' : `AND (
      o.owner_id = '${userId}' OR (
        o.id IS NULL AND (c.owner_id = '${userId}' OR c.secondary_owner_id = '${userId}')
      )
    )`;

    const customerTotalAt = endDate => db.prepare(`
      SELECT COUNT(DISTINCT c.id) AS total
      FROM customers c
      WHERE c.is_deleted = 0
        AND DATE(c.created_at) < DATE(?)
        ${customerScope}
    `).get(endDate)?.total || 0;

    const activeOpportunityCount = (startDate, endDate) => db.prepare(`
      SELECT COUNT(*) AS total
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
        AND o.status NOT IN ('signed', 'lost')
        AND DATE(o.expected_sign_date) >= DATE(?)
        AND DATE(o.expected_sign_date) < DATE(?)
        ${opportunityScope}
    `).get(startDate, endDate)?.total || 0;

    const contractAmount = (types, startDate, endDate) => {
      const placeholders = types.map(() => '?').join(', ');
      return db.prepare(`
        SELECT COALESCE(SUM(ct.amount), 0) AS total
        FROM contracts ct
        LEFT JOIN opportunities o ON o.id = ct.opportunity_id
        INNER JOIN customers c ON c.id = ct.customer_id
        WHERE c.is_deleted = 0
          AND COALESCE(o.type, ct.type) IN (${placeholders})
          AND DATE(ct.sign_date) >= DATE(?)
          AND DATE(ct.sign_date) < DATE(?)
          ${financialScope}
      `).get(...types, startDate, endDate)?.total || 0;
    };

    const paymentAmount = (startDate, endDate) => db.prepare(`
      SELECT COALESCE(SUM(p.amount), 0) AS total
      FROM payments p
      INNER JOIN contracts ct ON ct.id = p.contract_id
      LEFT JOIN opportunities o ON o.id = ct.opportunity_id
      INNER JOIN customers c ON c.id = ct.customer_id
      WHERE c.is_deleted = 0
        AND p.status IN ('已回款', 'received', 'paid')
        AND DATE(p.actual_date) >= DATE(?)
        AND DATE(p.actual_date) < DATE(?)
        ${financialScope}
    `).get(startDate, endDate)?.total || 0;

    // 完成率分母：所有启用用户的年度任务额之和（不区分角色/归属，全公司统一口径）
    const annualTargets = db.prepare(`
      SELECT
        COALESCE(SUM(renew_contract_amount), 0) AS renew_target,
        COALESCE(SUM(new_contract_amount), 0) AS new_target,
        COALESCE(SUM(payment_amount), 0) AS payment_target
      FROM users
      WHERE status = 'active'
    `).get();

    // 完成率统计范围跟随周期切换器：
    // 月视图 = 该月所在季度 + 该年；季度视图 = 该季度 + 该年；年视图 = 该年（季度完成率不展示）
    const quarterRange = period.type === 'year' ? null : getPeriodRange({
      period_type: 'quarter',
      year: period.year,
      quarter: period.type === 'quarter' ? period.value : Math.floor((period.value - 1) / 3) + 1
    });
    const yearRange = getPeriodRange({ period_type: 'year', year: period.year });

    // 完成率 = 周期实际值 ÷ 目标额 × 100，保留 2 位小数；目标额为 0 时返回 null（前端显示 -）
    const completionRate = (actual, target) => {
      if (!target || Number(target) <= 0) return null;
      return Number(((Number(actual) / Number(target)) * 100).toFixed(2));
    };

    let quarterRates = { renew: null, newSign: null, payment: null };
    let yearRates = { renew: null, newSign: null, payment: null };
    if (!isTechnical && annualTargets) {
      if (quarterRange) {
        // 季度目标额 = 年度任务额 ÷ 4
        quarterRates = {
          renew: completionRate(contractAmount(['renewal', 'maintenance'], quarterRange.startDate, quarterRange.endDate), annualTargets.renew_target / 4),
          newSign: completionRate(contractAmount(['new_project'], quarterRange.startDate, quarterRange.endDate), annualTargets.new_target / 4),
          payment: completionRate(paymentAmount(quarterRange.startDate, quarterRange.endDate), annualTargets.payment_target / 4)
        };
      }
      yearRates = {
        renew: completionRate(contractAmount(['renewal', 'maintenance'], yearRange.startDate, yearRange.endDate), annualTargets.renew_target),
        newSign: completionRate(contractAmount(['new_project'], yearRange.startDate, yearRange.endDate), annualTargets.new_target),
        payment: completionRate(paymentAmount(yearRange.startDate, yearRange.endDate), annualTargets.payment_target)
      };
    }

    const currentCustomerTotal = customerTotalAt(period.endDate);
    const previousCustomerTotal = customerTotalAt(previousPeriod.endDate);
    const currentActiveCount = activeOpportunityCount(period.startDate, period.endDate);
    const previousActiveCount = activeOpportunityCount(previousPeriod.startDate, previousPeriod.endDate);
    const currentRenewAmount = isTechnical ? 0 : contractAmount(['renewal', 'maintenance'], period.startDate, period.endDate);
    const previousRenewAmount = isTechnical ? 0 : contractAmount(['renewal', 'maintenance'], previousPeriod.startDate, previousPeriod.endDate);
    const currentNewAmount = isTechnical ? 0 : contractAmount(['new_project'], period.startDate, period.endDate);
    const previousNewAmount = isTechnical ? 0 : contractAmount(['new_project'], previousPeriod.startDate, previousPeriod.endDate);
    const currentPaymentAmount = isTechnical ? 0 : paymentAmount(period.startDate, period.endDate);
    const previousPaymentAmount = isTechnical ? 0 : paymentAmount(previousPeriod.startDate, previousPeriod.endDate);

    // 三个金额指标附加季度/年度完成率（技术角色为 null）
    const renewalMetric = createComparisonMetric(currentRenewAmount, previousRenewAmount, isTechnical);
    renewalMetric.quarter_rate = isTechnical ? null : quarterRates.renew;
    renewalMetric.year_rate = isTechnical ? null : yearRates.renew;
    const newContractMetric = createComparisonMetric(currentNewAmount, previousNewAmount, isTechnical);
    newContractMetric.quarter_rate = isTechnical ? null : quarterRates.newSign;
    newContractMetric.year_rate = isTechnical ? null : yearRates.newSign;
    const paymentMetric = createComparisonMetric(currentPaymentAmount, previousPaymentAmount, isTechnical);
    paymentMetric.quarter_rate = isTechnical ? null : quarterRates.payment;
    paymentMetric.year_rate = isTechnical ? null : yearRates.payment;

    res.json({
      period: {
        type: period.type,
        year: period.year,
        value: period.value,
        start_date: period.startDate,
        end_date: period.endDate
      },
      previous_period: {
        start_date: previousPeriod.startDate,
        end_date: previousPeriod.endDate
      },
      metrics: {
        customer_total: createComparisonMetric(currentCustomerTotal, previousCustomerTotal),
        active_opportunity_count: createComparisonMetric(currentActiveCount, previousActiveCount),
        renewal_contract_amount: renewalMetric,
        new_contract_amount: newContractMetric,
        payment_amount: paymentMetric
      }
    });
  } catch (error) {
    if (error.message.includes('无效')) return res.status(400).json({ error: error.message });
    console.error('获取数据概览周期摘要错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 客户商机状态（截至当前的全量累计，按客户聚合）
// =====================================================
router.get('/customer-opportunity-status', authMiddleware, (req, res) => {
  try {
    const opportunityScope = getOpportunityScope(req.user.role, req.user.id, 'o');
    const rows = db.prepare(`
      SELECT
        c.id AS customer_id,
        c.name AS customer_name,
        COUNT(o.id) AS opportunity_count,
        SUM(CASE WHEN o.status NOT IN ('signed', 'lost') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN o.status = 'potential' THEN 1 ELSE 0 END) AS potential_count,
        SUM(CASE WHEN o.status = 'technical' THEN 1 ELSE 0 END) AS technical_count,
        SUM(CASE WHEN o.status = 'poc' THEN 1 ELSE 0 END) AS poc_count,
        SUM(CASE WHEN o.status = 'project' THEN 1 ELSE 0 END) AS project_count,
        SUM(CASE WHEN o.status = 'bidding' THEN 1 ELSE 0 END) AS bidding_count,
        SUM(CASE WHEN o.status = 'contracting' THEN 1 ELSE 0 END) AS contracting_count,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) AS signed_count,
        SUM(CASE WHEN o.status = 'lost' THEN 1 ELSE 0 END) AS lost_count,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM opportunity_assignments oa
          WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'presales' AND oa.status = 'active'
        ) THEN 1 ELSE 0 END) AS presales_count,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM opportunity_assignments oa
          WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'fde' AND oa.status = 'active'
        ) THEN 1 ELSE 0 END) AS fde_count
      FROM customers c
      INNER JOIN opportunities o ON o.customer_id = c.id
      WHERE c.is_deleted = 0
        ${opportunityScope}
      GROUP BY c.id, c.name
      ORDER BY active_count DESC, opportunity_count DESC, c.name ASC
    `).all();

    res.json({
      data: rows.map(row => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, key.endsWith('_count') || key === 'opportunity_count' ? Number(value || 0) : value])
      )),
      as_of: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取客户商机状态错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 数据概览最近跟进（不放大跟进管理页面权限）
// =====================================================
router.get('/recent-followups', authMiddleware, (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 20) : 5;
    const opportunityScope = getOpportunityScope(req.user.role, req.user.id, 'o');
    const rows = db.prepare(`
      SELECT f.id, f.customer_id, f.opportunity_id, f.content,
        COALESCE(f.followup_time, f.created_at) AS created_at,
        c.name AS customer_name, o.name AS opportunity_name, u.name AS user_name, u.role AS user_role
      FROM followups f
      INNER JOIN customers c ON c.id = f.customer_id
      LEFT JOIN opportunities o ON o.id = f.opportunity_id
      LEFT JOIN users u ON u.id = f.user_id
      WHERE c.is_deleted = 0 AND u.role IN ('fde', 'presales') ${opportunityScope}
      ORDER BY COALESCE(f.followup_time, f.created_at) DESC, f.created_at DESC
      LIMIT ?
    `).all(limit);
    res.json({ data: rows });
  } catch (error) {
    console.error('获取数据概览最近跟进错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取数据概览（仪表盘核心指标）
// =====================================================
router.get('/overview', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    const user = db.prepare(`
      SELECT renew_contract_amount, new_contract_amount, payment_amount, customer_quota
      FROM users WHERE id = ?
    `).get(userId);

    const renewTarget = user?.renew_contract_amount || 0;
    const newTarget = user?.new_contract_amount || 0;
    const paymentTarget = user?.payment_amount || 0;
    const customerQuota = user?.customer_quota || 30;

    const ownerCond = getOwnerCondition(userRole, userId, 'c');
    const isTechnical = isTechnicalDashboardRole(userRole);

    const customerStats = db.prepare(`
      SELECT COUNT(DISTINCT c.id) as total, COALESCE(SUM(c.total_amount), 0) as total_amount
      FROM customers c WHERE c.is_deleted = 0 ${ownerCond}
    `).get();

    const renewStats = db.prepare(`
      SELECT COALESCE(SUM(c.amount), 0) as total FROM contracts c
      INNER JOIN opportunities o ON c.opportunity_id = o.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE o.type IN ('renewal', 'maintenance') AND cu.is_deleted = 0
        ${getOpportunityScope(userRole, userId, 'o')}
    `).get();

    const newStats = db.prepare(`
      SELECT COALESCE(SUM(c.amount), 0) as total FROM contracts c
      INNER JOIN opportunities o ON c.opportunity_id = o.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE o.type = 'new_project' AND cu.is_deleted = 0
        ${getOpportunityScope(userRole, userId, 'o')}
    `).get();

    let paymentQuery;
    if (canViewAll(userRole)) {
      paymentQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status IN ('已回款', 'received', 'paid')`;
    } else {
      paymentQuery = `
        SELECT COALESCE(SUM(p.amount), 0) as total FROM payments p
        INNER JOIN contracts c ON p.contract_id = c.id
        INNER JOIN customers cu ON c.customer_id = cu.id
        WHERE p.status IN ('已回款', 'received', 'paid')
        AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}')`;
    }
    const paymentStats = db.prepare(paymentQuery).get();

    const renewRate = renewTarget > 0 ? ((renewStats.total / renewTarget) * 100) : 0;
    const newRate = newTarget > 0 ? ((newStats.total / newTarget) * 100) : 0;
    const paymentRate = paymentTarget > 0 ? ((paymentStats.total / paymentTarget) * 100) : 0;

    const oppQuery = `
      SELECT o.status, COUNT(*) as count,
        SUM(CASE WHEN o.status = 'signed' THEN COALESCE(ct.amount, o.amount) ELSE o.amount END) as amount
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN contracts ct ON o.id = ct.opportunity_id
      WHERE c.is_deleted = 0 ${getOpportunityScope(userRole, userId, 'o')}
      GROUP BY o.status`;
    const opportunityByStatus = db.prepare(oppQuery).all();

    const opportunityScope = getOpportunityScope(userRole, userId, 'o');
    const opportunityMetrics = db.prepare(`
      SELECT COUNT(*) AS total_count,
        SUM(CASE WHEN o.status NOT IN ('signed', 'lost') THEN 1 ELSE 0 END) AS active_count,
        COALESCE(SUM(CASE WHEN o.status NOT IN ('signed', 'lost') THEN o.amount ELSE 0 END), 0) AS active_amount,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) AS signed_count
      FROM opportunities o INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0 ${opportunityScope}
    `).get();
    opportunityMetrics.conversion_rate = opportunityMetrics.total_count > 0
      ? Number(((opportunityMetrics.signed_count / opportunityMetrics.total_count) * 100).toFixed(2)) : 0;
    if (isTechnical) opportunityMetrics.active_amount = null;

    const followupStats = db.prepare(`
      SELECT COUNT(*) as total FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND o.status != 'signed' AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.opportunity_id = o.id)
        ${getOpportunityScope(userRole, userId, 'o')}
    `).get();

    const contractExpiringStats = db.prepare(`
      SELECT COUNT(*) as total FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.expire_date IS NOT NULL AND c.expire_date != '' AND cu.is_deleted = 0
      AND date(c.expire_date) BETWEEN date('now') AND date('now', '+30 days')
      ${getOwnerCondition(userRole, userId, 'cu')}
    `).get();

    const paymentReminderStats = db.prepare(`
      SELECT COUNT(DISTINCT c.id) as total FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.unpaid_amount > 0 ${getOwnerCondition(userRole, userId, 'cu')}
    `).get();

    res.json({
      customerCount: customerStats?.total || 0,
      customerAmount: isTechnical ? null : customerStats?.total_amount || 0,
      opportunityByStatus: opportunityByStatus.map(item => ({ ...item, amount: isTechnical ? null : item.amount })),
      opportunityMetrics,
      followupCount: followupStats?.total || 0,
      renewAmount: isTechnical ? null : renewStats?.total || 0, renewTarget: isTechnical ? null : renewTarget,
      renewRate: isTechnical ? null : parseFloat(renewRate.toFixed(2)),
      newAmount: isTechnical ? null : newStats?.total || 0, newTarget: isTechnical ? null : newTarget,
      newRate: isTechnical ? null : parseFloat(newRate.toFixed(2)),
      paymentAmount: isTechnical ? null : paymentStats?.total || 0, paymentTarget: isTechnical ? null : paymentTarget,
      paymentRate: isTechnical ? null : parseFloat(paymentRate.toFixed(2)),
      contractExpiringCount: contractExpiringStats?.total || 0,
      paymentReminderCount: paymentReminderStats?.total || 0,
      customerQuota
    });
  } catch (error) {
    console.error('获取统计数据错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按销售人员统计（本年度 + 去年）
// =====================================================
router.get('/sales-by-person', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;

    const yCond = (y) => "strftime('%Y', ct.sign_date) = '" + y + "'";
    const pyCond = (y) => "strftime('%Y', p.actual_date) = '" + y + "'";

    const makeSQL = (y) =>
      `SELECT u.id, u.name,` +
      `  (SELECT COUNT(*) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND ${yCond(y)} AND cu.owner_id = u.id) as contract_count,` +
      `  (SELECT COALESCE(SUM(ct.amount), 0) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND ${yCond(y)} AND cu.owner_id = u.id) as contract_amount,` +
      `  (SELECT COALESCE(SUM(p.amount), 0) FROM payments p INNER JOIN contracts ct2 ON p.contract_id = ct2.id INNER JOIN customers cu ON ct2.customer_id = cu.id WHERE p.status IN ('已回款', 'received', 'paid') AND ${pyCond(y)} AND cu.owner_id = u.id) as payment_amount` +
      ` FROM users u WHERE u.role = 'sales' AND u.status = 'active'` +
      ` GROUP BY u.id, u.name ORDER BY payment_amount DESC`;

    if (!canViewAll(userRole)) {
      const sql = `SELECT u.id, u.name,` +
        `  (SELECT COUNT(*) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND ${yCond(currentYear)} AND cu.owner_id = u.id) as contract_count,` +
        `  (SELECT COALESCE(SUM(ct.amount), 0) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND ${yCond(currentYear)} AND cu.owner_id = u.id) as contract_amount,` +
        `  (SELECT COALESCE(SUM(p.amount), 0) FROM payments p INNER JOIN contracts ct2 ON p.contract_id = ct2.id INNER JOIN customers cu ON ct2.customer_id = cu.id WHERE p.status IN ('已回款', 'received', 'paid') AND ${pyCond(currentYear)} AND cu.owner_id = u.id) as payment_amount` +
        ` FROM users u WHERE u.id = ? AND u.role = 'sales'`;
      const stats = db.prepare(sql).get(userId);
      return res.json({ cyData: stats ? [stats] : [], lyData: [] });
    }

    const rankingCurrent = db.prepare(makeSQL(currentYear)).all();
    const rankingLast = db.prepare(makeSQL(lastYear)).all();
    res.json({ cyData: rankingCurrent, lyData: rankingLast });
  } catch (error) {
    console.error('获取销售统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 时间维度统计
// =====================================================
router.get('/time-trend', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const ownerCond = getOwnerCondition(userRole, userId, 'cu');
    const ownerCond2 = getOwnerCondition(userRole, userId, 'c');

    const currentYearMonthly = db.prepare(`
      SELECT CAST(strftime('%m', p.actual_date) AS INTEGER) as month,
        COUNT(*) as payment_count, COALESCE(SUM(p.amount), 0) as payment_amount,
        COUNT(DISTINCT p.contract_id) as contract_count
      FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id
      INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
      GROUP BY month ORDER BY month
    `).all(String(currentYear));

    const lastYearMonthly = db.prepare(`
      SELECT CAST(strftime('%m', p.actual_date) AS INTEGER) as month,
        COUNT(*) as payment_count, COALESCE(SUM(p.amount), 0) as payment_amount
      FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id
      INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
      GROUP BY month ORDER BY month
    `).all(String(lastYear));

    const currentYearContracts = db.prepare(`
      SELECT CAST(strftime('%m', c.sign_date) AS INTEGER) as month,
        COUNT(*) as contract_count, COALESCE(SUM(c.amount), 0) as contract_amount
      FROM contracts c INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.sign_date IS NOT NULL AND strftime('%Y', c.sign_date) = ? ${ownerCond}
      GROUP BY month ORDER BY month
    `).all(String(currentYear));

    const currentYearOpp = db.prepare(`
      SELECT CAST(strftime('%m', o.created_at) AS INTEGER) as month,
        COUNT(*) as opp_count, COALESCE(SUM(o.amount), 0) as opp_amount,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count
      FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${canViewAll(userRole) ? '' : "AND o.owner_id = '" + userId + "'"}
      GROUP BY month ORDER BY month
    `).all(String(currentYear));

    const makeYearSummarySQL = (y) => {
      const oppWhere = `c.is_deleted = 0 AND strftime('%Y', o.created_at) = '${y}' ${canViewAll(userRole) ? '' : "AND o.owner_id = '" + userId + "'"}`;
      const oppSubq = `(SELECT COUNT(*) FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id WHERE ${oppWhere})`;
      const oppAmtSubq = `(SELECT COALESCE(SUM(o.amount), 0) FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id WHERE ${oppWhere})`;
      return `
        SELECT
          COUNT(DISTINCT c.id) as customer_count,
          COALESCE(SUM(c.total_amount), 0) as customer_amount,
          ${oppSubq} as opp_count,
          ${oppAmtSubq} as opp_amount,
          (SELECT COUNT(*) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = '${y}' ${getOwnerCondition(userRole, userId, 'cu')}) as contract_count,
          (SELECT COALESCE(SUM(ct.amount), 0) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = '${y}' ${getOwnerCondition(userRole, userId, 'cu')}) as contract_amount,
          (SELECT COUNT(*) FROM payments p2 INNER JOIN contracts ct2 ON p2.contract_id = ct2.id INNER JOIN customers cu2 ON ct2.customer_id = cu2.id WHERE p2.status IN ('已回款', 'received', 'paid') AND strftime('%Y', p2.actual_date) = '${y}' ${getOwnerCondition(userRole, userId, 'cu2')}) as payment_count,
          (SELECT COALESCE(SUM(p2.amount), 0) FROM payments p2 INNER JOIN contracts ct2 ON p2.contract_id = ct2.id INNER JOIN customers cu2 ON ct2.customer_id = cu2.id WHERE p2.status IN ('已回款', 'received', 'paid') AND strftime('%Y', p2.actual_date) = '${y}' ${getOwnerCondition(userRole, userId, 'cu2')}) as payment_amount
        FROM customers c WHERE c.is_deleted = 0 ${ownerCond2}`;
    };

    const currentYearSummary = db.prepare(makeYearSummarySQL(String(currentYear))).get();
    const lastYearSummary = db.prepare(makeYearSummarySQL(String(lastYear))).get();

    res.json({
      currentYear, lastYear,
      currentYearMonthly, lastYearMonthly,
      currentYearContracts, currentYearOpp,
      currentYearSummary: currentYearSummary || {},
      lastYearSummary: lastYearSummary || {}
    });
  } catch (error) {
    console.error('获取时间趋势错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按行业统计（本年度 + 去年）
// =====================================================
router.get('/industry', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const ownerCond = getOwnerCondition(userRole, userId, 'cu');

    const sql = `
      SELECT COALESCE(cu.industry, '未分类') as industry,
        COUNT(DISTINCT ct.id) as contract_count,
        COALESCE(SUM(ct.amount), 0) as contract_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount
      FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
      GROUP BY cu.industry ORDER BY contract_amount DESC`;

    const industryCurrent = db.prepare(sql).all(String(currentYear));
    const industryLast = db.prepare(sql).all(String(lastYear));
    res.json({ cyData: industryCurrent, lyData: industryLast });
  } catch (error) {
    console.error('获取行业统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按区域统计（本年度 + 去年）
// =====================================================
router.get('/region', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const ownerCond = getOwnerCondition(userRole, userId, 'cu');

    const sql = `
      SELECT
        CASE
          WHEN cu.region LIKE '%省%' THEN SUBSTR(cu.region, 1, INSTR(cu.region, '省')-1)
          WHEN cu.region LIKE '%市%' THEN SUBSTR(cu.region, 1, INSTR(cu.region, '市')-1)
          WHEN cu.region LIKE '%自治区%' THEN SUBSTR(cu.region, 1, INSTR(cu.region, '自治区')-1)
          ELSE COALESCE(cu.region, '未分类')
        END as region,
        COUNT(DISTINCT ct.id) as contract_count,
        COALESCE(SUM(ct.amount), 0) as contract_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount
      FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
      GROUP BY region ORDER BY contract_amount DESC`;

    const regionCurrent = db.prepare(sql).all(String(currentYear));
    const regionLast = db.prepare(sql).all(String(lastYear));
    res.json({ cyData: regionCurrent, lyData: regionLast });
  } catch (error) {
    console.error('获取区域统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按商机状态统计（本年度 + 去年）
// =====================================================
router.get('/opportunity-analysis', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const creatorCond = getCreatorCondition(userRole, userId, 'o');

    const byStatusCurrent = db.prepare(`
      SELECT o.status, COUNT(*) as count, COALESCE(SUM(o.amount), 0) as amount
      FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${creatorCond}
      GROUP BY o.status ORDER BY amount DESC
    `).all(String(currentYear));

    const byStatusLast = db.prepare(`
      SELECT o.status, COUNT(*) as count, COALESCE(SUM(o.amount), 0) as amount
      FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${creatorCond}
      GROUP BY o.status ORDER BY amount DESC
    `).all(String(lastYear));

    const byTypeCurrent = db.prepare(`
      SELECT o.type, COUNT(*) as count, COALESCE(SUM(o.amount), 0) as amount,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count
      FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${creatorCond}
      GROUP BY o.type
    `).all(String(currentYear));

    const byTypeLast = db.prepare(`
      SELECT o.type, COUNT(*) as count, COALESCE(SUM(o.amount), 0) as amount,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count
      FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${creatorCond}
      GROUP BY o.type
    `).all(String(lastYear));

    const totalOpp = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed
      FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id
      WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${creatorCond}
    `).get(String(currentYear));

    const conversionRate = totalOpp?.total > 0 ? ((totalOpp.signed / totalOpp.total) * 100) : 0;

    res.json({
      byStatusCurrent, byStatusLast,
      byTypeCurrent, byTypeLast,
      total: totalOpp?.total || 0,
      signed: totalOpp?.signed || 0,
      conversionRate: parseFloat(conversionRate.toFixed(2))
    });
  } catch (error) {
    console.error('获取商机统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按合同类型统计（本年度 + 去年）
// =====================================================
router.get('/contract-analysis', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const ownerCond = getOwnerCondition(userRole, userId, 'cu');

    const sql = `
      SELECT COALESCE(o.type, '未分类') as type,
        COUNT(*) as count,
        COALESCE(SUM(ct.amount), 0) as total_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount,
        COALESCE(SUM(ct.unpaid_amount), 0) as unpaid_amount
      FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id
      LEFT JOIN opportunities o ON ct.opportunity_id = o.id
      WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
      GROUP BY o.type ORDER BY total_amount DESC`;

    const byTypeCurrent = db.prepare(sql).all(String(currentYear));
    const byTypeLast = db.prepare(sql).all(String(lastYear));
    res.json({ currentYear, lastYear, cyData: byTypeCurrent, lyData: byTypeLast });
  } catch (error) {
    console.error('获取合同统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按回款方式统计（本年度 + 去年）
// =====================================================
router.get('/payment-analysis', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const ownerCond = getOwnerCondition(userRole, userId, 'cu');

    const sql = `
      SELECT COALESCE(p.method, '未指定') as method, COUNT(*) as count, COALESCE(SUM(p.amount), 0) as total_amount
      FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id
      INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
      GROUP BY p.method ORDER BY total_amount DESC`;

    const byMethodCurrent = db.prepare(sql).all(String(currentYear));
    const byMethodLast = db.prepare(sql).all(String(lastYear));

    const summarySQL = `
      SELECT COUNT(*) as count, COALESCE(SUM(p.amount), 0) as total_amount
      FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id
      INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}`;

    const currentYearSummary = db.prepare(summarySQL).get(String(currentYear));
    const lastYearSummary = db.prepare(summarySQL).get(String(lastYear));

    res.json({
      currentYear, lastYear,
      currentYearByMethod: byMethodCurrent,
      lastYearByMethod: byMethodLast,
      currentYearSummary: currentYearSummary || { count: 0, total_amount: 0 },
      lastYearSummary: lastYearSummary || { count: 0, total_amount: 0 }
    });
  } catch (error) {
    console.error('获取回款统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按意向产品统计（本年度 + 去年）
// =====================================================
router.get('/product-analysis', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;

    const oppWhere = (y) => {
      let cond = `c.is_deleted = 0 AND o.products IS NOT NULL AND o.products != '' AND strftime('%Y', o.created_at) = '${y}'`;
      if (!canViewAll(userRole)) {
        cond += ` AND o.creator_id = '${userId}'`;
      }
      return cond;
    };

    const sql = (y) => `
      SELECT 
        o.products as product_name,
        COUNT(*) as opp_count,
        COALESCE(SUM(o.amount), 0) as opp_amount,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_opp_count,
        COUNT(DISTINCT ct.id) as contract_count,
        COALESCE(SUM(ct.amount), 0) as contract_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN contracts ct ON o.id = ct.opportunity_id
      WHERE ${oppWhere(y)}
      GROUP BY o.products
      ORDER BY opp_amount DESC`;

    const cyData = db.prepare(sql(currentYear)).all();
    const lyData = db.prepare(sql(lastYear)).all();
    res.json({ currentYear, lastYear, cyData, lyData });
  } catch (error) {
    console.error('获取产品分析统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 客户统计
// =====================================================
router.get('/customers', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { group_by = 'type' } = req.query;
    const ownerCond = getOwnerCondition(userRole, userId, 'c');
    const regionAmountSelect = isTechnicalDashboardRole(userRole)
      ? 'NULL as amount'
      : 'COALESCE(SUM(c.total_amount), 0) as amount';

    let query;
    if (group_by === 'type') {
      query = `SELECT type, COUNT(*) as count FROM customers c WHERE c.is_deleted = 0 ${ownerCond} GROUP BY type`;
    } else if (group_by === 'status') {
      query = `SELECT status, COUNT(*) as count FROM customers c WHERE c.is_deleted = 0 ${ownerCond} GROUP BY status`;
    } else if (group_by === 'level') {
      query = `SELECT level, COUNT(*) as count FROM customers c WHERE c.is_deleted = 0 AND level IS NOT NULL ${ownerCond} GROUP BY level`;
    } else if (group_by === 'industry') {
      query = `SELECT COALESCE(NULLIF(TRIM(c.industry), ''), '未分类') as industry, COUNT(*) as count
        FROM customers c
        WHERE c.is_deleted = 0 ${ownerCond}
        GROUP BY COALESCE(NULLIF(TRIM(c.industry), ''), '未分类')
        ORDER BY count DESC`;
    } else if (group_by === 'region') {
      query = `SELECT
        TRIM(CASE
          WHEN c.region LIKE '%省%' THEN SUBSTR(c.region, 1, INSTR(c.region, '省')-1)
          WHEN c.region LIKE '%市%' THEN SUBSTR(c.region, 1, INSTR(c.region, '市')-1)
          WHEN c.region LIKE '%自治区%' THEN SUBSTR(c.region, 1, INSTR(c.region, '自治区')-1)
          ELSE c.region
        END) as region, COUNT(*) as count, ${regionAmountSelect}
      FROM customers c WHERE c.is_deleted = 0 AND c.region IS NOT NULL ${ownerCond}
      GROUP BY TRIM(CASE
          WHEN c.region LIKE '%省%' THEN SUBSTR(c.region, 1, INSTR(c.region, '省')-1)
          WHEN c.region LIKE '%市%' THEN SUBSTR(c.region, 1, INSTR(c.region, '市')-1)
          WHEN c.region LIKE '%自治区%' THEN SUBSTR(c.region, 1, INSTR(c.region, '自治区')-1)
          ELSE c.region
        END) ORDER BY count DESC`;
    } else {
      query = `SELECT type, COUNT(*) as count FROM customers c WHERE c.is_deleted = 0 ${ownerCond} GROUP BY type`;
    }

    res.json({ stats: db.prepare(query).all() });
  } catch (error) {
    console.error('获取客户统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 综合仪表盘数据（一次请求获取所有数据）
// =====================================================
router.get('/dashboard', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const currentYear = new Date().getFullYear();

    const ownerCond = getOwnerCondition(userRole, userId, 'cu');
    const ownerCond2 = getOwnerCondition(userRole, userId, 'c');
    const creatorCond = getCreatorCondition(userRole, userId, 'o');

    // 核心指标
    // ownerCond: 子查询中使用 (别名 cu)，需要 replace 为 cu2
    // ownerCond2: 外层 customers c 查询使用
    let oppCountWhere, oppSignedWhere;
    if (canViewAll(userRole)) {
      oppCountWhere = 'c.is_deleted = 0';
      oppSignedWhere = 'c.is_deleted = 0';
    } else {
      oppCountWhere = `c.is_deleted = 0 AND o.owner_id = '${userId}'`;
      oppSignedWhere = `c.is_deleted = 0 AND o.owner_id = '${userId}'`;
    }
    const oppCount = db.prepare(`SELECT COUNT(*) as cnt FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id WHERE ${oppCountWhere}`).get();
    const oppSigned = db.prepare(`SELECT COALESCE(SUM(o.amount), 0) as cnt FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id WHERE ${oppSignedWhere} AND o.status = 'signed'`).get();

    const coreMetrics = db.prepare(`
      SELECT
        COUNT(DISTINCT c.id) as customer_count,
        COALESCE(SUM(c.total_amount), 0) as customer_amount,
        (SELECT COUNT(*) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 ${ownerCond}) as contract_count,
        (SELECT COALESCE(SUM(ct.amount), 0) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 ${ownerCond}) as contract_amount,
        (SELECT COUNT(*) FROM payments p2 INNER JOIN contracts ct2 ON p2.contract_id = ct2.id INNER JOIN customers cu2 ON ct2.customer_id = cu2.id WHERE p2.status IN ('已回款', 'received', 'paid') AND cu2.is_deleted = 0 ${ownerCond.replace(/cu\./g, 'cu2.')}) as payment_count,
        (SELECT COALESCE(SUM(p2.amount), 0) FROM payments p2 INNER JOIN contracts ct2 ON p2.contract_id = ct2.id INNER JOIN customers cu2 ON ct2.customer_id = cu2.id WHERE p2.status IN ('已回款', 'received', 'paid') AND cu2.is_deleted = 0 ${ownerCond.replace(/cu\./g, 'cu2.')}) as payment_amount
      FROM customers c WHERE c.is_deleted = 0 ${ownerCond2}
    `).get();
    coreMetrics.opp_count = oppCount?.cnt || 0;
    coreMetrics.signed_opp_amount = oppSigned?.cnt || 0;

    const cyStr = String(currentYear);
    const lyStr = String(currentYear - 1);

    // 月度回款
    const monthlySQL = (y) => `
      SELECT CAST(strftime('%m', p.actual_date) AS INTEGER) as month,
        COALESCE(SUM(p.amount), 0) as payment_amount, COUNT(*) as payment_count
      FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id
      INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
      GROUP BY month ORDER BY month`;

    const currentYearMonthly = db.prepare(monthlySQL(cyStr)).all(cyStr);
    const lastYearMonthly = db.prepare(monthlySQL(lyStr)).all(lyStr);

    // 行业
    const industrySQL = `
      SELECT COALESCE(cu.industry, '未分类') as industry,
        COUNT(DISTINCT ct.id) as contract_count,
        COALESCE(SUM(ct.amount), 0) as contract_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount
      FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
      GROUP BY cu.industry ORDER BY contract_amount DESC`;
    const industryCurrent = db.prepare(industrySQL).all(cyStr);
    const industryLast = db.prepare(industrySQL).all(lyStr);

    // 区域
    const regionSQL = `
      SELECT
        CASE
          WHEN cu.region LIKE '%省%' THEN SUBSTR(cu.region, 1, INSTR(cu.region, '省')-1)
          WHEN cu.region LIKE '%市%' THEN SUBSTR(cu.region, 1, INSTR(cu.region, '市')-1)
          WHEN cu.region LIKE '%自治区%' THEN SUBSTR(cu.region, 1, INSTR(cu.region, '自治区')-1)
          ELSE COALESCE(cu.region, '未分类')
        END as region,
        COUNT(DISTINCT ct.id) as contract_count,
        COALESCE(SUM(ct.amount), 0) as contract_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount
      FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
      GROUP BY region ORDER BY contract_amount DESC`;
    const regionCurrent = db.prepare(regionSQL).all(cyStr);
    const regionLast = db.prepare(regionSQL).all(lyStr);

    // 商机状态
    const oppStatusQuery = `SELECT o.status, COUNT(*) as count, COALESCE(SUM(o.amount), 0) as amount FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${canViewAll(userRole) ? '' : "AND o.owner_id = '" + userId + "'"} GROUP BY o.status ORDER BY amount DESC`;
    const oppStatusCurrent = db.prepare(oppStatusQuery).all(cyStr);
    const oppStatusLast = db.prepare(oppStatusQuery).all(lyStr);

    // 商机类型
    const oppTypeQuery = `SELECT o.type, COUNT(*) as count, COALESCE(SUM(o.amount), 0) as amount, SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count FROM opportunities o INNER JOIN customers c ON o.customer_id = c.id WHERE c.is_deleted = 0 AND strftime('%Y', o.created_at) = ? ${canViewAll(userRole) ? '' : "AND o.owner_id = '" + userId + "'"} GROUP BY o.type`;
    const oppTypeCurrent = db.prepare(oppTypeQuery).all(cyStr);
    const oppTypeLast = db.prepare(oppTypeQuery).all(lyStr);

    // 合同类型（按商机类型统计）
    const contractTypeSQL = `
      SELECT COALESCE(o.type, '未分类') as type, COUNT(*) as count,
        COALESCE(SUM(ct.amount), 0) as total_amount,
        COALESCE(SUM(ct.total_received), 0) as received_amount,
        COALESCE(SUM(ct.unpaid_amount), 0) as unpaid_amount
      FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id
      LEFT JOIN opportunities o ON ct.opportunity_id = o.id
      WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = ? ${ownerCond}
      GROUP BY o.type ORDER BY total_amount DESC`;
    const contractTypeCurrent = db.prepare(contractTypeSQL).all(cyStr);
    const contractTypeLast = db.prepare(contractTypeSQL).all(lyStr);

    // 回款方式
    const paymentMethodSQL = `
      SELECT COALESCE(p.method, '未指定') as method, COUNT(*) as count, COALESCE(SUM(p.amount), 0) as total_amount
      FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id
      INNER JOIN customers cu ON ct.customer_id = cu.id
      WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = ? ${ownerCond}
      GROUP BY p.method ORDER BY total_amount DESC`;
    const paymentMethodCurrent = db.prepare(paymentMethodSQL).all(cyStr);
    const paymentMethodLast = db.prepare(paymentMethodSQL).all(lyStr);

    // 销售人员排名（admin）
    let salesRankingCurrent = [];
    let salesRankingLast = [];
    if (canViewAll(userRole)) {
      const salesSQL = (y) => `
        SELECT u.id, u.name,
          (SELECT COUNT(*) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = '${y}' AND cu.owner_id = u.id) as contract_count,
          (SELECT COALESCE(SUM(ct.amount), 0) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = '${y}' AND cu.owner_id = u.id) as contract_amount,
          (SELECT COALESCE(SUM(p.amount), 0) FROM payments p INNER JOIN contracts ct2 ON p.contract_id = ct2.id INNER JOIN customers cu ON ct2.customer_id = cu.id WHERE p.status IN ('已回款', 'received', 'paid') AND strftime('%Y', p.actual_date) = '${y}' AND cu.owner_id = u.id) as payment_amount
        FROM users u WHERE u.role = 'sales' AND u.status = 'active'
        GROUP BY u.id, u.name ORDER BY contract_amount DESC`;
      salesRankingCurrent = db.prepare(salesSQL(cyStr)).all();
      salesRankingLast = db.prepare(salesSQL(lyStr)).all();
    }

    // 年度汇总
    const makeYearSummarySQL = (y) => `
      SELECT
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id INNER JOIN customers cu ON ct.customer_id = cu.id WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = '${y}' ${ownerCond}) as payment_amount,
        (SELECT COUNT(*) FROM payments p INNER JOIN contracts ct ON p.contract_id = ct.id INNER JOIN customers cu ON ct.customer_id = cu.id WHERE p.status IN ('已回款', 'received', 'paid') AND cu.is_deleted = 0 AND strftime('%Y', p.actual_date) = '${y}' ${ownerCond}) as payment_count,
        (SELECT COALESCE(SUM(ct.amount), 0) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = '${y}' ${ownerCond}) as contract_amount,
        (SELECT COUNT(*) FROM contracts ct INNER JOIN customers cu ON ct.customer_id = cu.id WHERE cu.is_deleted = 0 AND strftime('%Y', ct.sign_date) = '${y}' ${ownerCond}) as contract_count
      FROM customers c WHERE c.is_deleted = 0 ${ownerCond2}`;

    const thisYearSummary = db.prepare(makeYearSummarySQL(cyStr)).get();
    const lastYearSummary = db.prepare(makeYearSummarySQL(lyStr)).get();

    res.json({
      userRole, currentYear,
      coreMetrics: coreMetrics || {},
      currentYearMonthly, lastYearMonthly,
      industryCurrent, industryLast,
      regionCurrent, regionLast,
      oppStatusCurrent, oppStatusLast,
      oppTypeCurrent, oppTypeLast,
      contractTypeCurrent, contractTypeLast,
      paymentMethodCurrent, paymentMethodLast,
      salesRankingCurrent, salesRankingLast,
      thisYearSummary: thisYearSummary || {},
      lastYearSummary: lastYearSummary || {}
    });
  } catch (error) {
    console.error('获取仪表盘数据错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按销售统计各状态商机数量（开周会页面）
// =====================================================
router.get('/weekly-meeting/opportunities-by-status', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;

    // 运营（operations）允许只读查看开周会数据
    if (!canViewAll(userRole)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const period = resolveMeetingPeriod(req.query);
    if (!period) {
      return res.status(400).json({ error: '统计周期参数无效' });
    }
    const { periodType, year, quarter, startDate, endDate } = period;

    // 获取所有在职销售用户：即使本周期没有商机也要在表格中占一行
    const salesUsers = db.prepare(`
      SELECT id, name FROM users WHERE role = 'sales' AND status = 'active'
    `).all();
    
    // 以「商机创建时间」归属统计周期（季度或年度），便于管理层跟踪每位销售的签约管道。
    // 状态口径：季度=季末时点的历史快照（累计），年度=当前最新状态（仅当年新建）。
    // owner 使用 LEFT JOIN：负责人被删除的商机仍需计入统计，归入「未分配」行，
    // 与「首页/商机管理」列表口径保持一致（该列表同样用 LEFT JOIN users）。
    const snapshot = buildOpportunitySnapshotQuery(period);
    const statusCounts = db.prepare(`
      ${snapshot.withClause}
      SELECT 
        o.owner_id as owner_id,
        u.name as owner_name,
        ${snapshot.statusExpr} as status,
        COUNT(*) as count,
        COALESCE(SUM(o.amount), 0) as amount
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      ${snapshot.joinClause}
      WHERE c.is_deleted = 0
        AND ${snapshot.rangeClause}
      GROUP BY o.owner_id, u.name, ${snapshot.statusExpr}
    `).all(...snapshot.withParams, ...snapshot.rangeParams);
    
    // 构建结果数据结构：以 owner_id 为 key，避免同名销售互相覆盖
    const result = Object.create(null); // 使用null原型对象，避免原型污染

    const createStatRow = (id, name) => ({
      id,
      sales_name: name,
      potential: 0,
      technical: 0,
      poc: 0,
      project: 0,
      bidding: 0,
      contracting: 0,
      signed: 0,
      lost: 0,
      total_count: 0,
      active_count: 0,
      completion_rate: 0,
      // 标记是否为「负责人已删除」的兜底行，前端据此置底展示
      is_unassigned: id === UNASSIGNED_OWNER_KEY
    });

    // 初始化所有在职销售的统计
    salesUsers.forEach(user => {
      result[user.id] = createStatRow(user.id, user.name);
    });

    // 填充统计数据
    statusCounts.forEach(item => {
      const ownerId = item.owner_id;
      const ownerName = item.owner_name;
      // owner_id 在 users 表中已不存在 → 统一归入「未分配」行
      const key = ownerName ? ownerId : UNASSIGNED_OWNER_KEY;
      // owner 存在但不在「在职销售」名单内（如管理员、已停用销售）时动态建行，
      // 不再静默丢弃，保证各销售合计等于周期内商机总数
      if (!result[key]) {
        result[key] = createStatRow(key, ownerName || '未分配');
      }

      const status = item.status;
      // 仅统计白名单内的状态，避免脏数据污染结果对象
      if (!OPPORTUNITY_STATUSES.includes(status)) return;

      const count = Number(item.count || 0);
      result[key][status] += count;
      // 已终止商机不计入「应签」与完成率分母，仅单独成列展示
      if (status !== 'lost') {
        result[key].total_count += count;
        if (ACTIVE_OPPORTUNITY_STATUSES.has(status)) {
          result[key].active_count += count;
        }
      }
    });

    Object.values(result).forEach(item => {
      item.completion_rate = item.total_count > 0
        ? Number(((item.signed / item.total_count) * 100).toFixed(1))
        : 0;
    });

    res.json({
      data: result,
      // 当前统计周期信息（年度模式下 quarter 为 null）
      period: {
        type: periodType,
        year,
        quarter: periodType === 'year' ? null : quarter,
        start_date: startDate,
        end_date: endDate
      },
      // 保留原 quarter 字段，兼容既有前端逻辑
      quarter: { year, quarter, start_date: startDate, end_date: endDate }
    });
  } catch (error) {
    console.error('获取销售商机状态统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 按销售统计合同数量和待回款数量（开周会页面）
// =====================================================
router.get('/weekly-meeting/contracts-and-payments', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    
    // 运营（operations）允许只读查看开周会数据
    if (!['admin', 'super_admin', 'operations'].includes(userRole)) {
      return res.status(403).json({ error: '权限不足' });
    }

    // 统计口径固定为按年：合同按签订日期、待回款按计划回款日期落在所选年度内
    const now = new Date();
    const requestedYear = Number.parseInt(req.query.year, 10);
    const year = Number.isInteger(requestedYear) ? requestedYear : now.getFullYear();

    if (year < 2000 || year > 2100) {
      return res.status(400).json({ error: '统计周期参数无效' });
    }

    // 时间窗为所选年度的 [年初, 次年初)，沿用左闭右开口径
    const startDate = `${year}-01-01`;
    const endDate = `${year + 1}-01-01`;

    // 获取所有销售用户
    const salesUsers = db.prepare(`
      SELECT id, name FROM users WHERE role = 'sales' AND status = 'active'
    `).all();
    
    // 合同按签订日期归属所选周期。
    const contractCounts = db.prepare(`
      SELECT 
        u.name as sales_name,
        u.id as sales_id,
        COUNT(*) as count,
        COALESCE(SUM(c.amount), 0) as amount
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN opportunities o ON c.opportunity_id = o.id
      INNER JOIN users u ON COALESCE(o.owner_id, cu.owner_id) = u.id
      WHERE cu.is_deleted = 0
        AND DATE(c.sign_date) >= DATE(?)
        AND DATE(c.sign_date) < DATE(?)
      GROUP BY u.id
    `).all(startDate, endDate);
    
    // 待回款按计划回款日期归属所选周期，部分到账按剩余金额统计。
    const paymentCounts = db.prepare(`
      SELECT 
        u.name as sales_name,
        u.id as sales_id,
        COUNT(*) as count,
        COALESCE(SUM(cpp.payment_amount - COALESCE(cpp.actual_amount, 0)), 0) as amount
      FROM contract_payment_plans cpp
      INNER JOIN contracts c ON cpp.contract_id = c.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN opportunities o ON c.opportunity_id = o.id
      INNER JOIN users u ON COALESCE(o.owner_id, cu.owner_id) = u.id
      WHERE cpp.payment_status IN ('unpaid', 'partial')
        AND DATE(cpp.payment_date) >= DATE(?)
        AND DATE(cpp.payment_date) < DATE(?)
      GROUP BY u.id
    `).all(startDate, endDate);
    
    // 构建结果数据结构
    const result = {};
    
    // 初始化所有销售的统计
    salesUsers.forEach(user => {
      result[user.name] = {
        id: user.id,
        contract_count: 0,
        pending_payment_count: 0
      };
    });
    
    // 填充合同数量
    contractCounts.forEach(item => {
      if (result[item.sales_name]) {
        result[item.sales_name].contract_count = item.count;
      }
    });
    
    // 填充待回款数量
    paymentCounts.forEach(item => {
      if (result[item.sales_name]) {
        result[item.sales_name].pending_payment_count = item.count;
      }
    });
    
    res.json({
      data: result,
      period: {
        type: 'year',
        year,
        value: year,
        start_date: startDate,
        end_date: endDate
      }
    });
  } catch (error) {
    console.error('获取销售合同和待回款统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 每位销售在所选周期（季度/年度）与上一周期的进展对比（开周会页面）
// =====================================================
// 周期参数与「销售季度签约管道」共用 resolveMeetingPeriod 口径：
//   period_type=quarter（默认）时按 year + quarter 统计；period_type=year 时按 year 统计。
// 时间窗一律左闭右开：[startDate, endDate)。
router.get('/weekly-meeting/weekly-progress', authMiddleware, (req, res) => {
  try {
    // 运营（operations）允许只读查看开周会数据
    if (!['admin', 'super_admin', 'operations'].includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const period = resolveMeetingPeriod(req.query);
    if (!period) {
      return res.status(400).json({ error: '统计周期参数无效' });
    }
    const { startDate, endDate } = period;

    // 上一周期：季度模式取上一季度，年度模式取上一年。
    // 由于时间窗左闭右开，上一周期的结束日恒等于当前周期的开始日。
    let prevStartDate;
    if (period.periodType === 'year') {
      prevStartDate = `${period.year - 1}-01-01`;
    } else {
      const prevQuarter = period.quarter === 1 ? 4 : period.quarter - 1;
      const prevYear = period.quarter === 1 ? period.year - 1 : period.year;
      prevStartDate = `${prevYear}-${String((prevQuarter - 1) * 3 + 1).padStart(2, '0')}-01`;
    }
    const prevEndDate = startDate;

    // 把左闭右开的结束日换算成「含当天的最后一天」，仅用于前端展示区间
    const toInclusiveEnd = (exclusiveEnd) => {
      const d = new Date(`${exclusiveEnd}T00:00:00`);
      d.setDate(d.getDate() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const salesUsers = db.prepare(`
      SELECT id, name FROM users WHERE role = 'sales' AND status = 'active' ORDER BY name
    `).all();

    // 说明：previous_period / current_period 避免使用 SQLite 保留字 CURRENT 作为列别名
    const opportunityCounts = db.prepare(`
      SELECT o.owner_id as sales_id,
        SUM(CASE WHEN DATE(o.created_at) >= DATE(?) AND DATE(o.created_at) < DATE(?) THEN 1 ELSE 0 END) as previous_period,
        SUM(CASE WHEN DATE(o.created_at) >= DATE(?) AND DATE(o.created_at) < DATE(?) THEN 1 ELSE 0 END) as current_period
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
      GROUP BY o.owner_id
    `).all(prevStartDate, prevEndDate, startDate, endDate);

    const signedCounts = db.prepare(`
      SELECT o.owner_id as sales_id,
        COUNT(DISTINCT CASE WHEN DATE(cl.changed_at) >= DATE(?) AND DATE(cl.changed_at) < DATE(?) THEN cl.opportunity_id END) as previous_period,
        COUNT(DISTINCT CASE WHEN DATE(cl.changed_at) >= DATE(?) AND DATE(cl.changed_at) < DATE(?) THEN cl.opportunity_id END) as current_period
      FROM opportunity_change_logs cl
      INNER JOIN opportunities o ON o.id = cl.opportunity_id
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0 AND cl.to_status = 'signed'
      GROUP BY o.owner_id
    `).all(prevStartDate, prevEndDate, startDate, endDate);

    const contractCounts = db.prepare(`
      SELECT COALESCE(o.owner_id, c.owner_id) as sales_id,
        SUM(CASE WHEN DATE(ct.created_at) >= DATE(?) AND DATE(ct.created_at) < DATE(?) THEN 1 ELSE 0 END) as previous_period,
        SUM(CASE WHEN DATE(ct.created_at) >= DATE(?) AND DATE(ct.created_at) < DATE(?) THEN 1 ELSE 0 END) as current_period
      FROM contracts ct
      INNER JOIN customers c ON c.id = ct.customer_id
      LEFT JOIN opportunities o ON o.id = ct.opportunity_id
      WHERE c.is_deleted = 0
      GROUP BY COALESCE(o.owner_id, c.owner_id)
    `).all(prevStartDate, prevEndDate, startDate, endDate);

    const followupCounts = db.prepare(`
      SELECT o.owner_id as sales_id,
        SUM(CASE WHEN DATE(f.followup_time) >= DATE(?) AND DATE(f.followup_time) < DATE(?) THEN 1 ELSE 0 END) as previous_period,
        SUM(CASE WHEN DATE(f.followup_time) >= DATE(?) AND DATE(f.followup_time) < DATE(?) THEN 1 ELSE 0 END) as current_period
      FROM followups f
      INNER JOIN opportunities o ON o.id = f.opportunity_id
      INNER JOIN customers c ON c.id = o.customer_id
      WHERE c.is_deleted = 0
      GROUP BY o.owner_id
    `).all(prevStartDate, prevEndDate, startDate, endDate);

    const toMap = rows => new Map(rows.map(row => [row.sales_id, {
      previous: Number(row.previous_period || 0),
      current: Number(row.current_period || 0)
    }]));
    const opportunityMap = toMap(opportunityCounts);
    const signedMap = toMap(signedCounts);
    const contractMap = toMap(contractCounts);
    const followupMap = toMap(followupCounts);
    const emptyMetric = { previous: 0, current: 0 };
    const withDelta = metric => ({ ...metric, delta: metric.current - metric.previous });

    const data = salesUsers.map(user => ({
      id: user.id,
      sales_name: user.name,
      opportunities: withDelta(opportunityMap.get(user.id) || emptyMetric),
      signed: withDelta(signedMap.get(user.id) || emptyMetric),
      contracts: withDelta(contractMap.get(user.id) || emptyMetric),
      followups: withDelta(followupMap.get(user.id) || emptyMetric)
    }));

    // 周期区间信息：供前端展示副标题，start/end 为含当天的闭区间
    const periodRange = {
      period_type: period.periodType,
      year: period.year,
      quarter: period.quarter,
      start: startDate,
      end: toInclusiveEnd(endDate),
      prev_start: prevStartDate,
      prev_end: toInclusiveEnd(prevEndDate)
    };

    res.json({ data, period: periodRange });
  } catch (error) {
    console.error('获取销售周进展统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取可筛选的商机列表（开周会页面）
// =====================================================
router.get('/weekly-meeting/filterable-opportunities', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    
    // 运营（operations）允许只读查看开周会数据
    if (!['admin', 'super_admin', 'operations'].includes(userRole)) {
      return res.status(403).json({ error: '权限不足' });
    }
    
    const { owner_id, customer_name } = req.query;
    const status = req.query.status ?? req.query['status[]'];
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 10;
    const offset = (page - 1) * limit;
    
    // 周期过滤：与「销售季度签约管道」共用 resolveMeetingPeriod，按商机创建时间归属，
    // 状态同样走历史快照口径，保证页面上下两块数据口径一致。
    // 未传任何周期参数时不做时间过滤（保留全量查询能力）。
    const hasPeriodParam = req.query.year !== undefined
      || req.query.quarter !== undefined
      || req.query.period_type !== undefined;
    let meetingPeriod = null;
    if (hasPeriodParam) {
      meetingPeriod = resolveMeetingPeriod(req.query);
      if (!meetingPeriod) {
        return res.status(400).json({ error: '统计周期参数无效' });
      }
    }
    // 快照查询片段：季度=季末快照状态，年度/无周期=当前状态
    const snapshot = buildOpportunitySnapshotQuery(meetingPeriod);
    // CTE 参数必须排在所有 WHERE 参数之前，与 SQL 中占位符的出现顺序一致
    let whereClause = `c.is_deleted = 0 AND ${snapshot.rangeClause}`;
    const params = [...snapshot.withParams, ...snapshot.rangeParams];

    if (customer_name && String(customer_name).trim()) {
      whereClause += ' AND c.name LIKE ?';
      params.push(`%${String(customer_name).trim()}%`);
    }
    
    // 状态筛选（支持多选）：按周期口径下的生效状态过滤，与上方签约管道的计数保持一致
    const statusList = status
      ? (Array.isArray(status) ? status : String(status).split(','))
          .map(item => String(item).trim())
          .filter(Boolean)
      : [];
    if (statusList.length > 0) {
      const placeholders = statusList.map(() => '?').join(',');
      whereClause += ` AND ${snapshot.statusExpr} IN (${placeholders})`;
      params.push(...statusList);
    } else {
      // 与「首页/商机管理」列表一致：默认不显示已丢失的数据
      whereClause += ` AND ${snapshot.statusExpr} != 'lost'`;
    }
    
    // 销售筛选：__unassigned__ 表示负责人已被删除的商机
    if (owner_id) {
      if (String(owner_id) === UNASSIGNED_OWNER_KEY) {
        whereClause += ' AND u.id IS NULL';
      } else {
        whereClause += ' AND o.owner_id = ?';
        params.push(owner_id);
      }
    }
    
    // owner 使用 LEFT JOIN：负责人被删除的商机不再被丢弃，与「首页/商机管理」列表口径一致
    const total = db.prepare(`
      ${snapshot.withClause}
      SELECT COUNT(*) as count
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      ${snapshot.joinClause}
      WHERE ${whereClause}
    `).get(...params)?.count || 0;

    const opportunities = db.prepare(`
      ${snapshot.withClause}
      SELECT 
        o.id,
        o.name as opportunity_name,
        o.type as opportunity_type,
        o.expected_sign_date,
        o.status,
        ${snapshot.statusExpr} as snapshot_status,
        DATE(o.created_at, '+8 hours') as created_date,
        o.amount,
        c.name as customer_name,
        c.owner_share_percent,
        c.secondary_owner_id,
        COALESCE(u.name, '未分配') as owner_name,
        o.owner_id as owner_id,
        COALESCE((SELECT GROUP_CONCAT(au.name, ', ')
          FROM opportunity_assignments oa
          INNER JOIN users au ON au.id = oa.user_id
          WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'presales' AND oa.status = 'active'), '') as presales_names,
        COALESCE((SELECT GROUP_CONCAT(au.name, ', ')
          FROM opportunity_assignments oa
          INNER JOIN users au ON au.id = oa.user_id
          WHERE oa.opportunity_id = o.id AND oa.assignment_type = 'fde' AND oa.status = 'active'), '') as fde_names,
        COALESCE(fc.followup_count, 0) as followup_count
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      ${snapshot.joinClause}
      LEFT JOIN (SELECT opportunity_id, COUNT(*) as followup_count FROM followups WHERE opportunity_id IS NOT NULL GROUP BY opportunity_id) fc ON fc.opportunity_id = o.id
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    
    res.json({
      data: opportunities,
      total: Number(total),
      page,
      limit,
      // 回传本次生效的统计周期，便于前端展示与校验
      period: meetingPeriod
        ? {
            type: meetingPeriod.periodType,
            year: meetingPeriod.year,
            quarter: meetingPeriod.periodType === 'year' ? null : meetingPeriod.quarter,
            start_date: meetingPeriod.startDate,
            end_date: meetingPeriod.endDate
          }
        : null
    });
  } catch (error) {
    console.error('获取筛选商机列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取跟进方式统计
// =====================================================
router.get('/followup-type-stats', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    let whereClause = '1=1';
    if (userRole === 'sales') {
      whereClause += ` AND user_id = '${userId}'`;
    } else if (userRole === 'presales') {
      whereClause += ` AND EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = followups.opportunity_id AND a.user_id = '${userId}' AND a.assignment_type = 'presales' AND a.status = 'active')`;
    } else if (userRole === 'fde') {
      whereClause += ` AND EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = followups.opportunity_id AND a.user_id = '${userId}' AND a.assignment_type = 'fde' AND a.status = 'active')`;
    }

    const stats = db.prepare(`SELECT type, COUNT(*) as count FROM followups WHERE ${whereClause} GROUP BY type`).all();
    res.json({ data: stats });
  } catch (error) {
    console.error('获取跟进方式统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});


// =====================================================
// 商机平均转化时间统计
// 权限：仅管理员和运营可见
// =====================================================
router.get('/opportunity-conversion-time', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    if (!canViewAll(userRole)) {
      return res.status(403).json({ error: '权限不足，仅管理员和运营可访问' });
    }

    const { type, date_start, date_end } = req.query;

    // 构建 WHERE 条件（不再全局过滤 product，因为要按产品维度展示）
    let oppWhere = 'c.is_deleted = 0';
    const params = [];
    if (type) {
      oppWhere += ` AND o.type = ?`;
      params.push(type);
    }
    if (date_start) {
      oppWhere += ` AND o.created_at >= ?`;
      params.push(date_start);
    }
    if (date_end) {
      oppWhere += ` AND o.created_at <= ?`;
      params.push(date_end);
    }

    // 1. 阶段停留时间 — 区分已签产品 vs 未签产品
    // 1a. 已签产品的阶段数据（精确）
    const signedStageData = db.prepare(`
      SELECT 
        COALESCE(o.products, '未指定') as product_name,
        cl.from_status,
        cl.to_status,
        COUNT(*) as transition_count,
        ROUND(AVG(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at), 
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as avg_days,
        ROUND(MIN(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at), 
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as min_days,
        ROUND(MAX(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at), 
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as max_days
      FROM opportunity_change_logs cl
      INNER JOIN opportunities o ON cl.opportunity_id = o.id
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN opportunity_change_logs cl2 ON cl2.opportunity_id = cl.opportunity_id 
        AND cl2.changed_at = (
          SELECT MAX(cl3.changed_at) FROM opportunity_change_logs cl3 
          WHERE cl3.opportunity_id = cl.opportunity_id AND cl3.changed_at < cl.changed_at
        )
      WHERE ${oppWhere}
        AND cl.from_status IS NOT NULL
        AND o.status = 'signed'
      GROUP BY COALESCE(o.products, '未指定'), cl.from_status, cl.to_status
      ORDER BY product_name, cl.from_status, cl.to_status
    `).all(...params);

    // 1b. 未签产品的阶段数据（基于已有变更日志）
    const unsignedStageData = db.prepare(`
      SELECT 
        COALESCE(o.products, '未指定') as product_name,
        cl.from_status,
        cl.to_status,
        COUNT(*) as transition_count,
        ROUND(AVG(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at), 
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as avg_days,
        ROUND(MIN(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at), 
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as min_days,
        ROUND(MAX(COALESCE(julianday(cl.changed_at) - julianday(cl2.changed_at), 
              julianday(cl.changed_at) - julianday(o.created_at))), 1) as max_days
      FROM opportunity_change_logs cl
      INNER JOIN opportunities o ON cl.opportunity_id = o.id
      INNER JOIN customers c ON o.customer_id = c.id
      LEFT JOIN opportunity_change_logs cl2 ON cl2.opportunity_id = cl.opportunity_id 
        AND cl2.changed_at = (
          SELECT MAX(cl3.changed_at) FROM opportunity_change_logs cl3 
          WHERE cl3.opportunity_id = cl.opportunity_id AND cl3.changed_at < cl.changed_at
        )
      WHERE ${oppWhere}
        AND cl.from_status IS NOT NULL
        AND o.status != 'signed'
      GROUP BY COALESCE(o.products, '未指定'), cl.from_status, cl.to_status
      ORDER BY product_name, cl.from_status, cl.to_status
    `).all(...params);

    // 定义所有阶段转换顺序
    const allStages = [
      { from: 'potential', to: 'technical' },
      { from: 'technical', to: 'poc' },
      { from: 'poc', to: 'project' },
      { from: 'project', to: 'bidding' },
      { from: 'bidding', to: 'contracting' },
      { from: 'contracting', to: 'signed' }
    ];

    // 识别哪些产品只有未签商机（无已签记录）
    const signedProducts = new Set(signedStageData.map(r => r.product_name))
    const unsignedProducts = unsignedStageData.map(r => r.product_name).filter(p => !signedProducts.has(p))
    const uniqueUnsigned = [...new Set(unsignedProducts)]

    // 构建 unsigned 数据 map
    const unsignedMap = {}
    unsignedStageData.forEach(r => {
      unsignedMap[r.product_name] = unsignedMap[r.product_name] || {}
      unsignedMap[r.product_name][`${r.from_status}→${r.to_status}`] = {
        avg_days: r.avg_days,
        min_days: r.min_days,
        max_days: r.max_days,
        transition_count: r.transition_count
      }
    })

    // 构建 stageDurations 结果
    const stageDurations = []

    // 已签产品数据
    signedStageData.forEach(r => {
      stageDurations.push({
        product_name: r.product_name,
        from_status: r.from_status,
        to_status: r.to_status,
        avg_days: r.avg_days,
        min_days: r.min_days,
        max_days: r.max_days,
        transition_count: r.transition_count,
        isEstimated: false
      })
    })

    // 未签产品数据（实线部分 + 虚线预估值）
    uniqueUnsigned.forEach(pname => {
      const existing = unsignedMap[pname] || {}
      let knownDaysSum = 0
      let knownCount = 0

      // 已知阶段（实线）
      allStages.forEach(st => {
        const key = `${st.from}→${st.to}`
        if (existing[key]) {
          knownDaysSum += (existing[key].avg_days || 0)
          knownCount++
          stageDurations.push({
            product_name: `${pname}(预估)`,
            from_status: st.from,
            to_status: st.to,
            avg_days: existing[key].avg_days,
            min_days: existing[key].min_days,
            max_days: existing[key].max_days,
            transition_count: existing[key].transition_count,
            isEstimated: false
          })
        }
      })

      // 预估阶段（虚线）— 剩余天数平均分配
      const remainingStages = allStages.filter(st => !existing[`${st.from}→${st.to}`])
      const remainingDays = Math.max(365 - knownDaysSum, 0)
      const avgPerStage = remainingStages.length > 0 ? Math.round(remainingDays / remainingStages.length) : 0

      remainingStages.forEach(st => {
        stageDurations.push({
          product_name: `${pname}(预估)`,
          from_status: st.from,
          to_status: st.to,
          avg_days: avgPerStage,
          min_days: null,
          max_days: null,
          transition_count: 0,
          isEstimated: true
        })
      })
    })

    // 2. 全程转化周期 — 按产品维度
    const fullCycleByProduct = db.prepare(`
      SELECT
        COALESCE(o.products, '未指定') as product_name,
        COUNT(*) as converted_count,
        ROUND(AVG(
          julianday(
            COALESCE(
              (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
              o.updated_at
            )
          ) - julianday(o.created_at)
        ), 1) as avg_total_days,
        ROUND(MIN(
          julianday(
            COALESCE(
              (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
              o.updated_at
            )
          ) - julianday(o.created_at)
        ), 1) as min_total_days,
        ROUND(MAX(
          julianday(
            COALESCE(
              (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
              o.updated_at
            )
          ) - julianday(o.created_at)
        ), 1) as max_total_days
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      WHERE ${oppWhere} AND o.status = 'signed'
      GROUP BY COALESCE(o.products, '未指定')
      ORDER BY avg_total_days ASC
    `).all(...params);

    // 3. 按销售 + 产品统计转化时间
    const salesConversion = db.prepare(`
      SELECT 
        u.name as sales_name,
        COALESCE(o.products, '未指定') as product_name,
        COUNT(*) as converted_count,
        ROUND(AVG(
          julianday(
            COALESCE(
              (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
              o.updated_at
            )
          ) - julianday(o.created_at)
        ), 1) as avg_days,
        ROUND(MIN(
          julianday(
            COALESCE(
              (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
              o.updated_at
            )
          ) - julianday(o.created_at)
        ), 1) as min_days,
        ROUND(MAX(
          julianday(
            COALESCE(
              (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
              o.updated_at
            )
          ) - julianday(o.created_at)
        ), 1) as max_days
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      INNER JOIN users u ON o.owner_id = u.id
      WHERE ${oppWhere} AND o.status = 'signed'
      GROUP BY u.id, u.name, COALESCE(o.products, '未指定')
      ORDER BY u.name, avg_days ASC
    `).all(...params);

    // 4. 按销售 + 产品统计转化率（含转化天数，合并销售转化数据）
    const salesConversionRate = db.prepare(`
      SELECT
        u.name as sales_name,
        COALESCE(o.products, '未指定') as product_name,
        COUNT(*) as total_opp,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        ROUND(SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as conversion_rate,
        ROUND(AVG(
          CASE WHEN o.status = 'signed' THEN
            julianday(
              COALESCE(
                (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
                o.updated_at
              )
            ) - julianday(o.created_at)
          END
        ), 1) as avg_days,
        ROUND(MIN(
          CASE WHEN o.status = 'signed' THEN
            julianday(
              COALESCE(
                (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
                o.updated_at
              )
            ) - julianday(o.created_at)
          END
        ), 1) as min_days,
        ROUND(MAX(
          CASE WHEN o.status = 'signed' THEN
            julianday(
              COALESCE(
                (SELECT changed_at FROM opportunity_change_logs cl2 WHERE cl2.opportunity_id = o.id AND cl2.to_status = 'signed' ORDER BY cl2.changed_at DESC LIMIT 1),
                o.updated_at
              )
            ) - julianday(o.created_at)
          END
        ), 1) as max_days
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      INNER JOIN users u ON o.owner_id = u.id
      WHERE ${oppWhere}
      GROUP BY u.id, u.name, COALESCE(o.products, '未指定')
      ORDER BY u.name, conversion_rate DESC
    `).all(...params);

    // 5. 总览数据
    const overview = db.prepare(`
      SELECT
        COUNT(*) as total_opp,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        ROUND(SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as conversion_rate,
        COUNT(*) - SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as in_progress_count
      FROM opportunities o
      INNER JOIN customers c ON o.customer_id = c.id
      WHERE ${oppWhere}
    `).get(...params);

    res.json({
      overview: overview || { total_opp: 0, signed_count: 0, conversion_rate: 0, in_progress_count: 0 },
      stageDurations,
      fullCycleByProduct,
      salesConversion,
      salesConversionRate,
      filterParams: { type, date_start, date_end }
    });
  } catch (error) {
    console.error('获取商机转化周期分析错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取商机时间轴（详情用）
// =====================================================
router.get('/opportunity-timeline/:oppId', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    if (!canViewAll(userRole)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const { oppId } = req.params;

    // 获取商机基本信息（不限制客户是否删除，管理需要看历史数据）
    const opp = db.prepare(`
      SELECT o.id, o.name, o.status, o.created_at, o.amount, o.products, o.type,
             c.name as customer_name, u.name as owner_name
      FROM opportunities o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.id = ?
    `).get(oppId);

    if (!opp) {
      return res.status(404).json({ error: '商机不存在' });
    }

    // 获取状态变更历史
    const changes = db.prepare(`
      SELECT cl.from_status, cl.to_status, cl.changed_at, cl.followup_id,
             u.name as changed_by_name
      FROM opportunity_change_logs cl
      LEFT JOIN users u ON cl.changed_by = u.id
      WHERE cl.opportunity_id = ?
      ORDER BY cl.changed_at ASC
    `).all(oppId);

    // 构建时间轴
    const timeline = [];
    // 起点：创建
    timeline.push({
      date: opp.created_at,
      from: '创建',
      to: opp.created_at ? '潜在' : null,
      action: 'created',
      changed_by: null,
      followup_id: null,
      days_elapsed: 0
    });

    let lastDate = opp.created_at;
    for (const change of changes) {
      const daysElapsed = Math.round((new Date(change.changed_at) - new Date(lastDate)) / (1000 * 60 * 60 * 24));
      timeline.push({
        date: change.changed_at,
        from: change.from_status || '',
        to: change.to_status,
        action: 'status_change',
        changed_by: change.changed_by_name,
        followup_id: change.followup_id,
        days_elapsed: Math.max(daysElapsed, 0)
      });
      lastDate = change.changed_at;
    }

    res.json({ opp, timeline });
  } catch (error) {
    console.error('获取商机时间轴错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});
module.exports = router;

// =====================================================
// 渠道分析统计
// 权限：仅管理员和运营可见
// =====================================================
router.get('/channel-analysis', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    if (!canViewAll(userRole)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const { type, date_start, date_end } = req.query;

    let chWhere = '1=1';
    const params = [];
    if (type) { chWhere += ' AND ch.type = ?'; params.push(type); }
    if (date_start) { chWhere += ' AND ch.created_at >= ?'; params.push(date_start); }
    if (date_end) { chWhere += ' AND ch.created_at <= ?'; params.push(date_end); }

    // 渠道排行
    const channelRanking = db.prepare(`
      SELECT 
        ch.id, ch.name, ch.type, ch.commission_rate,
        COUNT(DISTINCT cc.customer_id) as customer_count,
        COUNT(DISTINCT o.id) as opp_count,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        COALESCE(SUM(c.amount), 0) as contract_amount
      FROM channels ch
      LEFT JOIN channel_customers cc ON cc.channel_id = ch.id
      LEFT JOIN opportunities o ON o.customer_id = cc.customer_id
      LEFT JOIN contracts c ON c.customer_id = cc.customer_id AND c.status = 'active'
      WHERE ${chWhere}
      GROUP BY ch.id, ch.name, ch.type, ch.commission_rate
      ORDER BY contract_amount DESC
    `).all(...params);

    channelRanking.forEach(r => {
      r.commission_amount = Math.round(r.contract_amount * (r.commission_rate || 0) / 100);
    });

    // 渠道类型统计
    const channelTypeStats = db.prepare(`
      SELECT ch.type,
        COUNT(DISTINCT ch.id) as channel_count,
        COUNT(DISTINCT cc.customer_id) as customer_count,
        COUNT(DISTINCT o.id) as opp_count,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        COALESCE(SUM(c.amount), 0) as contract_amount
      FROM channels ch
      LEFT JOIN channel_customers cc ON cc.channel_id = ch.id
      LEFT JOIN opportunities o ON o.customer_id = cc.customer_id
      LEFT JOIN contracts c ON c.customer_id = cc.customer_id AND c.status = 'active'
      WHERE ${chWhere}
      GROUP BY ch.type
    `).all(...params);

    channelTypeStats.forEach(r => {
      r.commission_amount = Math.round(r.contract_amount * 
        (db.prepare('SELECT AVG(commission_rate) as avg_rate FROM channels WHERE type = ?').get(r.type).avg_rate || 0) / 100);
    });

    // 月度趋势
    const monthlyTrend = db.prepare(`
      SELECT 
        strftime('%Y-%m', ch.created_at) as month,
        COUNT(DISTINCT ch.id) as channel_count,
        COUNT(DISTINCT cc.customer_id) as customer_count,
        COALESCE(SUM(c.amount), 0) as contract_amount
      FROM channels ch
      LEFT JOIN channel_customers cc ON cc.channel_id = ch.id
      LEFT JOIN contracts c ON c.customer_id = cc.customer_id AND c.status = 'active'
      WHERE ${chWhere}
      GROUP BY month ORDER BY month
    `).all(...params);

    // 总览
    const overview = db.prepare(`
      SELECT
        COUNT(DISTINCT ch.id) as channel_count,
        COUNT(DISTINCT cc.customer_id) as customer_count,
        COUNT(DISTINCT o.id) as opp_count,
        SUM(CASE WHEN o.status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        COALESCE(SUM(c.amount), 0) as contract_amount
      FROM channels ch
      LEFT JOIN channel_customers cc ON cc.channel_id = ch.id
      LEFT JOIN opportunities o ON o.customer_id = cc.customer_id
      LEFT JOIN contracts c ON c.customer_id = cc.customer_id AND c.status = 'active'
      WHERE ${chWhere}
    `).get(...params);

    res.json({ channelRanking, channelTypeStats, monthlyTrend, overview });
  } catch (error) {
    console.error('渠道分析统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 人力资源投入分析
// =====================================================
router.get('/workforce-analysis', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    // 获取所有在跟商机（未签、未丢）并标注售前/FDE 指派情况
    const opps = db.prepare(`
      SELECT
        o.id, o.name, o.customer_id, o.owner_id, o.status,
        c.name AS customer_name,
        u.name AS owner_name,
        EXISTS(SELECT 1 FROM opportunity_assignments pa
          WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active') AS has_presales,
        EXISTS(SELECT 1 FROM opportunity_assignments fa
          WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active') AS has_fde,
        (SELECT GROUP_CONCAT(pu.name, ',') FROM opportunity_assignments pa
          INNER JOIN users pu ON pu.id = pa.user_id
          WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active') AS presales_names,
        (SELECT GROUP_CONCAT(fu.name, ',') FROM opportunity_assignments fa
          INNER JOIN users fu ON fu.id = fa.user_id
          WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active') AS fde_names
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.status NOT IN ('signed', 'lost') AND c.is_deleted = 0
    `).all();

    // 先初始化所有销售用户（确保没有商机的销售也出现在列表中）
    const allSalesUsers = db.prepare("SELECT id, name FROM users WHERE role = 'sales' AND status = 'active'").all();
    const salesMap = {};
    allSalesUsers.forEach(u => {
      salesMap[u.id] = { user_id: u.id, user_name: u.name, active_customers: new Set(), active_opportunities: 0, with_presales: 0, without_presales: 0, with_fde: 0, without_fde: 0, opp_ids: [] };
    });

    // --- 销售维度 ---
    opps.forEach(o => {
      if (!o.owner_id) return;
      if (!salesMap[o.owner_id]) {
        salesMap[o.owner_id] = { user_id: o.owner_id, user_name: o.owner_name || '未知', active_customers: new Set(), active_opportunities: 0, with_presales: 0, without_presales: 0, with_fde: 0, without_fde: 0, opp_ids: [] };
      }
      const s = salesMap[o.owner_id];
      s.active_customers.add(o.customer_id);
      s.active_opportunities++;
      s.opp_ids.push(o.id);
      if (o.has_presales) s.with_presales++; else s.without_presales++;
      if (o.has_fde) s.with_fde++; else s.without_fde++;
    });
    const salesDimension = Object.values(salesMap).map(s => ({ ...s, active_customers: s.active_customers.size }));

    // --- 售前维度 ---
    const presalesAssignments = db.prepare(`
      SELECT oa.opportunity_id, oa.user_id, u.name AS user_name,
        o.customer_id, o.name AS opp_name, o.owner_id,
        EXISTS(SELECT 1 FROM opportunity_assignments fa
          WHERE fa.opportunity_id = oa.opportunity_id AND fa.assignment_type = 'fde' AND fa.status = 'active') AS has_fde
      FROM opportunity_assignments oa
      INNER JOIN users u ON u.id = oa.user_id
      INNER JOIN opportunities o ON o.id = oa.opportunity_id
      WHERE oa.assignment_type = 'presales' AND oa.status = 'active'
        AND o.status NOT IN ('signed', 'lost')
    `).all();
    const presalesMap = {};
    presalesAssignments.forEach(pa => {
      if (!presalesMap[pa.user_id]) {
        presalesMap[pa.user_id] = { user_id: pa.user_id, user_name: pa.user_name || '未知', assigned_opportunities: 0, with_fde: 0, without_fde: 0, opp_ids: [] };
      }
      const p = presalesMap[pa.user_id];
      p.assigned_opportunities++;
      p.opp_ids.push(pa.opportunity_id);
      if (pa.has_fde) p.with_fde++; else p.without_fde++;
    });
    const presalesDimension = Object.values(presalesMap);

    // --- FDE维度 ---
    const fdeAssignments = db.prepare(`
      SELECT oa.opportunity_id, oa.user_id, u.name AS user_name,
        o.customer_id, o.name AS opp_name, o.owner_id
      FROM opportunity_assignments oa
      INNER JOIN users u ON u.id = oa.user_id
      INNER JOIN opportunities o ON o.id = oa.opportunity_id
      WHERE oa.assignment_type = 'fde' AND oa.status = 'active'
        AND o.status NOT IN ('signed', 'lost')
    `).all();
    const fdeMap = {};
    fdeAssignments.forEach(fa => {
      if (!fdeMap[fa.user_id]) {
        fdeMap[fa.user_id] = { user_id: fa.user_id, user_name: fa.user_name || '未知', assigned_opportunities: 0, opp_ids: [] };
      }
      const f = fdeMap[fa.user_id];
      f.assigned_opportunities++;
      f.opp_ids.push(fa.opportunity_id);
    });
    const fdeDimension = Object.values(fdeMap);

    // 获取售前和FDE人员列表（用于前端分配选择）
    const presalesUsers = db.prepare("SELECT id, name FROM users WHERE role = 'presales' AND status = 'active'").all();
    const fdeUsers = db.prepare("SELECT id, name FROM users WHERE role = 'fde' AND status = 'active'").all();

    res.json({ salesDimension, presalesDimension, fdeDimension, presalesUsers, fdeUsers });
  } catch (error) {
    console.error('人力资源投入分析错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 人力资源投入分析 — 点击数字钻取商机列表
router.get('/workforce-analysis/drilldown', authMiddleware, (req, res) => {
  try {
    const { dimension, user_id, metric } = req.query;
    let whereClause = 'o.status NOT IN (\'signed\', \'lost\') AND c.is_deleted = 0';
    const params = [];

    if (dimension === 'sales') {
      whereClause += ' AND o.owner_id = ?';
      params.push(user_id);
      if (metric === 'without_presales') {
        whereClause += " AND NOT EXISTS(SELECT 1 FROM opportunity_assignments pa WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active')";
      } else if (metric === 'without_fde') {
        whereClause += " AND NOT EXISTS(SELECT 1 FROM opportunity_assignments fa WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active')";
      } else if (metric === 'with_presales_no_fde') {
        whereClause += " AND EXISTS(SELECT 1 FROM opportunity_assignments pa WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active') AND NOT EXISTS(SELECT 1 FROM opportunity_assignments fa WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active')";
      }
    } else if (dimension === 'presales') {
      whereClause += " AND EXISTS(SELECT 1 FROM opportunity_assignments pa WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active' AND pa.user_id = ?)";
      params.push(user_id);
      if (metric === 'without_fde') {
        whereClause += " AND NOT EXISTS(SELECT 1 FROM opportunity_assignments fa WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active')";
      }
    } else if (dimension === 'fde') {
      whereClause += " AND EXISTS(SELECT 1 FROM opportunity_assignments fa WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active' AND fa.user_id = ?)";
      params.push(user_id);
    }

    const opportunities = db.prepare(`
      SELECT o.id, o.name, o.status, o.customer_id, o.owner_id, o.expected_sign_date,
        c.name AS customer_name, u.name AS owner_name,
        (SELECT GROUP_CONCAT(pu.name, ',') FROM opportunity_assignments pa
          INNER JOIN users pu ON pu.id = pa.user_id
          WHERE pa.opportunity_id = o.id AND pa.assignment_type = 'presales' AND pa.status = 'active') AS presales_names,
        (SELECT GROUP_CONCAT(fu.name, ',') FROM opportunity_assignments fa
          INNER JOIN users fu ON fu.id = fa.user_id
          WHERE fa.opportunity_id = o.id AND fa.assignment_type = 'fde' AND fa.status = 'active') AS fde_names,
        (SELECT cfa.user_id FROM customer_fde_assignments cfa
          WHERE cfa.customer_id = c.id AND cfa.status = 'active'
          ORDER BY cfa.assigned_at DESC LIMIT 1) AS customer_fde_id
      FROM opportunities o
      INNER JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users u ON u.id = o.owner_id
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
    `).all(...params);

    res.json({ data: opportunities });
  } catch (error) {
    console.error('钻取商机列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});