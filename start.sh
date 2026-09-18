#!/bin/bash

echo "🚀 启动 CRM 系统..."

# 检查端口是否被占用
if lsof -ti:3001 > /dev/null; then
    echo "❌ 错误：端口 3001 已被占用"
    echo "请运行：kill -9 \$(lsof -ti:3001)"
    exit 1
fi

# 启动后端
echo "📦 启动后端服务..."
cd "$(dirname "$0")/backend"
node src/server.js &
BACKEND_PID=$!

# 等待后端启动
echo "等待后端服务启动..."
sleep 3

# 检查后端是否成功启动
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "❌ 后端服务启动失败"
    exit 1
fi

# 检查前端目录是否存在
if [ -d "$(dirname "$0")/frontend" ]; then
    echo "🎨 启动前端服务..."
    cd "$(dirname "$0")/frontend"
    npm run dev &
    FRONTEND_PID=$!
    echo ""
    echo "✅ 服务启动完成!"
    echo "📍 前端地址：http://localhost:3000"
    echo "📍 后端地址：http://localhost:3001"
    echo "📝 默认账号：admin / admin123"
else
    echo "⚠️  前端目录不存在，仅启动后端服务"
    echo ""
    echo "✅ 后端服务启动完成!"
    echo "📍 后端地址：http://localhost:3001"
    echo "📊 API 健康检查：http://localhost:3001/api/health"
    echo "📝 默认账号：admin / admin123"
fi

echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待进程
wait
