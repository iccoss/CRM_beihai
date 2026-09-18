#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const MIGRATION_VERSION = 'v01-production-import-20260817';
const MIGRATION_NAME = 'CRM v0.1 production data import';
const REQUIRED_SOURCE_TABLES = [
  'users',
  'customers',
  'contacts',
  'followups',
  'opportunities',
  'contracts',
  'contract_payment_plans',
  'payments',
  'roles',
  'system_settings'
];
function usage() {
  return `
Usage:
  npm run migrate:production -- --source-db <crm.db> --output-db <crm.db.migrated> [--report <report.json>] --dry-run
  npm run migrate:production -- --source-db <crm.db> --output-db <crm.db.migrated> [--report <report.json>] --apply
  npm run migrate:production -- --source-sql <backup.sql> --output-db <crm.db.migrated> [--report <report.json>] --dry-run
  npm run migrate:production -- --source-sql <backup.sql> --output-db <crm.db.migrated> [--report <report.json>] --apply

Rules:
  - Exactly one of --source-db and --source-sql is required.
  - Exactly one of --dry-run and --apply is required.
  - The source is never modified.
  - The output and report paths must not already exist.
`;
}

function parseArgs(argv) {
  const args = { modes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') args.modes.push('dry-run');
    else if (token === '--apply') args.modes.push('apply');
    else if (['--source-db', '--source-sql', '--output-db', '--report'].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a path`);
      args[token.slice(2)] = value;
      index += 1;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (args.modes.length === 1) args.mode = args.modes[0];
  return args;
}

function resolveExistingFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${resolved}`);
  return resolved;
}

function resolveNewFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) throw new Error(`${label} already exists: ${resolved}`);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`${label} parent directory does not exist: ${parent}`);
  }
  return resolved;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stableId(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}

function queryAll(sqlDb, sql, params = []) {
  const statement = sqlDb.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function queryOne(sqlDb, sql, params = []) {
  return queryAll(sqlDb, sql, params)[0];
}

function runSql(sqlDb, sql, params = []) {
  const statement = sqlDb.prepare(sql);
  try {
    statement.bind(params);
    statement.step();
  } finally {
    statement.free();
  }
  return sqlDb.getRowsModified();
}

function tableExistsRaw(sqlDb, tableName) {
  return Boolean(queryOne(sqlDb, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]));
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function tableCountsRaw(sqlDb) {
  const tables = queryAll(sqlDb, `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const counts = {};
  for (const { name } of tables) {
    counts[name] = Number(queryOne(sqlDb, `SELECT COUNT(*) AS total FROM ${quoteIdentifier(name)}`).total || 0);
  }
  return counts;
}

function tableCounts(db) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  const counts = {};
  for (const { name } of tables) {
    counts[name] = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(name)}`).get().total || 0);
  }
  return counts;
}

function financialSnapshotRaw(sqlDb) {
  const result = queryOne(sqlDb, `
    SELECT
      COALESCE(SUM(amount), 0) AS contract_amount,
      COALESCE(SUM(total_received), 0) AS total_received,
      COALESCE(SUM(unpaid_amount), 0) AS unpaid_amount
    FROM contracts
  `);
  return {
    contractAmount: Number(result.contract_amount || 0),
    totalReceived: Number(result.total_received || 0),
    unpaidAmount: Number(result.unpaid_amount || 0),
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(queryAll(sqlDb, `
      SELECT id, amount, total_received, unpaid_amount
      FROM contracts ORDER BY id
    `))).digest('hex')
  };
}

function financialSnapshot(db) {
  const result = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0) AS contract_amount,
      COALESCE(SUM(total_received), 0) AS total_received,
      COALESCE(SUM(unpaid_amount), 0) AS unpaid_amount
    FROM contracts
  `).get();
  return {
    contractAmount: Number(result.contract_amount || 0),
    totalReceived: Number(result.total_received || 0),
    unpaidAmount: Number(result.unpaid_amount || 0),
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(db.prepare(`
      SELECT id, amount, total_received, unpaid_amount
      FROM contracts ORDER BY id
    `).all())).digest('hex')
  };
}

function duplicateOpportunityGroupsRaw(sqlDb) {
  return Number(queryOne(sqlDb, `
    SELECT COUNT(*) AS total FROM (
      SELECT customer_id, LOWER(TRIM(products)) AS product_key,
             strftime('%Y', expected_sign_date) AS sign_year, COUNT(*) AS amount
      FROM opportunities
      WHERE strftime('%Y', expected_sign_date) IS NOT NULL
      GROUP BY customer_id, product_key, sign_year
      HAVING amount > 1
    )
  `).total || 0);
}

function prepareSourceSchema(sqlDb) {
  const missingTables = REQUIRED_SOURCE_TABLES.filter(tableName => !tableExistsRaw(sqlDb, tableName));
  if (missingTables.length) throw new Error(`Source is missing required tables: ${missingTables.join(', ')}`);

  const integrity = queryOne(sqlDb, 'PRAGMA integrity_check');
  if (!integrity || integrity.integrity_check !== 'ok') {
    throw new Error(`Source integrity check failed: ${JSON.stringify(integrity || {})}`);
  }

  if (tableExistsRaw(sqlDb, 'schema_migrations')) {
    const existing = queryOne(sqlDb, 'SELECT status FROM schema_migrations WHERE version = ?', [MIGRATION_VERSION]);
    if (existing) throw new Error(`Source already contains migration ${MIGRATION_VERSION} (${existing.status})`);
  }

  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const operationsRole = queryOne(sqlDb, "SELECT id FROM roles WHERE name = '运营'");
  if (!operationsRole) {
    const legacyRole = queryOne(sqlDb, `
      SELECT id FROM roles
      WHERE name IN ('统计员', '销售运营')
      ORDER BY CASE name WHEN '统计员' THEN 0 ELSE 1 END
      LIMIT 1
    `);
    if (legacyRole) {
      runSql(sqlDb, `
        UPDATE roles
        SET name = '运营', status = 'active',
            permissions = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [JSON.stringify({ stats: 'r', exports: 'r', public_customers: 'c' }), legacyRole.id]);
    }
  }

  runSql(sqlDb, `
    INSERT INTO schema_migrations (version, name, status, details)
    VALUES (?, ?, 'prepared', ?)
  `, [MIGRATION_VERSION, MIGRATION_NAME, JSON.stringify({ preparedBy: 'migrate-v01-production.js' })]);
}

function normalizeLegacyDateTime(value) {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
  ) return null;

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-') + ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function createQuarantine(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_quarantine (
      id TEXT PRIMARY KEY,
      migration_version TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_row_id TEXT,
      reason TEXT NOT NULL,
      original_row TEXT NOT NULL,
      quarantined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function quarantineRow(db, tableName, rowId, reason, row) {
  const id = stableId('quarantine', MIGRATION_VERSION, tableName, String(rowId || ''), reason);
  db.prepare(`
    INSERT OR IGNORE INTO migration_quarantine
      (id, migration_version, source_table, source_row_id, reason, original_row)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, MIGRATION_VERSION, tableName, rowId === undefined ? null : String(rowId), reason, JSON.stringify(row));
}

function quarantineAndDelete(db, tableName, idColumn, reason, whereSql, params = []) {
  if (!tableExists(db, tableName)) return 0;
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${whereSql}`).all(...params);
  for (const row of rows) quarantineRow(db, tableName, row[idColumn], reason, row);
  if (rows.length) db.prepare(`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${whereSql}`).run(...params);
  return rows.length;
}

function quarantineAndClearReference(db, tableName, idColumn, columnName, reason, whereSql, params = []) {
  if (!tableExists(db, tableName)) return 0;
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${whereSql}`).all(...params);
  for (const row of rows) quarantineRow(db, tableName, row[idColumn], reason, row);
  if (rows.length) {
    db.prepare(`UPDATE ${quoteIdentifier(tableName)} SET ${quoteIdentifier(columnName)} = NULL WHERE ${whereSql}`).run(...params);
  }
  return rows.length;
}

function migrateOrphans(db, summary) {
  summary.orphans = {
    contractPaymentPlans: quarantineAndDelete(
      db,
      'contract_payment_plans',
      'id',
      'contract_id does not reference an existing contract',
      'contract_id NOT IN (SELECT id FROM contracts)'
    ),
    opportunities: 0,
    opportunityContactsCleared: 0,
    dependentRows: 0,
    otherLogs: 0
  };

  const orphanOpportunities = db.prepare(`
    SELECT * FROM opportunities
    WHERE customer_id NOT IN (SELECT id FROM customers)
  `).all();
  for (const opportunity of orphanOpportunities) {
    const opportunityId = opportunity.id;
    summary.orphans.dependentRows += quarantineAndDelete(
      db, 'opportunity_change_logs', 'id',
      'opportunity_id references a quarantined opportunity',
      'opportunity_id = ?', [opportunityId]
    );
    summary.orphans.dependentRows += quarantineAndDelete(
      db, 'opportunity_assignments', 'id',
      'opportunity_id references a quarantined opportunity',
      'opportunity_id = ?', [opportunityId]
    );
    summary.orphans.dependentRows += quarantineAndDelete(
      db, 'delivery_records', 'id',
      'opportunity_id references a quarantined opportunity',
      'opportunity_id = ?', [opportunityId]
    );
    summary.orphans.dependentRows += quarantineAndClearReference(
      db, 'followups', 'id', 'opportunity_id',
      'opportunity_id references a quarantined opportunity',
      'opportunity_id = ?', [opportunityId]
    );
    summary.orphans.dependentRows += quarantineAndClearReference(
      db, 'contracts', 'id', 'opportunity_id',
      'opportunity_id references a quarantined opportunity',
      'opportunity_id = ?', [opportunityId]
    );
    quarantineRow(db, 'opportunities', opportunityId, 'customer_id does not reference an existing customer', opportunity);
    db.prepare('DELETE FROM opportunities WHERE id = ?').run(opportunityId);
    summary.orphans.opportunities += 1;
  }

  summary.orphans.opportunityContactsCleared = quarantineAndClearReference(
    db,
    'opportunities',
    'id',
    'contact_id',
    'contact_id does not reference an existing contact',
    'contact_id IS NOT NULL AND contact_id NOT IN (SELECT id FROM contacts)'
  );

  const cleanupRules = [
    ['opportunity_change_logs', 'id', 'opportunity_id does not reference an existing opportunity', 'opportunity_id NOT IN (SELECT id FROM opportunities)'],
    ['opportunity_assignments', 'id', 'opportunity or user does not exist', 'opportunity_id NOT IN (SELECT id FROM opportunities) OR user_id NOT IN (SELECT id FROM users)'],
    ['delivery_records', 'id', 'contract or customer does not exist', 'contract_id NOT IN (SELECT id FROM contracts) OR customer_id NOT IN (SELECT id FROM customers)'],
    ['contract_change_logs', 'id', 'contract_id does not reference an existing contract', 'contract_id NOT IN (SELECT id FROM contracts)'],
    ['payment_change_logs', 'id', 'payment_id does not reference an existing payment', 'payment_id NOT IN (SELECT id FROM payments)'],
    ['customer_change_logs', 'id', 'customer_id does not reference an existing customer', 'customer_id NOT IN (SELECT id FROM customers)'],
    ['contact_change_logs', 'id', 'contact_id does not reference an existing contact', 'contact_id NOT IN (SELECT id FROM contacts)'],
    ['followup_reminders', 'id', 'customer or user does not exist', 'customer_id NOT IN (SELECT id FROM customers) OR user_id NOT IN (SELECT id FROM users)']
  ];
  for (const [tableName, idColumn, reason, whereSql] of cleanupRules) {
    summary.orphans.otherLogs += quarantineAndDelete(db, tableName, idColumn, reason, whereSql);
  }
}

function migrateFollowupTimes(db, summary) {
  const rows = db.prepare('SELECT id, followup_time FROM followups WHERE followup_time IS NOT NULL').all();
  let normalized = 0;
  const invalidIds = [];
  for (const row of rows) {
    const value = normalizeLegacyDateTime(row.followup_time);
    if (!value) {
      invalidIds.push(row.id);
      continue;
    }
    if (value !== row.followup_time) {
      db.prepare('UPDATE followups SET followup_time = ? WHERE id = ?').run(value, row.id);
      normalized += 1;
    }
  }
  if (invalidIds.length) {
    throw new Error(`Unable to normalize ${invalidIds.length} followup timestamps`);
  }
  summary.followupTimes = { scanned: rows.length, normalized, invalid: invalidIds.length };
}

function linkPaymentsToPlans(db, summary) {
  const payments = db.prepare(`
    SELECT id, contract_id, planned_date
    FROM payments
    WHERE payment_plan_id IS NULL AND planned_date IS NOT NULL
  `).all();
  let linked = 0;
  let unmatched = 0;
  let ambiguous = 0;
  const linkedPlanIds = new Set();

  for (const payment of payments) {
    const plans = db.prepare(`
      SELECT id FROM contract_payment_plans
      WHERE contract_id = ? AND payment_date = ? AND payment_status IN ('paid', 'partial')
      ORDER BY id
    `).all(payment.contract_id, payment.planned_date);
    if (plans.length === 1) {
      db.prepare('UPDATE payments SET payment_plan_id = ? WHERE id = ?').run(plans[0].id, payment.id);
      linkedPlanIds.add(plans[0].id);
      linked += 1;
    } else if (plans.length === 0) unmatched += 1;
    else ambiguous += 1;
  }

  for (const planId of linkedPlanIds) {
    const actual = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount, MAX(actual_date) AS actual_date
      FROM payments
      WHERE payment_plan_id = ? AND status IN ('已回款', 'received')
    `).get(planId);
    db.prepare(`
      UPDATE contract_payment_plans
      SET actual_amount = NULLIF(?, 0), actual_payment_date = COALESCE(?, actual_payment_date)
      WHERE id = ?
    `).run(Number(actual.amount || 0), actual.actual_date || null, planId);
  }

  summary.paymentPlanLinks = { scanned: payments.length, linked, unmatched, ambiguous };
}

function migrateLegacyChannels(db, summary) {
  const channelNames = db.prepare(`
    SELECT TRIM(channel_name) AS name, MIN(created_at) AS created_at
    FROM customers
    WHERE TRIM(COALESCE(channel_name, '')) <> ''
    GROUP BY TRIM(channel_name)
    ORDER BY TRIM(channel_name)
  `).all();

  const fallbackAdmin = db.prepare(`
    SELECT id FROM users WHERE role IN ('admin', 'super_admin') ORDER BY created_at, id LIMIT 1
  `).get();
  let channelsCreated = 0;
  let customerLinksCreated = 0;
  let membersCreated = 0;

  for (const legacyChannel of channelNames) {
    let channel = db.prepare('SELECT id FROM channels WHERE TRIM(name) = ? ORDER BY created_at, id LIMIT 1').get(legacyChannel.name);
    const ownerStats = db.prepare(`
      SELECT owner_id AS user_id, COUNT(*) AS customer_count
      FROM customers c
      INNER JOIN users u ON u.id = c.owner_id AND u.role = 'sales'
      WHERE TRIM(c.channel_name) = ? AND c.owner_id IS NOT NULL
      GROUP BY owner_id
      UNION ALL
      SELECT secondary_owner_id AS user_id, COUNT(*) AS customer_count
      FROM customers c
      INNER JOIN users u ON u.id = c.secondary_owner_id AND u.role = 'sales'
      WHERE TRIM(c.channel_name) = ? AND c.secondary_owner_id IS NOT NULL
      GROUP BY secondary_owner_id
      ORDER BY customer_count DESC, user_id
    `).all(legacyChannel.name, legacyChannel.name);
    const creatorId = ownerStats[0]?.user_id || fallbackAdmin?.id || null;

    if (!channel) {
      const typeStats = db.prepare(`
        SELECT
          SUM(CASE WHEN type = 'external_channel' THEN 1 ELSE 0 END) AS external_count,
          SUM(CASE WHEN type = 'company_channel' THEN 1 ELSE 0 END) AS company_count
        FROM customers WHERE TRIM(channel_name) = ?
      `).get(legacyChannel.name);
      const channelType = Number(typeStats.external_count || 0) > 0
        ? 'agent'
        : (Number(typeStats.company_count || 0) > 0 ? 'integrator' : 'other');
      const channelId = stableId('legacy-channel', legacyChannel.name);
      const channelCode = `LEGACY-${crypto.createHash('sha256').update(legacyChannel.name).digest('hex').slice(0, 12).toUpperCase()}`;
      db.prepare(`
        INSERT INTO channels
          (id, name, code, type, status, commission_rate, creator_id, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
      `).run(
        channelId,
        legacyChannel.name,
        channelCode,
        channelType,
        creatorId,
        '由 v0.1 历史客户渠道名称迁移生成',
        legacyChannel.created_at || new Date().toISOString(),
        legacyChannel.created_at || new Date().toISOString()
      );
      channel = { id: channelId };
      channelsCreated += 1;
    }

    const customers = db.prepare(`
      SELECT id FROM customers WHERE TRIM(channel_name) = ? ORDER BY created_at, id
    `).all(legacyChannel.name);
    for (const customer of customers) {
      db.prepare('UPDATE customers SET channel_id = ? WHERE id = ?').run(channel.id, customer.id);
      const existingLink = db.prepare('SELECT id FROM channel_customers WHERE customer_id = ?').get(customer.id);
      if (!existingLink) {
        db.prepare(`
          INSERT INTO channel_customers (id, channel_id, customer_id, commission_rate)
          VALUES (?, ?, ?, NULL)
        `).run(stableId('legacy-channel-customer', channel.id, customer.id), channel.id, customer.id);
        customerLinksCreated += 1;
      }
    }

    const uniqueOwners = [];
    const seenOwners = new Set();
    for (const owner of ownerStats) {
      if (!owner.user_id || seenOwners.has(owner.user_id)) continue;
      seenOwners.add(owner.user_id);
      uniqueOwners.push(owner.user_id);
    }
    for (let index = 0; index < uniqueOwners.length; index += 1) {
      const userId = uniqueOwners[index];
      const existingMember = db.prepare('SELECT id FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
      if (!existingMember) {
        db.prepare(`
          INSERT INTO channel_members (id, channel_id, user_id, role, assigned_by)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          stableId('legacy-channel-member', channel.id, userId),
          channel.id,
          userId,
          index === 0 ? 'primary' : 'member',
          fallbackAdmin?.id || creatorId
        );
        membersCreated += 1;
      }
    }
  }

  summary.channels = {
    legacyNames: channelNames.length,
    channelsCreated,
    customerLinksCreated,
    membersCreated
  };
}

function finalizeRoles(db, summary) {
  db.prepare(`
    UPDATE roles
    SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
    WHERE name IN ('统计员', '销售运营', '售后')
  `).run();
  const rows = db.prepare('SELECT name, status FROM roles ORDER BY id').all();
  summary.roles = {
    userCounts: db.prepare('SELECT role, COUNT(*) AS total FROM users GROUP BY role ORDER BY role').all(),
    metadata: rows
  };
}

function runDataMigration(db) {
  const summary = {};
  const migrate = db.transaction(() => {
    createQuarantine(db);
    migrateFollowupTimes(db, summary);
    migrateOrphans(db, summary);
    linkPaymentsToPlans(db, summary);
    migrateLegacyChannels(db, summary);
    finalizeRoles(db, summary);
    db.prepare(`
      UPDATE schema_migrations
      SET status = 'completed', details = ?, applied_at = CURRENT_TIMESTAMP
      WHERE version = ?
    `).run(JSON.stringify(summary), MIGRATION_VERSION);
  });
  migrate();
  return summary;
}

function approximatelyEqual(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.005;
}

function buildValidation(db, baseline, migrationSummary) {
  const integrityRow = db.prepare('PRAGMA integrity_check').get();
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  const postCounts = tableCounts(db);
  const postFinancials = financialSnapshot(db);
  const invalidFollowupTimes = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM followups
    WHERE followup_time IS NOT NULL AND date(followup_time) IS NULL
  `).get().total || 0);
  const duplicateOpportunityGroups = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT customer_id, LOWER(TRIM(products)) AS product_key,
             strftime('%Y', expected_sign_date) AS sign_year, COUNT(*) AS amount
      FROM opportunities
      WHERE strftime('%Y', expected_sign_date) IS NOT NULL
      GROUP BY customer_id, product_key, sign_year
      HAVING amount > 1
    )
  `).get().total || 0);
  const marker = db.prepare('SELECT status FROM schema_migrations WHERE version = ?').get(MIGRATION_VERSION);

  const checks = [];
  const addCheck = (name, passed, actual, expected) => checks.push({ name, passed: Boolean(passed), actual, expected });
  addCheck('database_integrity', integrityRow?.integrity_check === 'ok', integrityRow?.integrity_check, 'ok');
  addCheck('foreign_key_violations', foreignKeyViolations.length === 0, foreignKeyViolations.length, 0);
  addCheck('invalid_followup_times', invalidFollowupTimes === 0, invalidFollowupTimes, 0);
  addCheck(
    'duplicate_opportunity_groups_not_increased',
    duplicateOpportunityGroups <= baseline.duplicateOpportunityGroups,
    duplicateOpportunityGroups,
    `<= ${baseline.duplicateOpportunityGroups}`
  );
  addCheck('migration_marker', marker?.status === 'completed', marker?.status || null, 'completed');

  for (const tableName of ['users', 'customers', 'contacts', 'followups', 'contracts', 'payments']) {
    addCheck(`${tableName}_count`, postCounts[tableName] === baseline.counts[tableName], postCounts[tableName], baseline.counts[tableName]);
  }
  addCheck(
    'opportunities_count',
    postCounts.opportunities === baseline.counts.opportunities - migrationSummary.orphans.opportunities,
    postCounts.opportunities,
    baseline.counts.opportunities - migrationSummary.orphans.opportunities
  );
  addCheck(
    'contract_payment_plans_count',
    postCounts.contract_payment_plans === baseline.counts.contract_payment_plans - migrationSummary.orphans.contractPaymentPlans,
    postCounts.contract_payment_plans,
    baseline.counts.contract_payment_plans - migrationSummary.orphans.contractPaymentPlans
  );
  addCheck('contract_amount_preserved', approximatelyEqual(postFinancials.contractAmount, baseline.financials.contractAmount), postFinancials.contractAmount, baseline.financials.contractAmount);
  addCheck('total_received_preserved', approximatelyEqual(postFinancials.totalReceived, baseline.financials.totalReceived), postFinancials.totalReceived, baseline.financials.totalReceived);
  addCheck('unpaid_amount_preserved', approximatelyEqual(postFinancials.unpaidAmount, baseline.financials.unpaidAmount), postFinancials.unpaidAmount, baseline.financials.unpaidAmount);
  addCheck('contract_financial_rows_preserved', postFinancials.fingerprint === baseline.financials.fingerprint, postFinancials.fingerprint, baseline.financials.fingerprint);
  addCheck('legacy_channels_created', postCounts.channels >= baseline.legacyChannelNames, postCounts.channels, `>= ${baseline.legacyChannelNames}`);
  addCheck('legacy_channel_customers_linked', postCounts.channel_customers >= baseline.legacyChannelCustomers, postCounts.channel_customers, `>= ${baseline.legacyChannelCustomers}`);

  return {
    passed: checks.every(check => check.passed),
    checks,
    integrity: integrityRow?.integrity_check || null,
    foreignKeyViolations,
    postCounts,
    postFinancials,
    invalidFollowupTimes,
    duplicateOpportunityGroups
  };
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const sourceCount = Number(Boolean(args['source-db'])) + Number(Boolean(args['source-sql']));
  if (sourceCount !== 1) throw new Error('Exactly one of --source-db and --source-sql is required');
  if (args.modes.length !== 1) throw new Error('Exactly one of --dry-run and --apply is required');
  if (!args['output-db']) throw new Error('--output-db is required');

  const sourceKind = args['source-db'] ? 'database' : 'sql';
  const sourcePath = resolveExistingFile(args['source-db'] || args['source-sql'], 'Source');
  const outputPath = resolveNewFile(args['output-db'], 'Output');
  const reportPath = args.report ? resolveNewFile(args.report, 'Report') : null;
  if (sourcePath === outputPath) throw new Error('Source and output paths must be different');

  // Keep the working database beside the requested output so the final rename
  // is atomic even when /tmp and the application data directory are on different filesystems.
  const tempDirectory = fs.mkdtempSync(path.join(path.dirname(outputPath), '.crm-production-migration-'));
  const workingPath = path.join(tempDirectory, 'crm.db.migrating');
  const report = {
    migrationVersion: MIGRATION_VERSION,
    mode: args.mode,
    startedAt: new Date().toISOString(),
    source: { kind: sourceKind, path: sourcePath, sha256: sha256File(sourcePath) },
    output: { requestedPath: outputPath },
    status: 'running'
  };

  try {
    const SQL = await initSqlJs();
    let sourceDb;
    if (sourceKind === 'database') {
      sourceDb = new SQL.Database(fs.readFileSync(sourcePath));
    } else {
      sourceDb = new SQL.Database();
      sourceDb.exec(fs.readFileSync(sourcePath, 'utf8'));
    }

    const foreignKeyViolations = queryAll(sourceDb, 'PRAGMA foreign_key_check');
    const counts = tableCountsRaw(sourceDb);
    const financials = financialSnapshotRaw(sourceDb);
    const duplicateOpportunityGroups = duplicateOpportunityGroupsRaw(sourceDb);
    const legacyChannelNames = Number(queryOne(sourceDb, `
      SELECT COUNT(DISTINCT TRIM(channel_name)) AS total
      FROM customers WHERE TRIM(COALESCE(channel_name, '')) <> ''
    `).total || 0);
    const legacyChannelCustomers = Number(queryOne(sourceDb, `
      SELECT COUNT(*) AS total FROM customers
      WHERE TRIM(COALESCE(channel_name, '')) <> ''
    `).total || 0);
    report.baseline = {
      counts,
      financials,
      duplicateOpportunityGroups,
      foreignKeyViolationCount: foreignKeyViolations.length,
      foreignKeyViolations,
      legacyChannelNames,
      legacyChannelCustomers
    };

    prepareSourceSchema(sourceDb);
    fs.writeFileSync(workingPath, Buffer.from(sourceDb.export()), { mode: 0o600, flag: 'wx' });
    sourceDb.close();

    process.env.CRM_DB_PATH = workingPath;
    process.env.CRM_SKIP_STARTUP_BACKUP = '1';
    const { initDatabase, getDb } = require('../src/database');
    await initDatabase();
    const db = getDb();
    report.migration = runDataMigration(db);
    report.validation = buildValidation(db, report.baseline, report.migration);
    report.source.sha256After = sha256File(sourcePath);
    report.validation.checks.push({
      name: 'source_file_unchanged',
      passed: report.source.sha256After === report.source.sha256,
      actual: report.source.sha256After,
      expected: report.source.sha256
    });
    report.validation.passed = report.validation.checks.every(check => check.passed);
    if (!report.validation.passed) {
      const failedChecks = report.validation.checks.filter(check => !check.passed).map(check => check.name);
      throw new Error(`Migration validation failed: ${failedChecks.join(', ')}`);
    }

    report.status = 'passed';
    report.finishedAt = new Date().toISOString();

    if (args.mode === 'apply') {
      fs.renameSync(workingPath, outputPath);
      fs.chmodSync(outputPath, 0o600);
      report.output.created = true;
      report.output.sha256 = sha256File(outputPath);
    } else {
      report.output.created = false;
    }

    writeReport(reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    report.error = error.message;
    if (reportPath && !fs.existsSync(reportPath)) writeReport(reportPath, report);
    throw error;
  } finally {
    if (fs.existsSync(tempDirectory)) fs.rmSync(tempDirectory, { recursive: true, force: false });
  }
}

main().catch(error => {
  process.stderr.write(`Migration failed: ${error.message}\n`);
  process.exitCode = 1;
});
