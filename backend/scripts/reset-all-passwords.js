#!/usr/bin/env node
/**
 * 一次性脚本：重置所有用户密码（sql.js 版本）
 * 用法: node backend/scripts/reset-all-passwords.js [新密码]
 * 默认密码: BeiHai@2026
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '../../database/crm.db');
const NEW_PASSWORD = process.argv[2] || 'BeiHai@2026';

(async () => {
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  const users = db.exec('SELECT username, name, role FROM users ORDER BY created_at');
  const rows = users[0]?.values || [];
  console.log(`共 ${rows.length} 个用户，统一重置密码为: ${NEW_PASSWORD}\n`);

  const hashed = bcrypt.hashSync(NEW_PASSWORD, 10);
  const stmt = db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP');
  stmt.run([hashed]);
  stmt.free();

  const changed = db.getRowsModified();
  db.exec('SELECT 1'); // no-op

  // 回写文件
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();

  console.log(`✅ 已更新 ${changed} 个用户的密码`);
  rows.forEach(([username, name, role]) => {
    console.log(`  ${username.padEnd(16)} ${(name || '').padEnd(12)} ${role}`);
  });
})().catch((err) => {
  console.error('重置失败:', err);
  process.exit(1);
});
