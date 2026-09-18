const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// 获取部门树形列表
router.get('/tree', authMiddleware, (req, res) => {
  try {
    const allDepts = db.prepare(`
      SELECT d.*, u.name as manager_name
      FROM departments d
      LEFT JOIN users u ON d.manager_id = u.id
      WHERE d.status != 'deleted'
      ORDER BY d.level, d.sort_order, d.created_at
    `).all();

    // 构建树形结构
    function buildTree(departments, parentId = null) {
      return departments
        .filter(dept => dept.parent_id === parentId)
        .map(dept => ({
          ...dept,
          children: buildTree(departments, dept.id)
        }));
    }

    const tree = buildTree(allDepts);
    res.json({ data: tree });
  } catch (error) {
    console.error('获取部门树错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取部门列表（扁平）
router.get('/', authMiddleware, (req, res) => {
  try {
    const { status, parent_id } = req.query;
    
    let whereClause = "d.status != 'deleted'";
    const params = [];

    if (status) {
      whereClause += ` AND d.status = ?`;
      params.push(status);
    }
    if (parent_id !== undefined) {
      whereClause += ` AND d.parent_id ${parent_id === '' ? 'IS NULL' : '= ?'}`;
      if (parent_id !== '') params.push(parent_id);
    }

    const departments = db.prepare(`
      SELECT d.*, u.name as manager_name
      FROM departments d
      LEFT JOIN users u ON d.manager_id = u.id
      WHERE ${whereClause}
      ORDER BY d.level, d.sort_order, d.created_at
    `).all(...params);

    res.json({ data: departments });
  } catch (error) {
    console.error('获取部门列表错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取部门详情
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const department = db.prepare(`
      SELECT d.*, u.name as manager_name
      FROM departments d
      LEFT JOIN users u ON d.manager_id = u.id
      WHERE d.id = ? AND d.status != 'deleted'
    `).get(req.params.id);

    if (!department) {
      return res.status(404).json({ error: '部门不存在' });
    }

    // 获取下级部门
    const children = db.prepare(`
      SELECT * FROM departments 
      WHERE parent_id = ? AND status != 'deleted'
      ORDER BY sort_order, created_at
    `).all(req.params.id);

    // 获取部门成员
    const members = db.prepare(`
      SELECT id, username, name, role, email, phone
      FROM users 
      WHERE department_id = ? AND status = 'active'
    `).all(req.params.id);

    res.json({ 
      department,
      children,
      members 
    });
  } catch (error) {
    console.error('获取部门详情错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建部门
router.post('/', authMiddleware, requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const { name, parent_id, manager_id, sort_order = 0 } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: '部门名称不能为空' });
    }

    if (name.length > 50) {
      return res.status(400).json({ error: '部门名称长度不能超过 50 个字符' });
    }

    // 检查同级部门名称是否重复
    const existing = db.prepare(`
      SELECT id FROM departments 
      WHERE name = ? AND parent_id ${parent_id ? '= ?' : 'IS NULL'} AND status != 'deleted'
    `).get(name, ...(parent_id ? [parent_id] : []));

    if (existing) {
      return res.status(400).json({ error: '同级部门名称已存在' });
    }

    // 检查上级部门是否存在
    let level = 1;
    if (parent_id) {
      const parent = db.prepare('SELECT level FROM departments WHERE id = ? AND status != ?').get(parent_id, 'deleted');
      if (!parent) {
        return res.status(400).json({ error: '上级部门不存在' });
      }
      level = parent.level + 1;

      // 检查不能循环关联（不能设为自己的下级）
      let current = db.prepare('SELECT parent_id FROM departments WHERE id = ?').get(parent_id);
      while (current && current.parent_id) {
        if (current.parent_id === parent_id) {
          return res.status(400).json({ error: '不能循环设置上级部门' });
        }
        current = db.prepare('SELECT parent_id FROM departments WHERE id = ?').get(current.parent_id);
      }
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO departments (id, name, parent_id, manager_id, level, sort_order, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(id, name.trim(), parent_id || null, manager_id || null, level, parseInt(sort_order));

    res.status(201).json({ message: '部门创建成功', id });
  } catch (error) {
    console.error('创建部门错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新部门
router.put('/:id', authMiddleware, requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { name, parent_id, manager_id, sort_order, status } = req.body;

    const department = db.prepare('SELECT * FROM departments WHERE id = ? AND status != ?').get(id, 'deleted');
    if (!department) {
      return res.status(404).json({ error: '部门不存在' });
    }

    // 检查名称（如果修改了）
    if (name && name.trim() !== department.name) {
      if (name.length > 50) {
        return res.status(400).json({ error: '部门名称长度不能超过 50 个字符' });
      }

      const existing = db.prepare(`
        SELECT id FROM departments 
        WHERE name = ? AND parent_id ${parent_id !== undefined ? (parent_id ? '= ?' : 'IS NULL') : (department.parent_id ? '= ?' : 'IS NULL')} 
        AND status != 'deleted' AND id != ?
      `).get(name.trim(), ...(parent_id !== undefined ? (parent_id ? [parent_id, id] : [id]) : (department.parent_id ? [department.parent_id, id] : [id])));

      if (existing) {
        return res.status(400).json({ error: '同级部门名称已存在' });
      }
    }

    // 检查上级部门（如果修改了）
    let level = department.level;
    if (parent_id !== undefined && parent_id !== department.parent_id) {
      if (parent_id === id) {
        return res.status(400).json({ error: '不能将自己设为上级部门' });
      }

      if (parent_id) {
        const parent = db.prepare('SELECT level FROM departments WHERE id = ? AND status != ?').get(parent_id, 'deleted');
        if (!parent) {
          return res.status(400).json({ error: '上级部门不存在' });
        }
        level = parent.level + 1;

        // 检查不能设为自己的下级
        let current = db.prepare('SELECT parent_id FROM departments WHERE id = ?').get(parent_id);
        let depth = 0;
        while (current && current.parent_id && depth < 100) {
          if (current.parent_id === id) {
            return res.status(400).json({ error: '不能将下级部门设为上级部门' });
          }
          current = db.prepare('SELECT parent_id FROM departments WHERE id = ?').get(current.parent_id);
          depth++;
        }
      } else {
        level = 1;
      }

      // 更新下级部门的 level
      function updateChildrenLevel(deptId, newLevel) {
        const children = db.prepare('SELECT id FROM departments WHERE parent_id = ? AND status != ?').all(deptId, 'deleted');
        for (const child of children) {
          db.prepare('UPDATE departments SET level = ? WHERE id = ?').run(newLevel + 1, child.id);
          updateChildrenLevel(child.id, newLevel + 1);
        }
      }
      updateChildrenLevel(id, level);
    }

    const updateFields = [];
    const updateValues = [];

    if (name) { updateFields.push('name = ?'); updateValues.push(name.trim()); }
    if (parent_id !== undefined) { updateFields.push('parent_id = ?'); updateValues.push(parent_id || null); }
    if (manager_id !== undefined) { updateFields.push('manager_id = ?'); updateValues.push(manager_id || null); }
    if (sort_order !== undefined) { updateFields.push('sort_order = ?'); updateValues.push(parseInt(sort_order)); }
    if (status) { updateFields.push('status = ?'); updateValues.push(status); }
    
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateValues.push(id);

    updateFields.unshift('level = ?');
    updateValues.unshift(level);

    db.prepare(`UPDATE departments SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

    res.json({ message: '部门更新成功' });
  } catch (error) {
    console.error('更新部门错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除部门
router.delete('/:id', authMiddleware, requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const { id } = req.params;

    const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!department) {
      return res.status(404).json({ error: '部门不存在' });
    }

    // 检查是否有下级部门
    const childCount = db.prepare('SELECT COUNT(*) as count FROM departments WHERE parent_id = ? AND status != ?').get(id, 'deleted').count;
    if (childCount > 0) {
      return res.status(400).json({ error: '该部门有下级部门，无法删除' });
    }

    // 检查是否有用户
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE department_id = ? AND status = ?').get(id, 'active').count;
    if (userCount > 0) {
      return res.status(400).json({ error: `该部门有${userCount}名用户，请先转移或删除用户` });
    }

    // 软删除
    db.prepare(`
      UPDATE departments 
      SET status = 'deleted', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(id);

    res.json({ message: '部门删除成功' });
  } catch (error) {
    console.error('删除部门错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
