const { db } = require('../database');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 读取「私有客户无跟进自动移入公海」的天数配置，默认 30 天，最小 1 天
function getRecycleDays() {
  const setting = db.prepare(
    "SELECT value FROM system_settings WHERE key_name = 'public_recycle_days'"
  ).get();
  return Math.max(1, parseInt(setting?.value || '30', 10));
}

// 公海回收的计时基线（表别名固定为 c）。
// 取值口径：最近跟进时间 → 跟进表最新记录时间 → 客户创建时间，
// 再与「归属起点时间 claimed_at」（领取/分配时写入）取较大值，
// 保证刚领取或刚分配的客户从归属当天开始重新计时，不会因为
// 沿用上一任销售的旧跟进时间而在当晚立刻被回收。
// 注意：所有时间戳均由 CURRENT_TIMESTAMP 写入，格式一致可直接用 max() 比较。
const RECYCLE_BASELINE_SQL = `max(COALESCE(
        c.last_followup_at,
        (SELECT MAX(f.created_at) FROM followups f WHERE f.customer_id = c.id),
        c.created_at
      ), COALESCE(c.claimed_at, ''))`;

function getLocalDateOffset(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function recycleInactiveCustomers() {
  const recycleDays = getRecycleDays();
  const cutoffDate = getLocalDateOffset(recycleDays);

  const staleCustomers = db.prepare(`
    SELECT c.id
    FROM customers c
    WHERE c.is_deleted = 0
      AND c.status != 'public'
      AND c.owner_id IS NOT NULL
      AND date(${RECYCLE_BASELINE_SQL}) <= date(?)
  `).all(cutoffDate);

  if (staleCustomers.length === 0) return 0;

  const release = db.transaction(() => {
    for (const customer of staleCustomers) {
      db.prepare(`
        UPDATE customers SET
          status = 'public', owner_id = NULL, secondary_owner_id = NULL,
          department_id = NULL, public_at = CURRENT_TIMESTAMP,
          public_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(`连续${recycleDays}天无跟进，系统自动归入公海`, customer.id);
      db.prepare('DELETE FROM customer_members WHERE customer_id = ?').run(customer.id);
    }
  });

  release();
  return staleCustomers.length;
}

function startCustomerRecycleJob() {
  const execute = () => {
    try {
      const count = recycleInactiveCustomers();
      if (count > 0) console.log(`自动归入公海客户：${count} 个`);
    } catch (error) {
      console.error('客户自动归入公海任务失败:', error);
    }
  };

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(24, 5, 0, 0);
  const timer = setTimeout(() => {
    execute();
    const interval = setInterval(execute, ONE_DAY_MS);
    interval.unref?.();
  }, nextRun.getTime() - now.getTime());
  timer.unref?.();
  return timer;
}

module.exports = {
  recycleInactiveCustomers,
  startCustomerRecycleJob,
  getRecycleDays,
  getLocalDateOffset,
  RECYCLE_BASELINE_SQL
};
