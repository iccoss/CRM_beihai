-- 客户共享分成比例字段
ALTER TABLE customers ADD COLUMN owner_share_percent INTEGER DEFAULT 50;
