-- 商机管理表
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  contact_id TEXT,
  type TEXT NOT NULL,
  description TEXT,
  products TEXT,
  budget_range TEXT,
  expected_sign_date DATE,
  competitors TEXT,
  amount REAL NOT NULL DEFAULT 0,
  expected_close_date DATE NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'potential',
  creator_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (owner_id) REFERENCES users(id),
  FOREIGN KEY (creator_id) REFERENCES users(id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_opportunity_customer ON opportunities(customer_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_owner ON opportunities(owner_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opportunity_close_date ON opportunities(expected_close_date);
