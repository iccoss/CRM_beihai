-- 客户共享功能 - 添加副销售字段
ALTER TABLE customers ADD COLUMN secondary_owner_id TEXT;
ALTER TABLE customers ADD COLUMN shared_at DATETIME;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_customer_secondary_owner ON customers(secondary_owner_id);
