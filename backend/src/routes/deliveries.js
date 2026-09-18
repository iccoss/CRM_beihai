const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const validStages = ['technical_handover', 'implementation', 'acceptance', 'training', 'completed'];
const validStatuses = ['pending', 'in_progress', 'blocked', 'completed'];

function canManageAll(role) {
  return ['admin', 'super_admin'].includes(role);
}

router.use(authMiddleware, (req, res, next) => {
  if (req.user.role === 'operations' && req.method !== 'GET') {
    return res.status(403).json({ error: '运营角色只能查看交付记录' });
  }
  next();
});

router.get('/', authMiddleware, (req, res) => {
  try {
    const { contract_id, customer_id, owner_id, status } = req.query;
    const conditions = ['c.is_deleted = 0'];
    const params = [];

    if (req.user.role === 'fde_admin') {
      conditions.push("EXISTS (SELECT 1 FROM opportunity_assignments oa WHERE oa.opportunity_id = d.opportunity_id AND oa.assignment_type = 'fde' AND oa.status = 'active')");
    } else if (!canManageAll(req.user.role) && req.user.role !== 'presales') {
      conditions.push(`(
        d.owner_id = ? OR o.owner_id = ? OR c.owner_id = ? OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = c.id AND cm.user_id = ?) OR
        EXISTS (SELECT 1 FROM opportunity_assignments oa WHERE oa.opportunity_id = d.opportunity_id AND oa.user_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active')
      )`);
      params.push(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
    } else if (req.user.role === 'presales') {
      conditions.push('d.owner_id = ?');
      params.push(req.user.id);
    }
    if (contract_id) { conditions.push('d.contract_id = ?'); params.push(contract_id); }
    if (customer_id) { conditions.push('d.customer_id = ?'); params.push(customer_id); }
    if (owner_id) { conditions.push('d.owner_id = ?'); params.push(owner_id); }
    if (status) { conditions.push('d.status = ?'); params.push(status); }

    const data = db.prepare(`
      SELECT d.*, ct.contract_no, ct.title AS contract_title,
        c.name AS customer_name, o.name AS opportunity_name,
        u.name AS owner_name, creator.name AS creator_name
      FROM delivery_records d
      INNER JOIN contracts ct ON ct.id = d.contract_id
      INNER JOIN customers c ON c.id = d.customer_id
      LEFT JOIN opportunities o ON o.id = d.opportunity_id
      LEFT JOIN users u ON u.id = d.owner_id
      LEFT JOIN users creator ON creator.id = d.created_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE d.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        COALESCE(d.planned_at, d.created_at) ASC
    `).all(...params);

    res.json({ data, total: data.length });
  } catch (error) {
    console.error('获取交付记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/', authMiddleware, (req, res) => {
  try {
    const { contract_id, owner_id, stage, status, content, planned_at, completed_at, next_action } = req.body;
    if (!contract_id || !owner_id || !content) {
      return res.status(400).json({ error: '合同、售前负责人和交付内容不能为空' });
    }
    if (stage && !validStages.includes(stage)) return res.status(400).json({ error: '交付阶段无效' });
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: '交付状态无效' });

    const contract = db.prepare(`
      SELECT ct.id, ct.customer_id, ct.opportunity_id, o.owner_id AS sales_owner_id
      FROM contracts ct LEFT JOIN opportunities o ON o.id = ct.opportunity_id
      WHERE ct.id = ?
    `).get(contract_id);
    if (!contract) return res.status(404).json({ error: '合同不存在' });

    const owner = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'presales' AND status = 'active'").get(owner_id);
    if (!owner) return res.status(400).json({ error: '交付负责人必须是启用的售前用户' });

    if (!canManageAll(req.user.role) && !['presales', 'sales'].includes(req.user.role)) {
      return res.status(403).json({ error: '无权限创建交付记录' });
    }
    if (req.user.role === 'sales' && contract.sales_owner_id !== req.user.id) {
      return res.status(403).json({ error: '只能为自己负责的商机创建交付记录' });
    }
    if (req.user.role === 'presales' && owner_id !== req.user.id) {
      return res.status(403).json({ error: '售前只能填写自己的交付记录' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO delivery_records (
        id, contract_id, customer_id, opportunity_id, owner_id, stage, status,
        content, planned_at, completed_at, next_action, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, contract.id, contract.customer_id, contract.opportunity_id || null, owner_id,
      stage || 'technical_handover', status || 'pending', content,
      planned_at || null, completed_at || null, next_action || null, req.user.id);

    res.status(201).json({ message: '交付记录创建成功', id });
  } catch (error) {
    console.error('创建交付记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.put('/:id', authMiddleware, (req, res) => {
  try {
    const record = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ error: '交付记录不存在' });
    if (!canManageAll(req.user.role) && record.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限修改该交付记录' });
    }

    const { stage, status, content, planned_at, completed_at, next_action, owner_id } = req.body;
    if (stage && !validStages.includes(stage)) return res.status(400).json({ error: '交付阶段无效' });
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: '交付状态无效' });
    const fields = [];
    const values = [];
    for (const [field, value] of Object.entries({ stage, status, content, planned_at, completed_at, next_action, owner_id })) {
      if (value !== undefined) { fields.push(`${field} = ?`); values.push(value || null); }
    }
    if (status === 'completed' && completed_at === undefined) fields.push('completed_at = CURRENT_TIMESTAMP');
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.prepare(`UPDATE delivery_records SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json({ message: '交付记录更新成功' });
  } catch (error) {
    console.error('更新交付记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
