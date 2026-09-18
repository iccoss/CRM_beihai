#!/bin/bash
PID=$(lsof -ti:3001 2>/dev/null)
if [ -n "$PID" ]; then
    kill $PID
    echo "✅ CRM系统已停止 (原PID: $PID)"
else
    echo "⚠️  没有在3001端口运行的进程"
fi
