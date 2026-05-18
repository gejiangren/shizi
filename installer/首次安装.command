#!/bin/bash
# 拾字 · Voicetype Studio · 首次安装向导
# 双击即可。自动检测项目位置，必要时从 GitHub 克隆。

set -e

REPO_URL="https://github.com/gejiangren/shizi.git"
DEFAULT_DIR="$HOME/Projects/shizi"

# 智能找项目根目录
find_project() {
  # 1. 脚本上一级有 server.py？（installer/ 在 repo 内的标准位置）
  local up_one="$(cd "$(dirname "$0")/.." && pwd)"
  if [ -f "$up_one/server.py" ] && [ -f "$up_one/requirements.txt" ]; then
    echo "$up_one"; return 0
  fi
  # 2. 默认位置 ~/Projects/shizi 有？
  if [ -f "$DEFAULT_DIR/server.py" ] && [ -f "$DEFAULT_DIR/requirements.txt" ]; then
    echo "$DEFAULT_DIR"; return 0
  fi
  # 3. 脚本同级（installer/ 单独被复制出来用）有 server.py？
  local same_dir="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "$same_dir/server.py" ]; then
    echo "$same_dir"; return 0
  fi
  return 1
}

clear
cat <<'BANNER'
════════════════════════════════════════════════════════════

   拾字 · Voicetype Studio · 首次安装向导

   把任何视频变成可读的文字 · macOS 本地工具

════════════════════════════════════════════════════════════
BANNER

# 找项目
if PROJECT=$(find_project); then
  echo ""
  echo "▸ 找到项目：$PROJECT"
else
  echo ""
  echo "▸ 没找到项目代码。"
  echo "  默认会从 GitHub 克隆到：$DEFAULT_DIR"
  echo ""
  read -p "按回车继续克隆（或 Ctrl+C 退出后手动）... " dummy
  mkdir -p "$(dirname "$DEFAULT_DIR")"
  if [ ! -d "$DEFAULT_DIR" ]; then
    # 需要先有 git
    if ! command -v git >/dev/null 2>&1; then
      # 等下方 brew install 一起处理
      echo "（先装 brew + git，再克隆）"
    else
      git clone "$REPO_URL" "$DEFAULT_DIR"
    fi
  fi
  PROJECT="$DEFAULT_DIR"
fi

cd "$PROJECT" || { echo "✗ 进 $PROJECT 失败"; exit 1; }
echo ""
echo "  当前工作目录：$(pwd)"
echo ""

cat <<'INFO'
向导会自动装好以下东西（已装的会跳过）：
  ① Homebrew（macOS 包管理器，必备）
  ② Python 3.12（运行后端）
  ③ ffmpeg、yt-dlp、git（视频处理 + 拉代码）
  ④ Python 依赖（mlx-whisper、fastapi 等）
  ⑤ 1.5 GB Whisper 模型权重（首次启动 拾字.app 时下）

预计耗时：3-8 分钟（看网速）。中途让你输 Mac 密码是正常的，
那是 Homebrew 装东西要权限。

╭──────────────────────────────────────────────────────────╮
│  开始之前请确认：                                            │
│  · Mac 是 Apple Silicon（M 系列芯片）                       │
│  · 装好后用 拾字.app 双击启动                                  │
╰──────────────────────────────────────────────────────────╯

INFO
read -p "按回车开始安装... " dummy

# 1. 芯片检查
if [[ "$(uname -m)" != "arm64" ]]; then
  echo ""
  echo "⚠️ 检测到 Intel Mac。mlx-whisper 仅在 Apple Silicon 上跑。"
  echo "   可以继续，但要把 requirements.txt 里的 mlx-whisper 换成 faster-whisper。"
  read -p "继续？(y/N) " a; [[ "$a" != "y" ]] && exit 1
fi

# 2. Homebrew
echo ""
echo "▸ [1/5] 检查 Homebrew ..."
if command -v brew >/dev/null 2>&1; then
  echo "  ✓ 已装：$(which brew)"
else
  echo "  ✗ 未装。装 Homebrew 需要你输 Mac 密码（屏幕不显示密码字符是正常的）。"
  read -p "按回车继续 ... " dummy
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -d /opt/homebrew/bin ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# 3. 命令行工具
echo ""
echo "▸ [2/5] 检查 yt-dlp、ffmpeg、git ..."
for cmd in yt-dlp ffmpeg git; do
  if command -v $cmd >/dev/null 2>&1; then
    echo "  ✓ $cmd"
  else
    echo "  ⏳ brew install $cmd ..."
    brew install $cmd
  fi
done

# 如果之前 git 没装，要现在 clone 项目
if [ ! -f "$PROJECT/server.py" ] && [ -n "$REPO_URL" ]; then
  echo "  ⏳ 克隆代码 → $PROJECT ..."
  rmdir "$PROJECT" 2>/dev/null || true
  git clone "$REPO_URL" "$PROJECT"
  cd "$PROJECT"
fi

# 4. Python
echo ""
echo "▸ [3/5] 检查 Python 3.10+ ..."
if command -v python3 >/dev/null 2>&1; then
  PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
  PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
  if [[ $PY_MAJOR -lt 3 || ( $PY_MAJOR -eq 3 && $PY_MINOR -lt 10 ) ]]; then
    echo "  ⏳ Python 太老，brew install python@3.12 ..."
    brew install python@3.12
  else
    echo "  ✓ Python $PY_MAJOR.$PY_MINOR"
  fi
else
  echo "  ⏳ brew install python@3.12 ..."
  brew install python@3.12
fi

# 5. venv + 依赖
echo ""
echo "▸ [4/5] 创建虚拟环境 + 装 Python 依赖（约 2-3 分钟）..."
[[ -d .venv ]] || python3 -m venv .venv
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "  ✓ 完成"

# 6. .app 权限
echo ""
echo "▸ [5/5] 准备启动器 ..."
chmod +x installer/拾字.app/Contents/MacOS/applet 2>/dev/null
chmod +x installer/停止拾字.app/Contents/MacOS/applet 2>/dev/null
codesign --force --deep --sign - installer/拾字.app 2>/dev/null
codesign --force --deep --sign - installer/停止拾字.app 2>/dev/null
echo "  ✓ 已签名"

# 完成
cat <<DONE

════════════════════════════════════════════════════════════
   ✅  安装完成
════════════════════════════════════════════════════════════

接下来做一件事：

  把这两个图标拖进 应用程序 文件夹：

    📦  拾字.app          ← 启动
    📦  停止拾字.app      ← 停止

  现在 Finder 已经打开了 installer/ 目录给你拖。

  日常使用：
    · 想用 → 双击 拾字.app（浏览器会自动开）
    · 不用 → 双击 停止拾字.app

  首次双击 拾字.app 会下 1.5 GB Whisper 模型，
  耐心等 3-5 分钟。以后启动只要 6 秒。

DONE

# 在 Finder 里打开 installer
open "$PROJECT/installer"

read -p "按回车关闭此窗口... " dummy
