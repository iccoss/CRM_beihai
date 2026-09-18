const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isSystemAdmin, canViewAll, isCustomerMember, canViewCustomer } = require('../middleware/role-policy');

const router = express.Router();

router.use(authMiddleware, (req, res, next) => {
  if (req.method !== 'GET' && !isSystemAdmin(req.user.role) && req.user.role !== 'sales') {
    return res.status(403).json({ error: '当前角色只能查看联系人' });
  }
  next();
});

// 获取联系人列表
router.get('/', authMiddleware, (req, res) => {
  try {
    const { page = 1, limit = 10, name, customer_id } = req.query;
    const offset = (page - 1) * limit;
    const userRole = req.user.role;
    const userId = req.user.id;

    let ownerCondition = '';
    const permissionParams = [];
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = ? OR cu.secondary_owner_id = ? OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = ?) OR
        EXISTS (SELECT 1 FROM opportunities o WHERE o.customer_id = cu.id AND o.owner_id = ?))`;
      permissionParams.push(userId, userId, userId, userId);
    } else if (userRole === 'presales') {
      ownerCondition = ` AND (EXISTS (SELECT 1 FROM customer_presales_assignments cpa WHERE cpa.customer_id = cu.id AND cpa.user_id = ? AND cpa.status = 'active') OR
        EXISTS (SELECT 1 FROM opportunities o JOIN opportunity_assignments oa ON oa.opportunity_id = o.id WHERE o.customer_id = cu.id AND oa.user_id = ? AND oa.assignment_type = 'presales' AND oa.status = 'active'))`;
      permissionParams.push(userId, userId);
    } else if (userRole === 'fde') {
      ownerCondition = ` AND (EXISTS (SELECT 1 FROM customer_fde_assignments cfa WHERE cfa.customer_id = cu.id AND cfa.user_id = ? AND cfa.status = 'active') OR
        EXISTS (SELECT 1 FROM opportunities o JOIN opportunity_assignments oa ON oa.opportunity_id = o.id WHERE o.customer_id = cu.id AND oa.user_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active'))`;
      permissionParams.push(userId, userId);
    } else if (userRole === 'fde_admin') {
      ownerCondition = ` AND (EXISTS (SELECT 1 FROM customer_fde_assignments cfa WHERE cfa.customer_id = cu.id AND cfa.status = 'active') OR
        EXISTS (SELECT 1 FROM opportunities o JOIN opportunity_assignments oa ON oa.opportunity_id = o.id WHERE o.customer_id = cu.id AND oa.assignment_type = 'fde' AND oa.status = 'active'))`;
    } else if (!canViewAll(userRole)) {
      ownerCondition = ' AND 1 = 0';
    }

    let whereClause = '1=1' + ownerCondition;
    const params = [...permissionParams];

    if (name) {
      whereClause += ` AND c.name LIKE ?`;
      params.push(`%${name}%`);
    }
    if (customer_id) {
      whereClause += ` AND c.customer_id = ?`;
      params.push(customer_id);
    }

    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM contacts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND ${whereClause}
    `).get(...params);

    const contacts = db.prepare(`
      SELECT c.*, cu.name as customer_name
      FROM contacts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE cu.is_deleted = 0 AND ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
      data: contacts,
      pagination: {
        total: parseInt(total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取联系人列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建联系人
router.post('/', authMiddleware, (req, res) => {
  try {
    const { customer_id, name, position, phone, email, wechat, is_kp, birthday, notes } = req.body;
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!customer_id || !name) {
      return res.status(400).json({ error: '必填字段不能为空' });
    }

    // 验证手机、邮箱、微信三者必须填一项
    if (!phone && !email && !wechat) {
      return res.status(400).json({ error: '手机、邮箱、微信三者必须至少填写一项' });
    }

    // 权限检查：验证客户归属（包括副销售）
    const customer = db.prepare('SELECT owner_id, secondary_owner_id FROM customers WHERE id = ? AND is_deleted = 0').get(customer_id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }
    
    if (userRole === 'sales' && !isCustomerMember(customer_id, userId)) {
      return res.status(403).json({ error: '无权限为该客户添加联系人' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO contacts (id, customer_id, name, position, phone, email, wechat, is_kp, birthday, notes, creator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, customer_id, name, position, phone || null, email || null, wechat || null, is_kp ? 1 : 0, birthday || null, notes || null, req.user.id);

    res.json({ message: '联系人创建成功', id });
  } catch (error) {
    console.error('创建联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新联系人
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { name, position, phone, email, wechat, is_kp, birthday, notes } = req.body;

    // 获取旧值用于记录变更
    const oldContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!oldContact) {
      return res.status(404).json({ error: '联系人不存在' });
    }
    if (!isSystemAdmin(req.user.role) && !isCustomerMember(oldContact.customer_id, req.user.id)) {
      return res.status(403).json({ error: '无权限编辑该联系人' });
    }

    // 可更新字段及中文映射
    const fieldLabels = {
      name: '姓名',
      position: '职位',
      phone: '手机',
      email: '邮箱',
      wechat: '微信',
      is_kp: '是否 KP',
      birthday: '生日',
      notes: '备注'
    };

    const fieldMap = { name, position, phone, email, wechat, is_kp, birthday, notes };

    // 记录变更日志
    const changeLogInsert = db.prepare('INSERT INTO contact_change_logs (id, contact_id, changed_by, changed_by_name, changed_at, field_name, old_value) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)');

    const updateFields = [];
    const updateValues = [];

    for (const [field, value] of Object.entries(fieldMap)) {
      if (value !== undefined) {
        const oldValue = oldContact[field];
        const oldStr = oldValue === null || oldValue === undefined ? '' : String(oldValue);
        const newStr = value === null || value === undefined ? '' : String(value);

        if (oldStr !== newStr) {
          const logId = require('crypto').randomUUID();
          changeLogInsert.run(
            logId,
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

    db.prepare(`UPDATE contacts SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    res.json({ message: '联系人更新成功' });
  } catch (error) {
    console.error('更新联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量删除联系人（必须在 /:id 之前定义）
router.post('/batch/delete', authMiddleware, (req, res) => {
  try {
    console.log('批量删除请求 body:', req.body);
    const { ids } = req.body;
    const userRole = req.user.role;
    const userId = req.user.id;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      console.log('验证失败：ids =', ids);
      return res.status(400).json({ error: '请选择要删除的联系人' });
    }
    
    // 批量检查权限
    const contacts = db.prepare(`
      SELECT c.id, c.customer_id, cu.owner_id as customer_owner_id
      FROM contacts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
    
    if (!isSystemAdmin(userRole)) {
      const unauthorized = contacts.some(c => !isCustomerMember(c.customer_id, userId));
      if (unauthorized) {
        return res.status(403).json({ error: '无权限删除部分联系人' });
      }
    }
    
    db.prepare(`DELETE FROM contacts WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    
    res.json({
      message: '批量删除成功',
      deleted_count: ids.length
    });
  } catch (error) {
    console.error('批量删除联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除联系人
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const contact = db.prepare('SELECT c.*, cu.owner_id FROM contacts c INNER JOIN customers cu ON c.customer_id = cu.id WHERE c.id = ?').get(id);
    
    if (!contact) {
      return res.status(404).json({ error: '联系人不存在' });
    }
    
    // 权限检查
    const userRole = req.user.role;
    const userId = req.user.id;
    
    if (!isSystemAdmin(userRole) && !isCustomerMember(contact.customer_id, userId)) {
      return res.status(403).json({ error: '无权限删除该联系人' });
    }
    
    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    res.json({ message: '联系人删除成功' });
  } catch (error) {
    console.error('删除联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取联系人详情
router.get('/:id([0-9a-fA-F-]{36})', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;
    const userId = req.user.id;
    
    const contact = db.prepare(`
      SELECT c.*, cu.name as customer_name, cu.owner_id as customer_owner_id
      FROM contacts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.id = ? AND cu.is_deleted = 0
    `).get(id);
    
    if (!contact) {
      return res.status(404).json({ error: '联系人不存在' });
    }
    
    // 权限检查
    if (!canViewCustomer(req.user, contact.customer_id)) {
      return res.status(403).json({ error: '无权限查看该联系人' });
    }
    
    // 获取变更日志
    const changeLogs = db.prepare(`
      SELECT * FROM contact_change_logs
      WHERE contact_id = ?
      ORDER BY changed_at DESC
    `).all(id);

    res.json({ contact, changeLogs });
  } catch (error) {
    console.error('获取联系人详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取近期生日联系人（未来 30 天）
router.get('/birthdays/upcoming', authMiddleware, (req, res) => {
  try {
    const { days = 30 } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;
    
    // 使用本地系统时间（北京时间 UTC+8）
    const today = new Date();
    
    // 获取所有有生日的联系人，然后在内存中过滤
    const allContacts = db.prepare(`
      SELECT c.id, c.name, c.birthday, c.phone, c.email, c.customer_id, cu.name as customer_name, cu.owner_id
      FROM contacts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE c.birthday IS NOT NULL AND c.birthday != '' AND cu.is_deleted = 0
      ORDER BY c.name ASC
    `).all();
    
    const upcomingBirthdays = [];
    
    allContacts.filter(c => canViewCustomer(req.user, c.customer_id)).forEach(c => {
      const birthday = new Date(c.birthday);
      const birthMonth = birthday.getMonth() + 1;
      const birthDay = birthday.getDate();
      
      // 计算今年的生日（使用本地时间）
      let thisYearBirthday = new Date(today.getFullYear(), birthMonth - 1, birthDay);
      if (thisYearBirthday < today) {
        thisYearBirthday = new Date(today.getFullYear() + 1, birthMonth - 1, birthDay);
      }
      
      // 计算距离生日还有多少天
      const diffTime = thisYearBirthday.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays <= parseInt(days)) {
        // 使用本地时间格式化生日日期
        const birthdayDate = thisYearBirthday.toLocaleString('zh-CN', { hour12: false }).split(' ')[0].replace(/\//g, '-');
        upcomingBirthdays.push({
          id: c.id,
          name: c.name,
          birthday: c.birthday,
          phone: c.phone,
          email: c.email,
          customer_id: c.customer_id,
          customer_name: c.customer_name,
          birthday_date: birthdayDate,
          days_until_birthday: diffDays
        });
      }
    });
    
    // 按天数排序
    upcomingBirthdays.sort((a, b) => a.days_until_birthday - b.days_until_birthday);
    
    res.json({
      data: upcomingBirthdays,
      total: upcomingBirthdays.length
    });
  } catch (error) {
    console.error('获取生日提醒错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 导出联系人（CSV 格式）
router.get('/export', authMiddleware, (req, res) => {
  try {
    if (['presales', 'fde', 'fde_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '技术角色不可导出全量联系人' });
    }
    const userRole = req.user.role;
    const userId = req.user.id;
    
    let ownerCondition = '';
    if (userRole === 'sales') {
      ownerCondition = ` AND (cu.owner_id = '${userId}' OR cu.secondary_owner_id = '${userId}' OR
        EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = cu.id AND cm.user_id = '${userId}'))`;
    }
    
    const contacts = db.prepare(`
      SELECT c.name, c.position, c.phone, c.email, c.wechat, c.is_kp, c.birthday, c.notes, cu.name as customer_name
      FROM contacts c
      INNER JOIN customers cu ON c.customer_id = cu.id
      WHERE cu.is_deleted = 0 ${ownerCondition}
      ORDER BY cu.name, c.name
    `).all();
    
    // 生成 CSV
    let csv = '\uFEFF'; // BOM for Excel
    csv += '客户名称，联系人姓名，职位，手机，邮箱，微信，是否 KP，生日，备注\n';
    
    contacts.forEach(c => {
      const row = [
        c.customer_name || '',
        c.name || '',
        c.position || '',
        c.phone || '',
        c.email || '',
        c.wechat || '',
        c.is_kp === 1 ? '是' : '否',
        c.birthday || '',
        (c.notes || '').replace(/\n/g, ' ')
      ].map(field => `"${field}"`).join(',');
      csv += row + '\n';
    });
    
    // 使用本地系统时间生成文件名
    const now = new Date();
    const dateStr = now.toLocaleString('zh-CN', { hour12: false }).split(' ')[0].replace(/\//g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=contacts_${dateStr}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('导出联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 导入联系人（CSV 格式）
router.post('/import', authMiddleware, (req, res) => {
  try {
    const { customer_id, contacts } = req.body;
    const userRole = req.user.role;
    const userId = req.user.id;
    
    if (!customer_id || !contacts || !Array.isArray(contacts)) {
      return res.status(400).json({ error: '参数错误' });
    }
    
    // 权限检查
    const customer = db.prepare('SELECT owner_id FROM customers WHERE id = ? AND is_deleted = 0').get(customer_id);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }
    
    if (userRole === 'sales' && !isCustomerMember(customer_id, userId)) {
      return res.status(403).json({ error: '无权限为该客户导入联系人' });
    }
    
    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    
    contacts.forEach((c, index) => {
      try {
        if (!c.name) {
          errorCount++;
          errors.push(`第${index + 1}行：联系人姓名不能为空`);
          return;
        }
        
        const id = uuidv4();
        db.prepare(`
          INSERT INTO contacts (id, customer_id, name, position, phone, email, wechat, is_kp, birthday, notes, creator_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          customer_id,
          c.name,
          c.position || null,
          c.phone || null,
          c.email || null,
          c.wechat || null,
          c.is_kp === '是' ? 1 : 0,
          c.birthday || null,
          c.notes || null,
          userId
        );
        successCount++;
      } catch (err) {
        errorCount++;
        errors.push(`第${index + 1}行：${err.message}`);
      }
    });
    
    res.json({
      message: '导入完成',
      success_count: successCount,
      error_count: errorCount,
      errors: errors.slice(0, 10) // 只返回前 10 个错误
    });
  } catch (error) {
    console.error('导入联系人错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
