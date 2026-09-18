#!/usr/bin/env node
/**
 * 一次性脚本：为「已签」商机回填缺失的状态变更日志（sql.js 版本）
 *
 * 背景：创建合同时后端会把关联商机置为 signed，但历史上没有同步写 opportunity_change_logs。
 * 开周会的「季度历史状态快照」依赖这张表还原各季度末的状态，
 * 缺少签约日志会导致这些商机在历史季度里一直停留在签约前的状态。
 *
 * 回填规则：
 *  - 只处理 status = 'signed' 且没有任何 to_status = 'signed' 日志的商机；
 *  - changed_at 优先取该商机最早一份合同的 created_at（即状态被真正翻转的时刻），
 *    没有合同则退回合同签订日 sign_date（取当天中午，避免时区换算跨天），
 *    再退回商机的 updated_at / created_at；
 *  - changed_at 不早于商机创建时间；
 *  - from_status 取签约时刻之前最后一条日志的 to_status，没有则为 NULL；
 *  - changed_by 取合同创建人，其次商机负责人。
 *
 * 用法：
 *   node backend/scripts/backfill-signed-change-logs.js            # 执行回填并写回数据库
 *   node backend/scripts/backfill-signed-change-logs.js --dry-run  # 只打印将要回填的数据，不写库
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '../../database/crm.db');
const DRY_RUN = process.argv.includes('--dry-run');

// 执行查询并返回对象数组（sql.js 的 prepare + step 模式）
function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

(async () => {
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  // 待回填的商机：当前已签，但日志里没有签约记录
  const targets = queryAll(db, `
    SELECT
      o.id,
      o.name,
      o.owner_id,
      o.created_at,
      o.updated_at,
      (SELECT ct.created_at FROM contracts ct
        WHERE ct.opportunity_id = o.id AND ct.created_at IS NOT NULL
        ORDER BY ct.created_at LIMIT 1) AS contract_created_at,
      (SELECT ct.sign_date FROM contracts ct
        WHERE ct.opportunity_id = o.id AND ct.sign_date IS NOT NULL
        ORDER BY ct.sign_date LIMIT 1) AS contract_sign_date,
      (SELECT ct.creator_id FROM contracts ct
        WHERE ct.opportunity_id = o.id AND ct.created_at IS NOT NULL
        ORDER BY ct.created_at LIMIT 1) AS contract_creator_id
    FROM opportunities o
    WHERE o.status = 'signed'
      AND NOT EXISTS (
        SELECT 1 FROM opportunity_change_logs cl
        WHERE cl.opportunity_id = o.id AND cl.to_status = 'signed'
      )
    ORDER BY o.created_at
  `);

  console.log(`${DRY_RUN ? '[试运行] ' : ''}待回填签约日志的商机共 ${targets.length} 条\n`);

  const insertStmt = db.prepare(`
    INSERT INTO opportunity_change_logs (opportunity_id, from_status, to_status, changed_at, changed_by)
    VALUES (?, ?, 'signed', ?, ?)
  `);

  let inserted = 0;
  for (const opp of targets) {
    // 1) 计算签约时刻：合同创建时间 > 合同签订日（取中午）> 商机更新时间 > 商机创建时间
    let changedAt = null;
    if (opp.contract_created_at) {
      changedAt = String(opp.contract_created_at);
    } else if (opp.contract_sign_date) {
      changedAt = `${String(opp.contract_sign_date).slice(0, 10)} 12:00:00`;
    } else if (opp.updated_at) {
      changedAt = String(opp.updated_at);
    } else if (opp.created_at) {
      changedAt = String(opp.created_at);
    }
    // 签约时刻不能早于商机创建时间，否则快照会把「已签」提前到创建之前
    if (opp.created_at && changedAt && changedAt < String(opp.created_at)) {
      changedAt = String(opp.created_at);
    }

    // 2) from_status：签约时刻之前最后一条日志的目标状态
    const prevLog = changedAt
      ? queryAll(db, `
          SELECT to_status FROM opportunity_change_logs
          WHERE opportunity_id = ? AND changed_at < ?
          ORDER BY changed_at DESC, id DESC LIMIT 1
        `, [opp.id, changedAt])
      : [];
    const fromStatus = prevLog.length > 0 ? prevLog[0].to_status : null;

    // 3) changed_by：合同创建人优先，其次商机负责人
    const changedBy = opp.contract_creator_id || opp.owner_id || null;

    console.log(
      `  ${String(opp.name).padEnd(20)} from=${String(fromStatus || 'NULL').padEnd(12)} ` +
      `at=${changedAt || 'NULL'} by=${changedBy || 'NULL'}`
    );

    if (!DRY_RUN && changedAt) {
      insertStmt.run([opp.id, fromStatus, changedAt, changedBy]);
      inserted += 1;
    }
  }
  insertStmt.free();

  if (DRY_RUN) {
    db.close();
    console.log('\n[试运行] 未写入数据库');
    return;
  }

  // 回写数据库文件
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();

  console.log(`\n✅ 已回填 ${inserted} 条签约状态变更日志`);
})().catch((err) => {
  console.error('回填失败:', err);
  process.exit(1);
});
