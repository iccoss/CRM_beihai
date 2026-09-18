# 贝海 CRM

贝海 CRM 是一个面向内部销售团队的客户、商机、合同、回款和销售运营管理系统。

## 当前架构

项目是一个没有 workspace manager 的双包单体仓库：

```text
backend/          Express API、SQLite 数据访问和权限控制
frontend/         Vue 3 + Vite + Element Plus 单页应用
database/         crm.db，运行时自动创建，已被 Git 忽略
```

- 后端入口：`backend/src/server.js`
- 前端入口：`frontend/src/main.js`
- 数据库：`sql.js` 驱动的 SQLite，数据库文件默认位于 `database/crm.db`
- 开发前端：`http://localhost:8080`
- 后端 API：`http://localhost:3001`
- 生产环境：前端构建到 `frontend/dist` 后，由后端统一提供静态文件和 API

## 本地运行

要求 Node.js 18 或更高版本。

首次安装：

```bash
cd <项目目录>
npm run install:all
```

开发模式，同时启动前后端：

```bash
npm run dev
```

只启动后端：

```bash
npm run server
```

只启动前端：

```bash
npm run client
```

访问 `http://localhost:8080`。开发服务器会将 `/api` 请求代理到 `http://localhost:3001`。

停止服务：在运行终端按 `Ctrl+C`。检查端口：

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

## 生产运行

先构建前端，再启动后端：

```bash
cd <项目目录>/frontend
npm run build
cd ../backend
npm start
```

支持的主要环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端监听端口 |
| `HOST` | `0.0.0.0` | 后端监听地址；反向代理场景建议使用 `127.0.0.1` |
| `CRM_DB_PATH` | `database/crm.db` | 数据库文件路径，生产环境建议配置绝对路径 |
| `JWT_SECRET` | 自动生成并保存 | JWT 密钥；生产环境应通过环境变量固定配置 |

例如：

```bash
cd <项目目录>/backend
CRM_DB_PATH=/opt/beilian-crm/database/crm.db PORT=3001 HOST=127.0.0.1 npm start
```

## 数据库与数据安全

- 数据库使用 `sql.js`，后端启动时加载 WASM 并执行内置迁移。
- 数据会自动保存，进程运行期间设置了 30 秒自动保存周期。
- 不要删除或覆盖 `database/crm.db`，升级前应先备份。
- JWT 密钥默认保存在数据库文件旁的 `database/.jwt-secret`；生产升级时应与数据库一起备份，避免已有会话失效。
- 密码使用 `bcryptjs` 哈希保存，不保存明文密码。
- 新数据库默认管理员为 `admin` / `admin123`，首次登录后必须立即修改密码。

## 角色与数据权限

系统当前使用以下角色语境：

| 角色 | 数据范围 | 主要能力 |
| --- | --- | --- |
| 系统管理员 | 全部数据 | 全部业务操作、用户与系统配置、金额数据 |
| 运营 | 全部数据 | 全部数据只读，可新增公海客户；不可操作商机 |
| 销售 | 自己负责或关联的数据 | 管理自己的客户、商机和跟进，可查看金额并协作指派售前/FDE |
| 售前 | 被指派的客户、商机 | 技术沟通和跟进，不显示合同金额、回款金额、渠道分成等金额 |
| FDE | 被指派的客户、商机 | 技术交流后参与跟进，不显示商业金额 |
| FDE 管理员 | 全部技术相关数据 | 管理 FDE 指派和技术数据，不显示金额 |

成本管理当前仅对系统管理员开放；客户交付菜单暂时隐藏，待后续功能完善后再启用。

## 核心业务流程

```text
客户 → 商机（必须关联客户） → 销售跟进
                         ↘ 售前 / FDE 技术协作
商机签约 → 合同录入 → 回款计划 → 回款登记
```

- 同一年、同一产品不允许重复建立多个商机。
- 一个客户可以关联多个销售和多个商机；销售之间按商机跟踪，客户可以共享。
- 客户可以设置客户级别的默认售前和 FDE，商机也可以单独指定并覆盖默认人员。
- 公海客户被销售领取后，原有客户级别售前/FDE 指派继续保留。
- 客户在配置的自然日内没有新增跟进，会自动释放到公海；最短配置为 1 天。

## 主要功能

- 数据概览：按月、季度、年度查看客户、在跟商机、合同和回款指标；不同角色按权限显示数据和金额。
- 客户管理与公海客户：客户归属、客户级售前/FDE、领取、释放和导出。
- 商机管理：负责人、售前、FDE、状态流转、金额、跟进和导出。
- 跟进管理：销售、售前、FDE、管理员均可新增跟进，列表默认展示每个商机最新三条记录。
- 合同与回款：合同签订后生成回款计划，支持回款登记、提醒、统计和异常查看。
- 开周会：季度签约目标、在跟商机、合同、待回款和销售周度进展分析。

## 主要 API

路由统一挂载在 `/api` 下，主要模块包括：

`auth`、`users`、`customers`、`contacts`、`followups`、`opportunities`、`contracts`、`payments`、`stats`、`channels`、`costs`、`products`。

数据概览相关接口包括：

- `/api/stats/dashboard-period-summary`
- `/api/stats/customer-opportunity-status`
- `/api/stats/recent-followups`

健康检查：

```bash
curl http://localhost:3001/api/health
```

## 发布前检查

```bash
cd <项目目录>
npm run build --prefix frontend
git diff --check
```

生产升级和备份流程请参见 [DEPLOYMENT.md](./DEPLOYMENT.md)，快速上手请参见 [QUICKSTART.md](./QUICKSTART.md)。
