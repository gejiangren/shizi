#!/bin/bash
# 双击启动「拾字」视频转文字应用

cd "$(dirname "$0")"
source .venv/bin/activate

echo "════════════════════════════════════════════════"
echo "  🎬 拾字 · 视频转文字"
echo "  http://127.0.0.1:7860  (浏览器会自动打开)"
echo "  关闭：在这个窗口按 Ctrl+C"
echo "════════════════════════════════════════════════"

# 启动 FastAPI，然后等待 1 秒再开浏览器
(sleep 1.2 && open "http://127.0.0.1:7860") &
python server.py
