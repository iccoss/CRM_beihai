const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('./database');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const departmentRoutes = require('./routes/departments');
const customerRoutes = require('./routes/customers');
const customerTagRoutes = require('./routes/customer-tags');
const contactRoutes = require('./routes/contacts');
const followupRoutes = require('./routes/followups');
const contractRoutes = require('./routes/contracts');
const paymentRoutes = require('./routes/payments');
const statsRoutes = require('./routes/stats');
const opportunityRoutes = require('./routes/opportunities');
const channelRoutes = require('./routes/channels');
const costRoutes = require('./routes/costs');
const productRoutes = require('./routes/products');
const deliveryRoutes = require('./routes/deliveries');
const settingRoutes = require('./routes/settings');
const { startCustomerRecycleJob } = require('./services/customer-recycle');


const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// 检查前端是否存在（本地用 dist/，服务器上部署脚本会把 dist 内容放到 frontend/ 根目录）
let frontendDistPath = path.join(__dirname, '../../frontend/dist');
if (!fs.existsSync(frontendDistPath)) {
  frontendDistPath = path.join(__dirname, '../../frontend');
}
const hasFrontend = fs.existsSync(frontendDistPath);

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务（前端，仅当存在时）
if (hasFrontend) {
  app.use(express.static(frontendDistPath));
  console.log('📁 前端静态文件服务已启用');
} else {
  console.log('⚠️  前端目录不存在，仅 API 模式运行');
}

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/customer-tags', customerTagRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/followups', followupRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/costs', costRoutes);
app.use('/api/products', productRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/settings', settingRoutes);


// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    frontend: hasFrontend,
    apiDocs: '/api/health'
  });
});

// API 根路径欢迎信息
app.get('/', (req, res) => {
  if (hasFrontend) {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  } else {
    res.json({
      message: 'CRM 系统 API 服务',
      status: 'running',
      endpoints: {
        health: '/api/health',
        auth: '/api/auth',
        users: '/api/users',
        customers: '/api/customers',
        contacts: '/api/contacts',
        followups: '/api/followups',
        contracts: '/api/contracts',
        payments: '/api/payments',
        stats: '/api/stats'
      },
      note: '前端未部署，请使用 API 或 Postman 测试'
    });
  }
});

// SPA 回退路由（仅当前端存在时）
if (hasFrontend) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// 错误处理
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 初始化数据库并启动服务
initDatabase()
  .then(() => {
    startCustomerRecycleJob();
    app.listen(PORT, HOST, () => {
      console.log(`\n🚀 CRM 系统后端服务已启动`);
      console.log(`📍 访问地址：http://localhost:${PORT}`);
      console.log(`📊 API 文档：http://localhost:${PORT}/api/health\n`);
    });
  })
  .catch((error) => {
    console.error('启动失败:', error);
    process.exit(1);
  });
