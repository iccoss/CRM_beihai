const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isTechnicalRole } = require('../middleware/role-policy');

const router = express.Router();

router.use(authMiddleware, (req, res, next) => {
  if (['operations', 'presales', 'fde', 'fde_admin'].includes(req.user.role) && req.method !== 'GET') {
    return res.status(403).json({ error: '当前角色只能查看合同技术信息，不能修改商务数据' });
  }
  next();
});

function canManageContract(user, contract) {
  if (['admin', 'super_admin'].includes(user.role)) return true;
  if (user.role !== 'sales') return false;
  if (contract.opportunity_id) {
    return Boolean(db.prepare('SELECT 1 FROM opportunities WHERE id = ? AND owner_id = ?').get(contract.opportunity_id, user.id));
  }
  return Boolean(db.prepare(`
    SELECT 1 FROM customers c WHERE c.id = ? AND (
      c.owner_id = ? OR c.secondary_owner_id = ? OR
      EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = c.id AND cm.user_id = ?)
    )
  `).get(contract.customer_id, user.id, user.id, user.id));
}

// 上传目录配置
const UPLOAD_DIR = path.join(__dirname, '../../uploads/contracts');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// =====================================================
// 获取合同列表(支持多条件筛选)
// =====================================================
router.get('/', authMiddleware, (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      customer_id,
      customer_name,
      status,
      type,
      opportunity_type,
      start_date,
      end_date
    } = req.query;

    const offset = (page - 1) * limit;
    const userRole = req.user.role;
    const userId = req.user.id;

    // 构建权限控制条件：销售只能看到自己创建的客户关联的合同
    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (o.owner_id = '${userId}' OR cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    } else if (['presales', 'fde', 'fde_admin'].includes(userRole)) {
      const assignmentType = userRole === 'presales' ? 'presales' : 'fde';
      ownerCondition = ` AND EXISTS (
        SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = c.opportunity_id AND oa.assignment_type = '${assignmentType}'
          AND oa.status = 'active' ${userRole === 'fde_admin' ? '' : `AND oa.user_id = '${userId}'`}
      )`;
    }

    let whereClause = '1=1' + ownerCondition;
    const params = [];

    if (customer_id) {
      whereClause += ` AND c.customer_id = ?`;
      params.push(customer_id);
    }
    if (customer_name) {
      whereClause += ` AND cu.name LIKE ?`;
      params.push(`%${customer_name}%`);
    }
    if (status) {
      whereClause += ` AND c.status = ?`;
      params.push(status);
    }
    if (type) {
      whereClause += ` AND c.type = ?`;
      params.push(type);
    }
    if (opportunity_type) {
      whereClause += ` AND o.type = ?`;
      params.push(opportunity_type);
    }
    if (start_date) {
      whereClause += ` AND DATE(c.sign_date) >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ` AND DATE(c.sign_date) <= ?`;
      params.push(end_date);
    }

    // 查询总数
    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN opportunities o ON c.opportunity_id = o.id
      WHERE cu.is_deleted = 0 AND ${whereClause}
    `).get(...params);

    // 查询数据
    const contracts = db.prepare(`
      SELECT
        c.*,
        cu.name as customer_name,
        cu.customer_short_name,
        cont.name as contact_name,
        u.name as creator_name,
        o.name as opportunity_name,
        o.type as contract_type,
        COALESCE(
          NULLIF(c.channel_commission_rate, 0),
          (SELECT ch.commission_rate FROM channels ch
           INNER JOIN channel_customers cc ON cc.channel_id = ch.id
           WHERE cc.customer_id = cu.id LIMIT 1), 0
        ) as channel_commission_rate
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN contacts cont ON c.contact_id = cont.id
      LEFT JOIN users u ON c.creator_id = u.id
      LEFT JOIN opportunities o ON c.opportunity_id = o.id
      WHERE cu.is_deleted = 0 AND ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // 解析附件列表
    contracts.forEach(c => {
      if (c.attachments) {
        c.attachment_list = c.attachments.split(',').map(url => ({
          url,
          name: path.basename(url)
        }));
      } else {
        c.attachment_list = [];
      }

      // 添加合同类型中文标签
      if (c.contract_type) {
        const typeMap = {
          'new_project': '新项目',
          'renewal': '续签',
          'maintenance': '维护'
        };
        c.contract_type_label = typeMap[c.contract_type] || c.contract_type;
      } else {
        c.contract_type_label = '未关联商机';
      }

      // 计算渠道佣金
      c.channel_commission = c.channel_commission_rate > 0
        ? parseFloat((c.amount * c.channel_commission_rate / 100).toFixed(2))
        : 0;
      if (isTechnicalRole(req.user.role)) {
        c.amount = null;
        c.unpaid_amount = null;
        c.total_received = null;
        c.channel_commission_rate = null;
        c.channel_commission = null;
        c.commercial_hidden = true;
      }
    });

    res.json({
      data: contracts,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取合同列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取合同详情
// =====================================================
router.get('/:id([0-9a-fA-F-]{36})', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;
    const userId = req.user.id;

    const contract = db.prepare(`
      SELECT
        c.*,
        cu.name as customer_name,
        cu.customer_short_name,
        cu.type as customer_type,
        cu.industry as customer_industry,
        cu.region as customer_region,
        cont.name as contact_name,
        cont.position as contact_position,
        cont.phone as contact_phone,
        cont.email as contact_email,
        u.name as creator_name
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      LEFT JOIN contacts cont ON c.contact_id = cont.id
      LEFT JOIN users u ON c.creator_id = u.id
      WHERE c.id = ? AND cu.is_deleted = 0
    `).get(id);

    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }

    // 权限检查(含共享客户)
    if (userRole === 'sales') {
      const customer = db.prepare('SELECT owner_id, secondary_owner_id FROM customers WHERE id = ?').get(contract.customer_id);
      if (!customer || (!customer.owner_id && !customer.secondary_owner_id) ||
          (customer.owner_id !== userId && customer.secondary_owner_id !== userId)) {
        return res.status(403).json({ error: '无权限查看该合同' });
      }
    } else if (['presales', 'fde', 'fde_admin'].includes(userRole)) {
      const assignmentType = userRole === 'presales' ? 'presales' : 'fde';
      const assignment = db.prepare(`
        SELECT id FROM opportunity_assignments
        WHERE opportunity_id = (SELECT opportunity_id FROM contracts WHERE id = ?)
          AND assignment_type = ? AND status = 'active' ${userRole === 'fde_admin' ? '' : 'AND user_id = ?'}
      `).get(...(userRole === 'fde_admin' ? [id, assignmentType] : [id, assignmentType, userId]));
      if (!assignment) return res.status(403).json({ error: '无权限查看该合同' });
    }

    // 解析附件列表
    if (contract.attachments) {
      contract.attachment_list = contract.attachments.split(',').map(url => ({
        url,
        name: path.basename(url)
      }));
    } else {
      contract.attachment_list = [];
    }

    // 获取付款计划
    const paymentPlans = db.prepare(`
      SELECT id, payment_no, payment_amount, payment_date, payment_status, actual_payment_date, actual_amount, payment_remark
      FROM contract_payment_plans
      WHERE contract_id = ?
      ORDER BY payment_no ASC
    `).all(id);
    contract.payment_plans = paymentPlans;

    // 获取关联的回款记录
    const payments = db.prepare(`
      SELECT id, payment_no, type, amount, actual_date, status, method
      FROM payments
      WHERE contract_id = ?
      ORDER BY actual_date DESC
    `).all(id);
    contract.payments = payments;

    // 回款统计（以实际回款为准）
    contract.total_received = contract.total_received || 0;
    contract.unpaid_amount = Math.max(0, contract.amount - contract.total_received);
    contract.payment_progress = contract.amount > 0 ? ((contract.total_received / contract.amount) * 100).toFixed(2) : 0;

    if (isTechnicalRole(userRole)) {
      contract.amount = null;
      contract.unpaid_amount = null;
      contract.total_received = null;
      contract.payment_progress = null;
      contract.channel_commission_rate = null;
      contract.commercial_hidden = true;
      contract.payment_plans = contract.payment_plans.map(plan => ({
        ...plan,
        payment_amount: null,
        actual_amount: null
      }));
      contract.payments = contract.payments.map(payment => ({ ...payment, amount: null }));
    }

    // 获取变更日志
    let changeLogs = db.prepare(`
      SELECT * FROM contract_change_logs
      WHERE contract_id = ?
      ORDER BY changed_at DESC
    `).all(id);
    if (isTechnicalRole(userRole)) {
      changeLogs = changeLogs.filter(log => !['合同金额', '分成比例', 'channel_commission_rate', 'amount'].includes(log.field_name));
    }

    res.json({ contract, changeLogs });
  } catch (error) {
    console.error('获取合同详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 创建合同
// =====================================================
router.post('/', authMiddleware, (req, res) => {
  try {
    if (!['sales', 'admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '只有销售或系统管理员可以创建合同' });
    }
    const {
      customer_id,
      contact_id,
      opportunity_id,
      title,
      type,
      amount,
      sign_date,
      effective_date,
      expire_date,
      payment_method,
      payment_times,
      payment_plans,
      content,
      payment_terms,
      attachments,
      channel_commission_rate
    } = req.body;

    const userRole = req.user.role;
    const userId = req.user.id;

    // 必填字段验证
    const contractAmount = Number(amount);
    if (!customer_id || !title || !Number.isFinite(contractAmount) || contractAmount <= 0) {
      return res.status(400).json({ error: '必填字段不能为空' });
    }
    if (!sign_date) {
      return res.status(400).json({ error: '签订日期不能为空' });
    }
    if (!effective_date) {
      return res.status(400).json({ error: '生效日期不能为空' });
    }
    if (!expire_date) {
      return res.status(400).json({ error: '到期日期不能为空' });
    }
    if (!opportunity_id) {
      return res.status(400).json({ error: '合同必须关联商机，请先创建商机后再创建合同' });
    }

    const opportunity = db.prepare('SELECT id, customer_id, owner_id, status FROM opportunities WHERE id = ?').get(opportunity_id);
    if (!opportunity || opportunity.customer_id !== customer_id) {
      return res.status(400).json({ error: '关联商机不存在或不属于该客户' });
    }
    if (userRole === 'sales' && opportunity.owner_id !== userId) {
      return res.status(403).json({ error: '只能为自己负责的商机创建合同' });
    }
    if (contact_id && !db.prepare('SELECT 1 FROM contacts WHERE id = ? AND customer_id = ?').get(contact_id, customer_id)) {
      return res.status(400).json({ error: '合同联系人不属于所选客户' });
    }

    if (payment_plans && Array.isArray(payment_plans) && payment_plans.length > 0) {
      const planTotal = payment_plans.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      if (Math.abs(planTotal - contractAmount) > 0.01) {
        return res.status(400).json({
          error: `付款计划总额(${planTotal})与合同金额(${amount})不一致，差额${(planTotal - Number(amount)).toFixed(2)}元`
        });
      }
      if (payment_plans.some(plan => !plan.date || Number(plan.amount) <= 0)) {
        return res.status(400).json({ error: '每期付款计划必须填写日期和大于 0 的金额' });
      }
    }

    // 权限检查:验证客户归属(含共享客户)
    const customer = db.prepare('SELECT owner_id, secondary_owner_id FROM customers WHERE id = ? AND is_deleted = 0').get(customer_id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    if (userRole === 'sales') {
      if (!customer.owner_id || (customer.owner_id !== userId && customer.secondary_owner_id !== userId)) {
        return res.status(403).json({ error: '无权限为该客户创建合同,该客户不属于您或未共享给您' });
      }
    }

    const id = uuidv4();
    const contractNo = `CNT${Date.now()}`;

    console.log('创建合同参数:', {
      id, contractNo, title, customer_id, contact_id, type, amount,
      sign_date, effective_date, expire_date, payment_method, payment_times,
      content, payment_terms, attachments
    });

    try {
      db.transaction(() => {
      db.prepare(`
        INSERT INTO contracts (
          id, contract_no, title, customer_id, contact_id, opportunity_id, type, amount,
          sign_date, effective_date, expire_date, payment_method, payment_times,
          content, payment_terms, unpaid_amount, attachments, status, creator_id, channel_commission_rate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, contractNo, title, customer_id, contact_id || null, opportunity_id || null, type || '销售合同', contractAmount,
        sign_date || null, effective_date || null, expire_date || null,
        payment_method || null, payment_times || 1,
        content || null, payment_terms || null,
        contractAmount, attachments ? (Array.isArray(attachments) ? attachments.join(',') : attachments) : null,
        'active', req.user.id, channel_commission_rate || null
      );

      // 如果关联了商机,更新商机状态为已签,金额为合同金额,预计签约时间为签订日期
      if (opportunity_id) {
        db.prepare(`
          UPDATE opportunities
          SET status = 'signed',
              amount = ?,
              expected_sign_date = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(contractAmount, sign_date, opportunity_id);

        // 补记状态变更日志：开周会的「历史状态快照」依赖 opportunity_change_logs 还原各季度末的状态，
        // 缺少签约日志会导致已签商机在历史季度快照里仍停留在签约前的状态。
        // 已经是 signed 的商机不重复写日志，避免产生无意义的 signed → signed 记录。
        if (opportunity.status !== 'signed') {
          db.prepare(`
            INSERT INTO opportunity_change_logs (opportunity_id, from_status, to_status, changed_by)
            VALUES (?, ?, ?, ?)
          `).run(opportunity_id, opportunity.status || null, 'signed', userId);
        }
      }
      })();

      // 付款计划已在写入合同前完成校验，避免失败时留下半条合同数据。
      if (payment_plans && Array.isArray(payment_plans) && payment_plans.length > 0) {
        for (let i = 0; i < payment_plans.length; i++) {
          const plan = payment_plans[i];
          const planId = uuidv4();
          db.prepare(`
            INSERT INTO contract_payment_plans (
              id, contract_id, payment_no, payment_amount, payment_date, payment_status
            ) VALUES (?, ?, ?, ?, ?, 'unpaid')
          `).run(
            planId,
            id,
            i + 1,
            plan.amount || 0,
            plan.date || null
          );
        }
      }

      res.status(201).json({
        message: '合同创建成功',
        id,
        contractNo
      });
    } catch (error) {
      console.error('数据库插入错误:', error);
      console.error('错误信息:', error.message);
      throw error;
    }
  } catch (error) {
    console.error('创建合同错误:', error);
    res.status(500).json({ error: '服务器错误:' + error.message });
  }
});

// =====================================================
// 更新合同
// =====================================================
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      type,
      amount,
      content,
      status,
      sign_date,
      effective_date,
      expire_date,
      payment_method,
      payment_times,
      payment_terms,
      attachments,
      opportunity_id,
      channel_commission_rate
    } = req.body;

    // 检查合同是否存在并获取旧值
    const oldContract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!oldContract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (!canManageContract(req.user, oldContract)) {
      return res.status(403).json({ error: '无权限修改该合同' });
    }

    if (amount !== undefined) {
      const nextAmount = Number(amount);
      if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
        return res.status(400).json({ error: '合同金额必须大于0' });
      }
      if (nextAmount + 0.01 < Number(oldContract.total_received || 0)) {
        return res.status(400).json({ error: '合同金额不能小于已回款金额' });
      }
      const planTotal = Number(db.prepare(`
        SELECT COALESCE(SUM(payment_amount), 0) AS total FROM contract_payment_plans WHERE contract_id = ?
      `).get(id).total || 0);
      if (planTotal > 0 && Math.abs(planTotal - nextAmount) > 0.01) {
        return res.status(400).json({ error: '请先调整付款计划，付款计划总额必须与新合同金额一致' });
      }
    }

    if (opportunity_id !== undefined && opportunity_id !== null) {
      const opportunity = db.prepare('SELECT customer_id, owner_id FROM opportunities WHERE id = ?').get(opportunity_id);
      if (!opportunity || opportunity.customer_id !== oldContract.customer_id) {
        return res.status(400).json({ error: '关联商机不存在或不属于合同客户' });
      }
      if (req.user.role === 'sales' && opportunity.owner_id !== req.user.id) {
        return res.status(403).json({ error: '只能关联自己负责的商机' });
      }
    }

    // 字段中文映射
    const fieldLabels = {
      title: '合同名称',
      type: '合同类型',
      amount: '合同金额',
      content: '合同内容',
      status: '合同状态',
      sign_date: '签订日期',
      effective_date: '生效日期',
      expire_date: '到期日期',
      payment_method: '付款方式',
      payment_times: '付款次数',
      payment_terms: '付款条款',
      attachments: '附件',
      opportunity_id: '关联商机'
    };

    const fieldMap = { title, type, amount: amount === undefined ? undefined : Number(amount), content, status, sign_date, effective_date, expire_date, payment_method, payment_times, payment_terms, attachments, opportunity_id, channel_commission_rate };

    // 记录变更日志
    const changeLogInsert = db.prepare('INSERT INTO contract_change_logs (id, contract_id, changed_by, changed_by_name, changed_at, field_name, old_value) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)');

    const updateFields = [];
    const updateValues = [];

    db.transaction(() => {
    for (const [field, value] of Object.entries(fieldMap)) {
      if (value !== undefined) {
        const oldValue = oldContract[field];
        const oldStr = oldValue === null || oldValue === undefined ? '' : String(oldValue);
        const newStr = value === null || value === undefined ? '' : String(value);

        if (oldStr !== newStr) {
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
        updateValues.push(value);
      }
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.prepare(`UPDATE contracts SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);
    if (amount !== undefined) {
      db.prepare(`UPDATE contracts SET unpaid_amount = MAX(0, amount - COALESCE(total_received, 0)) WHERE id = ?`).run(id);
    }
    })();

    res.json({ message: '合同更新成功' });
  } catch (error) {
    console.error('更新合同错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 删除合同
// =====================================================
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    // 检查合同是否存在
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (!canManageContract(req.user, contract)) {
      return res.status(403).json({ error: '无权限删除该合同' });
    }

    // 检查是否有关联的回款记录
    const paymentCount = db.prepare('SELECT COUNT(*) as count FROM payments WHERE contract_id = ?').get(id).count;
    if (paymentCount > 0) {
      return res.status(400).json({ error: '该合同有关联回款记录,无法删除' });
    }

    // 删除附件文件
    if (contract.attachments) {
      const attachmentList = contract.attachments.split(',');
      for (const filePath of attachmentList) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.error('删除附件失败:', e);
        }
      }
    }

    db.prepare('DELETE FROM contracts WHERE id = ?').run(id);

    res.json({ message: '合同删除成功' });
  } catch (error) {
    console.error('删除合同错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 合同审核(状态变更)
// =====================================================
router.post('/:id/approve', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { status, audit_remark } = req.body;

    // 检查合同是否存在
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '只有系统管理员可以审核合同' });
    }

    // 更新合同状态(使用现有字段)
    db.prepare(`
      UPDATE contracts SET
        status = ?,
        reviewer_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status || 'approved', req.user.id, id);

    res.json({ message: '合同审核成功' });
  } catch (error) {
    console.error('合同审核错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 上传合同附件
// =====================================================
router.post('/:id/attachments', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { file_urls } = req.body;

    if (!file_urls || !Array.isArray(file_urls) || file_urls.length === 0) {
      return res.status(400).json({ error: '请上传附件' });
    }

    // 检查合同是否存在
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (!canManageContract(req.user, contract)) {
      return res.status(403).json({ error: '无权限修改合同附件' });
    }

    // 检查附件数量限制(最多 10 个)
    const existingAttachments = contract.attachments ? contract.attachments.split(',') : [];
    if (existingAttachments.length + file_urls.length > 10) {
      return res.status(400).json({ error: '最多只能上传 10 个附件' });
    }

    // 合并附件列表
    const newAttachments = [...existingAttachments, ...file_urls];

    db.prepare('UPDATE contracts SET attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newAttachments.join(','), id);

    res.json({
      message: '附件上传成功',
      count: file_urls.length
    });
  } catch (error) {
    console.error('上传附件错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 删除合同附件
// =====================================================
router.delete('/:id/attachments/:fileIndex', authMiddleware, (req, res) => {
  try {
    const { id, fileIndex } = req.params;
    const index = parseInt(fileIndex);

    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (!canManageContract(req.user, contract)) {
      return res.status(403).json({ error: '无权限修改合同附件' });
    }

    if (!contract.attachments) {
      return res.status(400).json({ error: '没有附件' });
    }

    const attachmentList = contract.attachments.split(',');
    if (index < 0 || index >= attachmentList.length) {
      return res.status(400).json({ error: '附件索引错误' });
    }

    // 删除文件
    const filePath = attachmentList[index];
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.error('删除文件失败:', e);
    }

    // 更新数据库
    attachmentList.splice(index, 1);
    db.prepare('UPDATE contracts SET attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(attachmentList.join(','), id);

    res.json({ message: '附件删除成功' });
  } catch (error) {
    console.error('删除附件错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 获取即将到期合同(未来 30 天)
// =====================================================
router.get('/expiring/upcoming', authMiddleware, (req, res) => {
  try {
    if (isTechnicalRole(req.user.role)) return res.status(403).json({ error: '技术角色不可查看合同金额提醒' });
    const { days = 30 } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (
        SELECT 1 FROM opportunities o WHERE o.id = c.opportunity_id AND o.owner_id = '${userId}'
      ))`;
    }

    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));

    const contracts = db.prepare(`
      SELECT
        c.id,
        c.contract_no,
        c.title,
        c.amount,
        c.expire_date,
        cu.name as customer_name,
        cu.owner_id as customer_owner_id,
        julianday(c.expire_date) - julianday('now') as days_until_expire
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.expire_date IS NOT NULL
        AND c.expire_date != ''
        AND cu.is_deleted = 0
        AND date(c.expire_date) BETWEEN date('now') AND date('now', '+${days} days')
        ${ownerCondition}
      ORDER BY c.expire_date ASC
    `).all();

    res.json({
      data: contracts,
      total: contracts.length
    });
  } catch (error) {
    console.error('获取到期合同错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 合同统计
// =====================================================
router.get('/stats/overview', authMiddleware, (req, res) => {
  try {
    if (isTechnicalRole(req.user.role)) return res.status(403).json({ error: '技术角色不可查看合同金额统计' });
    const { start_date, end_date } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR EXISTS (
        SELECT 1 FROM opportunities o WHERE o.id = c.opportunity_id AND o.owner_id = '${userId}'
      ))`;
    }

    let whereClause = `cu.is_deleted = 0 ${ownerCondition}`;
    const params = [];

    if (start_date) {
      whereClause += ` AND DATE(c.sign_date) >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ` AND DATE(c.sign_date) <= ?`;
      params.push(end_date);
    }

    // 合同总数
    const { total_count } = db.prepare(`
      SELECT COUNT(*) as total_count FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE ${whereClause}
    `).get(...params);

    // 各状态合同统计
    const by_status = db.prepare(`
      SELECT c.status, COUNT(*) as count, SUM(c.amount) as total_amount
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE ${whereClause}
      GROUP BY c.status
    `).all(...params);

    // 合同类型统计
    const by_type = db.prepare(`
      SELECT c.type, COUNT(*) as count
      FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE ${whereClause}
      GROUP BY c.type
    `).all(...params);

    // 合同总金额
    const { total_amount } = db.prepare(`
      SELECT SUM(c.amount) as total_amount FROM contracts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE ${whereClause}
    `).get(...params);

    // 已回款金额
    const { received_amount } = db.prepare(`
      SELECT SUM(p.amount) as received_amount
      FROM payments p
      INNER JOIN contracts c ON p.contract_id = c.id
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE p.status = '已回款' AND ${whereClause}
    `).get(...params);

    res.json({
      total_count: total_count || 0,
      total_amount: total_amount || 0,
      received_amount: received_amount || 0,
      unpaid_amount: (total_amount || 0) - (received_amount || 0),
      by_status,
      by_type
    });
  } catch (error) {
    console.error('获取合同统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// =====================================================
// 更新付款计划
// =====================================================
router.put('/:id/payment-plans', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { payment_plans } = req.body;

    if (!payment_plans || !Array.isArray(payment_plans)) {
      return res.status(400).json({ error: '付款计划数据格式错误' });
    }

    // 获取合同金额用于校验
    const contract = db.prepare('SELECT id, amount, customer_id, opportunity_id FROM contracts WHERE id = ?').get(id);
    if (!contract) {
      return res.status(404).json({ error: '合同不存在' });
    }
    if (!canManageContract(req.user, contract)) {
      return res.status(403).json({ error: '无权限修改付款计划' });
    }

    // 校验付款计划总额 = 合同金额
    const planTotal = payment_plans.reduce((sum, p) => sum + (p.amount || 0), 0);
    const diff = Math.abs(planTotal - contract.amount);
    if (diff > 0.01) {
      return res.status(400).json({
        error: `付款计划总额(${planTotal})与合同金额(${contract.amount})不一致，差额${(planTotal - contract.amount).toFixed(2)}元`
      });
    }

    // 使用事务：先删后插
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM contract_payment_plans WHERE contract_id = ?').run(id);

      for (let i = 0; i < payment_plans.length; i++) {
        const plan = payment_plans[i];
        const planId = uuidv4();
        db.prepare(`
          INSERT INTO contract_payment_plans (
            id, contract_id, payment_no, payment_amount, payment_date, payment_status
          ) VALUES (?, ?, ?, ?, ?, 'unpaid')
        `).run(
          planId,
          id,
          i + 1,
          plan.amount || 0,
          plan.date || null
        );
      }

      // 同步更新 payment_times
      db.prepare('UPDATE contracts SET payment_times = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(payment_plans.length, id);
    });

    tx();

    res.json({ message: '付款计划更新成功' });
  } catch (error) {
    console.error('更新付款计划错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
