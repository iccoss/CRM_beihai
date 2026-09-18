// ⚠️ 已废弃：本脚本依赖 better-sqlite3（项目已迁移到 sql.js），直接运行会报错。
// 请改用：node backend/scripts/reset-all-passwords.js [新密码]
process.exit(1);

const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

// 连接数据库
const dbPath = path.join(__dirname, '../database/crm.db');
const db = new Database(dbPath);

// 重置admin用户的密码为admin123
const newPassword = 'admin123';
const hashedPassword = bcrypt.hashSync(newPassword, 10);

// 更新admin用户的密码
const result = db.prepare('UPDATE users SET password = ? WHERE username = ?').run(hashedPassword, 'admin');

console.log(`已重置admin用户密码为: ${newPassword}`);
console.log(`影响行数: ${result.changes}`);

db.close();
console.log('数据库连接已关闭');