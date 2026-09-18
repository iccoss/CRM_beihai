#!/bin/bash
# 切换到脚本所在目录下的 backend，避免硬编码绝对路径
cd "$(dirname "$0")/backend"
node src/server.js
