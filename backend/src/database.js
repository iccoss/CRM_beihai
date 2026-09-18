const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.CRM_DB_PATH || path.join(__dirname, '../../database/crm.db');
const PRODUCTION_IMPORT_MIGRATION = 'v01-production-import-20260817';
let db = null;

// 包装器类，提供与 better-sqlite3兼容的 API
class DatabaseWrapper {
  constructor(sqlJsDb) {
    this.db = sqlJsDb;
    this.persistEnabled = false;
    this.transactionDepth = 0;
  }

  exec(sql) {
    const normalized = String(sql).trim().toUpperCase();
    if (normalized.startsWith('BEGIN')) this.transactionDepth += 1;
    const result = this.db.exec(sql);
    if (normalized.startsWith('COMMIT')) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      this.persist();
    } else if (normalized.startsWith('ROLLBACK')) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    } else if (!normalized.startsWith('SELECT') && !normalized.startsWith('PRAGMA')) {
      this.persist();
    }
    return result;
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      get: (...params) => {
        stmt.bind(params);
        if (stmt.step()) {
          const result = stmt.getAsObject();
          stmt.free();
          return result;
        }
        stmt.free();
        return undefined;
      },
      all: (...params) => {
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      run: (...params) => {
        stmt.bind(params);
        stmt.step();
        stmt.free();
        // 先取影响行数再持久化：db.export()（save 内部调用）会重置 SQLite 的 changes 计数
        const changes = this.db.getRowsModified();
        this.persist();
        return { changes };
      }
    };
  }

  run(sql, params = []) {
    if (params.length > 0) {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
    } else {
      this.db.run(sql);
    }
    // 先取影响行数再持久化：db.export()（save 内部调用）会重置 SQLite 的 changes 计数
    const changes = this.db.getRowsModified();
    this.persist();
    return { changes };
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    const tempPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, DB_PATH);
  }

  persist() {
    if (this.persistEnabled && this.transactionDepth === 0) this.save();
  }

  enablePersistence() {
    this.persistEnabled = true;
    this.save();
  }

  transaction(fn) {
    return (...args) => {
      this.transactionDepth += 1;
      this.db.exec('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        this.transactionDepth -= 1;
        this.persist();
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
        throw error;
      }
    };
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  
  // 如果数据库文件存在，读取它；否则创建新数据库
  let buffer = null;
  if (fs.existsSync(DB_PATH)) {
    if (process.env.CRM_SKIP_STARTUP_BACKUP !== '1') {
      const backupPath = `${DB_PATH}.pre-20260813-integrity-repair.bak`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(DB_PATH, backupPath);
    }
    buffer = fs.readFileSync(DB_PATH);
  }
  
  const sqlJsDb = buffer ? new SQL.Database(buffer) : new SQL.Database();
  db = new DatabaseWrapper(sqlJsDb);
  
  // 启用外键
  db.exec('PRAGMA foreign_keys = ON');

  // 一次性迁移记录。生产迁移工具会预写 prepared 标记，避免初始化阶段
  // 再次执行旧版数据清理和财务重算。
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const productionImportPrepared = Boolean(db.prepare(`
    SELECT 1 FROM schema_migrations
    WHERE version = ? AND status IN ('prepared', 'completed')
  `).get(PRODUCTION_IMPORT_MIGRATION));

  // 初始化数据库表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'sales',
      name TEXT NOT NULL,
      department_id TEXT,
      email TEXT,
      phone TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      renew_contract_amount REAL DEFAULT 0,
      new_contract_amount REAL DEFAULT 0,
      payment_amount REAL DEFAULT 0,
      profit_rate REAL DEFAULT 0,
      remark TEXT,
      customer_quota INTEGER DEFAULT 30,
      quarter_target REAL DEFAULT 0,
      FOREIGN KEY (department_id) REFERENCES departments(id)
    )
  `);

  // 迁移：为已存在的 users 表添加缺失字段
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  const addUserCols = [
    { name: 'renew_contract_amount', def: 'REAL DEFAULT 0' },
    { name: 'new_contract_amount', def: 'REAL DEFAULT 0' },
    { name: 'payment_amount', def: 'REAL DEFAULT 0' },
    { name: 'profit_rate', def: 'REAL DEFAULT 0' },
    { name: 'remark', def: 'TEXT' },
    { name: 'customer_quota', def: 'INTEGER DEFAULT 30' },
    { name: 'quarter_target', def: 'REAL DEFAULT 0' }
  ];
  for (const col of addUserCols) {
    if (!userCols.includes(col.name)) {
      try { db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`); } catch(e) {}
    }
  }

  // 部门表（树形结构）
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      manager_id TEXT,
      level INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      member_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES departments(id),
      FOREIGN KEY (manager_id) REFERENCES users(id)
    )
  `);
  
  // 创建部门唯一索引（同级部门名称唯一）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_department_parent_name 
    ON departments(parent_id, name)
  `);

  // 角色表
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 操作日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      content TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 客户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      customer_short_name TEXT,
      type TEXT NOT NULL DEFAULT 'enterprise',
      credit_code TEXT,
      industry TEXT,
      scale TEXT,
      region TEXT,
      address TEXT,
      website TEXT,
      company_phone TEXT,
      contact_person TEXT,
      phone TEXT,
      source TEXT NOT NULL,
      owner_id TEXT,
      department_id TEXT,
      status TEXT NOT NULL DEFAULT 'potential',
      level TEXT,
      intention_product TEXT,
      budget_range TEXT,
      expected_sign_date DATE,
      competitors TEXT,
      follow_stage TEXT DEFAULT 'potential',
      total_amount REAL DEFAULT 0.00,
      last_deal_at DATETIME,
      last_followup_at DATETIME,
      next_followup_at DATETIME,
      public_at DATETIME,
      public_reason TEXT,
      protect_days INTEGER DEFAULT 0,
      notes TEXT,
      internal_notes TEXT,
      creator_id TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);
  
  // 创建客户表索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customer_name ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_customer_credit_code ON customers(credit_code);
    CREATE INDEX IF NOT EXISTS idx_customer_owner ON customers(owner_id);
    CREATE INDEX IF NOT EXISTS idx_customer_status ON customers(status);
    CREATE INDEX IF NOT EXISTS idx_customer_deleted ON customers(is_deleted);
  `);

  // 客户协作成员：客户可由多名销售共同使用，但每个商机仍只有一名负责人
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_members (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      member_role TEXT NOT NULL DEFAULT 'collaborator',
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(customer_id, user_id),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_customer_member_customer ON customer_members(customer_id);
    CREATE INDEX IF NOT EXISTS idx_customer_member_user ON customer_members(user_id);
  `);

  // 客户级售前协作独立于销售归属，公海客户被领取后仍保留指派关系。
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_presales_assignments (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      remark TEXT,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      cancelled_at DATETIME,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_customer_presales_customer
      ON customer_presales_assignments(customer_id, status);
    CREATE INDEX IF NOT EXISTS idx_customer_presales_user
      ON customer_presales_assignments(user_id, status);
  `);

  // 迁移：售前指派已统一收敛到「商机管理」，客户级售前不再作为有效数据源。
  // 这里把存量的客户级活跃售前一次性作废，避免与商机级售前形成两套口径。
  // 该语句是幂等的：作废后不会再有新的 active 写入，后续启动均为 0 行受影响。
  try {
    const voided = db.prepare(`
      UPDATE customer_presales_assignments
      SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
      WHERE status = 'active'
    `).run();
    if (voided && voided.changes > 0) {
      console.log(`✅ 已作废 ${voided.changes} 条存量客户级售前指派（售前改由商机管理统一指派）`);
    }
  } catch (e) {
    console.log('⚠️ 作废存量客户级售前指派失败:', e.message);
  }

  // 客户级 FDE 协作独立于商机级 FDE 指派，不自动授予商机访问权限。
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_fde_assignments (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      remark TEXT,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      cancelled_at DATETIME,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_customer_fde_customer
      ON customer_fde_assignments(customer_id, status);
    CREATE INDEX IF NOT EXISTS idx_customer_fde_user
      ON customer_fde_assignments(user_id, status);
  `);

  // 联系人表
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position TEXT,
      phone TEXT,
      email TEXT,
      wechat TEXT,
      is_primary INTEGER DEFAULT 0,
      is_kp INTEGER DEFAULT 0,
      birthday TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      owner_id TEXT,
      creator_id TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);

  // 销售跟进表
  db.exec(`
    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      contact_id TEXT,
      user_id TEXT NOT NULL,
      followup_time DATE NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'potential',
      result TEXT NOT NULL DEFAULT 'pending',
      next_followup_at DATETIME,
      next_followup_content TEXT,
      attachments TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 跟进提醒表
  db.exec(`
    CREATE TABLE IF NOT EXISTS followup_reminders (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reminder_at DATETIME NOT NULL,
      content TEXT,
      status TEXT NOT NULL DEFAULT 'unread',
      reminder_type TEXT NOT NULL DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 客户标签表
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_tags (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT,
      notes TEXT,
      creator_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);

  // 客户 - 标签关联表
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_tag_relations (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES customer_tags(id) ON DELETE CASCADE
    )
  `);

  // 公海客户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_pool (
      id TEXT PRIMARY KEY,
      customer_id TEXT UNIQUE NOT NULL,
      reason TEXT,
      protect_days INTEGER DEFAULT 0,
      released_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      released_by TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (released_by) REFERENCES users(id)
    )
  `);

  // 合同表
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      contract_no TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      contact_id TEXT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      sign_date DATE,
      effective_date DATE,
      expire_date DATE,
      payment_terms TEXT,
      first_payment_amount REAL,
      first_payment_deadline DATE,
      content TEXT,
      attachments TEXT,
      total_received REAL DEFAULT 0.00,
      unpaid_amount REAL,
      channel_commission_rate REAL,
      creator_id TEXT NOT NULL,
      reviewer_id TEXT,
      review_opinion TEXT,
      reviewed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (creator_id) REFERENCES users(id),
      FOREIGN KEY (reviewer_id) REFERENCES users(id)
    )
  `);

  // 回款表
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      payment_no TEXT UNIQUE NOT NULL,
      contract_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      planned_date DATE,
      actual_date DATE,
      status TEXT NOT NULL DEFAULT '已回款',
      method TEXT,
      our_account TEXT,
      customer_account TEXT,
      voucher TEXT,
      notes TEXT,
      payment_plan_id TEXT,
      creator_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contract_id) REFERENCES contracts(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);

  // 回款提醒表
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_reminders (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reminder_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 售后工单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      deal_id TEXT,
      contract_id TEXT,
      customer_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (deal_id) REFERENCES deals(id),
      FOREIGN KEY (contract_id) REFERENCES contracts(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 系统设置表
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id TEXT PRIMARY KEY,
      key_name TEXT UNIQUE NOT NULL,
      value TEXT,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 商机表
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      contact_id TEXT,
      type TEXT NOT NULL,
      description TEXT,
      products TEXT,
      expected_sign_date DATE,
      competitors TEXT,
      amount REAL NOT NULL DEFAULT 0,
      channel_commission_rate REAL,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'potential',
      creator_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_opportunity_customer ON opportunities(customer_id);
    CREATE INDEX IF NOT EXISTS idx_opportunity_owner ON opportunities(owner_id);
    CREATE INDEX IF NOT EXISTS idx_opportunity_status ON opportunities(status);
  `);

  // 商机技术协作指派：销售负责人之外，售前和 FDE 通过此表参与商机。
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_assignments (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assignment_type TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      cancelled_at DATETIME,
      remark TEXT,
      UNIQUE(opportunity_id, user_id, assignment_type, status),
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_opp_assignment_opp ON opportunity_assignments(opportunity_id, status);
    CREATE INDEX IF NOT EXISTS idx_opp_assignment_user ON opportunity_assignments(user_id, status);
  `);

  const opportunityCols = db.prepare("PRAGMA table_info(opportunities)").all().map(c => c.name);
  if (!opportunityCols.includes('channel_commission_rate')) {
    try { db.exec('ALTER TABLE opportunities ADD COLUMN channel_commission_rate REAL'); } catch(e) {}
  }

  // 合同付款计划表
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_payment_plans (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      payment_no INTEGER NOT NULL,
      payment_amount REAL NOT NULL,
      payment_date DATE NOT NULL,
      payment_status TEXT DEFAULT 'unpaid',
      actual_payment_date DATE,
      actual_amount REAL,
      payment_remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_contract ON contract_payment_plans(contract_id);
  `);

  // 迁移：为已存在的 contract_payment_plans 表添加 actual_amount 字段
  const planCols = db.prepare("PRAGMA table_info(contract_payment_plans)").all().map(c => c.name);
  if (!planCols.includes('actual_amount')) {
    try { db.exec('ALTER TABLE contract_payment_plans ADD COLUMN actual_amount REAL'); console.log('✅ 已添加 contract_payment_plans.actual_amount 字段'); } catch(e) { console.log('⚠️ 添加 actual_amount 字段失败:', e.message); }
  }
  if (!planCols.includes('payment_no')) {
    // 极旧版本可能连 payment_no 都没有
    try { db.exec('ALTER TABLE contract_payment_plans ADD COLUMN payment_no INTEGER DEFAULT 1'); } catch(e) {}
  }

  // 回款记录保留对应付款计划，避免编辑或删除回款时误更新其他期次。
  const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
  if (!paymentCols.includes('payment_plan_id')) {
    try { db.exec('ALTER TABLE payments ADD COLUMN payment_plan_id TEXT'); } catch(e) {}
  }
  if (!productionImportPrepared) {
    db.exec(`
      UPDATE payments
      SET payment_plan_id = (
        SELECT MIN(pp.id)
        FROM contract_payment_plans pp
        WHERE pp.contract_id = payments.contract_id
          AND pp.payment_date = payments.planned_date
          AND pp.payment_status IN ('paid', 'partial')
      )
      WHERE payment_plan_id IS NULL
        AND planned_date IS NOT NULL
        AND 1 = (
          SELECT COUNT(*)
          FROM contract_payment_plans pp
          WHERE pp.contract_id = payments.contract_id
            AND pp.payment_date = payments.planned_date
            AND pp.payment_status IN ('paid', 'partial')
        );

      UPDATE contracts
      SET total_received = COALESCE((
            SELECT SUM(p.amount)
            FROM payments p
            WHERE p.contract_id = contracts.id
              AND p.status IN ('已回款', 'received')
          ), 0),
          unpaid_amount = CASE
            WHEN amount - COALESCE((
              SELECT SUM(p.amount)
              FROM payments p
              WHERE p.contract_id = contracts.id
                AND p.status IN ('已回款', 'received')
            ), 0) > 0
            THEN amount - COALESCE((
              SELECT SUM(p.amount)
              FROM payments p
              WHERE p.contract_id = contracts.id
                AND p.status IN ('已回款', 'received')
            ), 0)
            ELSE 0
          END;
    `);
  }

  // 渠道变更日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_change_logs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      field_name TEXT NOT NULL,
      old_value TEXT,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_log_channel ON channel_change_logs(channel_id);
  `);

  // 变更日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_change_logs (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      field_name TEXT NOT NULL,
      old_value TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_change_logs (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      field_name TEXT NOT NULL,
      old_value TEXT,
      FOREIGN KEY (contract_id) REFERENCES contracts(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_change_logs (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      field_name TEXT NOT NULL,
      old_value TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (changed_by) REFERENCES users(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_change_logs (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_by_name TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      field_name TEXT NOT NULL,
      old_value TEXT,
      FOREIGN KEY (payment_id) REFERENCES payments(id)
    )
  `);

  // 商机状态变更日志表（用于转化时间统计）
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      changed_by TEXT,
      followup_id TEXT,
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_opp_change_opp ON opportunity_change_logs(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_opp_change_time ON opportunity_change_logs(changed_at);
  `);

  // 渠道表
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'active',
      contact_person TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      region TEXT,
      commission_rate REAL DEFAULT 0,
      creator_id TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_status ON channels(status);
    CREATE INDEX IF NOT EXISTS idx_channel_type ON channels(type);
  `);

  // 产品表
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      r_and_d_cost_rate REAL NOT NULL DEFAULT 0,
      description TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_product_status ON products(status);`);

  // 成本记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      category TEXT NOT NULL,
      sub_category TEXT,
      amount REAL NOT NULL DEFAULT 0,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cost_user ON cost_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_cost_month ON cost_entries(month);
    CREATE INDEX IF NOT EXISTS idx_cost_user_month ON cost_entries(user_id, month);
  `);

  // 渠道客户关联表
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_customers (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      customer_id TEXT UNIQUE NOT NULL,
      commission_rate REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_customer_channel ON channel_customers(channel_id);
  `);

  // 渠道-销售关联表（渠道共享）
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      assigned_by TEXT,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, user_id),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_by) REFERENCES users(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_member_channel ON channel_members(channel_id);
    CREATE INDEX IF NOT EXISTS idx_channel_member_user ON channel_members(user_id);
  `);

  // 迁移：为 contracts 表添加缺失字段
  const contractCols = db.prepare("PRAGMA table_info(contracts)").all().map(c => c.name);
  const addContractCols = [
    { name: 'opportunity_id', def: 'TEXT' },
    { name: 'payment_method', def: 'TEXT' },
    { name: 'payment_times', def: 'INTEGER DEFAULT 1' },
    { name: 'payment_plans', def: 'TEXT' },
    { name: 'channel_commission_rate', def: 'REAL' }
  ];
  for (const col of addContractCols) {
    if (!contractCols.includes(col.name)) {
      try { db.exec(`ALTER TABLE contracts ADD COLUMN ${col.name} ${col.def}`); } catch(e) {}
    }
  }

  // 迁移：为 followups 表添加缺失字段
  const followupCols = db.prepare("PRAGMA table_info(followups)").all().map(c => c.name);
  if (!followupCols.includes('opportunity_id')) {
    try { db.exec('ALTER TABLE followups ADD COLUMN opportunity_id TEXT'); } catch(e) {}
  }
  if (!followupCols.includes('work_type')) {
    try { db.exec("ALTER TABLE followups ADD COLUMN work_type TEXT DEFAULT 'sales'"); } catch(e) {}
  }

  // 合同交付跟进：由售前负责记录技术沟通、实施、验收等里程碑
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_records (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      opportunity_id TEXT,
      owner_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'technical_handover',
      status TEXT NOT NULL DEFAULT 'pending',
      content TEXT NOT NULL,
      planned_at DATE,
      completed_at DATETIME,
      next_action TEXT,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id),
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_contract ON delivery_records(contract_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_owner ON delivery_records(owner_id);
  `);



  // 迁移：渠道成本表
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_costs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      description TEXT,
      expense_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 迁移：为 customers 表添加缺失字段
  const customerCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
  const addCustomerCols = [
    { name: 'secondary_owner_id', def: 'TEXT' },
    { name: 'shared_at', def: 'DATETIME' },
    { name: 'owner_share_percent', def: 'REAL DEFAULT NULL' },
    { name: 'channel_name', def: 'TEXT' },
    { name: 'channel_id', def: 'TEXT' },
    // 归属起点时间：销售领取公海客户或管理员分配客户时写入，
    // 用于「公海倒计时」计算，存量客户保持 NULL（不回填）
    { name: 'claimed_at', def: 'DATETIME' }
  ];
  for (const col of addCustomerCols) {
    if (!customerCols.includes(col.name)) {
      try { db.exec(`ALTER TABLE customers ADD COLUMN ${col.name} ${col.def}`); } catch(e) {}
    }
  }

  // 插入默认系统设置
  const settingsExist = db.prepare('SELECT id FROM system_settings WHERE key_name = ?').get('public_recycle_days');
  if (!settingsExist) {
    const settings = [
      { key: 'public_recycle_days', value: '30', desc: '私有客户无跟进自动移入公海天数' },
      { key: 'contract_expire_remind_days', value: '7', desc: '合同到期提前提醒天数' },
      { key: 'payment_remind_days', value: '3', desc: '回款到期提前提醒天数' },
      { key: 'followup_remind_minutes', value: '15', desc: '跟进提醒提前分钟数' },
      { key: 'max_customer_per_sales', value: '100', desc: '每个销售最大客户池数量' }
    ];
    for (const s of settings) {
      db.prepare(`
        INSERT INTO system_settings (id, key_name, value, description)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), s.key, s.value, s.desc);
    }
  }

  // 创建默认管理员账户
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (id, username, password, role, name, email)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('admin-001', 'admin', hashedPassword, 'admin', '系统管理员', 'admin@crm.com');
  }

  // 统一历史角色语义，旧运营统计账号迁移为只读运营，旧售后账号迁移为销售。
  db.prepare("UPDATE users SET role = 'operations', updated_at = CURRENT_TIMESTAMP WHERE role = 'statistician'").run();
  db.prepare("UPDATE users SET role = 'sales', updated_at = CURRENT_TIMESTAMP WHERE role = 'after_sales'").run();

  const operationsPermissions = JSON.stringify({ customers: 'r', opportunities: 'r', followups: 'r', stats: 'r', public_customers: 'c' });
  db.prepare("UPDATE roles SET name = '运营', permissions = ? WHERE id = 'role-005' AND name IN ('统计员', '运营')")
    .run(operationsPermissions);

  // 创建默认角色
  const rolesExist = db.prepare('SELECT id FROM roles WHERE name = ?').get('超级管理员');
  if (!rolesExist) {
    const roles = [
      { id: 'role-001', name: '超级管理员', permissions: JSON.stringify({ all: true }) },
      { id: 'role-002', name: '管理员', permissions: JSON.stringify({ users: 'rw', customers: 'rw', contracts: 'rw', deals: 'rw', stats: 'r' }) },
      { id: 'role-003', name: '销售', permissions: JSON.stringify({ customers: 'rw', contacts: 'rw', followups: 'rw', contracts: 'rw', deals: 'rw' }) },
      { id: 'role-004', name: '售后', permissions: JSON.stringify({ customers: 'r', contacts: 'r', tickets: 'rw' }) },
      { id: 'role-005', name: '运营', permissions: JSON.stringify({ stats: 'r', exports: 'r' }) }
    ];
    for (const r of roles) {
      db.prepare(`
        INSERT INTO roles (id, name, permissions)
        VALUES (?, ?, ?)
      `).run(r.id, r.name, r.permissions);
    }
  }

  // 兼容已有数据库，独立补齐新增角色。
  const extraRoles = [
    { id: 'role-006', name: '售前', permissions: JSON.stringify({ customers: 'r', opportunities: 'rw', followups: 'rw', contracts: 'rw', deliveries: 'rw' }) },
    { id: 'role-008', name: 'FDE', permissions: JSON.stringify({ opportunities: 'r', followups: 'rw', deliveries: 'rw' }) },
    { id: 'role-009', name: 'FDE管理员', permissions: JSON.stringify({ opportunities: 'r', followups: 'r', fde_assignments: 'rw', deliveries: 'rw' }) }
  ];
  for (const role of extraRoles) {
    if (!db.prepare('SELECT id FROM roles WHERE name = ?').get(role.name)) {
      db.prepare('INSERT INTO roles (id, name, permissions) VALUES (?, ?, ?)')
        .run(role.id, role.name, role.permissions);
    }
  }

  // 将旧版主/副销售关系迁移为多成员关系，迁移可重复执行。
  db.exec(`
    INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
    SELECT 'owner-' || id, id, owner_id, 'owner', creator_id FROM customers WHERE owner_id IS NOT NULL;
    INSERT OR IGNORE INTO customer_members (id, customer_id, user_id, member_role, created_by)
    SELECT 'secondary-' || id, id, secondary_owner_id, 'collaborator', creator_id FROM customers WHERE secondary_owner_id IS NOT NULL;
  `);

  // 普通数据库保留既有的兼容清理。一次性生产导入由迁移工具处理并记录，
  // 这里必须跳过，避免再次覆盖历史时间和财务口径。
  if (!productionImportPrepared) {
    db.exec(`
      DELETE FROM opportunity_change_logs WHERE opportunity_id NOT IN (SELECT id FROM opportunities);
      DELETE FROM opportunity_assignments WHERE opportunity_id NOT IN (SELECT id FROM opportunities) OR user_id NOT IN (SELECT id FROM users);
      DELETE FROM delivery_records WHERE contract_id NOT IN (SELECT id FROM contracts) OR customer_id NOT IN (SELECT id FROM customers);
      DELETE FROM contract_payment_plans WHERE contract_id NOT IN (SELECT id FROM contracts);
      DELETE FROM contract_change_logs WHERE contract_id NOT IN (SELECT id FROM contracts);
      DELETE FROM payment_change_logs WHERE payment_id NOT IN (SELECT id FROM payments);
      DELETE FROM customer_change_logs WHERE customer_id NOT IN (SELECT id FROM customers);
      DELETE FROM contact_change_logs WHERE contact_id NOT IN (SELECT id FROM contacts);
      DELETE FROM followup_reminders WHERE customer_id NOT IN (SELECT id FROM customers) OR user_id NOT IN (SELECT id FROM users);
      UPDATE opportunities SET contact_id = NULL WHERE contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts);
      DELETE FROM opportunities WHERE customer_id NOT IN (SELECT id FROM customers);
      UPDATE followups SET followup_time = created_at WHERE followup_time IS NOT NULL AND date(followup_time) IS NULL;

      UPDATE contract_payment_plans
      SET actual_amount = NULLIF(COALESCE((
            SELECT SUM(p.amount) FROM payments p
            WHERE p.payment_plan_id = contract_payment_plans.id AND p.status IN ('已回款', 'received')
          ), 0), 0),
          actual_payment_date = (
            SELECT MAX(p.actual_date) FROM payments p
            WHERE p.payment_plan_id = contract_payment_plans.id AND p.status IN ('已回款', 'received')
          ),
          payment_status = CASE
            WHEN COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.payment_plan_id = contract_payment_plans.id AND p.status IN ('已回款', 'received')), 0) <= 0 THEN 'unpaid'
            WHEN COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.payment_plan_id = contract_payment_plans.id AND p.status IN ('已回款', 'received')), 0) + 0.01 < payment_amount THEN 'partial'
            ELSE 'paid'
          END;
    `);
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS prevent_duplicate_opportunity_insert
    BEFORE INSERT ON opportunities
    WHEN EXISTS (
      SELECT 1 FROM opportunities o
      WHERE o.customer_id = NEW.customer_id
        AND LOWER(TRIM(o.products)) = LOWER(TRIM(NEW.products))
        AND strftime('%Y', o.expected_sign_date) = strftime('%Y', NEW.expected_sign_date)
    )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate opportunity for customer, product and year');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_duplicate_opportunity_update
    BEFORE UPDATE OF customer_id, products, expected_sign_date ON opportunities
    WHEN EXISTS (
      SELECT 1 FROM opportunities o
      WHERE o.id != NEW.id AND o.customer_id = NEW.customer_id
        AND LOWER(TRIM(o.products)) = LOWER(TRIM(NEW.products))
        AND strftime('%Y', o.expected_sign_date) = strftime('%Y', NEW.expected_sign_date)
    )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate opportunity for customer, product and year');
    END;
  `);

  db.enablePersistence();

  console.log('数据库初始化完成');
}

function getDb() {
  return db;
}

// 使用 Proxy 让 db 在运行时动态获取
const dbProxy = new Proxy({}, {
  get(target, prop) {
    const instance = getDb();
    if (!instance) {
      throw new Error('Database not initialized. Call initDatabase() first.');
    }
    const value = instance[prop];
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  }
});

module.exports = { db: dbProxy, initDatabase, getDb };
