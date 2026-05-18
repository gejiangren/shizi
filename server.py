# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 gejiangren <https://github.com/gejiangren>
# 拾字 / Shizi · Voicetype Studio — https://github.com/gejiangren/shizi
"""拾字 后端 — FastAPI 服务

替代原 Gradio。负责：
  - 静态文件托管（前端 SPA）
  - POST /api/probe          视频信息预探测（标题/时长/平台/合集）
  - POST /api/jobs           创建转录任务
  - POST /api/batch          创建批量任务
  - GET  /api/jobs/:id       任务状态快照
  - GET  /api/jobs/:id/stream  SSE 实时事件（进度/日志/字幕段）
  - POST /api/jobs/:id/cancel
  - GET  /api/jobs/:id/result/:fmt  下载结果
  - GET  /api/history        历史列表
  - DELETE /api/history/:id
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Optional

# ────────────────────────────────────────────────────────────
# PATH 修复 — 必须在 import httpx 之前，影响所有 subprocess。
#
# 当 server.py 被 .app 启动时（macOS Launch Services / WKWebView
# 启动器），Python 进程拿到的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
# 不含 /opt/homebrew/bin（brew 装的 yt-dlp/ffmpeg）也不含 venv bin。
# subprocess.run(["yt-dlp", ...]) 会 "[Errno 2] No such file or directory"。
# 在这里把 brew + venv 路径加到 PATH 头部，下面所有 subprocess 都能找到。
# ────────────────────────────────────────────────────────────
import os
from pathlib import Path as _PathBootstrap

_extra_paths = [
    str(_PathBootstrap(__file__).resolve().parent / ".venv" / "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
]
_current = os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
_kept = [p for p in _extra_paths if os.path.isdir(p) and p not in _current.split(":")]
os.environ["PATH"] = ":".join(_kept + [_current])

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

PROJECT_DIR = Path(__file__).parent
STATIC_DIR = PROJECT_DIR / "static"
OUTPUTS_DIR = PROJECT_DIR / "outputs"
CACHE_DIR = PROJECT_DIR / "cache"
DB_PATH = PROJECT_DIR / "shizi.db"
CONFIG_DIR = Path.home() / ".shizi"
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_DL_DIR = Path.home() / "Movies" / "拾字"
DEFAULT_DL_TEMPLATE = "{title}_{uploader}_{id}"
OUTPUTS_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)
CONFIG_DIR.mkdir(exist_ok=True)
DEFAULT_DL_DIR.mkdir(parents=True, exist_ok=True)
try:
    os.chmod(CONFIG_DIR, 0o700)
except Exception:
    pass

# ============================================================
# AI configuration
# ============================================================
DEFAULT_PROMPTS = {
    "smart-doc": """你是专业的内容编辑。把下面的视频转录稿整理成结构化 Markdown 文档：
1. 去除口语化（嗯/那个/对吧/然后这种填充词），合并破碎句
2. 按主题分章节，加 2 级目录（## 标题）
3. 在每个章节的关键句子前保留时间戳标记，格式 `[mm:ss]`
4. 顶部一句话总结
5. 整体保持作者原意，只做"重述+结构化"，不杜撰未提到的内容
转录稿如下：

{TEXT}""",
    "notes": """你是学习笔记专家。把下面的视频转录稿压缩为学习笔记，输出 Markdown：
1. 顶部 **一句话总结**
2. **关键词**（5–10 个，用 `· 词 ·` 分隔）
3. **要点**（10 条左右，每条 1–2 句，结合时间戳 `[mm:ss]`）
4. **值得深入**（3–5 个开放问题，激发后续学习）
转录稿如下：

{TEXT}""",
    "qa": """把下面的转录稿拆成 Q&A 卡片，便于导入 Anki。要求：
- 至少 8 张卡，最多 20 张
- 每张：**Q**: 简短具体的问题 / **A**: 自给自足的答案（不依赖其他卡）
- 输出格式：

```
**Q**: ...
**A**: ...
---
```
转录稿如下：

{TEXT}""",
    "mindmap": """把下面的转录稿提炼成思维导图，输出 Markdown 缩进列表：
- 根节点是视频核心主题
- 一级用 `- `（主章节）
- 二级用 `  - `（关键概念）
- 三级用 `    - `（细节，最多到这级）
转录稿如下：

{TEXT}""",
}

PROVIDER_PRESETS = {
    "deepseek":  {"label": "DeepSeek",         "base_url": "https://api.deepseek.com/v1",                          "model": "deepseek-v4-flash",      "kind": "openai"},
    "openai":    {"label": "OpenAI",           "base_url": "https://api.openai.com/v1",                            "model": "gpt-5-mini",             "kind": "openai"},
    "qwen":      {"label": "通义千问 (阿里百炼)",  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",    "model": "qwen3.6-plus",           "kind": "openai"},
    "glm":       {"label": "智谱 GLM (BigModel)","base_url": "https://open.bigmodel.cn/api/paas/v4",                 "model": "glm-4.6",                "kind": "openai"},
    "moonshot":  {"label": "月之暗面 Kimi",      "base_url": "https://api.moonshot.cn/v1",                            "model": "kimi-k2.6",              "kind": "openai"},
    "anthropic": {"label": "Anthropic Claude",  "base_url": "https://api.anthropic.com",                            "model": "claude-sonnet-4-6",      "kind": "anthropic"},
    "ollama":    {"label": "Ollama 本地",       "base_url": "http://localhost:11434/v1",                            "model": "llama3.1",               "kind": "openai"},
    "custom":    {"label": "自定义（OpenAI 兼容）","base_url": "",                                                "model": "",                       "kind": "openai"},
}

# 每个服务商当前可用模型清单（基于 2026-05 官方文档）
# 留空数组表示让用户自由输入（Ollama 本地装啥都行，custom 也一样）
PROVIDER_MODELS = {
    "deepseek": [
        {"id": "deepseek-v4-flash", "label": "V4 Flash",           "desc": "1M ctx · 默认推荐 · $0.14/$0.28 每 1M tokens"},
        {"id": "deepseek-v4-pro",   "label": "V4 Pro · 旗舰",       "desc": "1M ctx · 推理更强 · 75% 折扣截至 2026-05-31"},
        {"id": "deepseek-chat",     "label": "(旧) chat",            "desc": "即将下架 · 自动映射到 V4 Flash 非思考模式"},
        {"id": "deepseek-reasoner", "label": "(旧) reasoner",        "desc": "即将下架 · 自动映射到 V4 Flash 思考模式"},
    ],
    "openai": [
        {"id": "gpt-5",        "label": "GPT-5",             "desc": "旗舰"},
        {"id": "gpt-5-mini",   "label": "GPT-5 mini",        "desc": "性价比 · 默认"},
        {"id": "gpt-5-nano",   "label": "GPT-5 nano",        "desc": "最便宜"},
        {"id": "gpt-4o",       "label": "GPT-4o",            "desc": "经典多模态"},
        {"id": "gpt-4o-mini",  "label": "GPT-4o mini",       "desc": "便宜版"},
        {"id": "o3",           "label": "o3",                "desc": "推理"},
        {"id": "o3-mini",      "label": "o3 mini",           "desc": "推理 · 轻量"},
        {"id": "o1",           "label": "o1",                "desc": "上一代推理"},
    ],
    "qwen": [
        {"id": "qwen3.6-max-preview", "label": "Qwen 3.6 Max",   "desc": "旗舰 · 最强"},
        {"id": "qwen3.6-plus",        "label": "Qwen 3.6 Plus",  "desc": "默认 · 平衡"},
        {"id": "qwen3.6-flash",       "label": "Qwen 3.6 Flash", "desc": "便宜 · 高速"},
        {"id": "qwen-long",           "label": "Qwen Long",      "desc": "长文档专用"},
    ],
    "glm": [
        {"id": "glm-4.6",      "label": "GLM-4.6",      "desc": "最新"},
        {"id": "glm-4.5",      "label": "GLM-4.5",      "desc": "上一代旗舰"},
        {"id": "glm-4-plus",   "label": "GLM-4 Plus",   "desc": "前代旗舰"},
        {"id": "glm-4-flash",  "label": "GLM-4 Flash",  "desc": "免费版"},
        {"id": "glm-4-air",    "label": "GLM-4 Air",    "desc": "轻量"},
    ],
    "moonshot": [
        {"id": "kimi-k2.6",            "label": "Kimi K2.6",            "desc": "最新 · 默认"},
        {"id": "kimi-k2.5",            "label": "Kimi K2.5",            "desc": "上一代"},
        {"id": "kimi-k2-thinking",     "label": "Kimi K2 Thinking",     "desc": "深度思考"},
        {"id": "kimi-k2-thinking-turbo","label": "Kimi K2 Thinking Turbo","desc": "思考 · 加速"},
        {"id": "moonshot-v1-128k",     "label": "Moonshot v1 128k",     "desc": "长文 128K"},
        {"id": "moonshot-v1-32k",      "label": "Moonshot v1 32k",      "desc": "标准 32K"},
        {"id": "moonshot-v1-8k",       "label": "Moonshot v1 8k",       "desc": "短文 8K"},
        {"id": "moonshot-v1-auto",     "label": "Moonshot v1 auto",     "desc": "自适应长度"},
    ],
    "anthropic": [
        {"id": "claude-opus-4-7",   "label": "Claude Opus 4.7",   "desc": "旗舰 · 最强推理"},
        {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "desc": "平衡 · 默认"},
        {"id": "claude-haiku-4-5",  "label": "Claude Haiku 4.5",  "desc": "便宜 · 快"},
    ],
    "ollama":   [],   # 让用户自由输入：ollama list 里有啥就填啥
    "custom":   [],
}

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {"ai": {}}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"ai": {}}

def save_config(cfg: dict):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass

def mask_key(k: str) -> str:
    if not k: return ""
    if len(k) <= 8: return "*" * len(k)
    return k[:4] + "*" * (len(k) - 8) + k[-4:]

# ============================================================
# Helpers
# ============================================================
def fmt_ts_srt(seconds: float) -> str:
    total_ms = int(seconds * 1000)
    h, rem = divmod(total_ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def fmt_ts_vtt(seconds: float) -> str:
    return fmt_ts_srt(seconds).replace(",", ".")

def build_srt(segments) -> str:
    out = []
    for i, s in enumerate(segments, 1):
        out.append(str(i))
        out.append(f"{fmt_ts_srt(s['start'])} --> {fmt_ts_srt(s['end'])}")
        out.append(s["text"].strip())
        out.append("")
    return "\n".join(out)

def build_vtt(segments) -> str:
    out = ["WEBVTT", ""]
    for s in segments:
        out.append(f"{fmt_ts_vtt(s['start'])} --> {fmt_ts_vtt(s['end'])}")
        out.append(s["text"].strip())
        out.append("")
    return "\n".join(out)

def detect_platform(url: str) -> Optional[dict]:
    PLATFORMS = [
        ("bilibili.com", "Bilibili", "bili", "#FB7299"),
        ("b23.tv",       "Bilibili", "bili", "#FB7299"),
        ("youtube.com",  "YouTube",  "yt",   "#FF0000"),
        ("youtu.be",     "YouTube",  "yt",   "#FF0000"),
        ("twitter.com",  "Twitter",  "tw",   "#1DA1F2"),
        ("x.com",        "X",        "tw",   "#000000"),
        ("tiktok.com",   "TikTok",   "tt",   "#000000"),
        ("douyin.com",   "抖音",      "tt",  "#000000"),
        ("youku.com",    "优酷",      "yk",  "#28B7E8"),
        ("vimeo.com",    "Vimeo",    "vm",   "#1AB7EA"),
    ]
    u = url.lower()
    for host, name, kind, color in PLATFORMS:
        if host in u:
            return {"name": name, "kind": kind, "color": color}
    return None

def safe_filename(name: str, fallback: str) -> str:
    if not name:
        return fallback
    clean = "".join(c if c.isalnum() or c in " -_.()【】·" else "_" for c in name)
    clean = clean.strip()[:80]
    return clean or fallback

# ============================================================
# Database
# ============================================================
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS history (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            platform TEXT,
            platform_kind TEXT,
            video_id TEXT,
            title TEXT,
            duration REAL,
            model TEXT,
            lang TEXT,
            words INTEGER,
            elapsed_seconds REAL,
            file_base TEXT,
            created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_hist_created ON history(created_at DESC);
        """)

def history_save(job: "Job"):
    with get_db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO history
            (id, url, platform, platform_kind, video_id, title, duration, model, lang,
             words, elapsed_seconds, file_base, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            job.id, job.url,
            (job.platform or {}).get("name"),
            (job.platform or {}).get("kind"),
            job.video_id, job.title, job.duration,
            job.model, job.lang,
            len(job.full_text), job.elapsed_seconds,
            str(job.file_base) if job.file_base else None,
            job.created_at,
        ))

def history_list(q: Optional[str] = None, kind: Optional[str] = None, limit: int = 200):
    with get_db() as conn:
        sql = "SELECT * FROM history WHERE 1=1"
        args = []
        if q:
            sql += " AND (title LIKE ? OR video_id LIKE ?)"
            args += [f"%{q}%", f"%{q}%"]
        if kind:
            sql += " AND platform_kind = ?"
            args.append(kind)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        return [dict(r) for r in conn.execute(sql, args).fetchall()]

def history_delete(jid: str):
    with get_db() as conn:
        conn.execute("DELETE FROM history WHERE id=?", (jid,))

def history_clear():
    with get_db() as conn:
        conn.execute("DELETE FROM history")

# ============================================================
# Model mapping
# ============================================================
MODEL_MAP = {
    "tiny":     "mlx-community/whisper-tiny-mlx",
    "base":     "mlx-community/whisper-base-mlx",
    "small":    "mlx-community/whisper-small-mlx",
    "medium":   "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-turbo",
}
LANG_MAP = {"auto": None, "zh": "zh", "en": "en", "zh+en": None}

# ============================================================
# Job
# ============================================================
class Job:
    def __init__(self, url: str, model: str, lang: str, fmt: str,
                 advanced: Optional[dict] = None,
                 local_file: Optional[str] = None):
        self.id = uuid.uuid4().hex[:12]
        self.url = url
        self.model = model
        self.lang = lang
        self.fmt = fmt
        self.advanced = advanced or {}
        self.local_file = local_file   # 已有本地音/视频文件，跳过下载

        self.status = "pending"        # pending | downloading | extracting | transcribing | done | error | cancelled
        self.stage = "init"
        self.progress = 0.0            # 0-100
        self.eta: Optional[str] = None
        self.detail: Optional[str] = None

        self.title: Optional[str] = None
        self.duration: Optional[float] = None
        self.platform: Optional[dict] = None
        self.video_id: Optional[str] = None
        self.thumbnail: Optional[str] = None

        self.segments: list = []
        self.full_text: str = ""

        self.file_base: Optional[Path] = None
        self.elapsed_seconds: float = 0.0
        self.created_at = int(time.time())
        self.completed_at: Optional[int] = None
        self.error: Optional[str] = None
        self.error_kind: Optional[str] = None   # login_required | invalid | other

        self.logs: list = []
        self.cancel_event = threading.Event()
        self.subscribers: list[asyncio.Queue] = []
        self.main_loop: Optional[asyncio.AbstractEventLoop] = None

    # ----- emit to all SSE subscribers (thread-safe) -----
    def emit(self, event_type: str, **data):
        msg = {"type": event_type, "job_id": self.id, **data}
        if self.main_loop is None:
            return
        for q in list(self.subscribers):
            try:
                self.main_loop.call_soon_threadsafe(q.put_nowait, msg)
            except Exception:
                pass

    def log(self, level: str, msg: str):
        entry = {"ts": time.strftime("%H:%M:%S"), "level": level, "msg": msg}
        self.logs.append(entry)
        self.emit("log", **entry)

    def snapshot(self) -> dict:
        return {
            "id": self.id, "url": self.url,
            "status": self.status, "stage": self.stage,
            "progress": self.progress, "eta": self.eta, "detail": self.detail,
            "title": self.title, "duration": self.duration,
            "platform": self.platform, "video_id": self.video_id,
            "thumbnail": self.thumbnail,
            "model": self.model, "lang": self.lang, "fmt": self.fmt,
            "segments": self.segments, "full_text": self.full_text,
            "elapsed_seconds": self.elapsed_seconds,
            "error": self.error, "error_kind": self.error_kind,
            "logs": self.logs[-200:],
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


JOBS: dict[str, Job] = {}

# ============================================================
# yt-dlp probe (video metadata)
# ============================================================
def normalize_url(url: str) -> str:
    """规整一些"分享时变形"的 URL，让 yt-dlp 能正确识别。

    - 用户常常直接粘 App "复制链接"出来的整段文案（含中文表情、口令码），
      从里面抠出第一条 http(s):// 链接即可。
    - 抖音「在用户页弹窗里看视频」会得到 /user/self?modal_id=<vid>，
      需要改写成 /video/<vid> yt-dlp 才能认出。
    - B 站短链 b23.tv 由 yt-dlp 自己处理，这里不动。
    - YouTube 移动端 youtu.be 由 yt-dlp 自己处理，这里不动。
    """
    if not url:
        return url
    s = url.strip()
    # 从分享文案里抠 URL：用户粘进来的可能是
    # "6.97 复制打开抖音，看看【...】... https://v.douyin.com/abc/ R@K.jP ..."
    # 抓第一条 http(s)://，并去掉末尾的标点 / 中文符号。
    if not re.match(r"^https?://", s):
        m = re.search(r"https?://[^\s一-鿿]+", s)
        if m:
            s = m.group(0).rstrip(".,;:!?，。、；：！？)）】」』])>")
    # 抖音 modal_id
    if "douyin.com" in s.lower():
        m = re.search(r"[?&]modal_id=(\d+)", s)
        if m:
            return f"https://www.douyin.com/video/{m.group(1)}"
    return s


# ============================================================
# 抖音 fallback：yt-dlp 抖音 extractor 当前缺 web _signature 计算，
# 直接走抖音官方 share 页（手机端 UA）拿元数据 + mp4 直链。
# ============================================================
_DOUYIN_VIDEO_ID_RE = re.compile(r"douyin\.com/(?:video|share/video)/(\d+)")
_DOUYIN_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
# SSR 默认给 aweme.snssdk.com，这个 host 在很多网络环境（VPN/海外 DNS/部分
# ISP）解析不到。备选两个公网域名，DNS 普遍解析得到。
_DOUYIN_FALLBACK_HOSTS = ("https://www.iesdouyin.com", "https://api.amemv.com")


def _douyin_expand_urls(urls: list[str]) -> list[str]:
    """SSR URL host 替换为公网备选 → 拼一组按顺序试的下载地址。"""
    out: list[str] = []
    seen: set[str] = set()
    for u in urls:
        if u not in seen:
            out.append(u); seen.add(u)
        m = re.match(r"^https?://[^/]+(/.*)$", u)
        if not m:
            continue
        for h in _DOUYIN_FALLBACK_HOSTS:
            u2 = h + m.group(1)
            if u2 not in seen:
                out.append(u2); seen.add(u2)
    return out

def _douyin_extract_video_id(url: str) -> Optional[str]:
    """从抖音 URL 抽视频 ID。短链先跟随重定向。"""
    if not url:
        return None
    m = _DOUYIN_VIDEO_ID_RE.search(url)
    if m:
        return m.group(1)
    if "v.douyin.com" in url:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _DOUYIN_MOBILE_UA})
            with urllib.request.urlopen(req, timeout=10) as r:
                m = _DOUYIN_VIDEO_ID_RE.search(r.geturl())
                if m:
                    return m.group(1)
        except Exception as e:
            print(f"[douyin] short-link resolve failed: {e}")
    return None


def _douyin_share_resolve(url: str) -> Optional[dict]:
    """走抖音 share 页拿元数据 + mp4 直链。yt-dlp 抓不到时 fallback 用。

    返回 {title, duration_s, video_id, video_urls (list[str]), thumbnail, uploader}
    或 None。不需要登录、不需要 cookies。
    """
    vid = _douyin_extract_video_id(url)
    if not vid:
        return None
    try:
        req = urllib.request.Request(
            f"https://www.iesdouyin.com/share/video/{vid}/",
            headers={"User-Agent": _DOUYIN_MOBILE_UA},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"[douyin-share] HTTP error: {e}")
        return None
    # window._ROUTER_DATA = { ... } 紧接 </script>
    m = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>", html, re.DOTALL)
    if not m:
        print("[douyin-share] _ROUTER_DATA not found in HTML")
        return None
    try:
        data = json.loads(m.group(1))
        page = data.get("loaderData", {}).get("video_(id)/page", {})
        item = (page.get("videoInfoRes", {}).get("item_list") or [None])[0]
        if not item:
            return None
        play = (item.get("video") or {}).get("play_addr") or {}
        urls = play.get("url_list") or []
        if not urls:
            return None
        return {
            "title": item.get("desc") or "抖音视频",
            "duration_s": int((item.get("video") or {}).get("duration", 0) // 1000),
            "video_id": vid,
            "video_urls": _douyin_expand_urls(urls),
            "thumbnail": ((item.get("video") or {}).get("cover") or {}).get("url_list", [None])[0],
            "uploader": (item.get("author") or {}).get("nickname"),
        }
    except Exception as e:
        print(f"[douyin-share] parse error: {e}")
        return None


def classify_non_video_url(url: str) -> Optional[dict]:
    """识别"不是单个视频"的 URL。返回 {msg, scannable, type} 或 None。
    scannable=True 表示可以 --flat-playlist 列出视频供挑选。"""
    u = (url or "").lower().strip()
    if "space.bilibili.com" in u:
        return {"msg": "这是 Bilibili UP 主主页。可以扫描该 UP 主的视频列表，挑选批量处理。",
                "scannable": True, "type": "channel"}
    if "/medialist/" in u or "bilibili.com/list" in u:
        return {"msg": "这是 Bilibili 收藏夹/列表页。可以扫描列表内所有视频，挑选批量处理。",
                "scannable": True, "type": "playlist"}
    if "live.bilibili.com" in u:
        return {"msg": "这是 Bilibili 直播间，不支持直播流转录。",
                "scannable": False, "type": "live"}
    if re.search(r"youtube\.com/(@|c/|user/|channel/)", u):
        return {"msg": "这是 YouTube 频道主页。可以扫描该频道的视频列表，挑选批量处理。",
                "scannable": True, "type": "channel"}
    if "youtube.com/playlist" in u or ("youtube.com/watch" in u and "list=" in u and "v=" not in u):
        return {"msg": "这是 YouTube 播放列表。可以扫描列表内所有视频，挑选批量处理。",
                "scannable": True, "type": "playlist"}
    if re.match(r"^https?://(twitter|x)\.com/[^/?#]+/?$", u):
        return {"msg": "这是 X / Twitter 用户主页。可以扫描该用户的最新带视频推文，挑选批量处理。",
                "scannable": True, "type": "channel"}
    if "tiktok.com/@" in u and "/video/" not in u:
        return {"msg": "这是 TikTok 用户主页。可以扫描该用户的视频列表，挑选批量处理。",
                "scannable": True, "type": "channel"}
    # 抖音个人主页（含 /user/self / /user/MS4...）。yt-dlp 对抖音 channel 支持不稳，先不开扫描。
    if re.search(r"douyin\.com/user/", u):
        return {"msg": "这是抖音用户主页，本工具暂不支持扫描整个用户的视频。请在抖音里打开单个视频后复制其链接（形如 douyin.com/video/<id>）再来转录。",
                "scannable": False, "type": "channel"}
    return None


# ============================================================
# B 站官方 API（WBI 签名）— 比 yt-dlp 拿到的元数据完整得多
# ============================================================
BILI_MIXIN_KEY_ENC_TAB = [
    46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
    33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,
    26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,
    20,34,44,52,
]
BILI_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
           "AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/123.0.0.0 Safari/537.36")
_bili_wbi_cache = {"keys": None, "at": 0}

def _read_browser_cookies(browser: Optional[str], domain: str) -> dict:
    """读浏览器 cookies。失败返回 {}（让上游决定是否能继续）。
    browser 取 None / chrome / safari / firefox / edge / brave / chromium / opera / vivaldi。"""
    if not browser: return {}
    try:
        import browser_cookie3 as bc
        fn = {
            "safari":   bc.safari,
            "chrome":   bc.chrome,
            "firefox":  bc.firefox,
            "edge":     bc.edge,
            "brave":    bc.brave,
            "chromium": bc.chromium,
            "opera":    bc.opera,
            "vivaldi":  bc.vivaldi,
        }.get(browser)
        if not fn: return {}
        cj = fn(domain_name=domain)
        return {c.name: c.value for c in cj if c.domain.endswith(domain)}
    except Exception as e:
        print(f"[browser_cookies] {browser} 读取失败: {e}")
        return {}

def _bili_get_wbi_keys(cookies: Optional[dict] = None) -> tuple[str, str]:
    """从 web-interface/nav 拿 img_key 和 sub_key（缓存 10 分钟）"""
    now = time.time()
    if _bili_wbi_cache["keys"] and now - _bili_wbi_cache["at"] < 600:
        return _bili_wbi_cache["keys"]
    headers = {"User-Agent": BILI_UA, "Referer": "https://www.bilibili.com/"}
    r = httpx.get("https://api.bilibili.com/x/web-interface/nav",
                  headers=headers, cookies=cookies or {}, timeout=10)
    j = r.json()
    img_url = (j.get("data") or {}).get("wbi_img", {}).get("img_url", "")
    sub_url = (j.get("data") or {}).get("wbi_img", {}).get("sub_url", "")
    img_key = img_url.split("/")[-1].split(".")[0]
    sub_key = sub_url.split("/")[-1].split(".")[0]
    if not img_key or not sub_key:
        raise RuntimeError("无法获取 B 站 WBI key")
    _bili_wbi_cache["keys"] = (img_key, sub_key)
    _bili_wbi_cache["at"] = now
    return img_key, sub_key

def _bili_mixin_key(img_key: str, sub_key: str) -> str:
    combined = img_key + sub_key
    return "".join(combined[i] for i in BILI_MIXIN_KEY_ENC_TAB)[:32]

def _bili_wbi_sign(params: dict, cookies: Optional[dict] = None) -> dict:
    import urllib.parse, hashlib
    img_key, sub_key = _bili_get_wbi_keys(cookies)
    mixin = _bili_mixin_key(img_key, sub_key)
    p = dict(params)
    p["wts"] = int(time.time())
    p = dict(sorted(p.items()))
    # 过滤 B 站不允许的特殊字符
    p = {k: "".join(c for c in str(v) if c not in "!'()*") for k, v in p.items()}
    query = urllib.parse.urlencode(p)
    p["w_rid"] = hashlib.md5((query + mixin).encode("utf-8")).hexdigest()
    return p

def _bili_space_arc_search(mid: int, page_size: int = 50,
                            cookies: Optional[dict] = None) -> dict:
    """B 站 UP 主投稿列表官方接口。返回 JSON 原样。"""
    params = {
        "mid": mid, "ps": page_size, "tid": 0, "pn": 1,
        "order": "pubdate", "platform": "web", "web_location": "1550101",
    }
    signed = _bili_wbi_sign(params, cookies)
    headers = {"User-Agent": BILI_UA,
               "Referer": f"https://space.bilibili.com/{mid}",
               "Origin": "https://space.bilibili.com"}
    r = httpx.get("https://api.bilibili.com/x/space/wbi/arc/search",
                  params=signed, headers=headers, cookies=cookies or {}, timeout=15)
    return r.json()

def _parse_bili_duration(s) -> int:
    """B 站返回的 length 是 "M:SS" 或 "H:MM:SS" 字符串"""
    if isinstance(s, (int, float)): return int(s)
    if not s: return 0
    try:
        parts = [int(x) for x in str(s).split(":")]
        if len(parts) == 2: return parts[0] * 60 + parts[1]
        if len(parts) == 3: return parts[0] * 3600 + parts[1] * 60 + parts[2]
    except Exception:
        pass
    return 0

def _bili_probe_channel(mid: int, limit: int, url: str,
                         cookies_browser: Optional[str] = None) -> dict:
    """用官方 wbi API 拿 UP 主投稿列表。元数据齐全：title / cover / 时长 / 播放数。"""
    cookies = _read_browser_cookies(cookies_browser, "bilibili.com")
    ps = max(1, min(int(limit), 50))
    data = _bili_space_arc_search(mid, page_size=ps, cookies=cookies)
    if (data or {}).get("code") != 0:
        hint = ""
        if not cookies:
            hint = " | 提示：未读到浏览器 cookies，B 站对匿名 WBI 请求非常严，请在错误页选你的浏览器（且该浏览器已登录 B 站）。"
        raise RuntimeError(json.dumps({
            "kind": "rate_limited",
            "msg": f"B 站 API code={data.get('code')} msg={data.get('message','')[:200]}{hint}",
        }))
    body = data.get("data") or {}
    vlist = (body.get("list") or {}).get("vlist") or []
    page = body.get("page") or {}
    videos = []
    author = ""
    for v in vlist:
        bvid = v.get("bvid") or ""
        title = v.get("title") or bvid or "(无标题)"
        author = author or v.get("author") or ""
        upload_date = ""
        if v.get("created"):
            try:
                from datetime import datetime
                upload_date = datetime.fromtimestamp(int(v["created"])).strftime("%Y%m%d")
            except Exception: pass
        pic = v.get("pic") or ""
        if pic and not pic.startswith("http"):
            pic = ("https:" + pic) if pic.startswith("//") else f"https://{pic.lstrip('/')}"
        videos.append({
            "id": bvid,
            "title": title,
            "url": f"https://www.bilibili.com/video/{bvid}" if bvid else "",
            "duration": _parse_bili_duration(v.get("length")),
            "thumbnail": pic,
            "upload_date": upload_date,
            "view_count": v.get("play"),
        })
    return {
        "channel": {
            "name": author or f"UID {mid}",
            "id": str(mid),
            "url": url,
            "platform": {"name": "Bilibili", "kind": "bili", "color": "#FB7299"},
            "total": page.get("count") or len(videos),
            "thumbnail": None,
        },
        "videos": videos,
        "limited_to": ps,
        "has_more": (page.get("count") or 0) > len(videos),
    }


def probe_channel(url: str, cookies_browser: Optional[str] = None, limit: int = 50) -> dict:
    """优先用平台官方 API（B 站走 WBI），失败再回退 yt-dlp --flat-playlist。"""
    # ---- B 站 UP 主主页 → 用 WBI 官方接口（更快 / 元数据完整 / 不易被风控） ----
    m_bili = re.search(r"space\.bilibili\.com/(\d+)", (url or "").lower())
    if m_bili:
        try:
            return _bili_probe_channel(int(m_bili.group(1)), limit, url, cookies_browser)
        except Exception as e:
            # 失败就 fallthrough 到 yt-dlp
            print(f"[bili wbi] 失败，回退 yt-dlp: {e}")

    cmd = ["yt-dlp", "--flat-playlist", "-J", "--no-warnings",
           "--playlist-end", str(int(limit)), url]
    if cookies_browser:
        cmd += ["--cookies-from-browser", cookies_browser]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        err = (proc.stderr or "")[:600]
        kind = "other"
        low = err.lower()
        if ("412" in low or "352" in low or "509" in low
                or "blocked by server" in low or "rejected by server" in low):
            kind = "rate_limited"
        elif "login" in low or "cookies" in low or "members" in low or "private" in low:
            kind = "login_required"
        raise RuntimeError(json.dumps({"kind": kind, "msg": err.strip() or "channel scan failed"}))
    data = json.loads(proc.stdout)
    entries = data.get("entries") or []
    videos = []
    for ep in entries:
        if not ep: continue
        vid = ep.get("id") or ""
        vurl = ep.get("url") or ep.get("webpage_url") or ""
        if (not vurl or not vurl.startswith("http")) and vid:
            ul = (url or "").lower()
            if "bilibili" in ul or "b23.tv" in ul:
                vurl = f"https://www.bilibili.com/video/{vid}"
            elif "youtube" in ul or "youtu.be" in ul:
                vurl = f"https://www.youtube.com/watch?v={vid}"
        thumb = ep.get("thumbnail")
        if not thumb:
            tt = ep.get("thumbnails") or []
            thumb = tt[0].get("url") if tt else None
        # flat-playlist 模式下 B 站常返回 title=None，用 ID 兜底，前端能至少看到 BV 号
        raw_title = ep.get("title")
        title = raw_title if (raw_title and raw_title != "None") else (vid or "(无标题)")
        videos.append({
            "id": vid,
            "title": title,
            "url": vurl,
            "duration": ep.get("duration"),
            "thumbnail": thumb,
            "upload_date": ep.get("upload_date"),
            "view_count": ep.get("view_count"),
        })

    # 频道名兜底：yt-dlp flat 模式下 B 站经常给不了 uploader，从 URL 抠 UID
    ch_name = data.get("uploader") or data.get("title") or data.get("channel")
    if not ch_name or ch_name in ("None",):
        m = re.search(r"space\.bilibili\.com/(\d+)", (url or "").lower())
        if m:
            ch_name = f"UID {m.group(1)}"
        else:
            m2 = re.search(r"youtube\.com/(?:@|c/|user/|channel/)([\w\-.]+)", (url or "").lower())
            ch_name = f"@{m2.group(1)}" if m2 else "未知频道"

    return {
        "channel": {
            "name": ch_name,
            "id": data.get("id") or data.get("uploader_id"),
            "url": url,
            "platform": detect_platform(url),
            "total": data.get("playlist_count") or len(entries),
            "thumbnail": data.get("thumbnail"),
        },
        "videos": videos,
        "limited_to": int(limit),
        "has_more": len(entries) >= int(limit),
    }


def probe_video(url: str, cookies_browser: Optional[str] = None) -> dict:
    """Return {title, duration, video_id, thumbnail, is_collection, parts}.

    cookies_browser: chrome/safari/firefox/edge/... 让 yt-dlp 用对应浏览器的
    cookies 抓元数据。抖音 / 小红书 / 部分 B 站会员视频不带 cookies 直接 403。
    """
    url = normalize_url(url)
    bad = classify_non_video_url(url)
    if bad:
        raise RuntimeError(json.dumps({
            "kind": "not_video", "msg": bad["msg"],
            "scannable": bad.get("scannable", False), "type": bad.get("type"),
        }))

    # 抖音直接走 fallback：yt-dlp 抖音 extractor 当前抓不动，省 30s 等 timeout
    if "douyin.com" in url.lower():
        fb = _douyin_share_resolve(url)
        if fb:
            return {
                "title": fb["title"],
                "duration": fb["duration_s"],
                "video_id": fb["video_id"],
                "thumbnail": fb["thumbnail"],
                "uploader": fb["uploader"],
                "is_collection": False,
                "parts": [],
            }
        # fallback 也失败：继续走 yt-dlp 尝试（兜底）

    cmd = ["yt-dlp", "-J", "--no-warnings", "--no-playlist"]
    if cookies_browser:
        cmd += ["--cookies-from-browser", cookies_browser]
    cmd.append(url)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        err = proc.stderr or ""
        kind = "other"
        low = err.lower()
        # TikTok 卡 fresh cookies（没找到等价 fallback 接口）→ platform_limited
        if "fresh cookies" in low and "tiktok" in low:
            kind = "platform_limited"
        elif ("412" in low or "352" in low or "509" in low
                or "blocked by server" in low or "rejected by server" in low
                or "rate" in low and "limit" in low):
            kind = "rate_limited"
        elif "login" in low or "cookies" in low or "members" in low or "premium" in low or "private" in low:
            kind = "login_required"
        elif "unsupported url" in low or "no video" in low:
            kind = "invalid"
        raise RuntimeError(json.dumps({"kind": kind, "msg": err.strip()[:500] or "probe failed"}))
    data = json.loads(proc.stdout)
    info = {
        "title": data.get("title"),
        "duration": data.get("duration"),
        "video_id": data.get("id"),
        "thumbnail": data.get("thumbnail"),
        "uploader": data.get("uploader") or data.get("channel"),
        "is_collection": False,
        "parts": [],
    }
    # Detect Bilibili collection / playlist
    if "entries" in data and data["entries"]:
        info["is_collection"] = True
        for ep in data["entries"]:
            info["parts"].append({
                "p": ep.get("playlist_index") or ep.get("episode_number") or len(info["parts"]) + 1,
                "title": ep.get("title") or "(无标题)",
                "duration": ep.get("duration"),
                "video_id": ep.get("id"),
                "url": ep.get("webpage_url") or ep.get("url"),
            })
    return info

# ============================================================
# Worker pipeline
# ============================================================
import mlx_whisper  # lazy-import? -> import here cost ~2s. Keep at module top? actually here is fine.

def _douyin_share_download(job: "Job", audio_path: Path) -> Path:
    """抖音 fallback：share 接口拿直链 → ffmpeg 直拉流 + 边解码音频。
    用 ffmpeg 而不是 urllib 是因为抖音 CDN 经常中途 reset，ffmpeg 内置
    -reconnect / -reconnect_streamed 能续传，urllib 不会。"""
    job.emit("progress", stage="download", progress=0)
    info = _douyin_share_resolve(job.url)
    if not info:
        raise RuntimeError("抖音解析失败：未能从 share 页提取视频地址")
    job.log("inf", f"抖音直链就绪：{info['title'][:40]} ({info['duration_s']}s)")

    mp3_path = CACHE_DIR / f"{job.id}.mp3"
    duration_s = info["duration_s"] or 0
    time_re = re.compile(r"time=(\d+):(\d+):(\d+)\.(\d+)")
    last_err: Optional[str] = None
    # 转录只要音频，把 SSR 默认 720p 替换成 360p。CDN 上文件大小约缩到 1/3，
    # 抖音视频音轨没差别（都是同一条 AAC）。下载视频是另一条链路，不动。
    mirrors = [re.sub(r"ratio=\d+p", "ratio=360p", u) for u in info["video_urls"]]

    for i, u in enumerate(mirrors):
        # 让前端看到 mirror 切换 —— 否则切到 mirror 2 时 ffmpeg 在 connect 阶段
        # 没 time= 输出，进度条留在 mirror 1 的状态像卡死。
        job.detail = f"连接镜像 {i+1}/{len(mirrors)}…"
        job.emit("progress", stage="download", progress=job.progress or 0, detail=job.detail)
        job.log("inf", f"正在尝试 mirror {i+1}/{len(mirrors)}")

        # ffmpeg 当 downloader：HTTP 断流自动重连，输出端直接编码为 mp3
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "info",
            "-rw_timeout", "15000000",            # 15s socket 读写超时
            "-reconnect", "1",
            "-reconnect_at_eof", "1",
            "-reconnect_streamed", "1",
            "-reconnect_on_network_error", "1",
            "-reconnect_delay_max", "5",
            "-reconnect_max_retries", "8",        # 不再无限重试
            "-user_agent", _DOUYIN_MOBILE_UA,
            "-headers", "Referer: https://www.iesdouyin.com/\r\n",
            "-i", u,
            "-vn", "-acodec", "libmp3lame", "-q:a", "2",
            str(mp3_path),
        ]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
        except Exception as e:
            last_err = f"ffmpeg 启动失败: {e}"
            job.log("warn", f"mirror {i+1}/{len(mirrors)} {last_err}")
            continue

        tail_lines: list[str] = []  # 报错时回放
        try:
            for line in proc.stdout:
                if job.cancel_event.is_set():
                    proc.terminate()
                    try: proc.wait(timeout=2)
                    except Exception: proc.kill()
                    raise InterruptedError("cancelled")
                tail_lines.append(line.rstrip())
                if len(tail_lines) > 20: tail_lines.pop(0)
                m = time_re.search(line)
                if m and duration_s > 0:
                    hh, mm, ss, ms = m.groups()
                    cur = int(hh)*3600 + int(mm)*60 + int(ss) + int(ms)/100.0
                    pct = min(99.0, cur * 100.0 / duration_s)
                    job.progress = pct
                    job.detail = f"{cur:.0f}s / {duration_s}s"
                    job.emit("progress", stage="download", progress=pct, detail=job.detail)
        except InterruptedError:
            raise
        proc.wait()
        if proc.returncode == 0 and mp3_path.exists() and mp3_path.stat().st_size > 1024:
            job.emit("progress", stage="download", progress=100)
            return mp3_path
        last_err = f"ffmpeg returncode={proc.returncode}; last: " + " | ".join(tail_lines[-3:])[:240]
        job.log("warn", f"mirror {i+1}/{len(mirrors)} 失败")
        try: mp3_path.unlink()
        except Exception: pass

    raise RuntimeError(f"所有抖音 mirror 都下载失败：{last_err}")


def _yt_dlp_download(job: Job, audio_path: Path) -> Path:
    """Download audio (+convert to mp3). Streams progress to job."""
    # 抖音走 fallback：yt-dlp douyin extractor 当前抓不动单视频
    if job.url and "douyin.com" in job.url.lower():
        return _douyin_share_download(job, audio_path)

    cmd = [
        "yt-dlp", "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "-o", str(CACHE_DIR / f"{job.id}.%(ext)s"),
        "--no-playlist", "--newline", "--progress",
    ]
    cookies = job.advanced.get("cookies_browser") or job.advanced.get("cookiesBrowser")
    if cookies:
        cmd += ["--cookies-from-browser", cookies]
    cmd.append(job.url)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    pct_re = re.compile(r'(\d+\.?\d*)%\s+of\s+~?\s*([\d\.]+\w+)\s+at\s+([\d\.]+\w+/s)(?:\s+ETA\s+([\d:]+))?')
    for line in proc.stdout:
        if job.cancel_event.is_set():
            proc.terminate()
            try: proc.wait(timeout=2)
            except Exception: proc.kill()
            raise InterruptedError("cancelled")
        line = line.rstrip()
        if not line: continue
        m = pct_re.search(line)
        if m:
            pct = float(m.group(1))
            job.progress = pct
            job.eta = m.group(4) or ""
            job.detail = f"{m.group(2)} · {m.group(3)}"
            job.emit("progress", stage="download", progress=pct,
                     eta=job.eta, detail=job.detail)
            if int(pct) % 5 == 0:   # don't spam log
                job.log("dl", f"[download] {pct:.1f}% of {m.group(2)} at {m.group(3)} ETA {m.group(4) or '?'}")
        else:
            low = line.lower()
            if "destination" in low or "extracting audio" in low:
                job.log("inf", line[:140])
            elif "error" in low:
                job.log("warn", line[:140])
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"下载失败 (yt-dlp returncode={proc.returncode})")
    # Locate the produced file
    candidates = list(CACHE_DIR.glob(f"{job.id}.*"))
    if not candidates:
        raise RuntimeError("下载完成但未找到音频文件")
    return candidates[0]


def run_pipeline(job: Job):
    """Synchronous pipeline (runs in background thread)."""
    t_start = time.time()
    try:
        # 规整 URL（处理抖音 modal_id 这类 yt-dlp 不认的格式）
        if job.url:
            job.url = normalize_url(job.url)
        job.platform = detect_platform(job.url) if job.url else None

        # ---- 跨链路复用：已有本地文件，跳过下载 ----
        if job.local_file and os.path.exists(job.local_file):
            audio_path = Path(job.local_file)
            job.status = "extracting"
            job.stage = "extract"
            job.progress = 0
            # 试取文件名作 title
            job.title = job.title or audio_path.stem
            job.emit("status", status=job.status, stage=job.stage, progress=0)
            job.emit("meta", title=job.title, duration=job.duration,
                     video_id=job.video_id, platform=job.platform,
                     thumbnail=job.thumbnail)
            job.log("inf", f"复用本地文件 · {audio_path.name}")
            for p in (40, 80, 100):
                time.sleep(0.1)
                job.emit("progress", stage="extract", progress=p)
        else:
            # ---- Probe ----
            job.status = "downloading"
            job.stage = "download"
            job.progress = 0
            job.emit("status", status=job.status, stage=job.stage, progress=0)
            job.log("inf", f"开始处理 {job.url}")
            try:
                info = probe_video(job.url, job.advanced.get("cookies_browser") or job.advanced.get("cookiesBrowser"))
                job.title = info.get("title") or "(无标题)"
                job.duration = info.get("duration")
                job.video_id = info.get("video_id")
                job.thumbnail = info.get("thumbnail")
                job.emit("meta", title=job.title, duration=job.duration,
                         video_id=job.video_id, platform=job.platform,
                         thumbnail=job.thumbnail)
            except Exception as e:
                err_str = str(e)
                try:
                    err = json.loads(err_str)
                except Exception:
                    err = {"kind": "other", "msg": err_str}
                raise RuntimeError(err_str)

            if job.cancel_event.is_set():
                raise InterruptedError("cancelled")

            # ---- Download audio ----
            audio_path = _yt_dlp_download(job, CACHE_DIR / f"{job.id}.mp3")
            job.log("ok", f"下载完成 · {audio_path.name}")

        # ---- "Extract" (yt-dlp already produced mp3, briefly mark stage) ----
        if not job.local_file:
            if job.cancel_event.is_set():
                raise InterruptedError("cancelled")
            job.status = "extracting"
            job.stage = "extract"
            job.progress = 0
            job.emit("status", status=job.status, stage=job.stage, progress=0)
            job.log("inf", "音频已转码为 mp3")
            for p in (30, 70, 100):
                time.sleep(0.15)
                job.emit("progress", stage="extract", progress=p)

        # ---- Transcribe ----
        if job.cancel_event.is_set():
            raise InterruptedError("cancelled")
        job.status = "transcribing"
        job.stage = "transcribe"
        job.progress = 0
        job.emit("status", status=job.status, stage=job.stage, progress=0)

        model_id = MODEL_MAP.get(job.model, MODEL_MAP["large-v3"])
        language = LANG_MAP.get(job.lang)

        # Whisper 默认中文不输出标点（训练数据偏向无标点字幕）。给一段带标点
        # 的"种子文本"作为 initial_prompt，模型会倾向于沿用同样风格。
        if language == "en":
            initial_prompt = "The following is an English transcript with proper punctuation, commas, and periods."
        else:
            # 中文 / 中英混合 / auto 都走中文 prompt（最常见场景）
            initial_prompt = "以下是一段普通话语音转写，请用规范的中文标点（，。？！：；""''）断句。"

        job.log("inf", f"加载模型: {model_id}")
        t_tr_start = time.time()
        result = mlx_whisper.transcribe(
            str(audio_path),
            path_or_hf_repo=model_id,
            language=language,
            verbose=False,
            initial_prompt=initial_prompt,
            condition_on_previous_text=True,  # 让段间承上启下，标点更连贯
        )
        if job.cancel_event.is_set():
            raise InterruptedError("cancelled")

        job.segments = [
            {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
            for s in result["segments"]
        ]
        job.full_text = result["text"].strip()

        # Emit segments in chunks so client sees them
        for i, seg in enumerate(job.segments):
            job.emit("segment", index=i, **seg)

        # ---- Save output files ----
        base_name = safe_filename(job.title or job.id, job.id)
        file_base = OUTPUTS_DIR / base_name
        # If exists, append id
        if file_base.with_suffix(".txt").exists():
            file_base = OUTPUTS_DIR / f"{base_name}_{job.id[:6]}"
        file_base.with_suffix(".txt").write_text(job.full_text, encoding="utf-8")
        file_base.with_suffix(".srt").write_text(build_srt(job.segments), encoding="utf-8")
        file_base.with_suffix(".vtt").write_text(build_vtt(job.segments), encoding="utf-8")
        file_base.with_suffix(".json").write_text(
            json.dumps({"segments": job.segments, "text": job.full_text,
                        "title": job.title, "duration": job.duration,
                        "video_id": job.video_id, "model": job.model},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")
        job.file_base = file_base

        job.elapsed_seconds = time.time() - t_start
        job.status = "done"
        job.stage = "done"
        job.progress = 100
        job.completed_at = int(time.time())
        job.emit("status", status="done", stage="done", progress=100,
                 elapsed_seconds=job.elapsed_seconds,
                 words=len(job.full_text),
                 segments_count=len(job.segments),
                 file_base=str(file_base.name))
        job.log("ok", f"完成 · 耗时 {job.elapsed_seconds:.1f}s · {len(job.full_text)} 字 · {len(job.segments)} 段")

        try:
            history_save(job)
        except Exception as e:
            job.log("warn", f"历史保存失败: {e}")

        # Clean cache audio (keep if advanced.keep_cache)
        if not job.advanced.get("keep_cache"):
            try: audio_path.unlink()
            except Exception: pass

    except InterruptedError:
        job.status = "cancelled"
        job.error = "已取消"
        job.emit("status", status="cancelled")
        job.log("warn", "任务已取消")
    except Exception as e:
        msg = str(e)
        kind = "other"
        try:
            parsed = json.loads(msg)
            if isinstance(parsed, dict) and "kind" in parsed:
                kind = parsed["kind"]
                msg = parsed.get("msg") or msg
        except Exception:
            pass
        low = msg.lower()
        if kind == "other":
            if "login" in low or "cookies" in low or "members" in low or "premium" in low or "private" in low:
                kind = "login_required"
            elif "unsupported url" in low or "no video" in low or "invalid url" in low:
                kind = "invalid"
        job.status = "error"
        job.error = msg
        job.error_kind = kind
        job.emit("status", status="error", error=msg, error_kind=kind)
        job.log("warn", f"错误 · {msg[:200]}")

# ============================================================
# FastAPI app
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Pydantic schemas
class ProbeReq(BaseModel):
    url: str
    cookies_browser: Optional[str] = None

class JobReq(BaseModel):
    url: str
    model: str = "large-v3"
    lang: str = "auto"
    fmt: str = "txt"
    advanced: Optional[dict] = None
    local_file: Optional[str] = None   # 跨链路复用：已有本地视频/音频文件，跳过下载

class BatchReq(BaseModel):
    urls: list[str]
    model: str = "large-v3"
    lang: str = "auto"
    fmt: str = "txt"
    advanced: Optional[dict] = None

# ---------- API ----------
@app.post("/api/probe")
def api_probe(req: ProbeReq):
    try:
        info = probe_video(req.url, req.cookies_browser)
        info["platform"] = detect_platform(req.url)
        return info
    except Exception as e:
        msg = str(e)
        kind = "other"
        extra = {}
        try:
            parsed = json.loads(msg)
            if isinstance(parsed, dict):
                kind = parsed.get("kind", "other")
                msg = parsed.get("msg") or msg
                if "scannable" in parsed: extra["scannable"] = parsed["scannable"]
                if "type" in parsed: extra["type"] = parsed["type"]
        except Exception:
            pass
        raise HTTPException(status_code=400, detail={"kind": kind, "msg": msg[:300], **extra})

@app.post("/api/jobs")
async def api_create_job(req: JobReq, request: Request):
    # Python 3.14 起 asyncio.get_event_loop() 在 worker thread 里不再自动创建
    # loop，必须用 async def 端点 + get_running_loop()。
    job = Job(url=req.url, model=req.model, lang=req.lang, fmt=req.fmt,
              advanced=req.advanced, local_file=req.local_file)
    job.main_loop = asyncio.get_running_loop()
    JOBS[job.id] = job
    thread = threading.Thread(target=run_pipeline, args=(job,), daemon=True)
    thread.start()
    return {"job_id": job.id}

@app.get("/api/jobs/{jid}")
def api_get_job(jid: str):
    job = JOBS.get(jid)
    if not job:
        # Try history
        with get_db() as conn:
            row = conn.execute("SELECT * FROM history WHERE id=?", (jid,)).fetchone()
            if row:
                d = dict(row)
                # Load transcript
                base = d.get("file_base")
                if base:
                    base_p = Path(base)
                    txt = base_p.with_suffix(".txt")
                    js = base_p.with_suffix(".json")
                    if txt.exists():
                        d["full_text"] = txt.read_text(encoding="utf-8")
                    if js.exists():
                        try:
                            data = json.loads(js.read_text(encoding="utf-8"))
                            d["segments"] = data.get("segments", [])
                        except Exception: pass
                d["status"] = "done"
                d["from_history"] = True
                return d
        raise HTTPException(404, "job not found")
    return job.snapshot()

@app.post("/api/jobs/{jid}/cancel")
def api_cancel(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "job not found")
    job.cancel_event.set()
    return {"ok": True}

@app.get("/api/jobs/{jid}/stream")
async def api_stream(jid: str, request: Request):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "job not found")
    queue: asyncio.Queue = asyncio.Queue()
    job.subscribers.append(queue)

    async def gen():
        # Send initial snapshot
        yield f"event: snapshot\ndata: {json.dumps(job.snapshot(), ensure_ascii=False)}\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    # heartbeat
                    yield ": ping\n\n"
                    continue
                yield f"event: {msg.get('type','msg')}\ndata: {json.dumps(msg, ensure_ascii=False)}\n\n"
                if msg.get("type") == "status" and msg.get("status") in ("done", "error", "cancelled"):
                    yield f"event: end\ndata: {{}}\n\n"
                    break
        finally:
            try: job.subscribers.remove(queue)
            except ValueError: pass
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.get("/api/jobs/{jid}/result/{fmt}")
def api_download(jid: str, fmt: str):
    if fmt not in ("txt", "srt", "vtt", "json"):
        raise HTTPException(400, "bad fmt")
    job = JOBS.get(jid)
    file_base = None
    if job and job.file_base:
        file_base = job.file_base
    else:
        with get_db() as conn:
            row = conn.execute("SELECT file_base, title FROM history WHERE id=?", (jid,)).fetchone()
            if row and row["file_base"]:
                file_base = Path(row["file_base"])
    if not file_base:
        raise HTTPException(404, "result not found")
    fp = file_base.with_suffix(f".{fmt}")
    if not fp.exists():
        raise HTTPException(404, "file not found")
    return FileResponse(str(fp), filename=fp.name, media_type="application/octet-stream")

# ---------- History ----------
@app.get("/api/history")
def api_history(q: Optional[str] = None, kind: Optional[str] = None):
    return {"items": history_list(q, kind)}

@app.delete("/api/history/{jid}")
def api_history_delete(jid: str):
    history_delete(jid)
    return {"ok": True}

@app.delete("/api/history")
def api_history_clear():
    history_clear()
    return {"ok": True}

# ---------- Batch ----------
class BatchJob:
    def __init__(self, urls: list[str], model, lang, fmt, advanced):
        self.id = "B" + uuid.uuid4().hex[:10]
        self.created_at = int(time.time())
        self.items: list[Job] = []
        for u in urls:
            j = Job(url=u, model=model, lang=lang, fmt=fmt, advanced=advanced)
            self.items.append(j)
            JOBS[j.id] = j
        self.subscribers: list[asyncio.Queue] = []
        self.main_loop: Optional[asyncio.AbstractEventLoop] = None
        self.cancel_event = threading.Event()

    def emit(self, **data):
        msg = {"batch_id": self.id, **data}
        if self.main_loop is None:
            return
        for q in list(self.subscribers):
            try:
                self.main_loop.call_soon_threadsafe(q.put_nowait, msg)
            except Exception:
                pass

    def snapshot(self):
        return {
            "id": self.id,
            "items": [j.snapshot() for j in self.items],
            "created_at": self.created_at,
        }

BATCHES: dict[str, BatchJob] = {}

def run_batch(b: BatchJob):
    for j in b.items:
        if b.cancel_event.is_set(): break
        j.main_loop = b.main_loop
        b.emit(type="item_start", item_index=b.items.index(j), job_id=j.id)
        run_pipeline(j)
        b.emit(type="item_end", item_index=b.items.index(j), job_id=j.id, status=j.status)
    b.emit(type="batch_end")

@app.post("/api/batch")
async def api_batch(req: BatchReq):
    if not req.urls:
        raise HTTPException(400, "no urls")
    b = BatchJob(req.urls, req.model, req.lang, req.fmt, req.advanced)
    b.main_loop = asyncio.get_running_loop()
    BATCHES[b.id] = b
    threading.Thread(target=run_batch, args=(b,), daemon=True).start()
    return {"batch_id": b.id, "job_ids": [j.id for j in b.items]}

@app.get("/api/batch/{bid}")
def api_batch_get(bid: str):
    b = BATCHES.get(bid)
    if not b: raise HTTPException(404, "batch not found")
    return b.snapshot()

@app.get("/api/batch/{bid}/stream")
async def api_batch_stream(bid: str, request: Request):
    b = BATCHES.get(bid)
    if not b: raise HTTPException(404, "batch not found")
    queue: asyncio.Queue = asyncio.Queue()
    b.subscribers.append(queue)

    async def gen():
        yield f"event: snapshot\ndata: {json.dumps(b.snapshot(), ensure_ascii=False)}\n\n"
        try:
            while True:
                if await request.is_disconnected(): break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"; continue
                yield f"event: {msg.get('type','msg')}\ndata: {json.dumps(msg, ensure_ascii=False)}\n\n"
                if msg.get("type") == "batch_end":
                    yield f"event: end\ndata: {{}}\n\n"; break
        finally:
            try: b.subscribers.remove(queue)
            except ValueError: pass
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ============================================================
# AI Integration
# ============================================================
class AIConfigReq(BaseModel):
    provider: str
    base_url: str
    api_key: str
    model: str
    prompts: Optional[dict] = None

class AITestReq(BaseModel):
    provider: str
    base_url: str
    api_key: str
    model: str

class AIOrganizeReq(BaseModel):
    job_id: Optional[str] = None
    text: Optional[str] = None
    mode: str = "smart-doc"   # smart-doc | notes | qa | mindmap
    title: Optional[str] = None

@app.get("/api/ai/config")
def api_ai_config_get():
    cfg = load_config().get("ai", {})
    return {
        "provider": cfg.get("provider", "deepseek"),
        "base_url": cfg.get("base_url", PROVIDER_PRESETS["deepseek"]["base_url"]),
        "api_key_masked": mask_key(cfg.get("api_key", "")),
        "has_key": bool(cfg.get("api_key")),
        "model": cfg.get("model", ""),
        "prompts": {**DEFAULT_PROMPTS, **(cfg.get("prompts") or {})},
        "presets": PROVIDER_PRESETS,
        "models":  PROVIDER_MODELS,
    }

@app.post("/api/ai/config")
def api_ai_config_set(req: AIConfigReq):
    cfg = load_config()
    cfg.setdefault("ai", {})
    cfg["ai"]["provider"] = req.provider
    cfg["ai"]["base_url"] = req.base_url.rstrip("/")
    cfg["ai"]["model"]    = req.model
    # Only update key if non-empty + not the mask
    if req.api_key and "*" not in req.api_key:
        cfg["ai"]["api_key"] = req.api_key
    if req.prompts:
        cfg["ai"]["prompts"] = req.prompts
    save_config(cfg)
    return {"ok": True}

@app.post("/api/ai/test")
async def api_ai_test(req: AITestReq):
    """Send a tiny ping to verify configuration."""
    # If api_key is a mask string, load real key from config
    key = req.api_key
    if not key or "*" in key:
        key = (load_config().get("ai", {}) or {}).get("api_key", "")
    if not key:
        raise HTTPException(400, "缺少 API Key")
    preset = PROVIDER_PRESETS.get(req.provider, PROVIDER_PRESETS["custom"])
    kind = preset["kind"]
    try:
        if kind == "anthropic":
            url = f"{req.base_url.rstrip('/')}/v1/messages"
            headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
            body = {"model": req.model, "max_tokens": 16,
                    "messages": [{"role": "user", "content": "Reply with just OK."}]}
        else:
            url = f"{req.base_url.rstrip('/')}/chat/completions"
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            body = {"model": req.model,
                    "messages": [{"role": "user", "content": "Reply with just OK."}],
                    "max_tokens": 16, "stream": False, "temperature": 0}
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=body)
            if r.status_code != 200:
                return JSONResponse({"ok": False, "error": f"HTTP {r.status_code}: {r.text[:300]}"}, status_code=200)
            data = r.json()
            if kind == "anthropic":
                reply = data.get("content", [{}])[0].get("text", "")
            else:
                reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return {"ok": True, "reply": reply[:200]}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:300]}, status_code=200)

def _build_organize_prompt(text: str, mode: str, title: Optional[str], prompts: dict) -> str:
    tmpl = prompts.get(mode) or DEFAULT_PROMPTS.get(mode) or DEFAULT_PROMPTS["smart-doc"]
    prefix = ""
    if title:
        prefix = f"视频标题：{title}\n\n"
    return tmpl.replace("{TEXT}", prefix + text)

async def _organize_stream(req: AIOrganizeReq):
    """Async generator producing SSE lines for AI organize streaming."""
    cfg = load_config().get("ai", {}) or {}
    if not cfg.get("api_key"):
        yield f'event: error\ndata: {json.dumps({"error": "AI 未配置 · 请先到「设置」填写 API Key"}, ensure_ascii=False)}\n\n'
        return

    provider = cfg.get("provider", "deepseek")
    preset = PROVIDER_PRESETS.get(provider, PROVIDER_PRESETS["custom"])
    kind = preset["kind"]
    base_url = (cfg.get("base_url") or preset["base_url"]).rstrip("/")
    api_key = cfg["api_key"]
    model = cfg.get("model") or preset["model"]
    prompts = {**DEFAULT_PROMPTS, **(cfg.get("prompts") or {})}

    # Resolve text source
    text = req.text
    title = req.title
    if not text and req.job_id:
        # 1) live job
        j = JOBS.get(req.job_id)
        if j and j.full_text:
            text = j.full_text
            title = title or j.title
        else:
            # 2) batch — merge all done items
            for b in BATCHES.values():
                for it in b.items:
                    if it.id == req.job_id:
                        # full batch merge
                        chunks = []
                        for x in b.items:
                            if x.status == "done" and x.full_text:
                                chunks.append(f"## {x.title or x.id}\n\n{x.full_text}")
                        text = "\n\n".join(chunks)
                        title = title or "批量转录合并"
                        break
                if text: break
            # 3) history
            if not text:
                with get_db() as conn:
                    row = conn.execute("SELECT * FROM history WHERE id=?", (req.job_id,)).fetchone()
                    if row and row["file_base"]:
                        txt_p = Path(row["file_base"]).with_suffix(".txt")
                        if txt_p.exists():
                            text = txt_p.read_text(encoding="utf-8")
                            title = title or row["title"]
    if not text:
        yield f'event: error\ndata: {json.dumps({"error": "找不到要整理的文本"}, ensure_ascii=False)}\n\n'
        return

    prompt = _build_organize_prompt(text, req.mode, title, prompts)
    yield f'event: meta\ndata: {json.dumps({"provider": provider, "model": model, "mode": req.mode, "text_len": len(text)}, ensure_ascii=False)}\n\n'

    try:
        if kind == "anthropic":
            url = f"{base_url}/v1/messages"
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
            body = {"model": model, "max_tokens": 8000, "stream": True,
                    "messages": [{"role": "user", "content": prompt}]}
        else:
            url = f"{base_url}/chat/completions"
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            body = {"model": model, "stream": True, "temperature": 0.3,
                    "messages": [
                        {"role": "system", "content": "你是一个专业的中文内容整理助手。输出严格按用户要求的 Markdown 格式。"},
                        {"role": "user", "content": prompt},
                    ]}

        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, read=300.0)) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    raw = await resp.aread()
                    err_text = raw.decode("utf-8", errors="replace")[:300]
                    err_msg = f"HTTP {resp.status_code}: {err_text}"
                    yield f'event: error\ndata: {json.dumps({"error": err_msg}, ensure_ascii=False)}\n\n'
                    return
                async for line in resp.aiter_lines():
                    if not line: continue
                    if line.startswith("data: "):
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = json.loads(data)
                        except Exception:
                            continue
                        if kind == "anthropic":
                            if obj.get("type") == "content_block_delta":
                                delta = obj.get("delta", {}).get("text", "")
                                if delta:
                                    yield f'event: token\ndata: {json.dumps({"text": delta}, ensure_ascii=False)}\n\n'
                            elif obj.get("type") == "message_stop":
                                break
                        else:
                            choices = obj.get("choices") or []
                            if choices:
                                delta = (choices[0].get("delta") or {}).get("content", "")
                                if delta:
                                    yield f'event: token\ndata: {json.dumps({"text": delta}, ensure_ascii=False)}\n\n'
        yield f'event: done\ndata: {{}}\n\n'
    except Exception as e:
        yield f'event: error\ndata: {json.dumps({"error": str(e)[:500]}, ensure_ascii=False)}\n\n'

@app.post("/api/ai/organize")
async def api_ai_organize(req: AIOrganizeReq):
    return StreamingResponse(_organize_stream(req), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ============================================================
# Local file upload (for "本地文件" button)
# ============================================================
ALLOWED_EXTS = {".mp3", ".m4a", ".mp4", ".wav", ".mkv", ".webm", ".mov",
                ".aac", ".flac", ".ogg", ".opus", ".wma", ".aif", ".aiff", ".avi"}

@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)):
    """接受本地音/视频文件上传，保存到 cache，返回路径供 Job 复用。"""
    name = file.filename or "upload.bin"
    suffix = Path(name).suffix.lower()
    if suffix and suffix not in ALLOWED_EXTS:
        raise HTTPException(400, f"不支持的格式 {suffix}，请上传音频或视频文件")
    safe = re.sub(r"[^\w一-鿿.\-]", "_", name)
    target = CACHE_DIR / f"upload_{uuid.uuid4().hex[:8]}_{safe}"
    size = 0
    with target.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk: break
            f.write(chunk)
            size += len(chunk)
    return {
        "path": str(target),
        "name": name,
        "size": size,
        "title": Path(name).stem,
    }

# ============================================================
# Chain B: Download video chain
# ============================================================
def probe_formats(url: str, cookies_browser: Optional[str] = None) -> dict:
    """yt-dlp -J 探测 + 按画质档归类。返回 {meta, tiers, audio}."""
    url = normalize_url(url)
    bad = classify_non_video_url(url)
    if bad:
        raise RuntimeError(json.dumps({
            "kind": "not_video", "msg": bad["msg"],
            "scannable": bad.get("scannable", False), "type": bad.get("type"),
        }))

    cmd = ["yt-dlp", "-J", "--no-warnings", "--no-playlist", url]
    if cookies_browser:
        cmd += ["--cookies-from-browser", cookies_browser]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        err = (proc.stderr or "")[:300]
        kind = "other"
        low = err.lower()
        if ("412" in low or "352" in low or "509" in low
                or "blocked by server" in low or "rejected by server" in low):
            kind = "rate_limited"
        elif "login" in low or "cookies" in low or "members" in low or "premium" in low:
            kind = "login_required"
        raise RuntimeError(json.dumps({"kind": kind, "msg": err.strip() or "probe failed"}))
    data = json.loads(proc.stdout)
    formats = data.get("formats") or []

    video_fmts = [f for f in formats
                  if f.get("vcodec") and f["vcodec"] != "none" and f.get("height")]
    audio_fmts = [f for f in formats
                  if f.get("acodec") and f["acodec"] != "none"
                  and (not f.get("vcodec") or f.get("vcodec") == "none")]
    best_audio = max(audio_fmts, key=lambda f: f.get("abr") or 0, default=None) if audio_fmts else None
    audio_size = (best_audio or {}).get("filesize") or (best_audio or {}).get("filesize_approx") or 0

    TIERS = [(360, "360P"), (480, "480P"), (720, "720P"), (1080, "1080P"), (2160, "4K")]
    tiers_out = []
    for height, label in TIERS:
        cand = [f for f in video_fmts if f.get("height") == height]
        if not cand:
            continue
        # Highest fps first
        max_fps = max((c.get("fps") or 0) for c in cand)
        same_fps = [c for c in cand if (c.get("fps") or 0) >= max_fps - 1]
        # Prefer h264/avc for compat
        avc = [c for c in same_fps if "avc" in (c.get("vcodec") or "").lower()
               or "h264" in (c.get("vcodec") or "").lower()]
        chosen = avc[0] if avc else same_fps[0]
        fps = chosen.get("fps") or 0
        fps_suffix = f" {int(fps)}" if fps > 31 else ""
        vsize = chosen.get("filesize") or chosen.get("filesize_approx") or 0
        tiers_out.append({
            "format_id": chosen["format_id"],
            "height": height,
            "label": label + fps_suffix,
            "spec": f"{chosen.get('width') or '?'}x{chosen.get('height')} · {chosen.get('vcodec', '?')}",
            "fmt": chosen.get("ext") or "mp4",
            "size": (vsize or 0) + (audio_size or 0),
            "fps": fps,
            "vcodec": chosen.get("vcodec"),
            "acodec": (best_audio or {}).get("acodec", ""),
            "hdr": "hdr" in (chosen.get("dynamic_range") or "").lower(),
            "locked": False,
            "recommended": False,
        })

    # Mark recommended: 1080P 60 if present, else highest fps 1080P, else highest available
    if tiers_out:
        target = next((t for t in tiers_out if t["height"] == 1080), None) or tiers_out[-1]
        target["recommended"] = True

    # Available subtitle languages
    subs = data.get("subtitles") or {}
    autosubs = data.get("automatic_captions") or {}
    avail_subs = list(subs.keys())[:5]
    avail_auto = list(autosubs.keys())[:5]

    return {
        "title": data.get("title"),
        "duration": data.get("duration"),
        "uploader": data.get("uploader") or data.get("channel"),
        "video_id": data.get("id"),
        "thumbnail": data.get("thumbnail"),
        "upload_date": data.get("upload_date"),
        "platform": detect_platform(url),
        "tiers": tiers_out,
        "audio_format_id": (best_audio or {}).get("format_id"),
        "audio_size": audio_size,
        "subtitles_avail": avail_subs,
        "auto_subs_avail": avail_auto,
    }


class DownloadJob:
    def __init__(self, url: str, format_id: str, audio_format_id: Optional[str] = None,
                 save_dir: Optional[str] = None, name_template: Optional[str] = None,
                 extras: Optional[dict] = None, cookies_browser: Optional[str] = None):
        self.id = "D" + uuid.uuid4().hex[:11]
        self.url = url
        self.format_id = format_id
        self.audio_format_id = audio_format_id
        self.save_dir = Path(save_dir or _dl_save_dir()).expanduser()
        self.name_template = name_template or _dl_name_template()
        self.extras = extras or {}
        self.cookies_browser = cookies_browser

        self.status = "pending"   # pending|downloading|merging|done|error|cancelled
        self.progress = 0.0
        self.eta = ""
        self.speed = ""
        self.downloaded = 0
        self.total = 0

        self.title = None
        self.duration = None
        self.video_id = None
        self.platform = None
        self.thumbnail = None
        self.uploader = None
        self.upload_date = None

        self.file_path: Optional[Path] = None
        self.subtitle_paths: list[Path] = []
        self.thumbnail_path: Optional[Path] = None
        self.elapsed_seconds = 0.0
        self.created_at = int(time.time())
        self.completed_at: Optional[int] = None

        self.logs: list = []
        self.error: Optional[str] = None
        self.error_kind: Optional[str] = None
        self.cancel_event = threading.Event()
        self.subscribers: list[asyncio.Queue] = []
        self.main_loop: Optional[asyncio.AbstractEventLoop] = None

    def emit(self, event_type: str, **data):
        msg = {"type": event_type, "job_id": self.id, **data}
        if self.main_loop is None: return
        for q in list(self.subscribers):
            try: self.main_loop.call_soon_threadsafe(q.put_nowait, msg)
            except Exception: pass

    def log(self, level: str, msg: str):
        entry = {"ts": time.strftime("%H:%M:%S"), "level": level, "msg": msg}
        self.logs.append(entry)
        self.emit("log", **entry)

    def snapshot(self) -> dict:
        return {
            "id": self.id, "url": self.url,
            "status": self.status, "progress": self.progress,
            "eta": self.eta, "speed": self.speed,
            "downloaded": self.downloaded, "total": self.total,
            "title": self.title, "duration": self.duration,
            "video_id": self.video_id, "thumbnail": self.thumbnail,
            "uploader": self.uploader, "upload_date": self.upload_date,
            "format_id": self.format_id, "audio_format_id": self.audio_format_id,
            "save_dir": str(self.save_dir), "name_template": self.name_template,
            "extras": self.extras, "platform": self.platform,
            "file_path": str(self.file_path) if self.file_path else None,
            "subtitle_paths": [str(p) for p in self.subtitle_paths],
            "thumbnail_path": str(self.thumbnail_path) if self.thumbnail_path else None,
            "elapsed_seconds": self.elapsed_seconds,
            "created_at": self.created_at, "completed_at": self.completed_at,
            "error": self.error, "error_kind": self.error_kind,
            "logs": self.logs[-200:],
        }

DL_JOBS: dict[str, DownloadJob] = {}

def _dl_save_dir() -> str:
    return (load_config().get("download", {}) or {}).get("save_dir", str(DEFAULT_DL_DIR))

def _dl_name_template() -> str:
    return (load_config().get("download", {}) or {}).get("name_template", DEFAULT_DL_TEMPLATE)

def _yt_template(simple: str) -> str:
    """Map {title} {uploader} {id} {ext} → yt-dlp's %(title)s etc."""
    s = simple
    for k, v in [("{title}", "%(title)s"), ("{uploader}", "%(uploader)s"),
                  ("{id}", "%(id)s"), ("{ext}", "%(ext)s")]:
        s = s.replace(k, v)
    if "%(ext)s" not in s:
        s += ".%(ext)s"
    # Sanitize: yt-dlp itself handles invalid chars when --restrict-filenames is off
    return s


def run_download(job: DownloadJob):
    t_start = time.time()
    try:
        # 规整 URL（处理抖音 modal_id 这类 yt-dlp 不认的格式）
        if job.url:
            job.url = normalize_url(job.url)
        job.platform = detect_platform(job.url)
        # Probe for meta (best-effort)
        try:
            info = probe_video(job.url, job.cookies_browser)
            job.title = info.get("title")
            job.duration = info.get("duration")
            job.video_id = info.get("video_id")
            job.thumbnail = info.get("thumbnail")
            job.uploader = info.get("uploader")
            job.emit("meta", title=job.title, duration=job.duration,
                     video_id=job.video_id, thumbnail=job.thumbnail,
                     uploader=job.uploader, platform=job.platform)
        except Exception as e:
            job.log("warn", f"探测失败: {e}")

        if job.cancel_event.is_set(): raise InterruptedError("cancelled")

        out_path = job.save_dir / _yt_template(job.name_template)
        job.save_dir.mkdir(parents=True, exist_ok=True)

        fmt = job.format_id
        if job.audio_format_id and "+" not in fmt:
            fmt = f"{job.format_id}+{job.audio_format_id}"
        elif "+" not in fmt and "best" not in fmt.lower():
            fmt = f"{job.format_id}+bestaudio/best"

        cmd = ["yt-dlp", "-f", fmt,
               "-o", str(out_path),
               "--no-playlist", "--newline", "--progress",
               "--merge-output-format", "mp4",
               "--print", "after_move:filepath:%(filepath)s"]
        if job.cookies_browser:
            cmd += ["--cookies-from-browser", job.cookies_browser]
        if job.extras.get("subtitles"):
            cmd += ["--write-subs", "--write-auto-subs", "--sub-langs", "all,-live_chat"]
        if job.extras.get("thumbnail"):
            cmd += ["--write-thumbnail"]
        if job.extras.get("metadata"):
            cmd += ["--embed-metadata"]
        cmd.append(job.url)

        job.status = "downloading"
        job.emit("status", status=job.status)
        job.log("inf", f"开始下载 {job.url}")
        job.log("inf", f"格式: {fmt}")

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1)
        pct_re = re.compile(
            r'(\d+\.?\d*)%\s+of\s+~?\s*([\d\.]+)(KiB|MiB|GiB|B).*?at\s+([\d\.]+)(KiB/s|MiB/s|GiB/s|B/s)(?:\s+ETA\s+([\d:]+))?',
            re.IGNORECASE,
        )
        unit_map = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}
        final_path = None
        last_log_pct = -10
        for line in proc.stdout:
            if job.cancel_event.is_set():
                proc.terminate()
                try: proc.wait(timeout=2)
                except Exception: proc.kill()
                raise InterruptedError("cancelled")
            line = line.rstrip()
            if not line: continue
            if line.startswith("filepath:"):
                final_path = line[len("filepath:"):].strip()
                continue
            m = pct_re.search(line)
            if m:
                pct = float(m.group(1))
                total_val = float(m.group(2))
                total_unit = m.group(3)
                speed_val = float(m.group(4))
                speed_unit = m.group(5)
                eta = m.group(6) or ""
                total_bytes = int(total_val * unit_map.get(total_unit, 1))
                job.total = total_bytes
                job.downloaded = int(total_bytes * pct / 100)
                job.progress = pct
                job.eta = eta
                job.speed = f"{speed_val:.1f} {speed_unit.replace('iB', 'B')}"
                job.emit("progress",
                         progress=pct, eta=eta, speed=job.speed,
                         total=job.total, downloaded=job.downloaded)
                if pct - last_log_pct >= 10:
                    job.log("dl", f"[download] {pct:.1f}% of {total_val:.1f}{total_unit} at {speed_val:.1f}{speed_unit} ETA {eta or '?'}")
                    last_log_pct = pct
            else:
                low = line.lower()
                if "destination" in low or "merging formats" in low or "extracting" in low or "writing" in low:
                    if not line.startswith("[download]") or "destination" in low:
                        job.log("inf", line[:160])
                elif "error" in low:
                    job.log("warn", line[:160])
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"yt-dlp 退出码 {proc.returncode}")

        # Locate final file
        if final_path and os.path.exists(final_path):
            job.file_path = Path(final_path)
        else:
            files = sorted(job.save_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
            for f in files:
                if f.is_file() and f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov"):
                    job.file_path = f
                    break

        # Find sidecar files
        if job.file_path:
            stem = job.file_path.stem
            for s in job.save_dir.glob(f"{stem}*"):
                ext = s.suffix.lower()
                if ext in (".srt", ".vtt", ".ass"):
                    job.subtitle_paths.append(s)
                elif ext in (".jpg", ".jpeg", ".png", ".webp") and not job.thumbnail_path:
                    job.thumbnail_path = s

        job.elapsed_seconds = time.time() - t_start
        job.status = "done"
        job.progress = 100
        job.completed_at = int(time.time())
        job.emit("status",
                 status="done", progress=100,
                 file_path=str(job.file_path) if job.file_path else None,
                 subtitle_paths=[str(p) for p in job.subtitle_paths],
                 thumbnail_path=str(job.thumbnail_path) if job.thumbnail_path else None,
                 elapsed_seconds=job.elapsed_seconds)
        job.log("ok", f"完成 · 耗时 {job.elapsed_seconds:.1f}s · 已写入 {job.file_path.name if job.file_path else '?'}")
    except InterruptedError:
        job.status = "cancelled"
        job.emit("status", status="cancelled")
        job.log("warn", "已取消")
    except Exception as e:
        msg = str(e)
        kind = "other"
        low = msg.lower()
        if "login" in low or "cookies" in low or "members" in low or "premium" in low:
            kind = "login_required"
        elif "format" in low and ("not available" in low or "unavailable" in low):
            kind = "format_unavailable"
        job.status = "error"
        job.error = msg
        job.error_kind = kind
        job.emit("status", status="error", error=msg, error_kind=kind)
        job.log("warn", f"错误: {msg[:200]}")


# ---------- Download API ----------
class DLProbeReq(BaseModel):
    url: str
    cookies_browser: Optional[str] = None

class DLJobReq(BaseModel):
    url: str
    format_id: str
    audio_format_id: Optional[str] = None
    save_dir: Optional[str] = None
    name_template: Optional[str] = None
    extras: Optional[dict] = None
    cookies_browser: Optional[str] = None

class DLSettingsReq(BaseModel):
    save_dir: Optional[str] = None
    name_template: Optional[str] = None

@app.post("/api/dl/probe")
def api_dl_probe(req: DLProbeReq):
    try:
        return probe_formats(req.url, req.cookies_browser)
    except Exception as e:
        msg = str(e)
        kind = "other"
        extra = {}
        try:
            parsed = json.loads(msg)
            if isinstance(parsed, dict):
                kind = parsed.get("kind", "other")
                msg = parsed.get("msg") or msg
                if "scannable" in parsed: extra["scannable"] = parsed["scannable"]
                if "type" in parsed: extra["type"] = parsed["type"]
        except Exception: pass
        raise HTTPException(400, detail={"kind": kind, "msg": msg[:300], **extra})


# ---------- Channel scan + batch download ----------
class ChannelProbeReq(BaseModel):
    url: str
    cookies_browser: Optional[str] = None
    limit: int = 50

@app.post("/api/channel/probe")
def api_channel_probe(req: ChannelProbeReq):
    try:
        return probe_channel(req.url, req.cookies_browser, req.limit)
    except Exception as e:
        msg = str(e)
        kind = "other"
        try:
            parsed = json.loads(msg)
            if isinstance(parsed, dict):
                kind = parsed.get("kind", "other")
                msg = parsed.get("msg") or msg
        except Exception: pass
        raise HTTPException(400, detail={"kind": kind, "msg": msg[:300]})

class DLBatchReq(BaseModel):
    urls: list[str]
    height_max: Optional[int] = 1080      # 上限分辨率（720/1080/2160/9999）
    save_dir: Optional[str] = None
    name_template: Optional[str] = None
    extras: Optional[dict] = None
    cookies_browser: Optional[str] = None

@app.post("/api/dl/batch")
async def api_dl_batch(req: DLBatchReq):
    """批量下载：根据 height_max 让 yt-dlp 自挑各视频可用的最佳画质。"""
    if not req.urls:
        raise HTTPException(400, "no urls")
    hmax = int(req.height_max or 1080)
    fmt_spec = f"bv*[height<={hmax}]+ba/b[height<={hmax}]/best"
    loop = asyncio.get_running_loop()
    jobs = []
    for u in req.urls:
        j = DownloadJob(
            url=u,
            format_id=fmt_spec,  # 整串 format selector，run_download 里直接用
            audio_format_id=None,
            save_dir=req.save_dir,
            name_template=req.name_template,
            extras=req.extras,
            cookies_browser=req.cookies_browser,
        )
        j.main_loop = loop
        DL_JOBS[j.id] = j
        jobs.append(j)

    # 按顺序跑（CPU/带宽限制下并行无收益）
    def runner():
        for j in jobs:
            run_download(j)
    threading.Thread(target=runner, daemon=True).start()
    return {"job_ids": [j.id for j in jobs]}

@app.post("/api/dl/jobs")
async def api_dl_create(req: DLJobReq):
    j = DownloadJob(url=req.url, format_id=req.format_id,
                    audio_format_id=req.audio_format_id,
                    save_dir=req.save_dir,
                    name_template=req.name_template,
                    extras=req.extras,
                    cookies_browser=req.cookies_browser)
    j.main_loop = asyncio.get_running_loop()
    DL_JOBS[j.id] = j
    threading.Thread(target=run_download, args=(j,), daemon=True).start()
    return {"job_id": j.id}

@app.get("/api/dl/jobs/{jid}")
def api_dl_get(jid: str):
    j = DL_JOBS.get(jid)
    if not j: raise HTTPException(404, "not found")
    return j.snapshot()

@app.post("/api/dl/jobs/{jid}/cancel")
def api_dl_cancel(jid: str):
    j = DL_JOBS.get(jid)
    if not j: raise HTTPException(404, "not found")
    j.cancel_event.set()
    return {"ok": True}

@app.get("/api/dl/jobs/{jid}/stream")
async def api_dl_stream(jid: str, request: Request):
    j = DL_JOBS.get(jid)
    if not j: raise HTTPException(404, "not found")
    queue: asyncio.Queue = asyncio.Queue()
    j.subscribers.append(queue)
    async def gen():
        yield f"event: snapshot\ndata: {json.dumps(j.snapshot(), ensure_ascii=False)}\n\n"
        try:
            while True:
                if await request.is_disconnected(): break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"; continue
                yield f"event: {msg.get('type','msg')}\ndata: {json.dumps(msg, ensure_ascii=False)}\n\n"
                if msg.get("type") == "status" and msg.get("status") in ("done","error","cancelled"):
                    yield f"event: end\ndata: {{}}\n\n"; break
        finally:
            try: j.subscribers.remove(queue)
            except ValueError: pass
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

class RevealReq(BaseModel):
    path: str

@app.post("/api/dl/reveal")
def api_dl_reveal(req: RevealReq):
    if not req.path or not os.path.exists(req.path):
        raise HTTPException(404, "file not found")
    try:
        subprocess.Popen(["open", "-R", req.path])
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True}

class CookiesProbeReq(BaseModel):
    browser: str
    domain: str = "bilibili.com"

# 各平台"登录态"关键 cookie。比较前一律 .lower() —— 抖音/TikTok 习惯小写，
# B 站 / Google 习惯大写或混合。命中任一即认为已登录。
_PLATFORM_LOGIN_KEYS: dict[str, set[str]] = {
    "bilibili.com": {"sessdata", "dedeuserid", "bili_jct", "buvid3"},
    "youtube.com":  {"sapisid", "sid", "hsid", "ssid", "apisid", "__secure-3psid", "login_info"},
    "douyin.com":   {"sessionid", "sessionid_ss", "sid_tt", "passport_csrf_token", "uid_tt"},
    "tiktok.com":   {"sessionid", "sid_tt", "tt_webid", "sid_guard"},
    "x.com":        {"auth_token", "ct0"},
    "twitter.com":  {"auth_token", "ct0"},
}

@app.post("/api/cookies/probe")
def api_cookies_probe(req: CookiesProbeReq):
    """诊断指定浏览器能不能读到该域名的 cookies。"""
    try:
        cookies = _read_browser_cookies(req.browser, req.domain)
        keys = sorted(cookies.keys())
        login_keys = _PLATFORM_LOGIN_KEYS.get(req.domain.lower(), set())
        important = [k for k in keys if k.lower() in login_keys]
        return {
            "ok": bool(cookies),
            "count": len(keys),
            "keys": keys[:20],
            "important_keys": important,
            "has_login": bool(important),
            "domain": req.domain,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}

@app.get("/api/dl/settings")
def api_dl_settings_get():
    return {
        "save_dir": _dl_save_dir(),
        "name_template": _dl_name_template(),
        "default_save_dir": str(DEFAULT_DL_DIR),
        "default_name_template": DEFAULT_DL_TEMPLATE,
    }

@app.post("/api/dl/settings")
def api_dl_settings_set(req: DLSettingsReq):
    cfg = load_config()
    cfg.setdefault("download", {})
    if req.save_dir is not None:
        # Expand ~ and save absolute
        cfg["download"]["save_dir"] = str(Path(req.save_dir).expanduser())
    if req.name_template is not None:
        cfg["download"]["name_template"] = req.name_template
    save_config(cfg)
    return {"ok": True}

# ---------- Static / index ----------
# 静态文件加 no-cache 头：WKWebView 默认缓存激进，改代码后 .app 重启
# 也可能拿到旧 JS/CSS。这里强制每次请求都走网络（本地 HTTP，开销微忽略）。
@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") or path == "/":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    print("=" * 60)
    print("  拾字 · 视频转文字  ")
    print("  http://127.0.0.1:7860")
    print("  Ctrl+C 退出")
    print("=" * 60)
    uvicorn.run("server:app", host="127.0.0.1", port=7860, log_level="info")
