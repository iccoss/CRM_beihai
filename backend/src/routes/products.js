const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { isTechnicalRole } = require('../middleware/role-policy');

const router = express.Router();

router.use(authMiddleware, (req, res, next) => {
  if (req.method !== 'GET' && !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: '只有系统管理员可以维护产品' });
  }
  next();
});

// ==================== 产品列表 ====================
router.get('/', authMiddleware, (req, res) => {
  try {
    const { page = 1, limit = 20, name, status } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params = [];
    if (name) { whereClause += ' AND name LIKE ?'; params.push(`%${name}%`); }
    if (status) { whereClause += ' AND status = ?'; params.push(status); }

    const { total } = db.prepare(`SELECT COUNT(*) as total FROM products WHERE ${whereClause}`).get(...params);

    let products = db.prepare(`
      SELECT * FROM products WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);
    if (isTechnicalRole(req.user.role)) {
      products = products.map(({ unit_price, r_and_d_cost_rate, ...product }) => product);
    }

    res.json({
      data: products,
      pagination: { total: parseInt(total), page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('获取产品列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 所有产品（下拉用） ====================
router.get('/all', authMiddleware, (req, res) => {
  try {
    const products = db.prepare(`
      SELECT id, name${isTechnicalRole(req.user.role) ? '' : ', unit_price, quantity, r_and_d_cost_rate'} FROM products WHERE status = 'active' ORDER BY name
    `).all();
    res.json({ data: products });
  } catch (error) {
    console.error('获取所有产品错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 产品详情 ====================
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: '产品不存在' });
    if (isTechnicalRole(req.user.role)) {
      delete product.unit_price;
      delete product.r_and_d_cost_rate;
    }
    res.json({ data: product });
  } catch (error) {
    console.error('获取产品详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 创建产品 ====================
router.post('/', authMiddleware, (req, res) => {
  try {
    const { name, unit_price, quantity, r_and_d_cost_rate, description } = req.body;
    if (!name || unit_price === undefined) {
      return res.status(400).json({ error: '产品名称和单价为必填项' });
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO products (id, name, unit_price, quantity, r_and_d_cost_rate, description, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(id, name, parseFloat(unit_price), parseInt(quantity) || 1, parseFloat(r_and_d_cost_rate) || 0, description || null);

    res.status(201).json({ message: '产品创建成功', id });
  } catch (error) {
    console.error('创建产品错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 更新产品 ====================
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: '产品不存在' });

    const { name, unit_price, quantity, r_and_d_cost_rate, description, status } = req.body;
    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (unit_price !== undefined) { fields.push('unit_price = ?'); values.push(parseFloat(unit_price)); }
    if (quantity !== undefined) { fields.push('quantity = ?'); values.push(parseInt(quantity)); }
    if (r_and_d_cost_rate !== undefined) { fields.push('r_and_d_cost_rate = ?'); values.push(parseFloat(r_and_d_cost_rate)); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description || null); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }

    if (fields.length === 0) return res.json({ message: '无更新内容' });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);
    db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    res.json({ message: '产品更新成功' });
  } catch (error) {
    console.error('更新产品错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 删除产品 ====================
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: '产品不存在' });

    db.prepare('UPDATE products SET status = \'inactive\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ message: '产品已停用' });
  } catch (error) {
    console.error('删除产品错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
