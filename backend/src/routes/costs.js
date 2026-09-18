const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const ADMIN_ROLES = ['admin', 'super_admin'];

router.use(authMiddleware, (req, res, next) => {
  // 运营（operations）允许查看成本数据（只读），写操作仍仅限系统管理员
  const canView = [...ADMIN_ROLES, 'operations'];
  if (!canView.includes(req.user.role)) {
    return res.status(403).json({ error: '成本管理仅限系统管理员访问' });
  }
  if (req.method !== 'GET' && !ADMIN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: '当前角色只能查看成本数据' });
  }
  next();
});

// 费用分类映射
const CATEGORIES = {
  travel: '差旅成本',
  entertainment: '招待费',
  other: '其他费用'
};
const SUB_CATEGORIES = {
  taxi: '打车',
  meal: '餐费',
  flight: '机票',
  train: '火车',
  hotel: '酒店'
};
const TRAVEL_SUBS = ['taxi', 'meal', 'flight', 'train', 'hotel'];

function getUserCondition(userRole, userId) {
  return ADMIN_ROLES.includes(userRole) ? '' : ` AND user_id = '${userId}' `;
}

// ==================== 分类列表 ====================
router.get('/categories', authMiddleware, (req, res) => {
  res.json({
    data: [
      {
        key: 'travel',
        label: '差旅成本',
        subs: TRAVEL_SUBS.map(s => ({ key: s, label: SUB_CATEGORIES[s] }))
      },
      { key: 'entertainment', label: '招待费', subs: [] },
      { key: 'other', label: '其他费用', subs: [] }
    ]
  });
});

// ==================== 费用列表 ====================
router.get('/', authMiddleware, (req, res) => {
  try {
    const { month } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    let whereClause = `1=1 ${getUserCondition(userRole, userId)}`;
    const params = [];
    if (month) { whereClause += ' AND month = ?'; params.push(month); }

    const entries = db.prepare(`
      SELECT * FROM cost_entries WHERE ${whereClause}
      ORDER BY month DESC, created_at DESC
    `).all(...params);

    entries.forEach(e => {
      e.category_label = CATEGORIES[e.category] || e.category;
      e.sub_category_label = SUB_CATEGORIES[e.sub_category] || '';
    });

    // 汇总统计
    const summary = {};
    let monthTotal = 0;
    entries.forEach(e => {
      if (!summary[e.category]) summary[e.category] = { total: 0 };
      summary[e.category].total += e.amount;
      if (e.sub_category) {
        summary[e.category][e.sub_category] = (summary[e.category][e.sub_category] || 0) + e.amount;
      }
      monthTotal += e.amount;
    });

    // 保留两位小数
    Object.keys(summary).forEach(k => {
      summary[k].total = parseFloat(summary[k].total.toFixed(2));
      TRAVEL_SUBS.forEach(s => {
        if (summary[k][s] !== undefined) summary[k][s] = parseFloat(summary[k][s].toFixed(2));
      });
    });
    // 非 travel 大类扁平化为纯数字，方便前端直接用
    if (summary.entertainment) {
      summary.entertainment = summary.entertainment.total;
    }
    if (summary.other) {
      summary.other = summary.other.total;
    }

    res.json({
      data: entries,
      summary: {
        ...summary,
        month_total: parseFloat(monthTotal.toFixed(2))
      }
    });
  } catch (error) {
    console.error('获取费用列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 月度汇总（按子类明细） ====================
router.get('/monthly-summary', authMiddleware, (req, res) => {
  try {
    const { year } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;
    const isAdmin = ADMIN_ROLES.includes(userRole);

    let whereClause = `1=1 ${getUserCondition(userRole, userId)}`;
    const params = [];
    if (year) { whereClause += " AND month LIKE ?"; params.push(year + '%'); }

    if (isAdmin) {
      // admin：按用户+月份分组
      const rows = db.prepare(`
        SELECT ce.user_id, u.name as user_name, ce.month, ce.category, ce.sub_category,
          COALESCE(SUM(ce.amount), 0) as total
        FROM cost_entries ce
        INNER JOIN users u ON ce.user_id = u.id
        WHERE ${whereClause}
        GROUP BY ce.user_id, ce.month, ce.category, ce.sub_category
        ORDER BY u.name, ce.month DESC
      `).all(...params);

      // 按用户聚合
      const users = {};
      rows.forEach(r => {
        if (!users[r.user_id]) users[r.user_id] = { user_id: r.user_id, user_name: r.user_name, months: {} };
        if (!users[r.user_id].months[r.month]) {
          users[r.user_id].months[r.month] = { taxi: 0, meal: 0, flight: 0, train: 0, hotel: 0, entertainment: 0, other: 0, total: 0 };
        }
        const m = users[r.user_id].months[r.month];
        if (r.sub_category) m[r.sub_category] = parseFloat((m[r.sub_category] + r.total).toFixed(2));
        else if (r.category === 'entertainment') m.entertainment = parseFloat((m.entertainment + r.total).toFixed(2));
        else if (r.category === 'other') m.other = parseFloat((m.other + r.total).toFixed(2));
        m.total = parseFloat((m.total + r.total).toFixed(2));
      });

      Object.values(users).forEach(u => {
        Object.values(u.months).forEach(m => {
          m.travel = parseFloat((m.taxi + m.meal + m.flight + m.train + m.hotel).toFixed(2));
        });
      });

      res.json({ data: Object.values(users), is_admin: true });
    } else {
      // 非admin：按月份聚合（原有逻辑）
      const rows = db.prepare(`
        SELECT month, category, sub_category,
          COALESCE(SUM(amount), 0) as total
        FROM cost_entries WHERE ${whereClause}
        GROUP BY month, category, sub_category
        ORDER BY month DESC
      `).all(...params);

      const months = {};
      rows.forEach(r => {
        if (!months[r.month]) {
          months[r.month] = { taxi: 0, meal: 0, flight: 0, train: 0, hotel: 0, entertainment: 0, other: 0, total: 0 };
        }
        if (r.sub_category) months[r.month][r.sub_category] = parseFloat((months[r.month][r.sub_category] + r.total).toFixed(2));
        else if (r.category === 'entertainment') months[r.month].entertainment = parseFloat((months[r.month].entertainment + r.total).toFixed(2));
        else if (r.category === 'other') months[r.month].other = parseFloat((months[r.month].other + r.total).toFixed(2));
        months[r.month].total = parseFloat((months[r.month].total + r.total).toFixed(2));
      });
      Object.values(months).forEach(m => {
        m.travel = parseFloat((m.taxi + m.meal + m.flight + m.train + m.hotel).toFixed(2));
      });
      const sorted = Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, data]) => ({ month, ...data }));
      res.json({ data: sorted, is_admin: false });
    }
  } catch (error) {
    console.error('月度汇总错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 年度汇总 ====================
router.get('/yearly-summary', authMiddleware, (req, res) => {
  try {
    const { year } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    let whereClause = `1=1 ${getUserCondition(userRole, userId)}`;
    const params = [];
    if (year) { whereClause += " AND month LIKE ?"; params.push(year + '%'); }

    const rows = db.prepare(`
      SELECT month,
        COALESCE(SUM(CASE WHEN category = 'travel' THEN amount ELSE 0 END), 0) as travel,
        COALESCE(SUM(CASE WHEN category = 'entertainment' THEN amount ELSE 0 END), 0) as entertainment,
        COALESCE(SUM(CASE WHEN category = 'other' THEN amount ELSE 0 END), 0) as other,
        COALESCE(SUM(amount), 0) as total
      FROM cost_entries WHERE ${whereClause}
      GROUP BY month ORDER BY month
    `).all(...params);

    const months = rows.map(r => ({
      month: r.month,
      travel: parseFloat(r.travel.toFixed(2)),
      entertainment: parseFloat(r.entertainment.toFixed(2)),
      other: parseFloat(r.other.toFixed(2)),
      total: parseFloat(r.total.toFixed(2))
    }));

    const yearTotal = parseFloat(months.reduce((s, m) => s + m.total, 0).toFixed(2));

    res.json({ data: months, year_total: yearTotal });
  } catch (error) {
    console.error('年度汇总错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 创建费用 ====================
router.post('/', authMiddleware, (req, res) => {
  try {
    const { month, category, sub_category, amount, description } = req.body;
    const userId = req.user.id;

    if (!month || !category || amount === undefined || amount === null) {
      return res.status(400).json({ error: '月份、分类和金额为必填项' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: '金额必须大于 0' });
    }
    if (!CATEGORIES[category]) {
      return res.status(400).json({ error: '无效的类别' });
    }
    if (category === 'travel') {
      if (!sub_category || !TRAVEL_SUBS.includes(sub_category)) {
        return res.status(400).json({ error: '差旅成本需要选择子类：打车/餐费/机票/火车/酒店' });
      }
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO cost_entries (id, user_id, month, category, sub_category, amount, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, month, category, category === 'travel' ? sub_category : null, amt, description || null);

    res.status(201).json({ message: '费用记录创建成功', id });
  } catch (error) {
    console.error('创建费用错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 更新费用 ====================
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const entry = db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: '记录不存在' });
    if (!['admin', 'super_admin'].includes(userRole) && entry.user_id !== userId) {
      return res.status(403).json({ error: '无权限修改' });
    }

    const { month, category, sub_category, amount, description } = req.body;
    const fields = [];
    const values = [];

    if (month !== undefined) { fields.push('month = ?'); values.push(month); }
    if (category !== undefined) {
      if (!CATEGORIES[category]) return res.status(400).json({ error: '无效的类别' });
      fields.push('category = ?'); values.push(category);
    }
    if (sub_category !== undefined) {
      fields.push('sub_category = ?');
      values.push((category || entry.category) === 'travel' ? sub_category : null);
    }
    if (amount !== undefined) {
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: '金额必须大于 0' });
      fields.push('amount = ?'); values.push(amt);
    }
    if (description !== undefined) { fields.push('description = ?'); values.push(description || null); }

    if (fields.length === 0) return res.json({ message: '无更新内容' });

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    db.prepare(`UPDATE cost_entries SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    res.json({ message: '费用记录更新成功' });
  } catch (error) {
    console.error('更新费用错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 删除费用 ====================
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const entry = db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: '记录不存在' });
    if (!['admin', 'super_admin'].includes(userRole) && entry.user_id !== userId) {
      return res.status(403).json({ error: '无权限删除' });
    }

    db.prepare('DELETE FROM cost_entries WHERE id = ?').run(id);
    res.json({ message: '删除成功' });
  } catch (error) {
    console.error('删除费用错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
