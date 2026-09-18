#!/bin/bash
# 基于脚本所在目录解析路径，避免硬编码绝对路径
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR/backend"

# 检查是否已经在运行
if lsof -ti:3001 > /dev/null; then
    echo "⚠️  端口3001已被占用，正在重启..."
    kill $(lsof -ti:3001) 2>/dev/null
    sleep 1
fi

mkdir -p "$ROOT_DIR/logs"
nohup node src/server.js > "$ROOT_DIR/logs/server.log" 2>&1 &
echo "🚀 CRM系统已后台启动 (PID: $!)"
sleep 2
if lsof -ti:3001 > /dev/null; then
    echo "✅ 服务正常运行: http://localhost:3001"
else
    echo "❌ 启动失败，请查看日志: logs/server.log"
fi
