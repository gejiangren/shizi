#!/bin/bash
# 拾字 · Voicetype Studio · 首次安装向导
# 双击即可，自动装好 Homebrew / Python / ffmpeg / yt-dlp + Python 依赖

set -e

# 进入项目根目录（installer/ 的上级）
cd "$(dirname "$0")/.."

clear
cat <<'BANNER'
════════════════════════════════════════════════════════════

   拾字 · Voicetype Studio · 首次安装向导

   把任何视频变成可读的文字 · macOS 本地工具

════════════════════════════════════════════════════════════

这个向导会自动装好以下东西（已装的会跳过）：
  ① Homebrew（macOS 包管理器，必备）
  ② Python 3.12（运行后端）
  ③ ffmpeg、yt-dlp（视频处理）
  ④ Python 依赖（mlx-whisper、fastapi 等）
  ⑤ 1.5 GB Whisper 模型权重（首次启动 拾字.app 时下）

预计耗时：3-8 分钟（看网速）。中途让你输 Mac 密码是正常的，
那是 Homebrew 装东西要权限。

╭──────────────────────────────────────────────────────────╮
│  开始之前请确认：                                            │
│  · Mac 是 Apple Silicon（M 系列芯片）                       │
│  · 装好后用 拾字.app 双击启动                                  │
╰──────────────────────────────────────────────────────────╯

BANNER

read -p "按回车开始安装... " dummy

# 1. 检查芯片
if [[ "$(uname -m)" != "arm64" ]]; then
  echo ""
  echo "⚠️ 检测到 Intel Mac。mlx-whisper 仅在 Apple Silicon 上跑。"
  echo "   你仍然可以装，但实际上要把 requirements.txt 里的 mlx-whisper 换成"
  echo "   faster-whisper（README 有说明）。"
  echo ""
  read -p "继续？(y/N) " a; [[ "$a" != "y" ]] && exit 1
fi

# 2. Homebrew
echo ""
echo "▸ [1/5] 检查 Homebrew ..."
if command -v brew >/dev/null 2>&1; then
  echo "  ✓ 已装：$(which brew)"
else
  echo "  ✗ 未装。下面会自动装，需要你输 Mac 密码（输密码时屏幕不显示，正常）。"
  echo "  按回车继续，或 Ctrl+C 退出。"
  read dummy
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 配 brew 到 PATH（M 系列默认在 /opt/homebrew）
  if [[ -d /opt/homebrew/bin ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi

# 3. yt-dlp + ffmpeg
echo ""
echo "▸ [2/5] 检查 yt-dlp 和 ffmpeg ..."
for cmd in yt-dlp ffmpeg; do
  if command -v $cmd >/dev/null 2>&1; then
    echo "  ✓ $cmd 已装"
  else
    echo "  ⏳ brew install $cmd ..."
    brew install $cmd
  fi
done

# 4. Python
echo ""
echo "▸ [3/5] 检查 Python 3.10+ ..."
if command -v python3 >/dev/null 2>&1; then
  PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
  PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
  PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
  if [[ $PY_MAJOR -lt 3 || ( $PY_MAJOR -eq 3 && $PY_MINOR -lt 10 ) ]]; then
    echo "  ⏳ Python $PY_VER 太老，brew install python@3.12 ..."
    brew install python@3.12
  else
    echo "  ✓ Python $PY_VER"
  fi
else
  echo "  ⏳ brew install python@3.12 ..."
  brew install python@3.12
fi

# 5. venv + Python 依赖
echo ""
echo "▸ [4/5] 创建虚拟环境 .venv/ 并装 Python 依赖（首次约 2-3 分钟）..."
if [[ -d .venv ]]; then
  echo "  ✓ .venv 已存在，跳过创建"
else
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "  ✓ 依赖装好"

# 6. 给 .app 加可执行权限 + 拖到 Applications 提示
echo ""
echo "▸ [5/5] 准备 启动 / 停止 .app ..."
chmod +x installer/拾字.app/Contents/MacOS/applet 2>/dev/null
chmod +x installer/停止拾字.app/Contents/MacOS/applet 2>/dev/null
codesign --force --deep --sign - installer/拾字.app 2>/dev/null
codesign --force --deep --sign - installer/停止拾字.app 2>/dev/null
echo "  ✓ 已签名"

# 完成
cat <<'DONE'

════════════════════════════════════════════════════════════
   ✅  安装完成！
════════════════════════════════════════════════════════════

接下来你只要做一件事：

  把这两个图标拖进 应用程序 文件夹：

    📦  拾字.app          ← 启动
    📦  停止拾字.app      ← 停止

  现在 Finder 里打开了 installer/ 目录给你拖。

  以后日常使用就：
    · 想用 → 双击 拾字.app（自动开浏览器）
    · 不用 → 双击 停止拾字.app

  首次双击 拾字.app 会下 1.5 GB Whisper 模型，
  之后启动就 6 秒搞定。

DONE

# 在 Finder 里打开 installer 目录
open "$(pwd)/installer"

read -p "按回车关闭此窗口... " dummy
