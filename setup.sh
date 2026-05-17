#!/bin/bash
# 拾字 · Voicetype Studio · 一键安装脚本
# 用法：bash setup.sh

set -e
cd "$(dirname "$0")"

echo "════════════════════════════════════════════════"
echo "  拾字 · Voicetype Studio 安装"
echo "════════════════════════════════════════════════"
echo ""

# 1. 检查 macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ 这个脚本只在 macOS 上跑（mlx-whisper 仅支持 Apple Silicon）"
  echo "   非 Mac 用户参考 README 的「非 Apple Silicon 适配」一节"
  exit 1
fi

# 2. 检查芯片
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "⚠️  检测到 Intel Mac。mlx-whisper 仅在 Apple Silicon 上跑。"
  echo "   建议把 requirements.txt 里的 mlx-whisper 换成 faster-whisper"
  echo "   是否继续？(y/N)"
  read -r ans
  [[ "$ans" != "y" ]] && exit 1
fi

# 3. 检查 / 安装 Homebrew
if ! command -v brew &> /dev/null; then
  echo "▸ 没找到 Homebrew，正在安装..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# 4. yt-dlp + ffmpeg
echo ""
echo "▸ 检查 yt-dlp 与 ffmpeg ..."
for cmd in yt-dlp ffmpeg; do
  if command -v $cmd &> /dev/null; then
    echo "  ✓ $cmd 已安装：$(which $cmd)"
  else
    echo "  ✗ $cmd 缺失，brew install ..."
    brew install $cmd
  fi
done

# 5. Python
echo ""
echo "▸ 检查 Python ..."
if ! command -v python3 &> /dev/null; then
  echo "  ✗ 缺 python3，brew install ..."
  brew install python@3.12
fi
PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "  ✓ Python $PY_VER"

# 6. venv
echo ""
echo "▸ 创建虚拟环境 .venv/ ..."
if [[ -d .venv ]]; then
  echo "  ✓ .venv 已存在，跳过"
else
  python3 -m venv .venv
  echo "  ✓ 已创建"
fi

# 7. 装依赖
echo ""
echo "▸ 安装 Python 依赖（首次约 2-5 分钟）..."
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "  ✓ 完成"

# 8. 启动脚本可执行
chmod +x 启动.command

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅ 安装完成"
echo "════════════════════════════════════════════════"
echo ""
echo "启动方式："
echo "  ① 终端：bash 启动.command"
echo "  ② Finder：双击「启动.command」"
echo ""
echo "首次跑会自动从 Hugging Face 下 whisper 模型权重（约 1.5 GB）"
echo "浏览器会自动打开 http://127.0.0.1:7860"
echo ""
