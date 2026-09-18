# 部署与升级

本文档对应当前项目结构：前端由 Vite 构建，后端 Express 在生产环境统一提供前端静态文件和 `/api` 接口，数据库使用 `sql.js` 保存为 SQLite 文件。

## 一、生产目录

建议目录结构：

```text
/opt/beilian-crm/
├── backend/
├── frontend/
├── database/
│   ├── crm.db
│   └── .jwt-secret
└── backups/
```

生产数据库不要放在 `backend/` 下。默认路径是项目根目录的 `database/crm.db`，也可以通过 `CRM_DB_PATH` 指定绝对路径。

## 二、首次部署

```bash
cd /opt/beilian-crm
npm run install:all

cd frontend
npm run build

cd ../backend
CRM_DB_PATH=/opt/beilian-crm/database/crm.db \
PORT=3001 HOST=127.0.0.1 \
npm start
```

浏览器不应直接访问 3001，生产环境建议由 Nginx、Caddy 或云负载均衡器提供 HTTPS 和域名入口。

## 三、使用 PM2 运行

```bash
cd /opt/beilian-crm/backend
CRM_DB_PATH=/opt/beilian-crm/database/crm.db \
PORT=3001 HOST=127.0.0.1 \
pm2 start src/server.js --name beilian-crm
pm2 save
pm2 startup
```

查看状态和日志：

```bash
pm2 status
pm2 logs beilian-crm
```

健康检查：

```bash
curl http://127.0.0.1:3001/api/health
```

## 四、Nginx 反向代理

由于后端已经提供 `frontend/dist`，只需要代理到后端：

```nginx
server {
    listen 80;
    server_name crm.example.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

正式环境应配置 HTTPS，并将 3001 端口限制为本机访问。

## 五、升级流程

从 v0.1 升级到当前版本时，禁止让新代码直接启动旧数据库，也不能使用本地数据库覆盖生产数据库。必须使用一次性迁移工具，以停服后的最终备份为只读来源，生成独立的新数据库文件。

核心顺序为：

```text
准备新代码 -> 停服 -> 最终备份 -> dry-run
-> apply 生成新库 -> 新代码连接新库 -> 验收 -> 开放访问
```

一次性迁移命令入口：

```bash
npm run migrate:production -- --help
```

其他已经完成一次性迁移的后续版本升级，也必须先备份并在数据库副本上验证，不能把启动时的兼容迁移当作备份替代品。

## 六、回滚原则

代码回滚和数据库回滚必须分开评估：

1. 先停止服务并保留当前数据库副本。
2. 回退代码到已验证版本。
3. 只有确认数据库结构与旧版本兼容时，才恢复数据库备份。
4. 启动后检查健康接口、登录、客户、商机、合同和回款数据。

不要在没有备份的情况下覆盖生产数据库。

## 七、生产环境配置

支持的环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端端口，默认 `3001` |
| `HOST` | 监听地址，反向代理时建议 `127.0.0.1` |
| `CRM_DB_PATH` | SQLite 文件绝对路径 |
| `JWT_SECRET` | 固定的 JWT 密钥；未设置时使用 `database/.jwt-secret` |

生产环境至少应完成以下配置：

- 使用 HTTPS。
- 设置稳定的 `JWT_SECRET`，并限制配置文件权限。
- 修改默认管理员密码。
- 不将 3001 端口暴露到公网。
- 按日备份 `database/crm.db` 和 `database/.jwt-secret`，并定期验证备份可恢复。

## 八、当前 CI/CD 状态

仓库当前没有完整的 CI/CD 配置。建议后续流水线至少执行：

```bash
npm run build --prefix frontend
git diff --check
```

生产发布建议采用“备份数据库 → 拉取代码 → 安装依赖 → 构建前端 → 重启应用 → 健康检查”的顺序，并保留上一版构建产物和数据库备份。
