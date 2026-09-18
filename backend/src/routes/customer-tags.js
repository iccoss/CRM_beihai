const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isSystemAdmin } = require('../middleware/role-policy');
const { isCustomerMember } = require('../middleware/role-policy');

const router = express.Router();

router.use(authMiddleware, (req, res, next) => {
  if (req.method !== 'GET' && !isSystemAdmin(req.user.role) && req.user.role !== 'sales') {
    return res.status(403).json({ error: '当前角色只能查看客户标签' });
  }
  next();
});

// 获取标签列表
router.get('/list', authMiddleware, (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    
    let tags;
    
    // 管理员可以看到所有标签，普通用户只能看到自己创建的标签
    if (userRole === 'admin' || userRole === 'super_admin') {
      tags = db.prepare(`
        SELECT t.*, 
          (SELECT COUNT(*) FROM customer_tag_relations WHERE tag_id = t.id) as customer_count,
          u.name as creator_name
        FROM customer_tags t
        LEFT JOIN users u ON t.creator_id = u.id
        ORDER BY t.created_at DESC
      `).all();
    } else {
      tags = db.prepare(`
        SELECT t.*, 
          (SELECT COUNT(*) FROM customer_tag_relations WHERE tag_id = t.id) as customer_count,
          u.name as creator_name
        FROM customer_tags t
        LEFT JOIN users u ON t.creator_id = u.id
        WHERE t.creator_id = ?
        ORDER BY t.created_at DESC
      `).all(userId);
    }

    res.json({ tags });
  } catch (error) {
    console.error('获取标签列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建标签
router.post('/', authMiddleware, (req, res) => {
  try {
    const { name, color, notes } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: '标签名称不能为空' });
    }

    if (name.trim().length > 20) {
      return res.status(400).json({ error: '标签名称长度不能超过 20 个字符' });
    }

    const existing = db.prepare('SELECT id FROM customer_tags WHERE name = ?').get(name.trim());
    if (existing) {
      return res.status(400).json({ error: '标签名称已存在' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO customer_tags (id, name, color, notes, creator_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name.trim(), color || null, notes || null, req.user.id);

    res.status(201).json({ message: '标签创建成功', id });
  } catch (error) {
    console.error('创建标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新标签
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, notes } = req.body;

    const tag = db.prepare('SELECT * FROM customer_tags WHERE id = ?').get(id);
    if (!tag) {
      return res.status(404).json({ error: '标签不存在' });
    }
    if (!isSystemAdmin(req.user.role) && tag.creator_id !== req.user.id) {
      return res.status(403).json({ error: '只能修改自己创建的标签' });
    }

    if (name && name.trim() !== tag.name) {
      if (name.length > 20) {
        return res.status(400).json({ error: '标签名称长度不能超过 20 个字符' });
      }

      const existing = db.prepare('SELECT id FROM customer_tags WHERE name = ? AND id != ?').get(name.trim(), id);
      if (existing) {
        return res.status(400).json({ error: '标签名称已存在' });
      }
    }

    const updateFields = [];
    const updateValues = [];

    if (name) { updateFields.push('name = ?'); updateValues.push(name.trim()); }
    if (color !== undefined) { updateFields.push('color = ?'); updateValues.push(color || null); }
    if (notes !== undefined) { updateFields.push('notes = ?'); updateValues.push(notes || null); }
    
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    db.prepare(`UPDATE customer_tags SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    res.json({ message: '标签更新成功' });
  } catch (error) {
    console.error('更新标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除标签
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;

    const tag = db.prepare('SELECT * FROM customer_tags WHERE id = ?').get(id);
    if (!tag) {
      return res.status(404).json({ error: '标签不存在' });
    }
    if (!isSystemAdmin(req.user.role) && tag.creator_id !== req.user.id) {
      return res.status(403).json({ error: '只能删除自己创建的标签' });
    }

    // 检查是否有关联客户
    const customerCount = db.prepare('SELECT COUNT(*) as count FROM customer_tag_relations WHERE tag_id = ?').get(id).count;
    if (customerCount > 0) {
      return res.status(400).json({ error: '该标签已关联客户，请先解除关联' });
    }

    db.prepare('DELETE FROM customer_tags WHERE id = ?').run(id);

    res.json({ message: '标签删除成功' });
  } catch (error) {
    console.error('删除标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取客户的标签
router.get('/customer/:customerId', authMiddleware, (req, res) => {
  try {
    const tags = db.prepare(`
      SELECT t.* FROM customer_tags t
      INNER JOIN customer_tag_relations r ON t.id = r.tag_id
      WHERE r.customer_id = ?
    `).all(req.params.customerId);

    res.json({ tags });
  } catch (error) {
    console.error('获取客户标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 给客户添加标签
router.post('/customer/:customerId/tag/:tagId', authMiddleware, (req, res) => {
  try {
    const { customerId, tagId } = req.params;
    if (!isSystemAdmin(req.user.role) && !isCustomerMember(customerId, req.user.id)) {
      return res.status(403).json({ error: '无权限维护该客户标签' });
    }

    // 检查客户是否存在
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND is_deleted = 0').get(customerId);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    // 检查标签是否存在
    const tag = db.prepare('SELECT id FROM customer_tags WHERE id = ?').get(tagId);
    if (!tag) {
      return res.status(404).json({ error: '标签不存在' });
    }

    // 检查是否已关联
    const existing = db.prepare('SELECT id FROM customer_tag_relations WHERE customer_id = ? AND tag_id = ?').get(customerId, tagId);
    if (existing) {
      return res.status(400).json({ error: '该客户已关联此标签' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO customer_tag_relations (id, customer_id, tag_id)
      VALUES (?, ?, ?)
    `).run(id, customerId, tagId);

    res.json({ message: '标签关联成功' });
  } catch (error) {
    console.error('关联标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量给客户添加标签
router.post('/customer/:customerId/tags', authMiddleware, (req, res) => {
  try {
    const { customerId } = req.params;
    if (!isSystemAdmin(req.user.role) && !isCustomerMember(customerId, req.user.id)) {
      return res.status(403).json({ error: '无权限维护该客户标签' });
    }
    const { tag_ids } = req.body;

    if (!tag_ids || !Array.isArray(tag_ids) || tag_ids.length === 0) {
      return res.status(400).json({ error: '请选择要添加的标签' });
    }

    // 检查客户是否存在
    const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND is_deleted = 0').get(customerId);
    if (!customer) {
      return res.status(404).json({ error: '客户不存在' });
    }

    for (const tagId of tag_ids) {
      const tag = db.prepare('SELECT id FROM customer_tags WHERE id = ?').get(tagId);
      if (!tag) continue;

      const existing = db.prepare('SELECT id FROM customer_tag_relations WHERE customer_id = ? AND tag_id = ?').get(customerId, tagId);
      if (existing) continue;

      const id = uuidv4();
      db.prepare(`
        INSERT INTO customer_tag_relations (id, customer_id, tag_id)
        VALUES (?, ?, ?)
      `).run(id, customerId, tagId);
    }

    res.json({ message: '标签批量关联成功' });
  } catch (error) {
    console.error('批量关联标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 移除客户的标签
router.delete('/customer/:customerId/tag/:tagId', authMiddleware, (req, res) => {
  try {
    const { customerId, tagId } = req.params;
    if (!isSystemAdmin(req.user.role) && !isCustomerMember(customerId, req.user.id)) {
      return res.status(403).json({ error: '无权限维护该客户标签' });
    }

    db.prepare('DELETE FROM customer_tag_relations WHERE customer_id = ? AND tag_id = ?').run(customerId, tagId);

    res.json({ message: '标签移除成功' });
  } catch (error) {
    console.error('移除标签错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
