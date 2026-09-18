# Git 仓库使用说明

## 仓库信息

- **仓库位置**: 当前项目目录
- **当前分支**: 使用 `git branch --show-current` 查看
- **远程仓库**: 使用 `git remote -v` 查看
- **工作区状态**: 使用 `git status --short` 查看

## 🔧 Git 配置

### 设置用户信息（首次使用）
```bash
git config --global user.name "你的名字"
git config --global user.email "you@example.com"
```

### 查看当前配置
```bash
git config --list
```

## 📝 常用 Git 命令

### 查看状态
```bash
# 查看仓库状态
git status

# 查看提交历史
git log --oneline

# 查看文件变更
git diff
```

### 提交代码
```bash
# 添加所有变更
git add -A

# 或添加指定文件
git add frontend/src/views/Dashboard.vue
git add backend/src/routes/customers.js

# 提交变更
git commit -m "feat: 新增客户管理功能"

# 推送当前分支到远程仓库（确认远程地址和分支后执行）
git push origin HEAD
```

### 分支管理
```bash
# 创建并切换到开发分支
git switch -c feature/new-feature

# 切换到目标分支并合并
git switch main
git merge feature/new-feature

# 删除分支
git branch -d feature/new-feature
```

### 安全撤销与版本查看
```bash
# 查看提交历史
git log --oneline

# 查看指定版本内容，不修改工作区
git show <commit>

# 撤销尚未暂存的单个文件修改（确认文件没有需要保留的内容后执行）
git restore -- <filename>

# 暂存当前工作，切换分支处理其他事情
git stash push -u -m "临时保存"
git stash list
git stash pop
```

不要在没有确认和备份的情况下使用 `git reset --hard` 或覆盖生产数据库。

## 📂 .gitignore 说明

已配置忽略以下文件：
- `node_modules/` - 依赖包
- `dist/` - 构建输出
- `*.db` - 数据库文件
- `.env` - 环境配置
- `*.log` - 日志文件
- `.DS_Store` - 系统文件

## 🚀 推送到远程仓库

### 1. 创建 GitHub 仓库
1. 访问 https://github.com
2. 创建新仓库 `crm-system`
3. 不要初始化 README

### 2. 关联远程仓库
```bash
# 添加远程仓库
git remote add origin https://github.com/your-username/crm-system.git

# 推送代码
git push -u origin main
```

### 3. 推送到 Gitee（码云）
```bash
# 添加远程仓库
git remote add origin https://gitee.com/your-username/crm-system.git

# 推送代码
git push -u origin main
```

### 4. 推送到阿里云 Code
```bash
# 添加远程仓库
git remote add origin https://code.aliyun.com/your-username/crm-system.git

# 推送代码
git push -u origin main
```

## 📊 提交规范

### Commit Message 格式
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type 类型
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具相关

### 示例
```bash
# 新功能
git commit -m "feat(customers): 添加客户标签管理功能"

# 修复 bug
git commit -m "fix(contracts): 修复合同到期提醒查询错误"

# 文档更新
git commit -m "docs: 更新部署文档"

# 重构
git commit -m "refactor(followups): 重构跟进记录查询逻辑"
```

## 🔍 查看代码统计

```bash
# 查看各语言代码量
git ls-files | grep '\.vue$' | xargs wc -l
git ls-files | grep '\.js$' | xargs wc -l

# 查看提交者贡献
git shortlog -sn

# 查看文件变更历史
git log --follow frontend/src/views/Dashboard.vue
```

## ⚠️ 注意事项

1. **数据库文件不提交**
   - `*.db` 文件已在 `.gitignore` 中忽略
   - 部署时手动上传或使用迁移脚本

2. **环境配置不提交**
   - `.env` 文件包含敏感信息
   - 使用 `.env.example` 作为模板

3. **依赖包不提交**
   - `node_modules/` 已忽略
   - 使用 `package.json` 管理依赖

4. **定期提交**
   - 完成功能后及时提交
   - 提交前测试确保代码正常

## 📖 相关文档

- 部署文档：`DEPLOYMENT.md`
- 快速开始：`QUICKSTART.md`

---

提交前请确认代码、数据库和生产配置没有被误加入版本库。
