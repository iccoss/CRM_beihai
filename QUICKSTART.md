# 快速开始

## 1. 准备环境

要求：

- Node.js 18+
- npm
- 可写的项目目录

## 2. 安装依赖

```bash
cd <项目目录>
npm run install:all
```

该命令会依次安装根目录、后端和前端依赖。

## 3. 启动开发环境

```bash
npm run dev
```

启动后：

- 前端：`http://localhost:8080`
- 后端：`http://localhost:3001`
- 前端 `/api` 请求自动代理到后端

也可以分开启动：

```bash
npm run server   # 后端
npm run client   # 前端
```

停止服务时，在对应终端按 `Ctrl+C`。不要通过删除数据库文件来解决启动问题。

## 4. 首次登录

新数据库默认账号：

```text
账号：admin
密码：admin123
```

首次登录后立即修改密码。密码由后端使用 bcrypt 哈希保存，不是明文存储。

## 5. 数据库位置

默认数据库为：

```text
<项目目录>/database/crm.db
```

数据库不存在时，后端会自动创建并执行初始化迁移。正式环境升级前请备份 `crm.db` 和 `database/.jwt-secret`。

## 6. 生产构建

```bash
cd <项目目录>/frontend
npm run build
cd ../backend
npm start
```

构建完成后，后端会从 `frontend/dist` 提供前端页面，并继续提供 `/api` 接口。生产环境建议使用 Nginx 或其他反向代理，并将后端绑定到 `127.0.0.1`。

## 7. 常见检查

检查后端健康状态：

```bash
curl http://localhost:3001/api/health
```

检查端口是否被占用：

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

如果前端打开但接口报错，先确认后端已经启动，并检查浏览器请求是否指向 `/api`。
