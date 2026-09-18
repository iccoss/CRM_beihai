const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isTechnicalRole, presalesCanAccessOpportunity, userCanAccessOpportunity, opportunityHasActiveAssignment } = require('../middleware/role-policy');

const router = express.Router();

router.use(authMiddleware, (req, res, next) => {
  if (['operations', 'fde_admin'].includes(req.user.role) && req.method !== 'GET') {
    return res.status(403).json({ error: '当前角色只能查看跟进记录' });
  }
  next();
});

// 上传目录配置
const UPLOAD_DIR = path.join(__dirname, '../../uploads/followups');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// =====================================================
// 注意：路由顺序很重要！具体路径必须放在参数路径之前
// =====================================================

// 获取跟进提醒（必须在 /:id 之前）
router.get('/reminders', authMiddleware, (req, res) => {
  try {
    const { limit = 10, status } = req.query;
    
    let whereClause = 'r.user_id = ?';
    const params = [req.user.id];

    if (status) {
      whereClause += ` AND r.status = ?`;
      params.push(status);
    }

    const reminders = db.prepare(`
      SELECT 
        r.*, 
        c.name as customer_name,
        c.customer_short_name
      FROM followup_reminders r
      LEFT JOIN customers c ON r.customer_id = c.id
      WHERE ${whereClause}
      ORDER BY r.reminder_at ASC
      LIMIT ?
    `).all(...params, parseInt(limit));

    res.json({ 
      data: reminders,
      total: reminders.length
    });
  } catch (error) {
    console.error('获取跟进提醒错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 标记提醒为已处理（必须在 /:id 之前）
router.put('/reminders/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { status, processed_content } = req.body;

    const reminder = db.prepare('SELECT * FROM followup_reminders WHERE id = ?').get(id);
    if (!reminder) {
      return res.status(404).json({ error: '提醒不存在' });
    }

    if (reminder.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权限操作该提醒' });
    }

    const updateFields = [];
    const updateValues = [];

    if (status) {
      updateFields.push('status = ?');
      updateValues.push(status);
    }
    if (processed_content) {
      updateFields.push('processed_content = ?');
      updateValues.push(processed_content);
    }
    if (status === 'processed') {
      updateFields.push('processed_at = CURRENT_TIMESTAMP');
    }

    updateValues.push(id);

    db.prepare(`UPDATE followup_reminders SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    res.json({ message: '提醒更新成功' });
  } catch (error) {
    console.error('更新提醒错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 根据商机ID获取跟进记录（必须在 /:id 之前）
router.get('/by-opportunity/:opportunityId', authMiddleware, (req, res) => {
  try {
    const { opportunityId } = req.params;
    const opportunity = db.prepare('SELECT owner_id FROM opportunities WHERE id = ?').get(opportunityId);
    if (!opportunity) return res.status(404).json({ error: '商机不存在' });
    if (req.user.role === 'sales' && opportunity.owner_id !== req.user.id) {
      return res.status(403).json({ error: '无权限查看该商机的跟进记录' });
    }
    // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
    if (req.user.role === 'presales' && !presalesCanAccessOpportunity(req.user.id, opportunityId)) {
      return res.status(403).json({ error: '该商机未指派给您' });
    }
    if (req.user.role === 'fde' && !userCanAccessOpportunity(req.user.id, opportunityId, 'fde')) {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      return res.status(403).json({ error: '该商机未指派给您' });
    }
    if (req.user.role === 'fde_admin' && !opportunityHasActiveAssignment(opportunityId, 'fde')) {
      // FDE管理员可见范围：存在商机级或客户级FDE指派的商机
      return res.status(403).json({ error: '该商机尚未进入FDE跟进范围' });
    }
    
    const followups = db.prepare(`
      SELECT 
        f.*,
        c.name as customer_name,
        c.customer_short_name,
        cont.name as contact_name,
        u.name as user_name,
        u.role as user_role
      FROM followups f
      LEFT JOIN customers c ON f.customer_id = c.id
      LEFT JOIN contacts cont ON f.contact_id = cont.id
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.opportunity_id = ?
      ORDER BY COALESCE(f.followup_time, f.created_at) DESC, f.created_at DESC
    `).all(opportunityId);

    res.json({ data: followups, total: followups.length });
  } catch (error) {
    console.error('获取商机跟进记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取跟进统计（必须在 /:id 之前）
router.get('/stats/overview', authMiddleware, (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const userId = req.user.id;
    const userRole = req.user.role;

    let whereClause = '1=1';
    const params = [];

    // 按角色限制统计范围。
    if (userRole === 'sales') {
      whereClause += ` AND user_id = '${userId}'`;
    } else if (userRole === 'presales') {
      // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = followups.opportunity_id AND a.user_id = '${userId}' AND a.assignment_type = 'presales' AND a.status = 'active')
        OR EXISTS (SELECT 1 FROM opportunities o JOIN customer_presales_assignments cpa ON cpa.customer_id = o.customer_id
          WHERE o.id = followups.opportunity_id AND cpa.user_id = '${userId}' AND cpa.status = 'active'))`;
    } else if (userRole === 'fde') {
      whereClause += ` AND EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = followups.opportunity_id AND a.user_id = '${userId}' AND a.assignment_type = 'fde' AND a.status = 'active')`;
    } else if (userRole === 'fde_admin') {
      whereClause += ` AND EXISTS (SELECT 1 FROM opportunity_assignments a WHERE a.opportunity_id = followups.opportunity_id AND a.assignment_type = 'fde' AND a.status = 'active')`;
    }
    if (start_date) {
      whereClause += ` AND DATE(followup_time) >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ` AND DATE(followup_time) <= ?`;
      params.push(end_date);
    }

    // 总跟进次数
    const { total_count } = db.prepare(`
      SELECT COUNT(*) as total_count FROM followups WHERE ${whereClause}
    `).get(...params);

    // 各跟进方式统计
    const by_type = db.prepare(`
      SELECT type, COUNT(*) as count 
      FROM followups 
      WHERE ${whereClause}
      GROUP BY type
    `).all(...params);

    // 各跟进结果统计
    const by_result = db.prepare(`
      SELECT result, COUNT(*) as count 
      FROM followups 
      WHERE ${whereClause}
      GROUP BY result
    `).all(...params);

    // 跟进成功率
    const success_count = db.prepare(`
      SELECT COUNT(*) as count 
      FROM followups 
      WHERE ${whereClause} AND result IN ('完全达成', '达成部分')
    `).get(...params).count || 0;

    const success_rate = total_count > 0 ? ((success_count / total_count) * 100).toFixed(2) : 0;

    res.json({
      total_count,
      success_count,
      success_rate: `${success_rate}%`,
      by_type,
      by_result
    });
  } catch (error) {
    console.error('获取跟进统计错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取跟进列表（支持多条件筛选）- 按客户分组，显示最新跟进
router.get('/', authMiddleware, (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      customer_id,
      customer_name,
      contact_id,
      user_id,
      type,
      stage,
      result,
      start_date,
      end_date,
      has_attachment
    } = req.query;

    const offset = (page - 1) * limit;
    const currentUserId = req.user.id;
    const userRole = req.user.role;

    let whereClause = '1=1';
    const params = [];

    // 商机由负责销售独立跟进；运营和售前可看到自己参与的记录。
    if (userRole === 'sales') {
      whereClause += ` AND o.owner_id = '${currentUserId}'`;
    } else if (userRole === 'presales') {
      // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa WHERE oa.opportunity_id = f.opportunity_id AND oa.user_id = '${currentUserId}' AND oa.assignment_type = 'presales' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM opportunities o JOIN customer_presales_assignments cpa ON cpa.customer_id = o.customer_id
          WHERE o.id = f.opportunity_id AND cpa.user_id = '${currentUserId}' AND cpa.status = 'active'))`;
    } else if (userRole === 'fde') {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa WHERE oa.opportunity_id = f.opportunity_id AND oa.user_id = '${currentUserId}' AND oa.assignment_type = 'fde' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM opportunities o JOIN customer_fde_assignments cfa ON cfa.customer_id = o.customer_id
          WHERE o.id = f.opportunity_id AND cfa.user_id = '${currentUserId}' AND cfa.status = 'active'))`;
    } else if (userRole === 'fde_admin') {
      // FDE管理员可见范围：存在商机级或客户级FDE指派的商机
      whereClause += ` AND (EXISTS (SELECT 1 FROM opportunity_assignments oa WHERE oa.opportunity_id = f.opportunity_id AND oa.assignment_type = 'fde' AND oa.status = 'active')
        OR EXISTS (SELECT 1 FROM opportunities o JOIN customer_fde_assignments cfa ON cfa.customer_id = o.customer_id
          WHERE o.id = f.opportunity_id AND cfa.status = 'active'))`;
    } else if (userRole === 'operations') {
      // 运营只读全量跟进，不在此处新增或编辑。
    }

    // 筛选条件（应用于最新跟进）
    if (customer_id) {
      whereClause += ` AND f.customer_id = ?`;
      params.push(customer_id);
    }
    if (customer_name) {
      whereClause += ` AND c.name LIKE ?`;
      params.push(`%${customer_name}%`);
    }
    if (type) {
      whereClause += ` AND f.type = ?`;
      params.push(type);
    }
    if (stage) {
      const stageList = stage.split(',').filter(Boolean);
      if (stageList.length > 1) {
        const placeholders = stageList.map(() => '?').join(',');
        whereClause += ` AND f.stage IN (${placeholders})`;
        params.push(...stageList);
      } else {
        whereClause += ` AND f.stage = ?`;
        params.push(stageList[0]);
      }
    }
    if (result) {
      whereClause += ` AND f.result = ?`;
      params.push(result);
    }
    if (start_date) {
      whereClause += ` AND DATE(f.followup_time) >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ` AND DATE(f.followup_time) <= ?`;
      params.push(end_date);
    }

    // 查询所有跟进记录（不分页）
    const followups = db.prepare(`
      SELECT 
        f.id,
        f.customer_id,
        f.contact_id,
        f.opportunity_id,
        f.user_id,
        f.followup_time,
        f.type,
        f.content,
        f.stage,
        f.result,
        f.next_followup_at,
        f.next_followup_content,
        f.attachments,
        f.created_at,
        f.updated_at,
        c.name as customer_name,
        c.customer_short_name,
        cont.name as contact_name,
        cont.position as contact_position,
        u.name as user_name,
        o.name as opportunity_name
      FROM followups f
      INNER JOIN customers c ON f.customer_id = c.id
      LEFT JOIN contacts cont ON f.contact_id = cont.id
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN opportunities o ON f.opportunity_id = o.id
      WHERE c.is_deleted = 0
      AND ${whereClause}
      ORDER BY COALESCE(f.followup_time, f.created_at) DESC, f.created_at DESC
    `).all(...params);

    res.json({
      data: followups,
      pagination: { total: followups.length, page: 1, limit: followups.length, pages: 1 }
    });
  } catch (error) {
    console.error('获取跟进列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取跟进详情
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const followup = db.prepare(`
      SELECT 
        f.*,
        c.name as customer_name,
        c.customer_short_name,
        c.type as customer_type,
        c.industry as customer_industry,
        c.region as customer_region,
        c.address as customer_address,
        c.website as customer_website,
        c.company_phone as customer_company_phone,
        c.source as customer_source,
        c.status as customer_status,
        c.level as customer_level,
        c.budget_range as customer_budget_range,
        c.follow_stage as customer_follow_stage,
        cont.name as contact_name,
        cont.position as contact_position,
        cont.phone as contact_phone,
        cont.email as contact_email,
        cont.wechat as contact_wechat,
        cont.is_kp as contact_is_kp,
        u.name as user_name,
        u.username as user_username,
        u.role as user_role,
        u.department_id as user_department_id
      FROM followups f
      INNER JOIN customers c ON f.customer_id = c.id
      LEFT JOIN contacts cont ON f.contact_id = cont.id
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.id = ?
    `).get(req.params.id);

    if (!followup) {
      return res.status(404).json({ error: '跟进记录不存在' });
    }

    // 权限检查：销售只能查看自己客户的跟进记录
    const userRole = req.user.role;
    const userId = req.user.id;
    
    if (userRole === 'sales') {
      const opportunity = db.prepare('SELECT owner_id FROM opportunities WHERE id = ?').get(followup.opportunity_id);
      if (!opportunity || opportunity.owner_id !== userId) {
        return res.status(403).json({ error: '无权限查看该跟进记录，该商机不由您负责' });
      }
    } else if (userRole === 'presales' && !presalesCanAccessOpportunity(userId, followup.opportunity_id)) {
      // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
      return res.status(403).json({ error: '该商机未指派给您' });
    } else if (userRole === 'fde' && !userCanAccessOpportunity(userId, followup.opportunity_id, 'fde')) {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      return res.status(403).json({ error: '该商机未指派给您' });
    } else if (userRole === 'fde_admin' && !opportunityHasActiveAssignment(followup.opportunity_id, 'fde')) {
      // FDE管理员可见范围：存在商机级或客户级FDE指派的商机
      return res.status(403).json({ error: '该商机尚未进入FDE跟进范围' });
    }

    // 解析附件列表
    if (followup.attachments) {
      followup.attachment_list = followup.attachments.split(',').map(url => ({
        url,
        name: path.basename(url)
      }));
    } else {
      followup.attachment_list = [];
    }

    // 格式化日期时间（精确到时分秒）
    followup.followup_time_formatted = followup.followup_time ? new Date(followup.followup_time).toLocaleString('zh-CN', { hour12: false }) : null;
    followup.created_at_formatted = followup.created_at ? new Date(followup.created_at).toLocaleString('zh-CN', { hour12: false }) : null;
    followup.updated_at_formatted = followup.updated_at ? new Date(followup.updated_at).toLocaleString('zh-CN', { hour12: false }) : null;
    followup.next_followup_at_formatted = followup.next_followup_at ? new Date(followup.next_followup_at).toLocaleString('zh-CN', { hour12: false }) : null;

    // 获取客户的所有联系人
    const contacts = db.prepare(`
      SELECT id, name, position, phone, email, wechat, is_kp, is_primary
      FROM contacts
      WHERE customer_id = ?
      ORDER BY is_primary DESC, name ASC
    `).all(followup.customer_id);
    followup.customer_contacts = contacts;

    // 获取该客户同一商机的跟进记录（按时间倒序显示，最新的在前）
    if (followup.opportunity_id) {
      const opportunityFollowups = db.prepare(`
        SELECT f.id, f.followup_time, f.created_at, f.type, f.content, f.stage, f.result, f.user_id,
               u.name as user_name
        FROM followups f
        LEFT JOIN users u ON f.user_id = u.id
        WHERE f.customer_id = ? AND f.opportunity_id = ?
        ORDER BY COALESCE(f.followup_time, f.created_at) DESC, f.created_at DESC
      `).all(followup.customer_id, followup.opportunity_id);
      followup.customer_followups = opportunityFollowups;
    } else {
      const customerFollowups = db.prepare(`
        SELECT f.id, f.followup_time, f.created_at, f.type, f.content, f.stage, f.result, f.user_id,
               u.name as user_name
        FROM followups f
        LEFT JOIN users u ON f.user_id = u.id
        WHERE f.customer_id = ? AND f.opportunity_id IS NULL
        ORDER BY COALESCE(f.followup_time, f.created_at) DESC, f.created_at DESC
      `).all(followup.customer_id);
      followup.customer_followups = customerFollowups;
    }
    
    // 获取跟进人名称并格式化时间
    followup.customer_followups.forEach(f => {
      f.user_name = f.user_name || '未知';
      f.followup_time_formatted = f.created_at ? new Date(f.created_at).toLocaleString('zh-CN', { hour12: false }) : (f.followup_time ? new Date(f.followup_time).toLocaleString('zh-CN', { hour12: false }) : null);
    });

    // 获取跟进提醒
    const reminder = db.prepare(`
      SELECT id, reminder_at, content, status, processed_at
      FROM followup_reminders
      WHERE customer_id = ? AND reminder_type = 'manual'
      ORDER BY reminder_at DESC
      LIMIT 1
    `).get(followup.customer_id);
    followup.next_reminder = reminder;

    // 阶段翻译
    const stageMap = {
      'potential': '潜在',
      'technical': '技术交流',
      'poc': 'POC',
      'project': '立项',
      'bidding': '招投标',
      'contracting': '合同中',
      'signed': '已签'
    };
    followup.stage_label = stageMap[followup.stage] || followup.stage;

    // 结果翻译
    const resultMap = {
      'pending': '未出结果',
      '未达成': '未达成',
      '达成部分': '达成部分',
      '完全达成': '完全达成',
      '客户拒绝': '客户拒绝',
      '客户失联': '客户失联'
    };
    followup.result_label = resultMap[followup.result] || followup.result;

    res.json({ followup });
  } catch (error) {
    console.error('获取跟进详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建跟进记录
router.post('/', authMiddleware, (req, res) => {
  try {
    const { 
      customer_id, 
      contact_id, 
      opportunity_id,
      work_type,
      type, 
      content, 
      stage, 
      result, 
      next_followup_at,
      next_followup_content,
      attachments
    } = req.body;

    // 必填字段验证
    if (!customer_id) {
      return res.status(400).json({ error: '请选择客户' });
    }
    if (!opportunity_id) {
      return res.status(400).json({ error: '跟进记录必须关联商机' });
    }
    if (!type) {
      return res.status(400).json({ error: '请选择跟进方式' });
    }
    if (!content || content.length < 10) {
      return res.status(400).json({ error: '跟进内容至少 10 个字，当前：' + (content ? content.length : 0) + '字' });
    }

    // 检查客户是否存在
    const customer = db.prepare('SELECT id, name, is_deleted FROM customers WHERE id = ?').get(customer_id);
    if (!customer) {
      return res.status(400).json({ 
        error: '客户不存在，请重新选择',
        debug: `客户 ID: ${customer_id}`
      });
    }
    if (customer.is_deleted) {
      return res.status(400).json({ 
        error: '客户已被删除，请选择其他客户',
        debug: `客户 ID: ${customer_id}, 客户名称：${customer.name}`
      });
    }

    const opportunity = db.prepare('SELECT id, customer_id, owner_id FROM opportunities WHERE id = ?').get(opportunity_id);
    if (!opportunity || opportunity.customer_id !== customer_id) {
      return res.status(400).json({ error: '所选商机不存在或不属于该客户' });
    }

    const roleWorkTypes = {
      sales: ['sales'],
      operations: [],
      presales: ['technical', 'delivery'],
      fde: ['technical', 'delivery'],
      fde_admin: [],
      admin: ['sales', 'promotion', 'technical', 'delivery'],
      super_admin: ['sales', 'promotion', 'technical', 'delivery']
    };
    const effectiveWorkType = work_type || (['presales', 'fde', 'fde_admin'].includes(req.user.role) ? 'technical' : 'sales');
    if (!(roleWorkTypes[req.user.role] || []).includes(effectiveWorkType)) {
      return res.status(403).json({ error: '当前角色不能填写该类型的跟进记录' });
    }
    if (req.user.role === 'sales' && opportunity.owner_id !== req.user.id) {
      return res.status(403).json({ error: '只能跟进自己负责的商机' });
    }
    // 售前可见范围：商机级售前指派，或该商机所属客户存在客户级活跃售前指派
    if (req.user.role === 'presales' && !presalesCanAccessOpportunity(req.user.id, opportunity_id)) {
      return res.status(403).json({ error: '该商机未指派给您' });
    }
    if (req.user.role === 'fde' && !userCanAccessOpportunity(req.user.id, opportunity_id, 'fde')) {
      // FDE可见范围：商机级FDE指派，或该商机所属客户存在客户级活跃FDE指派
      return res.status(403).json({ error: '该商机未指派给您' });
    }
    if (req.user.role === 'fde_admin' && !opportunityHasActiveAssignment(opportunity_id, 'fde')) {
      // FDE管理员可见范围：存在商机级或客户级FDE指派的商机
      return res.status(403).json({ error: '该商机尚未进入FDE跟进范围' });
    }
    if (req.user.role === 'operations') {
      return res.status(403).json({ error: '运营角色仅可查看跟进记录' });
    }

    // 检查联系人是否属于该客户
    if (contact_id) {
      const contact = db.prepare('SELECT id, name, customer_id FROM contacts WHERE id = ?').get(contact_id);
      if (!contact) {
        return res.status(400).json({ 
          error: '联系人不存在',
          debug: `联系人 ID: ${contact_id}`
        });
      }
      if (contact.customer_id !== customer_id) {
        return res.status(400).json({ 
          error: '联系人不属于所选客户',
          debug: `联系人 ID: ${contact_id}, 联系人客户 ID: ${contact.customer_id}, 所选客户 ID: ${customer_id}`
        });
      }
    }

    const id = uuidv4();
    // 使用本地时间（而非 toISOString 的 UTC 时间），避免时间偏移
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const followup_time = now.toISOString().slice(0, 19).replace('T', ' ');

    const stmt = db.prepare(`
      INSERT INTO followups (
        id, customer_id, contact_id, opportunity_id, user_id, followup_time, type, work_type, content,
        stage, result, next_followup_at, next_followup_content, attachments
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    try {
      stmt.run(
        id, 
        customer_id, 
        contact_id || null, 
        opportunity_id || null,
        req.user.id, 
        followup_time,
        type, 
        effectiveWorkType,
        content, 
        stage || 'potential', 
        result || 'pending', 
        next_followup_at || null,
        next_followup_content || null,
        attachments ? (Array.isArray(attachments) ? attachments.join(',') : attachments) : null
      );
    } catch (error) {
      console.error('数据库插入错误:', error);
      console.error('错误码:', error.code);
      console.error('错误信息:', error.message);
      
      // 外键约束失败
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(400).json({ 
          error: '客户不存在或已被删除',
          detail: '请确认选择的客户仍然有效',
          customer_id: customer_id
        });
      }
      
      // 其他数据库错误
      return res.status(400).json({ 
        error: '数据保存失败',
        detail: error.message,
        customer_id: customer_id
      });
    }

    // 更新客户最近跟进时间和跟进阶段
    db.prepare(`
      UPDATE customers SET 
        last_followup_at = CURRENT_TIMESTAMP,
        follow_stage = ?
      WHERE id = ?
    `).run(stage || 'potential', customer_id);

    // 如果关联了商机且指定了跟进阶段，同步更新商机状态
    if (opportunity_id && stage) {
      // 获取原状态
      const oldOpp = db.prepare('SELECT status FROM opportunities WHERE id = ?').get(opportunity_id);
      const oldStatus = oldOpp?.status;

      db.prepare(`
        UPDATE opportunities SET 
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(stage, opportunity_id);

      // 记录状态变更日志（仅状态实际变化时）
      if (oldStatus && oldStatus !== stage) {
        try {
          db.prepare(`
            INSERT INTO opportunity_change_logs (opportunity_id, from_status, to_status, changed_by, followup_id)
            VALUES (?, ?, ?, ?, ?)
          `).run(opportunity_id, oldStatus, stage, req.user.id, id);
        } catch (e) {
          console.error('记录商机状态变更日志失败:', e.message);
        }
      }
    }

    // 如果有下次跟进时间，创建提醒
    if (next_followup_at) {
      const reminderId = uuidv4();
      db.prepare(`
        INSERT INTO followup_reminders (
          id, customer_id, user_id, reminder_at, content, status, reminder_type
        ) VALUES (?, ?, ?, ?, ?, 'unread', 'manual')
      `).run(reminderId, customer_id, req.user.id, next_followup_at, next_followup_content || '跟进提醒');
    }

    res.status(201).json({ 
      message: '跟进记录创建成功', 
      id,
      followup_time
    });
  } catch (error) {
    console.error('创建跟进记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新跟进记录
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { 
      type, 
      content, 
      stage, 
      result, 
      next_followup_at,
      next_followup_content,
      attachments
    } = req.body;

    // 检查跟进记录是否存在
    const followup = db.prepare('SELECT * FROM followups WHERE id = ?').get(id);
    if (!followup) {
      return res.status(404).json({ error: '跟进记录不存在' });
    }

    // 权限检查：只能编辑自己的跟进记录
    if (followup.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限编辑该跟进记录' });
    }

    const updateFields = [];
    const updateValues = [];

    if (type) { 
      updateFields.push('type = ?'); 
      updateValues.push(type); 
    }
    if (content) { 
      if (content.length < 10) {
        return res.status(400).json({ error: '跟进内容至少 10 个字' });
      }
      updateFields.push('content = ?'); 
      updateValues.push(content); 
    }
    if (stage) { 
      updateFields.push('stage = ?'); 
      updateValues.push(stage); 
    }
    if (result !== undefined) { 
      updateFields.push('result = ?'); 
      updateValues.push(result); 
    }
    if (next_followup_at !== undefined) { 
      updateFields.push('next_followup_at = ?'); 
      updateValues.push(next_followup_at || null); 
    }
    if (next_followup_content !== undefined) {
      updateFields.push('next_followup_content = ?');
      updateValues.push(next_followup_content || null);
    }
    if (attachments !== undefined) {
      updateFields.push('attachments = ?');
      updateValues.push(attachments ? (Array.isArray(attachments) ? attachments.join(',') : attachments) : null);
    }
    
    updateFields.push('user_id = ?');
    updateValues.push(req.user.id);
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.prepare(`UPDATE followups SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    db.prepare('UPDATE customers SET last_followup_at = CURRENT_TIMESTAMP WHERE id = ?').run(followup.customer_id);

    // 如果修改了跟进阶段，同步更新客户
    if (stage && stage !== followup.stage) {
      db.prepare('UPDATE customers SET follow_stage = ? WHERE id = ?').run(stage, followup.customer_id);

      // 如果跟进关联了商机，同步更新商机状态并记录变更日志
      if (followup.opportunity_id) {
        const oldOpp = db.prepare('SELECT status FROM opportunities WHERE id = ?').get(followup.opportunity_id);
        const oldStatus = oldOpp?.status;
        db.prepare('UPDATE opportunities SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, followup.opportunity_id);
        if (oldStatus && oldStatus !== stage) {
          try {
            db.prepare(`
              INSERT INTO opportunity_change_logs (opportunity_id, from_status, to_status, changed_by, followup_id)
              VALUES (?, ?, ?, ?, ?)
            `).run(followup.opportunity_id, oldStatus, stage, req.user.id, id);
          } catch (e) {
            console.error('记录商机状态变更日志失败:', e.message);
          }
        }
      }
    }

    res.json({ message: '跟进记录更新成功' });
  } catch (error) {
    console.error('更新跟进记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除跟进记录
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const followup = db.prepare('SELECT * FROM followups WHERE id = ?').get(id);
    if (!followup) {
      return res.status(404).json({ error: '跟进记录不存在' });
    }

    // 权限检查：仅 admin / super_admin 可删除跟进记录
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '无权限删除该跟进记录' });
    }

    // 删除附件文件
    if (followup.attachments) {
      const attachmentList = followup.attachments.split(',');
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

    db.prepare('DELETE FROM followups WHERE id = ?').run(id);

    res.json({ message: '跟进记录删除成功' });
  } catch (error) {
    console.error('删除跟进记录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 上传跟进附件
router.post('/:id/attachments', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { file_urls } = req.body;

    if (!file_urls || !Array.isArray(file_urls) || file_urls.length === 0) {
      return res.status(400).json({ error: '请上传附件' });
    }

    const followup = db.prepare('SELECT * FROM followups WHERE id = ?').get(id);
    if (!followup) {
      return res.status(404).json({ error: '跟进记录不存在' });
    }

    // 权限检查
    if (followup.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限添加附件' });
    }

    // 检查附件数量限制（最多 10 个）
    const existingAttachments = followup.attachments ? followup.attachments.split(',') : [];
    if (existingAttachments.length + file_urls.length > 10) {
      return res.status(400).json({ error: '最多只能上传 10 个附件' });
    }

    // 合并附件列表
    const newAttachments = [...existingAttachments, ...file_urls];
    
    db.prepare('UPDATE followups SET attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
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

// 删除跟进附件
router.delete('/:id/attachments/:fileIndex', authMiddleware, (req, res) => {
  try {
    const { id, fileIndex } = req.params;
    const index = parseInt(fileIndex);

    const followup = db.prepare('SELECT * FROM followups WHERE id = ?').get(id);
    if (!followup) {
      return res.status(404).json({ error: '跟进记录不存在' });
    }

    // 权限检查
    if (followup.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限删除附件' });
    }

    if (!followup.attachments) {
      return res.status(400).json({ error: '没有附件' });
    }

    const attachmentList = followup.attachments.split(',');
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
    db.prepare('UPDATE followups SET attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(attachmentList.join(','), id);

    res.json({ message: '附件删除成功' });
  } catch (error) {
    console.error('删除附件错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
