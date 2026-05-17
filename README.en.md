# Shizi · Voicetype Studio

> Turn any video into readable text — runs entirely on your Mac, nothing uploaded.

A local-first video processing workstation for macOS, with **two chains**:
- 🅣 **Transcribe**: Paste a video URL → mlx-whisper recognizes → outputs txt / srt / vtt / json
- ⬇ **Download**: Paste a video URL → yt-dlp picks quality → saves to disk

**Highlights**
- Supports 1,800+ platforms (Bilibili / YouTube / X / TikTok / 小宇宙 …)
- One-click scan a Bilibili UP creator's space / YouTube channel / playlist → tick videos for batch processing
- Collection auto-detection. Multiple transcripts can be merged into a single Markdown doc (bring your own AI key: DeepSeek / OpenAI / Anthropic / Qwen / GLM / Moonshot / local Ollama / any OpenAI-compatible service)
- Live subtitles with timestamp jumping + full-text search
- Runs on Apple Silicon (mlx-whisper). `large-v3` is roughly 1:8 realtime on M-series
- Design: editorial / magazine feel, deep crimson + navy two-chain color system

> 中文 README：[README.md](./README.md)

---

## Requirements

| Item | Required |
|---|---|
| OS | macOS 13+ |
| Chip | **Apple Silicon (M1/M2/M3/M4)** — mlx-whisper needs Apple GPU |
| Python | 3.10+ |
| CLI | `yt-dlp` · `ffmpeg` (setup script installs via Homebrew) |
| Browser (for cookies) | Safari / Chrome / Firefox / Edge / Brave / Chromium / Opera / Vivaldi |

**Intel Mac / Linux / Windows**: replace `mlx-whisper` with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (see *Non-Apple-Silicon adaptation* below).

---

## Install (one command)

```bash
git clone https://github.com/<your-username>/shizi.git
cd shizi
bash setup.sh
```

`setup.sh` will:
1. Install `yt-dlp` and `ffmpeg` via Homebrew (skip if present)
2. Create Python venv `.venv/`
3. Install Python deps from `requirements.txt`
4. Print launch instructions

---

## Launch

```bash
bash 启动.command          # or double-click 启动.command in Finder
```

Browser opens at `http://127.0.0.1:7860` automatically. Stop with `Ctrl+C` in the terminal.

---

## Configure AI organize (optional, recommended)

Raw transcripts are colloquial. AI can refine them into:
- 📑 **Cleaned doc** — remove fillers, split chapters, table of contents
- 🧠 **Study notes** — key points + keywords + one-sentence summary
- 🎯 **Q&A cards** — Anki-importable
- 🌳 **Mind map** — Markdown indent tree

**How**:
1. Click the `[AI]` rail icon (left side)
2. Pick a provider (DeepSeek V4 Flash recommended — cheapest, fast enough)
3. Paste API Key → Test → Save
4. After transcription completes, click "AI 整理" on the complete view

Keys stored in `~/.shizi/config.json` (chmod 600).

---

## Bilibili login state (bypass 412/352 anti-bot)

Bilibili rate-limits anonymous requests. To scan UP creator pages or download 1080P+:

1. Open `bilibili.com` in any supported browser, log in
2. Back in Shizi, on the "需要登录" error page, pick that browser
3. See "✓ 已检测到登录态 (with SESSDATA, buvid3, etc.)" → retry

**First-time Safari**: macOS requires "Full Disk Access" for the Terminal running the server. System Settings → Privacy & Security → Full Disk Access → add Terminal.

**First-time Chrome / Brave / other Chromium**: click "Allow" on the Keychain dialog.

---

## File layout

```
shizi/
├── server.py            # FastAPI backend
├── static/              # Frontend (HTML/CSS/JS, no build step)
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
├── NOTICE
└── README.md / README.en.md
```

**Runtime-created** (gitignored):
- `.venv/` — Python venv
- `cache/` — downloaded temp audio
- `outputs/` — transcribed files
- `shizi.db` — SQLite history
- `~/.shizi/config.json` — AI config (outside repo)

---

## Default paths

| Type | Default |
|---|---|
| Transcripts (.txt/.srt/.vtt/.json) | `<repo>/outputs/` |
| Downloaded videos | `~/Movies/拾字/` |
| Temp audio cache | `<repo>/cache/` (auto-cleaned after transcription) |

Download path + name template configurable on the AI Settings page.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 7860 already in use` | `kill $(lsof -ti:7860)` then retry |
| Blank browser | Hard refresh `Cmd+Option+R`; Safari → Privacy → Manage data → remove 127.0.0.1 |
| Bilibili 412/352 | Pick a logged-in browser on the error page; or use "Manual paste" to bypass scanner |
| Safari cookies unreadable | Grant Terminal "Full Disk Access" |
| Chrome cookies unreadable | Allow Keychain prompt; test with `security find-generic-password -wga 'Chrome'` |
| Model download slow | mlx-whisper pulls from Hugging Face on first use; configure proxy or mirror |

---

## Non-Apple-Silicon adaptation

`mlx-whisper` only runs on Apple Silicon. For Intel Mac / Linux / Windows, swap to `faster-whisper`:

1. In `requirements.txt`: remove `mlx-whisper`, add `faster-whisper>=1.0`
2. In `server.py`: replace `import mlx_whisper` with `from faster_whisper import WhisperModel`
3. Replace the call:
   ```python
   model = WhisperModel("large-v3", device="cuda" or "cpu")
   segments, info = model.transcribe(path, language=lang)
   ```

PRs welcome to abstract this into a runtime backend selector.

---

## Privacy

- **URLs, audio, transcripts** stay on your disk. Never uploaded.
- **AI keys** live in `~/.shizi/config.json` (chmod 600). Forwarded to providers by your local server only, never exposed to the browser.
- **Browser cookies** read only at scan-time for yt-dlp / Bilibili API calls. Not persisted by Shizi.
- **localhost only** — FastAPI binds `127.0.0.1`. Other devices on the same Wi-Fi cannot reach it.

---

## Contributing

Issues and PRs welcome. UI contributions should preserve the editorial typography rhythm:
- Yandex Sans for sans body
- Noto Serif SC for Chinese display
- Instrument Serif italic for data signatures (numbers/Latin)
- Mono pill for code-like IDs (BV, paths, commands)

Code style:
- snake_case Python / camelCase JS / kebab-case CSS
- Server ↔ client field names consistent (no mixed case)
- Inline comments explain *why*, not *what*

---

## License

[GNU AGPL 3.0](./LICENSE)

Note: AGPL is copyleft. **If you fork this and run it as a network service, you must also open-source your modifications.** See [LICENSE](./LICENSE).

Third-party attributions in [NOTICE](./NOTICE).

---

## Acknowledgements

Design language inspired by RANEPA's editorial typography. Built on the shoulders of: [yt-dlp](https://github.com/yt-dlp/yt-dlp) · [mlx-whisper](https://github.com/ml-explore/mlx-examples) · [FastAPI](https://github.com/tiangolo/fastapi) · [browser-cookie3](https://github.com/borisbabic/browser_cookie3).
