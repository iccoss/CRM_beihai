-- 客户管理模块优化 - 添加渠道名称字段
-- 执行时间：2026-04-12

-- 添加渠道名称字段
ALTER TABLE customers ADD COLUMN channel_name TEXT;

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_customer_channel_name ON customers(channel_name);
