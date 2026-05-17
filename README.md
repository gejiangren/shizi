# 拾字 · Voicetype Studio

> 把任何视频变成可读的文字 —— 本地运行，链接和音频不上传任何服务器。

<!-- 著作权声明 / Copyright Notice -->
> 🔏 **原作者** [@gejiangren](https://github.com/gejiangren) · **首次发布** 2026-05-17 · **协议** [AGPL-3.0-or-later](./LICENSE)
> **原始仓库** https://github.com/gejiangren/shizi
>
> 依据 AGPL 3.0，**转载 / 二次开发必须保留本声明和 LICENSE 文件**；**任何在线服务部署都必须公开你修改后的源码**。

---

一个 macOS 本地的视频处理工作站，**两条链路**：
- 🅣 **转录文字**：粘视频链接 → mlx-whisper 识别 → 输出 txt / srt / vtt / json
- ⬇ **下载视频**：粘视频链接 → yt-dlp 选画质 → 下到本地

**亮点**
- 支持 1,800+ 平台（B 站 / YouTube / X / TikTok / 小宇宙 …）
- B 站 UP 主主页 / YouTube 频道 / 播放列表 一键扫描 → 勾选视频批量处理
- 合集自动检测，多条转录可串成一份 Markdown 文档（接你自己的 AI Key：DeepSeek / OpenAI / Anthropic / 通义 / 智谱 / Moonshot / 本地 Ollama / 任意 OpenAI 兼容服务）
- 字幕实时滚动 + 时间戳跳转 + 全文搜索
- 模型在 Apple Silicon 上跑（mlx-whisper），large-v3 大约 1:8 实时倍速
- 设计：杂志/编辑气质，深红 / 海军蓝两条色彩链路

> English README: [README.en.md](./README.en.md)

---

## 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | macOS 13+ |
| 芯片 | **Apple Silicon (M1/M2/M3/M4)** — mlx-whisper 仅在 Apple GPU 上跑 |
| Python | 3.10+ |
| 命令行工具 | `yt-dlp` · `ffmpeg`（脚本会用 Homebrew 自动装） |
| 浏览器（用于 cookies）| Safari / Chrome / Firefox / Edge / Brave / Chromium / Opera / Vivaldi 任一 |

**Intel Mac / Linux / Windows** 用户：把 `mlx-whisper` 换成 [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) 即可（见下方"非 Apple Silicon 适配"）。

---

## 安装（一行命令）

```bash
git clone https://github.com/<your-username>/shizi.git
cd shizi
bash setup.sh
```

`setup.sh` 会自动：
1. 检查并通过 Homebrew 安装 `yt-dlp` `ffmpeg`
2. 创建 Python 虚拟环境 `.venv/`
3. 安装 `requirements.txt` 里的 Python 依赖
4. 提示首次启动方式

---

## 启动

```bash
bash 启动.command           # 或者直接在 Finder 里双击「启动.command」
```

浏览器会自动打开 `http://127.0.0.1:7860`。停止：在终端按 `Ctrl+C`。

---

## 配置 AI 整理（可选，但很值）

转录出来的原文是口语化的，AI 可以把它整理成：
- 📑 整理文档（去口语化、分章节、加目录）
- 🧠 学习笔记（要点 + 关键词 + 总结）
- 🎯 Q&A 卡片（可导入 Anki）
- 🌳 思维导图（Markdown 缩进树）

**配置步骤**：
1. 启动应用，左栏点 `[AI]` 图标
2. 选服务商（推荐 DeepSeek V4 Flash，最便宜 + 速度够用）
3. 粘 API Key，点测试连接 → 保存
4. 转录完成后，完成页右上角点「AI 整理」

Key 存在 `~/.shizi/config.json`（权限 600，只有你能读）。

---

## B 站登录态（绕过 412/352 风控）

B 站对未登录请求严格限速。需要扫描 UP 主主页或下载 1080P+ 视频时：

1. 用任意支持的浏览器（Safari / Chrome / Firefox / …）打开 `bilibili.com` 用账号登录
2. 回到拾字，在「需要登录」错误页选你登录的那个浏览器
3. 看到"✓ 已检测到登录态 (含 SESSDATA, buvid3 等)" → 重试即可

**首次用 Safari**：macOS 会要求给运行 server 的 Terminal「完全磁盘访问权限」。系统设置 → 隐私与安全 → 完全磁盘访问 → 添加 Terminal。

**首次用 Chrome / Brave 等 Chromium 系**：弹出钥匙串对话框时点 Allow。

---

## 文件结构

```
shizi/
├── server.py            # FastAPI 后端
├── static/              # 前端（HTML/CSS/JS，无构建依赖）
│   ├── index.html
│   ├── app.js
│   ├── app.css
│   ├── tokens.css
│   ├── extra.css
│   ├── icons.js
│   └── fonts/           # Yandex Sans
├── requirements.txt
├── setup.sh
├── 启动.command
├── LICENSE              # AGPL 3.0
├── NOTICE               # 第三方资产说明
└── README.md
```

**运行时生成的目录**（已被 `.gitignore`）：
- `.venv/` —— Python 虚拟环境
- `cache/` —— 下载的临时音频
- `outputs/` —— 转录结果文件
- `shizi.db` —— SQLite 历史记录
- `~/.shizi/config.json` —— AI 配置（不在仓库内）

---

## 视频/音频文件保存到哪

| 类型 | 默认路径 |
|---|---|
| 转录结果 (.txt/.srt/.vtt/.json) | `<repo>/outputs/` |
| 下载的视频 | `~/Movies/拾字/` |
| 临时音频缓存 | `<repo>/cache/`（转录完自动清，可在设置里保留） |

下载路径和命名模板都可以在「AI 设置」页面改。

---

## 故障排查

| 症状 | 解法 |
|---|---|
| `Port 7860 already in use` | 端口被占 → `kill $(lsof -ti:7860)` 后重试 |
| 浏览器白屏 | 强制刷新 `Cmd+Option+R`；或清 Safari → 隐私 → 网站数据 → 127.0.0.1 |
| B 站视频报 412/352 | 在错误页选你登录的浏览器；或用「手动粘贴一批」绕开扫描接口 |
| Safari cookies 读不到 | 给 Terminal「完全磁盘访问权限」 |
| Chrome cookies 读不到 | 钥匙串弹窗点 Allow，或运行 `security find-generic-password -wga 'Chrome'` 测试 |
| 上传文件 413 错误 | FastAPI 默认无大小限制，若反代有限制需调整 |
| 模型下载慢 | mlx-whisper 首次会从 Hugging Face 拉权重，配代理或换镜像 |

---

## 非 Apple Silicon 适配

`mlx-whisper` 只在 Apple Silicon 上跑。Intel Mac / Linux / Windows 把它换成 `faster-whisper`：

1. `requirements.txt` 删 `mlx-whisper`，加 `faster-whisper>=1.0`
2. `server.py` 改 `import mlx_whisper` 为 `from faster_whisper import WhisperModel`
3. 调用 API 从 `mlx_whisper.transcribe(path, ...)` 改为：
   ```python
   model = WhisperModel("large-v3", device="cuda" or "cpu")
   segments, info = model.transcribe(path, language=lang)
   ```

欢迎提 PR 把这层包一个抽象层，自动检测平台选后端。

---

## 隐私

- **链接、音频、转录文本** 全部留在你的硬盘上，不上传任何服务器
- **AI Key** 存 `~/.shizi/config.json`（权限 600），调用 AI 时由本地 server 转发，不进浏览器
- **浏览器 Cookies** 仅在该次扫描调用 yt-dlp / B 站 API 时读取，不存储
- **localhost only** —— FastAPI 服务只绑 `127.0.0.1`，同 WiFi 下别的设备访问不到

---

## 贡献

欢迎 issue / PR。改 UI 要保留杂志气质（Yandex Sans + Noto Serif SC + Instrument Serif 的三层节奏）。

提交代码请：
1. 跟现有命名约定一致（snake_case in Python, camelCase in JS, kebab-case in CSS）
2. 服务端 / 前端的字段命名保持一致（不要驼峰下划线混着用）
3. 加一行 inline comment 说明"为什么"，不解释"是什么"

---

## License

[GNU AGPL 3.0](./LICENSE)

注意：AGPL 是 copyleft，**如果你把这套代码拿去做线上服务，必须把你的修改也同样开源**。详见 [LICENSE](./LICENSE)。

第三方资产归属见 [NOTICE](./NOTICE)。

---

## 致谢

设计语言参考 RANEPA design system，编辑气质受到杂志排版启发；技术上站在巨人肩上：[yt-dlp](https://github.com/yt-dlp/yt-dlp) · [mlx-whisper](https://github.com/ml-explore/mlx-examples) · [FastAPI](https://github.com/tiangolo/fastapi) · [browser-cookie3](https://github.com/borisbabic/browser_cookie3)。
