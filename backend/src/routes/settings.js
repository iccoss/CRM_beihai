const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

const SETTING_DEFS = {
  public_recycle_days: {
    label: '客户自动释放天数',
    description: '私有客户连续自然日无跟进后自动释放到公海，最少 1 天',
    min: 1,
    defaultValue: '30'
  }
};

function getSetting(key) {
  const def = SETTING_DEFS[key];
  const row = db.prepare('SELECT key_name, value, description, updated_at FROM system_settings WHERE key_name = ?').get(key);
  return {
    key,
    label: def.label,
    description: row?.description || def.description,
    value: row?.value || def.defaultValue,
    min: def.min,
    updated_at: row?.updated_at || null
  };
}

router.get('/', authMiddleware, (req, res) => {
  try {
    res.json({
      data: Object.keys(SETTING_DEFS).map(getSetting)
    });
  } catch (error) {
    console.error('获取系统配置错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.put('/public-recycle-days', authMiddleware, requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const days = Number.parseInt(req.body.value, 10);
    if (!Number.isInteger(days) || days < SETTING_DEFS.public_recycle_days.min) {
      return res.status(400).json({ error: '自动释放天数不能小于 1 天' });
    }

    const existing = db.prepare('SELECT id FROM system_settings WHERE key_name = ?').get('public_recycle_days');
    if (existing) {
      db.prepare(`
        UPDATE system_settings
        SET value = ?, description = ?, updated_at = CURRENT_TIMESTAMP
        WHERE key_name = ?
      `).run(String(days), SETTING_DEFS.public_recycle_days.description, 'public_recycle_days');
    } else {
      db.prepare(`
        INSERT INTO system_settings (id, key_name, value, description)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), 'public_recycle_days', String(days), SETTING_DEFS.public_recycle_days.description);
    }

    res.json({ message: '系统配置已保存', data: getSetting('public_recycle_days') });
  } catch (error) {
    console.error('保存系统配置错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
