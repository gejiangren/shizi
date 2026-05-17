/* 拾字 — 前端主程序
   状态机：state.view (home|history) + state.flow (empty|filled|downloading|...)
   API：详见 server.py
*/
(() => {
  "use strict";

  // ============================================================
  // State
  // ============================================================
  const state = {
    view: "home",                  // home | history | settings
    mode: localStorage.getItem("mode") || "transcribe",   // transcribe | download
    flow: "empty",                 // empty | filled | downloading | extracting | transcribing | complete | err-invalid | err-login | collection | batch | dl-detected | dl-progress | dl-complete | ai-organizing
    url: "",
    probe: null,                   // result of /api/probe (transcribe chain)
    selectedEpisodes: [],
    selectedOutputMode: "smart-doc",
    model: "large-v3",
    lang: "auto",
    fmt: "txt",

    // Chain B (download) state
    dl: {
      probe: null,                 // {tiers, audio_format_id, title, duration, video_id, ...}
      selectedTier: null,          // tier object from probe.tiers
      extras: { subtitles: true, thumbnail: false, metadata: true, danmaku: false },
      job: null,                   // current download job snapshot
      eventSource: null,
      settings: null,              // {save_dir, name_template} from server
    },

    // Channel (UP 主主页 / 频道 / 播放列表) 批量
    channel: {
      probe: null,                 // {channel:{name,...}, videos:[...], has_more}
      selected: [],                // index 数组
      qualityMax: 1080,            // 下载模式：高度上限 (720/1080/2160/9999)
      scanning: false,
    },
    showAdvanced: false,
    advanced: {
      preferPlatformSubtitle: true,
      cookiesBrowser: localStorage.getItem("lastBrowser") || "",
      outputDir: "~/Documents/拾字",
      keepCache: false,
      segmentLength: 30,
    },
    job: null,                     // active Job snapshot (during/after processing)
    batch: null,                   // active Batch snapshot
    history: [],
    histFilter: "all",
    histQuery: "",
    tweaks: {
      theme: localStorage.getItem("theme") || "light",
      accent: localStorage.getItem("accent") || "#A30236",
      uiScale: parseFloat(localStorage.getItem("uiScale") || localStorage.getItem("fontScale") || "1"),
      textScale: parseFloat(localStorage.getItem("textScale") || "1"),
      density: localStorage.getItem("density") || "comfy",
    },
    tweaksOpen: false,
    eventSource: null,
    batchEventSource: null,

    // AI integration
    ai: {
      config: null,                  // {provider, base_url, api_key_masked, has_key, model, prompts, presets, models}
      configDraft: null,             // edits before save
      useCustomModel: false,         // 用户在模型下拉里选了「其他·手动输入」
      testing: false,
      testResult: null,              // {ok, reply | error}
      organizing: false,
      organizeMode: "smart-doc",
      organizeText: "",
      organizeError: null,
      organizeSource: null,          // {job_id, title, mode}
      organizeAbort: null,           // AbortController
      organizeMeta: null,            // {provider, model, mode, text_len}
    },
    completeAIOpen: false,           // dropdown open on complete view
  };

  const TONES = {
    "#A30236": { accent: "#A30236", accentDark: "#8A002D", tint: "#FBEAEF", darkAccent: "#D03A60" },
    "#061A6C": { accent: "#061A6C", accentDark: "#040F4D", tint: "#E9EBF5", darkAccent: "#5A78E6" },
    "#1F2937": { accent: "#1F2937", accentDark: "#111827", tint: "#E5E7EB", darkAccent: "#A8B3C7" },
  };

  function applyTweaks() {
    const root = document.documentElement;
    root.setAttribute("data-theme", state.tweaks.theme);
    root.style.setProperty("--ui-scale",   state.tweaks.uiScale.toFixed(3));
    root.style.setProperty("--text-scale", state.tweaks.textScale.toFixed(3));
    const tone = TONES[state.tweaks.accent] || TONES["#A30236"];
    root.style.setProperty("--accent", state.tweaks.theme === "dark" ? tone.darkAccent : tone.accent);
    root.style.setProperty("--ranepa-crimson-dark", tone.accentDark);
    root.style.setProperty("--ranepa-crimson-tint", tone.tint);
    localStorage.setItem("theme", state.tweaks.theme);
    localStorage.setItem("accent", state.tweaks.accent);
    localStorage.setItem("uiScale",   String(state.tweaks.uiScale));
    localStorage.setItem("textScale", String(state.tweaks.textScale));
    localStorage.setItem("density", state.tweaks.density);
  }

  // ============================================================
  // DOM helpers
  // ============================================================
  const root = document.getElementById("root");

  function h(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (typeof c === "string" || typeof c === "number") e.appendChild(document.createTextNode(String(c)));
      else e.appendChild(c);
    }
    return e;
  }
  const icon = (name, opts = {}) => Icons[name](opts);
  const $$  = (s, parent = document) => parent.querySelectorAll(s);

  function fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return "—";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    return `${m}:${String(s).padStart(2,"0")}`;
  }
  function fmtTimestamp(sec) {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }
  function fmtDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    const now = new Date();
    const today0 = new Date(now); today0.setHours(0,0,0,0);
    const yest0  = new Date(today0); yest0.setDate(yest0.getDate() - 1);
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    if (d >= today0) return `今天 ${hh}:${mm}`;
    if (d >= yest0)  return `昨天 ${hh}:${mm}`;
    return `${d.getMonth()+1}月${d.getDate()}日`;
  }

  // ============================================================
  // API client
  // ============================================================
  const api = {
    async probe(url) {
      const r = await fetch("/api/probe", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({url})
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw err.detail || err;
      }
      return await r.json();
    },
    async createJob({url, model, lang, fmt, advanced}) {
      const r = await fetch("/api/jobs", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({url, model, lang, fmt, advanced})
      });
      if (!r.ok) throw await r.json().catch(() => ({}));
      return await r.json();
    },
    async getJob(id) {
      const r = await fetch(`/api/jobs/${id}`);
      if (!r.ok) throw new Error("not found");
      return await r.json();
    },
    async cancelJob(id) {
      await fetch(`/api/jobs/${id}/cancel`, {method:"POST"});
    },
    async createBatch({urls, model, lang, fmt, advanced}) {
      const r = await fetch("/api/batch", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({urls, model, lang, fmt, advanced})
      });
      if (!r.ok) throw await r.json().catch(() => ({}));
      return await r.json();
    },
    async getHistory(q, kind) {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (kind) params.set("kind", kind);
      const r = await fetch(`/api/history?${params}`);
      return (await r.json()).items;
    },
    async deleteHistory(id) {
      await fetch(`/api/history/${id}`, {method:"DELETE"});
    },
    async clearHistory() {
      await fetch("/api/history", {method:"DELETE"});
    },
    downloadResult(id, fmt) {
      window.location.href = `/api/jobs/${id}/result/${fmt}`;
    },
  };

  // ============================================================
  // SSE handling
  // ============================================================
  function openJobStream(jobId) {
    closeStreams();
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    state.eventSource = es;
    es.addEventListener("snapshot", e => {
      state.job = JSON.parse(e.data);
      updateFlowFromJob();
      render();
    });
    es.addEventListener("status", e => {
      const d = JSON.parse(e.data);
      Object.assign(state.job, d);
      updateFlowFromJob();
      render();
    });
    es.addEventListener("progress", e => {
      const d = JSON.parse(e.data);
      state.job.progress = d.progress;
      state.job.stage = d.stage;
      state.job.eta = d.eta;
      state.job.detail = d.detail;
      patchProgress();
    });
    es.addEventListener("meta", e => {
      const d = JSON.parse(e.data);
      Object.assign(state.job, d);
      // Update title bar
      patchTopbar();
    });
    es.addEventListener("log", e => {
      const d = JSON.parse(e.data);
      (state.job.logs ||= []).push(d);
      patchLog(d);
    });
    es.addEventListener("segment", e => {
      const d = JSON.parse(e.data);
      (state.job.segments ||= []).push({start: d.start, end: d.end, text: d.text});
      patchSegment(d);
    });
    es.addEventListener("end", () => closeStreams());
    es.onerror = () => { /* silently retry until end */ };
  }
  function closeStreams() {
    if (state.eventSource)      { try { state.eventSource.close(); }      catch(e){} state.eventSource = null; }
    if (state.batchEventSource) { try { state.batchEventSource.close(); } catch(e){} state.batchEventSource = null; }
    if (state.dl.eventSource)   { try { state.dl.eventSource.close(); }   catch(e){} state.dl.eventSource = null; }
  }
  function updateFlowFromJob() {
    if (!state.job) return;
    const map = {
      "downloading":  "downloading",
      "extracting":   "extracting",
      "transcribing": "transcribing",
      "done":         "complete",
      "cancelled":    "filled",
      "error":        state.job.error_kind === "login_required" ? "err-login"
                    : state.job.error_kind === "invalid"        ? "err-invalid"
                    : "err-invalid",
    };
    state.flow = map[state.job.status] || state.flow;
  }

  function openBatchStream(batchId) {
    closeStreams();
    const es = new EventSource(`/api/batch/${batchId}/stream`);
    state.batchEventSource = es;
    es.addEventListener("snapshot", e => {
      state.batch = JSON.parse(e.data);
      render();
    });
    es.addEventListener("item_start", e => {
      const d = JSON.parse(e.data);
      const item = state.batch.items[d.item_index];
      if (item) item.status = "downloading";
      patchBatchRow(d.item_index);
    });
    es.addEventListener("item_end", e => {
      const d = JSON.parse(e.data);
      const item = state.batch.items[d.item_index];
      if (item) item.status = d.status;
      patchBatchRow(d.item_index);
    });
    es.addEventListener("batch_end", () => { closeStreams(); });
  }

  // ============================================================
  // Patches (live update without full re-render)
  // ============================================================
  function patchProgress() {
    const fill = $$(".bar-fill")[0];
    if (fill) fill.style.width = (state.job.progress || 0) + "%";
    const pct = $$(".proc-eta-pct")[0];
    if (pct) {
      const p = Math.floor(state.job.progress || 0);
      pct.innerHTML = `${p}<span style="font-size:18px">%</span>`;
    }
    const etaEl = $$(".proc-eta-label")[0];
    if (etaEl && state.job.eta) etaEl.innerHTML = `剩余 <span class="latin">${state.job.eta}</span>`;
    const detailEl = document.getElementById("bar-meta-detail");
    if (detailEl && state.job.detail) detailEl.innerHTML = `<span class="latin">${state.job.detail.replace(/</g, "&lt;")}</span>`;
  }
  function patchLog(entry) {
    const log = $$(".log")[0];
    if (!log) return;
    const lvlMap = {dl:"DL", ok:"OK", inf:"INF", run:"RUN", warn:"WRN"};
    const line = h("div", {class:"log-line"},
      h("span", {class:"ts"}, `[${entry.ts}]`),
      h("span", {class:`tag ${entry.level}`}, lvlMap[entry.level] || entry.level.toUpperCase()),
      h("span", {}, entry.msg)
    );
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  function patchSegment(seg) {
    const t = document.getElementById("live-transcript");
    if (!t) return;
    const ts = fmtTimestamp(seg.start);
    const row = h("div", {class:"seg-line"},
      h("div", {class:"seg-time"}, ts),
      h("div", {class:"seg-text"}, seg.text)
    );
    t.appendChild(row);
    t.scrollTop = t.scrollHeight;
  }
  function patchTopbar() {
    const sub = $$(".topbar-sub")[0];
    if (sub && state.job && state.job.title) {
      sub.textContent = `${state.job.status === "done" ? "转录完成" : "正在处理"} · ${state.job.title.slice(0, 36)}`;
    }
  }
  function patchBatchRow(idx) {
    // Just re-render batch view
    render();
  }

  // ============================================================
  // Main render
  // ============================================================
  function render() {
    root.innerHTML = "";
    const app = h("div", {
      class: `app ${state.tweaks.density === "compact" ? "is-compact" : ""}`,
      "data-mode": state.mode,
      "data-theme-dark": state.tweaks.theme === "dark" ? "1" : "",
    },
      renderSideRail(),
      renderBody()
    );
    root.appendChild(app);
    root.appendChild(renderTweaksFAB());
    if (state.tweaksOpen) root.appendChild(renderTweaksPanel());
  }

  // ----- Side rail -----
  function renderSideRail() {
    const railBtn = (active, key, ic, title) =>
      h("button", {
        class: `rail-btn ${active ? "is-active" : ""}`,
        title,
        onClick: () => {
          state.view = key;
          if (key === "home") state.flow = state.job?.status === "done" ? "complete" : (state.probe ? "filled" : "empty");
          render();
        }
      }, icon(ic, {size: 18}));

    // Settings 改成 "AI" 文字徽章按钮，比齿轮更明确指代「AI 配置」
    const aiSettingsBtn = h("button", {
      class: `rail-btn rail-btn-text ${state.view === "settings" ? "is-active" : ""}`,
      title: "AI 设置",
      onClick: () => { state.view = "settings"; render(); }
    }, h("span", {class:"rail-text-badge"}, "AI"));

    return h("aside", {class:"rail"},
      h("div", {class:"rail-logo"}, "拾"),
      railBtn(state.view === "home",    "home",    "Home",    "主页"),
      railBtn(state.view === "history", "history", "History", "历史"),
      aiSettingsBtn,
      h("div", {class:"rail-bottom"},
        h("div", {class:"rail-avatar"}, "YL")
      )
    );
  }

  // ----- Body (topbar + workarea) -----
  function renderBody() {
    return h("div", {class:"body"},
      renderTopbar(),
      h("div", {class:"workarea"},
        renderInputPanel(),
        h("div", {class:"card"}, renderRightPanel())
      )
    );
  }

  function renderTopbar() {
    let title = "新转录";
    if (state.view === "history") title = `历史记录`;
    else if (state.flow === "downloading" || state.flow === "extracting" || state.flow === "transcribing") title = `正在处理 · ${state.job?.title?.slice(0,30) || ""}`;
    else if (state.flow === "complete") title = `转录完成 · ${fmtDuration(state.job?.duration)}`;
    else if (state.flow === "batch") title = `批量转录`;
    else if (state.flow === "collection") title = `检测到合集`;
    return h("header", {class:"topbar"},
      h("div", {class:"topbar-title"}, "拾字",
        h("span", {class:"latin"}, "Voicetype")),
      h("div", {class:"topbar-sub"}, title),
      h("div", {class:"topbar-spacer"}),
      h("div", {class:"topbar-pill"},
        h("span", {class:"dot"}),
        "mlx-whisper 已就绪"
      ),
      h("div", {class:"topbar-pill"},
        "Apple Silicon"
      ),
    );
  }

  // ----- Input panel (left card) -----
  function renderInputPanel() {
    if (state.view === "history") {
      return h("div", {class:"card"},
        h("div", {class:"card-hd"},
          h("div", {class:"eyebrow", style:{flex:1}}, "历史"),
        ),
        h("div", {class:"card-bd"},
          h("p", {style:{fontSize:13, color:"var(--fg-3)", lineHeight:1.6}},
            "查看以前的转录任务。"),
          h("p", {style:{fontSize:12, color:"var(--fg-3)", lineHeight:1.6}},
            "点击右侧任一条目，可复制文本、下载文件、重新查看，或用 AI 整理。"),
          h("button", {class:"btn-primary", style:{marginTop:"auto"}, onClick: () => { state.view = "home"; render(); }},
            icon("Plus", {size:14}), "新建转录"
          ),
        )
      );
    }
    if (state.mode === "download") return renderInputPanelDownload();
    if (state.view === "settings") {
      const hasKey = state.ai.config?.has_key;
      return h("div", {class:"card"},
        h("div", {class:"card-hd"},
          h("div", {class:"eyebrow", style:{flex:1}}, "AI 设置"),
        ),
        h("div", {class:"card-bd"},
          h("p", {style:{fontSize:13, color:"var(--fg-3)", lineHeight:1.6}},
            "配置 AI 服务后，可在「完成页」「批量完成」「历史」三处用 AI 整理转录文本。"),
          h("div", {class:"settings-status"},
            h("span", {class: `dot ${hasKey ? "ok" : "empty"}`}),
            hasKey ? "已配置" : "未配置",
          ),
          h("p", {style:{fontSize:12, color:"var(--fg-3)", lineHeight:1.6}},
            "API Key 保存到本机 ~/.shizi/config.json（权限 600，仅当前用户可读）。"),
          h("button", {class:"btn-primary", style:{marginTop:"auto"}, onClick: () => { state.view = "home"; render(); }},
            icon("Plus", {size:14}), "返回主页"
          ),
        )
      );
    }

    const running = ["downloading","extracting","transcribing"].includes(state.flow);
    const urlState = state.flow === "err-invalid" ? "invalid"
                   : state.flow === "err-login"   ? "login-required"
                   : state.url ? "filled" : "empty";
    const isFilled = urlState !== "empty";

    const platform = state.probe?.platform;
    let urlMeta = "";
    if (state.probe) {
      const parts = [];
      if (state.probe.video_id) parts.push(state.probe.video_id);
      if (state.probe.duration) parts.push(`时长 ${fmtDuration(state.probe.duration)}`);
      urlMeta = parts.join(" · ");
    } else if (state.flow === "err-invalid") {
      urlMeta = "无法识别此域名";
    }

    return h("div", {class:"card"},
      h("div", {class:"card-hd"},
        h("div", {class:"eyebrow", style:{flex:1}}, "新转录"),
        h("button", {class:"btn-ghost",
          title: "从本地选一个音/视频文件直接转录（跳过下载步骤）",
          onClick: handleLocalFilePick
        }, icon("Upload",{size:13}), "本地文件"),
      ),
      h("div", {class:"card-bd"},
        renderModeToggle(),
        // URL
        h("div", {},
          h("div", {class:"field-label"},
            h("span", {}, "视频链接"),
            h("span", {class:"hint"}, "支持 1,800+ 平台"),
          ),
          (function () {
            const wrap = h("div", {class: `url-wrap ${isFilled ? "is-filled" : ""}`});
            const inp = h("input", {
              type:"text", class:"url-input",
              placeholder:"粘贴视频链接，例如 https://www.bilibili.com/video/...",
              value: state.url || "",
              onInput: (e) => { state.url = e.target.value; },
              onKeyDown: (e) => { if (e.key === "Enter" && state.url) handleProbe(); },
              onPaste: () => {
                setTimeout(() => { state.url = inp.value; if (state.url) handleProbe(); }, 0);
              },
            });
            wrap.appendChild(inp);
            if (!isFilled) {
              wrap.appendChild(h("button", {
                class:"paste-btn",
                onClick: async () => {
                  try {
                    const txt = await navigator.clipboard.readText();
                    if (txt) { state.url = txt; inp.value = txt; handleProbe(); }
                  } catch (e) { inp.focus(); }
                }
              }, icon("Clipboard",{size:12}), "粘贴"));
            } else {
              const meta = h("div", {class:"url-meta"});
              if (platform) {
                meta.appendChild(h("div", {class:"platform-chip"},
                  h("span", {class:"sw", style:{background: platform.color}}),
                  platform.name
                ));
              }
              if (state.flow === "err-invalid") {
                meta.appendChild(h("div", {
                  class:"platform-chip",
                  style:{background:"rgba(241,162,63,0.16)", color:"var(--ranepa-orange)"}
                }, icon("Alert",{size:11}), "未识别"));
              }
              if (state.flow === "err-login") {
                meta.appendChild(h("div", {
                  class:"platform-chip",
                  style:{background:"rgba(6,26,108,0.08)", color:"var(--ranepa-navy)"}
                }, icon("Lock",{size:11}), "需登录"));
              }
              meta.appendChild(h("span", {class:"url-meta-text"}, urlMeta || ""));
              meta.appendChild(h("button", {
                class:"url-clear",
                onClick: () => {
                  state.url = ""; state.probe = null;
                  state.flow = "empty"; state.job = null;
                  closeStreams(); render();
                }
              }, icon("Close",{size:12})));
              wrap.appendChild(meta);
            }
            return wrap;
          })(),
        ),

        // Model
        h("div", {},
          h("div", {class:"field-label"}, h("span",{},"识别模型"), h("span",{class:"hint"},"越大越准 · 越大越慢")),
          renderSeg([
            {k:"tiny", l:"tiny"},
            {k:"base", l:"base"},
            {k:"small", l:"small"},
            {k:"medium", l:"medium"},
            {k:"large-v3", l:"large-v3", rec:true},
          ], state.model, (v) => { state.model = v; render(); })
        ),

        // Language
        h("div", {},
          h("div", {class:"field-label"}, h("span",{},"语言")),
          renderSeg([
            {k:"auto",  l:"自动检测"},
            {k:"zh",    l:"中文"},
            {k:"en",    l:"英文"},
            {k:"zh+en", l:"中英混合"},
          ], state.lang, (v) => { state.lang = v; render(); })
        ),

        // Format
        h("div", {},
          h("div", {class:"field-label"}, h("span",{},"导出格式")),
          renderSeg([
            {k:"txt",  l:"txt"},
            {k:"srt",  l:"srt"},
            {k:"vtt",  l:"vtt"},
            {k:"json", l:"json"},
          ], state.fmt, (v) => { state.fmt = v; render(); })
        ),

        // Advanced expander
        renderAdvanced(),

        h("div", {style:{flex:1, minHeight: "8px"}}),

        // Button
        (function () {
          if (running) {
            return h("button", {
              class:"btn-danger",
              onClick: async () => {
                if (state.job?.id) await api.cancelJob(state.job.id);
              }
            }, icon("Stop",{size:14}), "停止当前任务");
          }
          const disabled = urlState === "empty" || urlState === "invalid";
          const label = urlState === "login-required"
            ? [icon("Lock",{size:16}), "导入 Cookies 后开始"]
            : urlState === "invalid"
              ? [icon("Alert",{size:16}), "链接无法识别"]
              : [icon("Play",{size:14}), "开始转录"];
          return h("button", {
            class:`btn-primary ${disabled ? "is-disabled" : ""}`,
            disabled,
            onClick: handleStart,
          }, ...label);
        })(),
      )
    );
  }

  function renderSeg(options, current, onPick) {
    return h("div", {class:"seg"},
      options.map(o => {
        const isOn = current === o.k;
        const btn = h("button", {
          class: `seg-opt ${isOn ? "is-on" : ""}`,
          onClick: () => onPick(o.k),
        }, o.l);
        if (o.rec && isOn) btn.appendChild(h("span", {class:"rec"}, "推荐"));
        return btn;
      })
    );
  }

  function renderAdvanced() {
    const wrap = h("div", {class:"advanced"});
    const tog = h("button", {
      class: `advanced-tog ${state.showAdvanced ? "is-open" : ""}`,
      onClick: () => { state.showAdvanced = !state.showAdvanced; render(); }
    });
    const chev = icon("ChevDown", {size: 12});
    chev.classList.add("chev");
    tog.appendChild(chev);
    tog.appendChild(document.createTextNode("高级选项"));
    if (!state.showAdvanced)
      tog.appendChild(h("span", {class:"summary"},
        "· 字幕优先 · 自动 ", h("span", {class:"latin"}, "Cookies"), " · 保留缓存"));
    wrap.appendChild(tog);
    if (state.showAdvanced) {
      const body = h("div", {class:"advanced-body"});
      const switchEl = (on, onChange) => {
        const s = h("span", {class:`switch ${on ? "is-on" : ""}`,
          onClick: () => { onChange(!on); render(); }});
        return s;
      };
      const row = (lbl, val) => h("div", {class:"adv-row"},
        h("span", {class:"lbl"}, lbl),
        val instanceof Node ? val : h("span", {class:"val"}, val)
      );
      body.appendChild(row("优先使用平台字幕", switchEl(state.advanced.preferPlatformSubtitle, v => state.advanced.preferPlatformSubtitle = v)));
      body.appendChild(row("浏览器 Cookies", h("select", {
        class:"adv-select", style:{background:"transparent", border:"none", textAlign:"right", fontFamily:"var(--font-mono)", color:"var(--fg-1)", outline:"none"},
        onChange: (e) => { state.advanced.cookiesBrowser = e.target.value; if (e.target.value) localStorage.setItem("lastBrowser", e.target.value); }
      },
        h("option", {value:""}, "未启用"),
        ...[
          ["safari",   "Safari"],
          ["chrome",   "Chrome"],
          ["firefox",  "Firefox"],
          ["edge",     "Edge"],
          ["brave",    "Brave"],
          ["chromium", "Chromium"],
          ["opera",    "Opera"],
          ["vivaldi",  "Vivaldi"],
        ].map(([v, l]) => h("option", {value:v, selected: state.advanced.cookiesBrowser===v}, l)),
      )));
      body.appendChild(row("输出目录", "~/Desktop/video2text/outputs"));
      body.appendChild(row("保留缓存音频", switchEl(state.advanced.keepCache, v => state.advanced.keepCache = v)));
      body.appendChild(row("自动分段长度", "30 s"));
      wrap.appendChild(body);
    }
    return wrap;
  }

  // ============================================================
  // Right panel: dispatches by state.flow
  // ============================================================
  function renderRightPanel() {
    if (state.view === "settings") return renderSettings();
    if (state.view === "history")  return renderHistory();
    switch (state.flow) {
      case "empty":         return renderEmpty();
      case "filled":        return renderEmpty();
      case "downloading":   return renderProcessing("download");
      case "extracting":    return renderProcessing("extract");
      case "transcribing":  return renderProcessing("transcribe");
      case "complete":      return renderComplete();
      case "err-invalid":   return renderErrorInvalid();
      case "err-login":     return renderErrorLogin();
      case "collection":    return renderCollection();
      case "batch":         return renderBatch();
      case "ai-organizing": return renderAIOrganize();
      case "dl-detected":   return renderDlDetected();
      case "dl-progress":   return renderDlProgress();
      case "dl-complete":   return renderDlComplete();
      case "channel-detect": return renderChannelDetect();
      case "manual-paste":   return renderManualPaste();
      default:              return renderEmpty();
    }
  }

  // ----- Empty / recent -----
  function renderEmpty() {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(h("div", {class:"empty-hero"},
      (() => { const m = h("div", {class:"empty-mark"}); m.appendChild(icon("Waveform",{size:44,stroke:1.6})); return m; })(),
      h("div", {},
        h("h2", {class:"empty-headline", html: "把任何视频<br/>变成可读的文字"}),
        h("p", {class:"empty-sub", html: '支持 <b>B站 · YouTube · 小宇宙 · X · TikTok</b> 等 1,800+ 平台。<br/>模型在本地运行，链接和音频<b>不会上传到任何服务器</b>。'}),
      ),
      // 右上角印章签名（杂志气质）
      h("div", {class:"hero-stamp"}, "№ 0001 · Voicetype Studio · 2026"),
    ));
    wrap.appendChild(h("div", {class:"tip-strip"},
      h("div", {class:"tip-item"},
        h("div", {class:"tip-num"}, "01"),
        h("div", {class:"tip-label"}, "粘贴链接"),
        h("div", {class:"tip-desc"}, "从浏览器复制视频网址即可"),
      ),
      h("div", {class:"tip-item"},
        h("div", {class:"tip-num"}, "02"),
        h("div", {class:"tip-label"}, "选择模型"),
        h("div", {class:"tip-desc"}, "默认 ", h("span", {class:"latin"}, "large-v3"), "，约 ", h("span", {class:"latin"}, "1:8"), " 实时倍速"),
      ),
      h("div", {class:"tip-item"},
        h("div", {class:"tip-num"}, "03"),
        h("div", {class:"tip-label"}, "导出文本"),
        h("div", {class:"tip-desc"}, h("span", {class:"latin"}, "txt / srt / vtt / json"), " 任选"),
      ),
    ));
    // Recent list
    const recentSection = h("div", {class:"recent-section"});
    recentSection.appendChild(h("div", {class:"recent-hd"},
      h("div", {class:"eyebrow"}, "最近转录"),
      h("button", {class:"btn-ghost", onClick: () => { state.view = "history"; render(); }},
        "查看全部 ", icon("ChevRight",{size:12}))
    ));
    const recentList = h("div", {class:"recent-list", id:"recent-list"}, h("div", {style:{fontSize:12, color:"var(--fg-4)", padding:"12px 8px"}}, "加载中…"));
    recentSection.appendChild(recentList);
    wrap.appendChild(recentSection);

    // Load recent async
    api.getHistory().then(items => {
      const target = document.getElementById("recent-list");
      if (!target) return;
      target.innerHTML = "";
      if (items.length === 0) {
        target.appendChild(h("div", {style:{fontSize:12, color:"var(--fg-4)", padding:"12px 8px"}},
          "还没有转录记录。粘贴一个视频链接开始。"));
        return;
      }
      items.slice(0, 5).forEach(r => {
        target.appendChild(h("div", {class:"recent-row", onClick: () => loadFromHistory(r.id)},
          h("div", {class:`recent-thumb t-${r.platform_kind || "bili"}`}),
          h("div", {class:"recent-title"}, r.title || r.video_id || "(无标题)"),
          h("div", {class:"recent-meta"}, h("span", {class:"latin"}, fmtDuration(r.duration))),
          h("div", {class:"recent-meta-2"}, h("span", {class:"latin"}, fmtDate(r.created_at))),
          h("div", {class:"more"}, "···")
        ));
      });
    }).catch(() => {});

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  // ----- Processing (downloading / extracting / transcribing) -----
  function renderProcessing(stage) {
    const stageInfo = {
      download:   { idx: 1, title: "正在下载视频…",  ic: "Download" },
      extract:    { idx: 2, title: "正在提取音频…",  ic: "Waveform" },
      transcribe: { idx: 3, title: `正在识别语音…`,  ic: "Sparkle" },
    };
    const si = stageInfo[stage];
    const j = state.job || {};
    const progress = Math.max(0, Math.min(100, j.progress || 0));
    const ic = icon(si.ic, {size:20});

    const container = document.createDocumentFragment();

    // Top: stage / pct
    const procStage = h("div", {class:"proc-stage"},
      h("div", {class:"proc-status-row"},
        (() => { const p = h("div", {class:"proc-pulse"}); p.appendChild(ic); return p; })(),
        h("div", {class:"proc-info"},
          h("div", {class:"proc-stage-label"}, `阶段 ${si.idx} / 4${stage === "transcribe" ? " · mlx-whisper · " + state.model : ""}`),
          h("div", {class:"proc-stage-title"}, si.title),
        ),
        h("div", {class:"proc-eta"},
          h("div", {class:"proc-eta-pct", html: `${Math.floor(progress)}<span style="font-size:18px">%</span>`}),
          h("div", {class:"proc-eta-label"}, j.eta ? `剩余 ${j.eta}` : "估算中"),
        ),
      ),
      renderStepBar(stage),
      h("div", {class:"bar"}, h("div", {class:"bar-fill", style:{width: progress + "%"}})),
      h("div", {class:"bar-meta"},
        h("span", {id:"bar-meta-detail"},
          stage === "extract"
            ? h("span", {}, "转码 ", h("span", {class:"mono"}, "→ mp3"), " mono ", h("span", {class:"latin"}, "16 kHz"))
            : (j.detail ? h("span", {class:"latin"}, j.detail) : "")),
        stage === "transcribe" && j.duration
          ? h("span", {class:"accent"}, h("span", {class:"latin"}, `${fmtTimestamp(progress / 100 * j.duration)} / ${fmtDuration(j.duration)}`))
          : h("span", {}),
      ),
    );
    container.appendChild(procStage);

    // Bottom: live transcript (for transcribe), log (for download/extract)
    if (stage === "transcribe") {
      const tr = h("div", {class:"transcript", id:"live-transcript", style:{flex:1, minHeight:0}});
      const segs = j.segments || [];
      segs.forEach(seg => {
        tr.appendChild(h("div", {class:"seg-line"},
          h("div", {class:"seg-time"}, fmtTimestamp(seg.start)),
          h("div", {class:"seg-text"}, seg.text)
        ));
      });
      container.appendChild(tr);
    } else {
      const log = h("div", {class:"log"});
      (j.logs || []).forEach(entry => {
        const lvlMap = {dl:"DL", ok:"OK", inf:"INF", run:"RUN", warn:"WRN"};
        log.appendChild(h("div", {class:"log-line"},
          h("span", {class:"ts"}, `[${entry.ts}]`),
          h("span", {class:`tag ${entry.level}`}, lvlMap[entry.level] || entry.level.toUpperCase()),
          h("span", {}, entry.msg)
        ));
      });
      container.appendChild(log);
    }

    const wrap = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    wrap.appendChild(container);
    return wrap;
  }

  function renderStepBar(active) {
    const order = ["download", "extract", "transcribe", "done"];
    const idx = order.indexOf(active);
    const items = [
      {key:"download", name:"下载视频", detail:"yt-dlp"},
      {key:"extract", name:"提取音频", detail:"→ mp3 16k"},
      {key:"transcribe", name:"语音识别", detail:"mlx-whisper"},
      {key:"done", name:"导出文本", detail:"txt · srt"},
    ];
    return h("div", {class:"steps"},
      items.map((s, i) => {
        const sCls = i < idx ? "is-done" : i === idx ? "is-active" : "is-pending";
        const bullet = h("span", {class:"step-bullet"});
        if (i < idx) bullet.appendChild(icon("Check",{size:10,stroke:2.5}));
        else bullet.appendChild(h("span", {style:{fontSize:9, fontWeight:700}}, String(i+1)));
        return h("div", {class:`step ${sCls}`},
          h("div", {class:"step-hd"}, bullet, i < idx ? "已完成" : i === idx ? "进行中" : "等待中"),
          h("div", {class:"step-name"}, s.name),
          h("div", {class:"step-detail"}, s.detail),
        );
      })
    );
  }

  // ----- Complete -----
  function renderComplete() {
    const j = state.job || {};
    const segs = j.segments || [];
    const wrap = document.createDocumentFragment();

    const platformKind = j.platform?.kind || "bili";
    const thumbBg = platformKind === "yt" ? "linear-gradient(135deg, #FF0000, #8B0000)"
                  : platformKind === "tw" ? "linear-gradient(135deg, #1DA1F2, #000)"
                  : "linear-gradient(135deg, #00AEEC, #FB7299)";

    wrap.appendChild(h("div", {class:"complete-hd"},
      h("div", {class:"complete-thumb", style:{background: thumbBg}}),
      h("div", {class:"complete-info"},
        h("div", {class:"complete-title"}, j.title || "(无标题)"),
        h("div", {class:"complete-meta"},
          j.video_id ? h("span", {class:"mono"}, j.video_id) : null,
          j.video_id ? h("span", {class:"dot"}, "·") : null,
          h("span", {}, h("span", {class:"latin"}, fmtDuration(j.duration))),
          h("span", {class:"dot"}, "·"),
          h("span", {}, h("span", {class:"latin"}, (j.full_text || "").length.toLocaleString()), " 字"),
          h("span", {class:"dot"}, "·"),
          h("span", {}, h("span", {class:"latin"}, j.model || "")),
          j.elapsed_seconds ? h("span", {class:"dot"}, "·") : null,
          j.elapsed_seconds ? h("span", {class:"accent"}, "耗时 ", h("span", {class:"latin"}, fmtDuration(j.elapsed_seconds))) : null,
        ),
      ),
      h("div", {class:"complete-actions"},
        h("button", {class:"btn-secondary", onClick: () => copyText(j.full_text || "")}, icon("Copy",{size:13}), "复制"),
        h("button", {class:"btn-secondary", onClick: () => api.downloadResult(j.id, "txt")}, icon("Download",{size:13}), "下载 .txt"),
        h("button", {
          class:"btn-secondary ai-action-btn",
          onClick: () => handleAIOrganize(j.id, "smart-doc", j.title)
        }, h("span", {class:"ai-text-badge"}, "AI"), "整理"),
      ),
    ));

    let tab = state.completeTab || "text";
    const tabs = h("div", {class:"tabs"},
      h("div", {class:`tab ${tab==="text"?"is-on":""}`, onClick: () => { state.completeTab = "text"; render(); }}, icon("Doc",{size:13}), "转录文本"),
      h("div", {class:`tab ${tab==="time"?"is-on":""}`, onClick: () => { state.completeTab = "time"; render(); }},
        "带时间轴 ", h("span", {class:"count"}, segs.length)),
      h("div", {class:`tab ${tab==="srt"?"is-on":""}`, onClick: () => { state.completeTab = "srt"; render(); }}, "SRT 字幕"),
      h("div", {class:`tab ${tab==="raw"?"is-on":""}`, onClick: () => { state.completeTab = "raw"; render(); }}, "原始 JSON"),
      h("div", {style:{flex:1}}),
      // 转录文本搜索：实时过滤片段
      (tab === "time" || tab === "text") ? h("div", {
        class:"tab", style:{padding:"0 8px", cursor:"text"},
      },
        (() => { const i = icon("Search",{size:13}); i.style.cssText="margin-right:4px;color:var(--fg-3)"; return i; })(),
        h("input", {
          type:"text",
          placeholder:"在转录里搜索…",
          value: state.transcriptQuery || "",
          style:{
            border:"none", outline:"none", background:"transparent",
            width:"140px", fontSize:"12px", fontFamily:"var(--font-body)",
            color:"var(--fg-1)"
          },
          onInput: (e) => {
            state.transcriptQuery = e.target.value;
            // 局部高亮（不全局重渲，速度快）
            highlightTranscript();
          }
        })
      ) : null,
    );
    wrap.appendChild(tabs);

    const tr = h("div", {class:"transcript"});
    if (tab === "text") {
      tr.innerHTML = "";
      tr.appendChild(h("div", {style:{whiteSpace:"pre-wrap", lineHeight:1.85, color:"var(--fg-1)", fontSize:14}}, j.full_text || ""));
    } else if (tab === "time") {
      segs.forEach(s => {
        tr.appendChild(h("div", {class:"seg-line"},
          h("div", {class:"seg-time"}, fmtTimestamp(s.start)),
          h("div", {class:"seg-text"}, s.text)
        ));
      });
    } else if (tab === "srt") {
      // Build SRT inline preview
      let txt = "";
      segs.forEach((s, i) => {
        txt += `${i+1}\n${formatSrtTs(s.start)} --> ${formatSrtTs(s.end)}\n${s.text}\n\n`;
      });
      tr.appendChild(h("pre", {style:{fontFamily:"var(--font-mono)", fontSize:12, whiteSpace:"pre-wrap", lineHeight:1.7, color:"var(--fg-1)", margin:0}}, txt));
    } else {
      tr.appendChild(h("pre", {style:{fontFamily:"var(--font-mono)", fontSize:12, whiteSpace:"pre-wrap", lineHeight:1.6, color:"var(--fg-1)", margin:0}},
        JSON.stringify({title: j.title, duration: j.duration, segments: segs}, null, 2)));
    }
    wrap.appendChild(tr);

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  function highlightTranscript() {
    const q = (state.transcriptQuery || "").trim();
    document.querySelectorAll(".transcript .seg-line").forEach(line => {
      const txt = line.querySelector(".seg-text");
      if (!txt) return;
      const raw = txt.textContent;
      if (!q) {
        txt.textContent = raw;
        line.style.display = "";
        return;
      }
      const lower = raw.toLowerCase();
      const ql = q.toLowerCase();
      if (lower.indexOf(ql) === -1) {
        line.style.display = "none";
      } else {
        line.style.display = "";
        // 加亮匹配文字
        const re = new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "gi");
        txt.innerHTML = raw.replace(re, m => `<mark style="background:var(--ranepa-crimson-tint);color:var(--accent);padding:0 2px;border-radius:2px">${m}</mark>`);
      }
    });
  }

  function formatSrtTs(sec) {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(r).padStart(3,"0")}`;
  }

  // ----- Error states -----
  function renderErrorInvalid() {
    const kind = state.job?.error_kind || "other";
    const errMsg = state.job?.error || "这个域名暂时不在 yt-dlp 支持的 1,800+ 站点里。";
    const scannable = state.job?.scannable;
    const urlType = state.job?.url_type;

    // Per-kind 文案
    let title, iconName, suggestHtml, primaryBtn;
    if (kind === "not_video") {
      const typeLabel = urlType === "channel" ? "主页"
                      : urlType === "playlist" ? "播放列表"
                      : urlType === "live" ? "直播间"
                      : "页面";
      title = `这是${typeLabel}，不是单视频`;
      iconName = "Link";
      suggestHtml = scannable
        ? `<b>两条路批量处理：</b>
           ① 点「扫描视频列表」自动列出 — 但 B 站可能 412/352 风控<br/>
           ② 浏览器里复制想要的视频链接，用「手动粘贴一批」绕开风控接口`
        : `<b>常见误粘：</b>
           · UP 主主页（space.bilibili.com/...）<br/>
           · 频道首页 / 播放列表页<br/>
           · 用户个人页 / 收藏夹列表<br/>
           请打开具体某条视频，复制浏览器地址栏的链接`;
      if (scannable) {
        primaryBtn = h("div", {style:{display:"flex", gap:8}},
          h("button", {class:"btn-secondary",
            style:{height:"36px", padding:"0 14px", fontSize:"12px"},
            onClick: () => { state.flow = "manual-paste"; render(); }
          }, icon("Clipboard",{size:12}), "手动粘贴一批"),
          h("button", {class:"btn-primary",
            style:{width:"auto", padding:"0 18px", height:"36px", fontSize:"13px", boxShadow:"none"},
            disabled: state.channel.scanning,
            onClick: handleScanChannel
          }, icon("Search",{size:14}),
             state.channel.scanning ? "扫描中…" : "扫描视频列表"),
        );
      } else {
        primaryBtn = h("button", {class:"btn-primary",
          style:{width:"auto", padding:"0 18px", height:"36px", fontSize:"13px", boxShadow:"none"},
          onClick: () => { state.url=""; state.job=null; state.flow="empty"; render(); }},
          icon("Plus",{size:14}), "重新粘贴");
      }
    } else {
      title = "没识别出这条链接";
      iconName = "Alert";
      suggestHtml = `<b>你可以试试：</b>
          · 检查链接是否完整（缺少 <span class="kbd">https://</span> 或 ID 参数？）<br/>
          · 点「本地文件」直接选音/视频文件转录<br/>
          · 查询完整支持站点列表`;
      primaryBtn = h("button", {class:"btn-primary",
        style:{width:"auto", padding:"0 18px", height:"36px", fontSize:"13px", boxShadow:"none"},
        onClick: () => window.open("https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md", "_blank")},
        icon("Search",{size:14}), "查询支持平台");
    }

    return h("div", {class:"err-pane"},
      h("div", {class:"err-card"},
        (() => { const i = h("div", {class:"err-icon warn"}); i.appendChild(icon(iconName,{size:28})); return i; })(),
        h("h2", {class:"err-title"}, title),
        h("p", {class:"err-msg", html:`我们检查了 <code>${escapeHtml(state.url || "")}</code>，<br/>${escapeHtml(errMsg)}`}),
        h("div", {class:"err-actions"},
          h("button", {class:"btn-secondary", onClick: () => { state.url=""; state.probe=null; state.flow="empty"; render(); }},
            icon("Close",{size:13}), "清除链接"),
          primaryBtn,
        ),
        h("div", {class:"err-suggest", html: suggestHtml}),
      )
    );
  }
  function renderErrorLogin() {
    const BROWSERS = [
      { k: "safari",  l: "Safari" },
      { k: "chrome",  l: "Chrome" },
      { k: "firefox", l: "Firefox" },
      { k: "edge",    l: "Edge" },
      { k: "brave",   l: "Brave" },
      { k: "chromium",l: "Chromium" },
      { k: "opera",   l: "Opera" },
      { k: "vivaldi", l: "Vivaldi" },
    ];
    const picked = state.advanced?.cookiesBrowser || localStorage.getItem("lastBrowser") || "";
    const kind = state.job?.error_kind || "login_required";
    const isRateLimit = kind === "rate_limited";
    const rawError = state.job?.error || "";
    const title = isRateLimit ? "平台暂时拒绝了请求" : "这个视频需要登录";
    const desc = isRateLimit
      ? `平台触发了反爬虫风控（HTTP 412）。常见解法是用<b>已登录该站点的浏览器</b>导入 Cookies 绕过。`
      : `平台返回需要登录或会员才能访问。从浏览器导入登录态后就能用了，全程在本地完成。`;
    return h("div", {class:"err-pane"},
      h("div", {class:"err-card"},
        (() => { const i = h("div", {class:"err-icon lock"}); i.appendChild(icon(isRateLimit ? "Alert" : "Lock", {size:26})); return i; })(),
        h("h2", {class:"err-title"}, title),
        h("p", {class:"err-msg", html: desc}),
        // 真实的 yt-dlp 报错（折叠在小灰框里方便诊断，不会破坏主流程描述）
        rawError ? h("details", {class:"err-raw"},
          h("summary", {}, "查看原始报错"),
          h("pre", {}, rawError),
        ) : null,

        // Browser chooser grid
        h("div", {class:"browser-grid"},
          BROWSERS.map(b => h("button", {
            class: `browser-chip ${picked === b.k ? "is-on" : ""}`,
            onClick: async () => {
              state.advanced = state.advanced || {};
              state.advanced.cookiesBrowser = b.k;
              localStorage.setItem("lastBrowser", b.k);
              state.showAdvanced = true;
              // 选完立即诊断该浏览器能否读到 cookies + 是否检测到登录态
              state.cookiesProbe = {browser: b.k, loading: true};
              render();
              // 探测目标域名：B 站 URL 用 bilibili.com，YouTube 用 youtube.com，其他用 bilibili.com 做默认
              const u = (state.url || "").toLowerCase();
              const domain = u.includes("youtube") || u.includes("youtu.be") ? "youtube.com"
                          : u.includes("twitter") || u.includes("x.com") ? "x.com"
                          : "bilibili.com";
              try {
                const r = await api.cookiesProbe(b.k, domain);
                state.cookiesProbe = {browser: b.k, domain, ...r, loading: false};
              } catch (e) {
                state.cookiesProbe = {browser: b.k, domain, ok: false, error: _readableError(e), loading: false};
              }
              render();
            }
          }, b.l)),
        ),
        // 实时诊断结果
        state.cookiesProbe && state.cookiesProbe.browser === picked ? (function () {
          const cp = state.cookiesProbe;
          if (cp.loading) {
            return h("div", {class:"err-tip", style:{marginTop:8, background:"var(--bg-muted)", borderLeftColor:"var(--fg-3)"}},
              "诊断中…");
          }
          if (!cp.ok) {
            return h("div", {class:"err-tip", style:{marginTop:8, background:"rgba(241,162,63,0.10)", borderLeftColor:"var(--ranepa-orange)"}},
              h("b", {}, "✗ 读不到 "), `${BROWSERS.find(b=>b.k===picked)?.l} 的 ${cp.domain} cookies。`,
              cp.error ? h("div", {style:{fontSize:11, fontFamily:"var(--font-mono)", marginTop:6, color:"var(--fg-3)"}}, cp.error) : null,
              h("div", {style:{marginTop:6, fontSize:11, color:"var(--fg-3)"}},
                picked === "chrome" || picked === "edge" || picked === "brave" || picked === "chromium" || picked === "opera" || picked === "vivaldi"
                  ? "可能是钥匙串权限：首次会弹「Terminal wants to use information stored in your keychain」，需要点 Allow。"
                  : picked === "safari"
                    ? "Safari 需要 Terminal/iTerm 拿到「完全磁盘访问权限」。系统设置 → 隐私与安全 → 完全磁盘访问。"
                    : "可能没装这个浏览器，或没在它里面访问过该网站。"
              ),
            );
          }
          if (cp.has_login) {
            return h("div", {class:"err-tip", style:{marginTop:8, background:"rgba(46,139,87,0.10)", borderLeftColor:"var(--ranepa-green)"}},
              h("b", {}, "✓ 已检测到登录态 "), `(${cp.count} 个 cookies，含 ${cp.important_keys.join(", ")})`);
          }
          return h("div", {class:"err-tip", style:{marginTop:8, background:"rgba(241,162,63,0.10)", borderLeftColor:"var(--ranepa-orange)"}},
            h("b", {}, "⚠ 读到 cookies 但没找到登录态 "), `(${cp.count} 个，但没有 SESSDATA / SAPISID 等关键 key)`,
            h("div", {style:{marginTop:6, fontSize:11, color:"var(--fg-3)"}},
              `请先在 ${BROWSERS.find(b=>b.k===picked)?.l} 里用账号登录 ${cp.domain}，登录成功后再点这里重试。`),
          );
        })() : null,
        // Safari 专属一次性提示
        picked === "safari" ? h("div", {class:"err-tip"},
          h("b", {}, "Safari 注意 "),
          "macOS 第一次读 Safari Cookies 时，需要给运行 server.py 的应用（Terminal / iTerm / Warp）",
          h("b", {}, "「完全磁盘访问权限」"),
          "。系统设置 → 隐私与安全 → 完全磁盘访问 → 把对应 App 勾上。"
        ) : null,
        // 通用前置条件提示
        picked ? h("div", {class:"err-tip", style:{marginTop:8}},
          h("b", {}, "前提："),
          `已经在 ${BROWSERS.find(b => b.k === picked).l} 里用账号登录过这个网站（B 站 / YouTube 等）。yt-dlp 只读取那个浏览器的 Cookie 文件，自己不做登录。`
        ) : null,
        // 逃生通道 — 反复触发风控时手动粘贴
        h("div", {class:"err-tip", style:{marginTop:8, background:"rgba(46,139,87,0.08)", borderLeftColor:"var(--ranepa-green)"}},
          h("b", {}, "如果反复风控失败 "),
          "可以打开浏览器进入 UP 主主页，逐个右键复制你想要的视频链接，粘到下方批量列表里 —— 不走扫描接口，绕开风控。",
          h("div", {style:{marginTop:8}},
            h("button", {class:"btn-secondary", style:{height:32, fontSize:12},
              onClick: () => { state.flow = "manual-paste"; render(); }
            }, icon("Clipboard",{size:12}), "改用 · 手动粘贴一批链接")
          )
        ),

        h("div", {class:"err-actions", style:{marginTop:18}},
          h("button", {class:"btn-secondary", onClick: () => {
            state.flow = (state.mode === "download" ? (state.dl.probe ? "dl-detected" : "empty")
                                                    : (state.probe ? "filled" : "empty"));
            render();
          }}, "稍后处理"),
          picked ? h("button", {
            class:"btn-primary",
            style:{width:"auto", padding:"0 18px", height:"36px", fontSize:"13px", boxShadow:"none"},
            onClick: () => {
              // 重试要看用户之前在做什么：
              //   url_type=channel/playlist  → 上次是扫描列表失败，重试扫描
              //   其它（单视频 412 / 需要会员）→ 重试探测
              const ut = state.job?.url_type;
              if (ut === "channel" || ut === "playlist") {
                handleScanChannel();
              } else {
                handleProbe();
              }
            }
          }, "用 ", BROWSERS.find(b => b.k === picked).l, " 重试") : null,
        ),
        h("div", {class:"err-suggest", html: `<b>隐私说明：</b>
          只读取你选的浏览器对该网站的会话凭证，不会读取密码或其他浏览记录。<br/>
          每个浏览器需要先在里面用账号登录过该站点（B 站 / YouTube 等）。`}),
      )
    );
  }

  // ----- History -----
  function renderHistory() {
    const wrap = document.createDocumentFragment();
    const search = h("input", {
      type:"text", placeholder:"搜索标题或 BV / 视频 ID…",
      value: state.histQuery,
      onInput: (e) => { state.histQuery = e.target.value; loadHistory(); }
    });
    const toolbar = h("div", {class:"hist-toolbar"},
      h("div", {class:"search-input"},
        icon("Search",{size:14}),
        search
      ),
      h("div", {class:"hist-filter"},
        ["all","bili","yt","tw"].map(k => {
          const labels = {all:"全部", bili:"B站", yt:"YouTube", tw:"其他"};
          return h("button", {
            class: state.histFilter===k ? "is-on" : "",
            onClick: () => { state.histFilter = k; loadHistory(); }
          }, labels[k]);
        })
      ),
      h("button", {class:"btn-secondary", onClick: async () => {
        if (confirm("清空所有历史记录？")) { await api.clearHistory(); state.history = []; render(); }
      }}, icon("Trash",{size:13}), "清空"),
    );
    wrap.appendChild(toolbar);

    const list = h("div", {class:"hist-list", id:"hist-list"});
    if (state.history.length === 0) {
      list.appendChild(h("div", {style:{padding:"32px 16px", textAlign:"center", color:"var(--fg-3)", fontSize:13}},
        "还没有转录记录。"));
    } else {
      state.history.forEach(r => {
        const kind = r.platform_kind || "bili";
        const thumbBg = kind === "yt" ? "linear-gradient(135deg, #FF0000, #8B0000)"
                     : kind === "tw" ? "linear-gradient(135deg, #1DA1F2, #000)"
                     : "linear-gradient(135deg, #00AEEC, #FB7299)";
        list.appendChild(h("div", {class:"hist-item", onClick: () => loadFromHistory(r.id)},
          h("div", {class:"hist-thumb", style:{background: thumbBg}},
            h("div", {class:"badge"}, fmtDuration(r.duration))),
          h("div", {class:"hist-info"},
            h("div", {class:"hist-title"}, r.title || "(无标题)"),
            h("div", {class:"hist-sub"},
              h("span", {class:"source-tag"}, r.video_id || ""),
              h("span", {}, h("span", {class:"latin"}, (r.words || 0).toLocaleString()), " 字 · 模型 ", h("span", {class:"latin"}, r.model || "—")),
            ),
          ),
          h("div", {class:"hist-meta-col"}, h("span", {class:"latin"}, fmtDate(r.created_at))),
          h("div", {class:"hist-actions"},
            h("button", {class:"hist-ai-btn", title:"用 AI 整理这条转录", onClick: (e) => { e.stopPropagation(); handleAIOrganize(r.id, "smart-doc", r.title); }},
              h("span", {class:"ai-text-badge sm"}, "AI")),
            h("button", {title:"下载 .txt", onClick: (e) => { e.stopPropagation(); api.downloadResult(r.id, "txt"); }}, icon("Download",{size:13})),
            h("button", {title:"删除", onClick: async (e) => { e.stopPropagation(); if (confirm("删除这条记录？")) { await api.deleteHistory(r.id); loadHistory(); } }},
              icon("Trash",{size:13})),
          ),
        ));
      });
    }
    wrap.appendChild(list);

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  async function loadHistory() {
    const kind = state.histFilter === "all" ? null : state.histFilter;
    state.history = await api.getHistory(state.histQuery, kind);
    if (state.view === "history") render();
  }

  async function loadFromHistory(id) {
    try {
      const r = await api.getJob(id);
      state.job = r;
      state.url = r.url;
      state.probe = {platform: detectPlatformFromKind(r.platform_kind), video_id: r.video_id, duration: r.duration};
      state.flow = "complete";
      state.view = "home";
      state.completeTab = "text";
      render();
    } catch (e) {
      alert("加载失败：" + e.message);
    }
  }
  function detectPlatformFromKind(kind) {
    if (kind === "bili") return {name:"Bilibili", kind:"bili", color:"#FB7299"};
    if (kind === "yt")   return {name:"YouTube", kind:"yt", color:"#FF0000"};
    if (kind === "tw")   return {name:"Twitter", kind:"tw", color:"#1DA1F2"};
    return null;
  }

  // ----- Collection -----
  function renderCollection() {
    const p = state.probe;
    if (!p || !p.parts) return renderEmpty();
    const eps = p.parts;
    const wrap = document.createDocumentFragment();
    wrap.appendChild(h("div", {class:"coll-hd"},
      h("div", {class:"coll-cover"}, h("div", {class:"ep-badge"}, `${eps.length}P · ${fmtDuration(p.duration || eps.reduce((a,b) => a + (b.duration||0), 0))}`)),
      h("div", {class:"coll-info"},
        h("div", {class:"coll-eyebrow"}, icon("Sparkle",{size:11}), `检测到合集 · ${eps.length} 个分 P`),
        h("h2", {class:"coll-title"}, p.title || "(无标题合集)"),
        h("div", {class:"coll-meta"}, p.uploader ? `UP 主：${p.uploader} · ` : "", `共 ${eps.length} 集`),
      )
    ));
    wrap.appendChild(h("div", {class:"coll-toolbar"},
      (() => {
        const allOn = state.selectedEpisodes.length === eps.length;
        const cb = h("div", {class:`checkbox ${allOn ? "is-on" : ""}`,
          onClick: () => {
            state.selectedEpisodes = allOn ? [] : eps.map((_, i) => i);
            render();
          }
        });
        if (allOn) cb.appendChild(icon("Check",{size:10, stroke:3}));
        return cb;
      })(),
      h("div", {class:"sel-label", html: `已选 <b>${state.selectedEpisodes.length}</b> / ${eps.length}`}),
      h("button", {class:"btn-ghost", onClick: () => { state.selectedEpisodes = eps.map((_,i)=>i); render(); }}, "全选"),
      h("button", {class:"btn-ghost", onClick: () => {
        state.selectedEpisodes = eps.map((_,i)=>i).filter(i => !state.selectedEpisodes.includes(i));
        render();
      }}, "反选"),
      h("div", {style:{flex:1}}),
    ));
    const list = h("div", {class:"coll-list"});
    eps.forEach((ep, i) => {
      const sel = state.selectedEpisodes.includes(i);
      const h_ = (ep.p || i+1) * 37 % 360;
      const row = h("div", {class:`ep-row ${sel ? "is-selected" : ""}`,
        onClick: () => {
          if (sel) state.selectedEpisodes = state.selectedEpisodes.filter(x => x !== i);
          else state.selectedEpisodes = [...state.selectedEpisodes, i];
          render();
        }
      });
      const cb = h("div", {class:`checkbox ${sel ? "is-on" : ""}`});
      if (sel) cb.appendChild(icon("Check",{size:10, stroke:3}));
      row.appendChild(cb);
      row.appendChild(h("div", {class:"ep-num"}, `P${String(ep.p || (i+1)).padStart(2,"0")}`));
      row.appendChild(h("div", {class:"ep-thumb", style:{background: `linear-gradient(135deg, hsl(${h_},60%,55%), hsl(${(h_+60)%360},70%,45%))`}},
        h("div", {class:"dur"}, fmtDuration(ep.duration))));
      row.appendChild(h("div", {},
        h("div", {class:"ep-title"}, ep.title || "(无标题)"),
        h("div", {class:"ep-sub"}, h("span", {}, fmtDuration(ep.duration))),
      ));
      row.appendChild(h("div", {class:"ep-sub", style:{margin:0, fontFamily:"var(--font-mono)"}}, fmtDuration(ep.duration)));
      row.appendChild(h("div", {style:{color:"var(--fg-4)"}}, "···"));
      list.appendChild(row);
    });
    wrap.appendChild(list);

    // Output mode selector — AI modes shown but disabled
    const modes = [
      {k:"smart-doc", ai:true,  ic:"Doc",       name:"整理文档",     desc:"分章节 · 去口语化 · 自动目录"},
      {k:"notes",     ai:true,  ic:"Notes",     name:"学习笔记",     desc:"要点 · 关键词 · 一句话总结"},
      {k:"qa",        ai:true,  ic:"Clipboard", name:"Q&A 卡片",    desc:"问答对 · 可导入 Anki"},
      {k:"mindmap",   ai:true,  ic:"MindMap",   name:"思维导图",     desc:"Markdown / Mermaid 格式"},
      {k:"srt-bundle",ai:false, ic:"Waveform",  name:"字幕合集",     desc:"连续 .srt · 自动偏移"},
    ];
    wrap.appendChild(h("div", {class:"output-mode-strip"},
      h("div", {class:"output-mode-hd"}, "合并后的输出形式"),
      h("div", {class:"output-modes"},
        modes.map(m => {
          const on = state.selectedOutputMode === m.k;
          const card = h("div", {
            class:`output-mode ${on ? "is-on" : ""}`,
            style: m.ai ? {opacity: 0.7} : null,
            title: m.ai ? "AI 模式需要配置 Claude API（暂未启用）" : "",
            onClick: () => {
              if (m.ai) { alert("AI 整理需要你自己配置 Claude API。可以先选「字幕合集」生成连续 .srt。"); return; }
              state.selectedOutputMode = m.k; render();
            }
          });
          if (m.ai) card.appendChild(h("span", {class:"om-ai"}, "AI"));
          const ic = h("div", {class:"om-icon"});
          ic.appendChild(icon(m.ic, {size:20}));
          card.appendChild(ic);
          card.appendChild(h("div", {class:"om-name"}, m.name));
          card.appendChild(h("div", {class:"om-desc"}, m.desc));
          return card;
        })
      ),
    ));

    const totalDur = state.selectedEpisodes.reduce((sum, i) => sum + (eps[i]?.duration || 0), 0);
    const etaMin = Math.ceil(totalDur / 60 / 8); // 8× realtime estimate
    wrap.appendChild(h("div", {class:"coll-footer"},
      h("div", {class:"est", html: `预计 <b>${state.selectedEpisodes.length}</b> 个视频 · 总时长 <b>${fmtDuration(totalDur)}</b> · 预计耗时 <b>约 ${etaMin} 分钟</b><br/>
        <span style="color:var(--fg-4); font-size:11px;">mlx-whisper ${state.model} · ${state.lang === "auto" ? "自动语言检测" : state.lang}</span>`}),
      h("button", {class:"btn-go", onClick: handleStartBatch,
        disabled: state.selectedEpisodes.length === 0
      }, icon("Play",{size:13}), "开始批量转录"),
    ));

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  // ----- Batch -----
  function renderBatch() {
    const b = state.batch;
    if (!b) return renderEmpty();
    const items = b.items || [];
    const done = items.filter(i => i.status === "done").length;
    const active = items.find(i => ["downloading","extracting","transcribing"].includes(i.status));
    const totalPct = (items.reduce((s, it) => {
      if (it.status === "done") return s + 100;
      return s + (it.progress || 0);
    }, 0) / Math.max(items.length, 1));
    const dash = (2 * Math.PI * 26 * (totalPct / 100)).toFixed(2);
    const fullDash = (2 * Math.PI * 26).toFixed(2);

    const wrap = document.createDocumentFragment();

    const overview = h("div", {class:"batch-overview"},
      h("div", {class:"col"},
        h("span", {class:"lbl"}, "当前任务"),
        h("span", {class:"num", style:{fontSize:16, fontFamily:"var(--font-display)", lineHeight:1.3}},
          active ? (active.title || active.url || "—") : "—"),
        h("span", {style:{fontSize:11, color:"var(--fg-3)", marginTop:4}}, `已完成 ${done} / ${items.length}`),
      ),
      h("div", {class:"col"},
        h("span", {class:"lbl"}, "已完成"),
        h("span", {class:"num green"}, String(done)),
      ),
      h("div", {class:"col"},
        h("span", {class:"lbl"}, "进度"),
        h("span", {class:"num", style:{fontFamily:"var(--font-mono)"}}, `${Math.floor(totalPct)}%`),
      ),
      (() => {
        const ring = h("div", {class:"ring"});
        ring.innerHTML = `<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" stroke="var(--bg-muted)" stroke-width="6"/><circle cx="30" cy="30" r="26" fill="none" stroke="var(--accent)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash} ${fullDash}"/></svg><div class="ring-pct">${Math.floor(totalPct)}%</div>`;
        return ring;
      })(),
    );
    wrap.appendChild(overview);

    const list = h("div", {class:"batch-list"});
    items.forEach((it, idx) => {
      const stateCls = it.status === "done" ? "is-done" :
                       ["downloading","extracting","transcribing"].includes(it.status) ? "is-active" :
                       it.status === "error" ? "is-failed" : "is-pending";
      const stageChip = it.stage === "download" ? {cls:"dl", label:"下载中"} :
                        it.stage === "extract"  ? {cls:"tr", label:"提取中"} :
                        it.stage === "transcribe" ? {cls:"tr", label:"识别中"} : null;
      const hueSeed = (idx + 1) * 37 % 360;
      const row = h("div", {class:`batch-row ${stateCls}`},
        h("div", {class:"b-status"},
          it.status === "done" ? icon("Check",{size:10, stroke:3}) : String(idx+1).padStart(2,"0")),
        h("div", {class:"b-thumb", style:{background: `linear-gradient(135deg, hsl(${hueSeed},60%,55%), hsl(${(hueSeed+60)%360},70%,45%))`}}),
        h("div", {class:"b-info"},
          h("div", {class:"b-title"}, it.title || it.url),
          h("div", {class:"b-meta"},
            stageChip ? h("span", {class:`stage-chip ${stageChip.cls}`}, stageChip.label) : null,
            h("span", {}, `${fmtDuration(it.duration)} · ${it.status === "pending" ? "排队中" : (it.eta ? `剩余 ${it.eta}` : "处理中")}`),
          ),
        ),
        h("div", {},
          h("div", {class:"b-bar"}, h("div", {class:"b-bar-fill", style:{width: (it.status === "done" ? 100 : (it.progress || 0)) + "%"}})),
        ),
        h("div", {class:"b-time"},
          it.status === "done" ? "✓ 完成" : it.status === "error" ? "× 失败" : it.status === "pending" ? "—" : `${Math.floor(it.progress || 0)}%`),
        h("div", {class:"b-more"}, "···"),
      );
      list.appendChild(row);
    });
    wrap.appendChild(list);

    const allDone = done === items.length && items.length > 0;
    wrap.appendChild(h("div", {style:{padding:"12px 28px", borderTop:"var(--border-hair)", display:"flex", alignItems:"center", gap:12}},
      h("span", {style:{fontSize:11, color:"var(--fg-3)"}},
        active ? `共 ${items.length} 个 · 已完成 ${done} 个`
               : allDone ? "全部完成 · 可用 AI 整理合并"
                        : `共 ${items.length} 个 · 已完成 ${done}`),
      h("div", {style:{flex:1}}),
      allDone
        ? h("button", {class:"btn-primary ai-action-btn", style:{width:"auto", padding:"0 18px", height:36, fontSize:13, boxShadow:"none"},
            onClick: () => handleAIOrganize(items[0].id, "smart-doc", "批量合并 · " + items.length + " 集")
          }, h("span", {class:"ai-text-badge on-accent"}, "AI"), "整理合并")
        : h("button", {class:"btn-secondary",
            onClick: async () => {
              for (const it of items) {
                if (["downloading","extracting","transcribing"].includes(it.status)) {
                  await api.cancelJob(it.id);
                }
              }
            }
          }, icon("Stop",{size:13}), "停止队列"),
    ));

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  // ============================================================
  // Chain B (download): API methods
  // ============================================================
  Object.assign(api, {
    async dlProbe(url, cookies_browser) {
      const r = await fetch("/api/dl/probe", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({url, cookies_browser}),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw err.detail || err;
      }
      return await r.json();
    },
    async dlCreate(body) {
      const r = await fetch("/api/dl/jobs", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(body),
      });
      if (!r.ok) throw await r.json().catch(() => ({}));
      return await r.json();
    },
    async dlCancel(id) { await fetch(`/api/dl/jobs/${id}/cancel`, {method:"POST"}); },
    async dlReveal(path) {
      await fetch("/api/dl/reveal", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({path}),
      });
    },
    async dlSettingsGet() {
      const r = await fetch("/api/dl/settings");
      return await r.json();
    },
    async dlSettingsSet(settings) {
      const r = await fetch("/api/dl/settings", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(settings),
      });
      return await r.json();
    },
    async channelProbe(url, cookies_browser, limit = 50) {
      const r = await fetch("/api/channel/probe", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({url, cookies_browser, limit}),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw err.detail || err;
      }
      return await r.json();
    },
    async cookiesProbe(browser, domain) {
      const r = await fetch("/api/cookies/probe", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({browser, domain}),
      });
      return await r.json();
    },
    async dlBatch(body) {
      const r = await fetch("/api/dl/batch", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(body),
      });
      if (!r.ok) throw await r.json().catch(() => ({}));
      return await r.json();
    },
  });

  function openDlStream(jobId) {
    closeStreams();
    const es = new EventSource(`/api/dl/jobs/${jobId}/stream`);
    state.dl.eventSource = es;
    es.addEventListener("snapshot", e => {
      state.dl.job = JSON.parse(e.data);
      updateDlFlowFromJob();
      render();
    });
    es.addEventListener("status", e => {
      const d = JSON.parse(e.data);
      Object.assign(state.dl.job, d);
      updateDlFlowFromJob();
      render();
    });
    es.addEventListener("progress", e => {
      const d = JSON.parse(e.data);
      Object.assign(state.dl.job, d);
      patchDlProgress();
    });
    es.addEventListener("meta", e => {
      const d = JSON.parse(e.data);
      Object.assign(state.dl.job, d);
      render();
    });
    es.addEventListener("log", e => {
      const d = JSON.parse(e.data);
      (state.dl.job.logs ||= []).push(d);
      patchLog(d);
    });
    es.addEventListener("end", () => closeStreams());
  }
  function updateDlFlowFromJob() {
    if (!state.dl.job) return;
    const map = {
      "downloading": "dl-progress",
      "merging":     "dl-progress",
      "done":        "dl-complete",
      "cancelled":   "dl-detected",
      "error":       state.dl.job.error_kind === "login_required" ? "err-login" : "err-invalid",
    };
    state.flow = map[state.dl.job.status] || state.flow;
  }
  function patchDlProgress() {
    const j = state.dl.job; if (!j) return;
    const fill = document.querySelector(".dl-bar-big .fill");
    if (fill) fill.style.width = (j.progress || 0) + "%";
    const speedEl = document.getElementById("dl-stat-speed");
    if (speedEl) speedEl.innerHTML = formatSpeed(j.speed);
    const dlEl = document.getElementById("dl-stat-downloaded");
    if (dlEl) dlEl.innerHTML = formatBytes(j.downloaded || 0);
    const metaEl = document.getElementById("dl-bar-meta");
    if (metaEl) metaEl.innerHTML = `<span>${formatBytes(j.downloaded||0)} / ${formatBytes(j.total||0)}</span><span style="color:var(--accent); font-weight:600">${Math.floor(j.progress||0)}%</span><span>剩余 ${j.eta || "?"}</span>`;
  }

  function formatBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n/(1024**2)).toFixed(1)} MB`;
    return `${(n/(1024**3)).toFixed(2)} GB`;
  }
  function formatSpeed(s) {
    if (!s) return "—";
    return `${s.replace(/^(\d+\.?\d*)\s*(.*)$/, '$1<small> $2</small>')}`;
  }

  function setMode(m) {
    if (state.mode === m) return;
    closeStreams();
    state.mode = m;
    localStorage.setItem("mode", m);
    // Recompute flow based on new mode
    if (m === "download") {
      state.flow = state.dl.probe ? "dl-detected" : (state.url ? "filled" : "empty");
    } else {
      state.flow = state.job?.status === "done" ? "complete"
                  : state.probe?.is_collection ? "collection"
                  : (state.probe ? "filled" : "empty");
    }
    render();
  }

  function renderModeToggle() {
    return h("div", {class:"mode-tog"},
      h("button", {
        class: `mode-tog-opt tone-a ${state.mode === "transcribe" ? "is-on" : ""}`,
        onClick: () => setMode("transcribe")
      },
        h("span", {class:"badge-mode"}, "Aa"),
        "转录文字"
      ),
      h("button", {
        class: `mode-tog-opt tone-b ${state.mode === "download" ? "is-on" : ""}`,
        onClick: () => setMode("download")
      },
        (() => { const b = h("span", {class:"badge-mode"}); b.appendChild(icon("Download", {size:12})); return b; })(),
        "下载视频"
      ),
    );
  }

  // ============================================================
  // Chain B: download input panel (LEFT card)
  // ============================================================
  function renderInputPanelDownload() {
    const running = ["dl-progress"].includes(state.flow);
    const urlState = state.flow === "err-invalid" ? "invalid"
                   : state.flow === "err-login"   ? "login-required"
                   : state.url ? "filled" : "empty";
    const isFilled = urlState !== "empty";
    const platform = state.dl.probe?.platform || (state.url ? detectPlatformFromUrl(state.url) : null);
    const probe = state.dl.probe;
    const tier = state.dl.selectedTier;

    let urlMeta = "";
    if (probe) {
      const parts = [probe.video_id, fmtDuration(probe.duration), tier?.label].filter(Boolean);
      urlMeta = parts.join(" · ");
    }

    const sdir  = state.dl.settings?.save_dir || "~/Movies/拾字";
    const tmpl  = state.dl.settings?.name_template || "{title}_{uploader}_{id}";

    return h("div", {class:"card"},
      h("div", {class:"card-hd"},
        h("div", {class:"eyebrow", style:{flex:1}}, "新任务"),
        h("button", {class:"btn-ghost", title:"前往 AI 设置 配置保存位置", onClick: () => { state.view="settings"; render(); }},
          icon("Cog",{size:13}), "保存设置"),
      ),
      h("div", {class:"card-bd"},
        renderModeToggle(),

        // URL
        h("div", {},
          h("div", {class:"field-label"},
            h("span", {}, "视频链接"),
            h("span", {class:"hint"}, "支持 1,800+ 平台"),
          ),
          (function () {
            const wrap = h("div", {class: `url-wrap ${isFilled ? "is-filled" : ""}`});
            const inp = h("input", {
              type:"text", class:"url-input",
              placeholder:"粘贴视频链接（B站 / YouTube / X 等）",
              value: state.url || "",
              onInput: (e) => { state.url = e.target.value; },
              onKeyDown: (e) => { if (e.key === "Enter" && state.url) handleProbe(); },
              onPaste: () => { setTimeout(() => { state.url = inp.value; if (state.url) handleProbe(); }, 0); }
            });
            wrap.appendChild(inp);
            if (!isFilled) {
              wrap.appendChild(h("button", {
                class:"paste-btn",
                onClick: async () => {
                  try { const t = await navigator.clipboard.readText();
                    if (t) { state.url = t; inp.value = t; handleProbe(); } }
                  catch (e) { inp.focus(); }
                }
              }, icon("Clipboard",{size:12}), "粘贴"));
            } else {
              const meta = h("div", {class:"url-meta"});
              if (platform) {
                meta.appendChild(h("div", {class:"platform-chip"},
                  h("span", {class:"sw", style:{background: platform.color}}),
                  platform.name));
              }
              if (state.flow === "err-invalid")
                meta.appendChild(h("div", {class:"platform-chip", style:{background:"rgba(241,162,63,0.16)", color:"var(--ranepa-orange)"}}, icon("Alert",{size:11}), "未识别"));
              if (state.flow === "err-login")
                meta.appendChild(h("div", {class:"platform-chip", style:{background:"rgba(6,26,108,0.08)", color:"var(--ranepa-navy)"}}, icon("Lock",{size:11}), "需登录"));
              meta.appendChild(h("span", {class:"url-meta-text"}, urlMeta || ""));
              meta.appendChild(h("button", {class:"url-clear", onClick: () => {
                state.url = ""; state.dl.probe = null; state.dl.selectedTier = null;
                state.dl.job = null; state.flow = "empty";
                closeStreams(); render();
              }}, icon("Close",{size:12})));
              wrap.appendChild(meta);
            }
            return wrap;
          })(),
        ),

        // Naming template preview
        h("div", {},
          h("div", {class:"field-label"},
            h("span", {}, "命名模板"),
            h("span", {class:"hint"}, "在 AI 设置 里调整"),
          ),
          h("div", {style:{
            background:"var(--bg-muted)", padding:"10px 12px",
            borderRadius:"var(--radius-md)",
            fontFamily:"var(--font-mono)", fontSize:12, color:"var(--fg-1)",
            wordBreak:"break-all"
          }}, tmpl + ".mp4"),
        ),

        // Save dir
        h("div", {},
          h("div", {class:"field-label"}, h("span", {}, "保存位置")),
          h("div", {style:{
            background:"var(--bg-muted)", padding:"10px 12px",
            borderRadius:"var(--radius-md)",
            fontFamily:"var(--font-mono)", fontSize:12, color:"var(--fg-1)",
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}, sdir),
        ),

        // Extras
        h("div", {},
          h("div", {class:"field-label"}, h("span", {}, "附加内容")),
          h("div", {style:{display:"flex", flexDirection:"column", gap:10}},
            ...renderDlExtraRows()
          ),
        ),

        h("div", {style:{flex:1, minHeight: "8px"}}),

        (function () {
          if (running) {
            return h("button", {class:"btn-danger",
              onClick: async () => { if (state.dl.job?.id) await api.dlCancel(state.dl.job.id); }
            }, icon("Stop",{size:14}), "停止下载");
          }
          const disabled = !tier || state.flow === "err-invalid" || state.flow === "err-login";
          const sizeStr = tier ? ` · 约 ${formatBytes(tier.size)}` : "";
          return h("button", {
            class:`btn-primary ${disabled ? "is-disabled" : ""}`,
            disabled,
            onClick: handleStartDownload,
          }, icon("Download",{size:15}),
             tier ? `下载 ${tier.label}${sizeStr}` : (state.url ? "选择画质" : "粘贴链接开始"));
        })(),
      )
    );
  }

  function renderDlExtraRows() {
    const x = state.dl.extras;
    const row = (k, label, sub) => {
      const r = h("div", {class:"extra-row"});
      const sw = h("span", {class:`switch ${x[k] ? "is-on" : ""}`,
        onClick: () => { x[k] = !x[k]; render(); }});
      r.appendChild(sw);
      const lbl = h("div", {class:"lbl"}, label);
      if (sub) lbl.appendChild(h("small", {}, sub));
      r.appendChild(lbl);
      return r;
    };
    const subsAvail = (state.dl.probe?.subtitles_avail || []).join(" · ") || "未检测";
    return [
      row("subtitles", "同时下载官方字幕", subsAvail),
      row("metadata",  "写入元数据", "标题 · UP 主 · 上传日期"),
      row("thumbnail", "下载封面图", "JPG / PNG"),
      row("danmaku",   "下载弹幕（B 站）", "ASS 字幕格式"),
    ];
  }

  function detectPlatformFromUrl(url) {
    const u = (url || "").toLowerCase();
    if (u.includes("bilibili") || u.includes("b23.tv")) return {name:"Bilibili", kind:"bili", color:"#FB7299"};
    if (u.includes("youtube") || u.includes("youtu.be")) return {name:"YouTube", kind:"yt", color:"#FF0000"};
    if (u.includes("twitter") || u.includes("x.com"))   return {name:"X", kind:"tw", color:"#000000"};
    if (u.includes("tiktok"))                            return {name:"TikTok", kind:"tt", color:"#000000"};
    return null;
  }

  // ============================================================
  // Chain B: RIGHT panel — three states
  // ============================================================
  function renderDlDetected() {
    const p = state.dl.probe;
    if (!p) return renderEmpty();
    const tiers = p.tiers || [];
    const wrap = document.createDocumentFragment();

    wrap.appendChild(h("div", {class:"dl-meta-card"},
      h("div", {class:"dl-thumb"},
        h("div", {class:"dl-thumb-badge"}, `${fmtDuration(p.duration)} · ${state.dl.selectedTier?.label || ""}`)),
      h("div", {class:"dl-meta-info"},
        h("div", {class:"dl-meta-eyebrow"}, icon("Download",{size:11}), "已识别 · 可下载"),
        h("div", {class:"dl-title"}, p.title || "(无标题)"),
        h("div", {class:"dl-author"}, p.uploader ? `UP 主：${p.uploader}` : "",
          p.upload_date ? ` · ${formatUploadDate(p.upload_date)} 上传` : ""),
        h("div", {class:"dl-stats"},
          state.dl.selectedTier ? h("span", {}, state.dl.selectedTier.label) : null,
          state.dl.selectedTier ? h("span", {class:"dot"}, "·") : null,
          state.dl.selectedTier ? h("span", {}, state.dl.selectedTier.vcodec) : null,
          state.dl.selectedTier ? h("span", {class:"dot"}, "·") : null,
          h("span", {}, p.video_id || ""),
        ),
      ),
    ));

    wrap.appendChild(h("div", {class:"dl-quality-section"},
      h("div", {class:"dl-section-hd"}, "画质 / 格式",
        h("span", {class:"pill"}, `${tiers.length} 个可选`)),
      h("div", {class:"qual-list"},
        tiers.map(t => {
          const sel = state.dl.selectedTier?.format_id === t.format_id;
          return h("div", {
            class:`qual-row ${sel ? "is-selected" : ""} ${t.locked ? "is-locked" : ""}`,
            onClick: () => { if (!t.locked) { state.dl.selectedTier = t; render(); } }
          },
            h("div", {class:"qual-radio"}),
            h("div", {class:"qual-name"}, t.label,
              t.recommended ? h("span", {class:"rec-tag"}, "推荐") : null),
            h("div", {class:"qual-fmt"}, t.fmt),
            h("div", {class:"qual-spec"}, t.spec,
              t.hdr ? h("span", {style:{marginLeft:6, fontSize:10, color:"var(--ranepa-orange)", fontWeight:600}}, " · HDR") : null),
            h("div", {class:"qual-size"}, formatBytes(t.size)),
          );
        }),
      ),
    ));

    wrap.appendChild(h("div", {class:"dl-extras"},
      h("div", {class:"dl-section-hd"}, "附加内容"),
      h("div", {class:"dl-extras-grid"}, ...renderDlExtraRows()),
    ));

    wrap.appendChild(h("div", {class:"dl-output-row"},
      h("span", {class:"lbl"}, "保存到"),
      h("div", {class:"path"},
        `${state.dl.settings?.save_dir || "~/Movies/拾字"}/${(state.dl.settings?.name_template || "{title}_{uploader}_{id}")}.${state.dl.selectedTier?.fmt || "mp4"}`),
      h("button", {class:"btn-secondary", onClick: () => { state.view="settings"; render(); }}, "更改…"),
    ));

    const tot = state.dl.selectedTier?.size || 0;
    wrap.appendChild(h("div", {class:"dl-footer"},
      h("div", {class:"est"},
        h("b", {}, formatBytes(tot)),
        " · ",
        state.dl.extras.subtitles ? "含字幕" : "无字幕",
        " · ",
        state.dl.extras.metadata ? "嵌入元数据" : "纯视频"),
      h("button", {class:"btn-go",
        disabled: !state.dl.selectedTier,
        onClick: handleStartDownload
      }, icon("Download",{size:14}), "开始下载"),
    ));

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0, overflowY:"auto"}});
    container.appendChild(wrap);
    return container;
  }

  function renderDlProgress() {
    const j = state.dl.job || {};
    const tier = state.dl.selectedTier || {};
    const wrap = document.createDocumentFragment();

    const card = h("div", {class:"dl-prog-card"},
      h("div", {class:"dl-prog-hd"},
        h("div", {class:"dl-thumb"}, h("div", {class:"dl-thumb-badge"}, fmtDuration(j.duration))),
        h("div", {class:"dl-prog-info"},
          h("span", {class:"dl-prog-spec"}, icon("Download",{size:12}), `正在下载 · ${tier.label || ""}`),
          h("div", {class:"dl-prog-file"}, j.title || "(获取中)"),
          h("div", {style:{fontSize:11, color:"var(--fg-3)", fontFamily:"var(--font-mono)"}},
            `${state.dl.settings?.save_dir || "~/Movies/拾字"}/`),
        ),
      ),
      h("div", {},
        h("div", {class:"dl-bar-big"}, h("div", {class:"fill", style:{width: (j.progress || 0) + "%"}})),
        h("div", {class:"bar-meta", id:"dl-bar-meta", style:{marginTop:8}},
          h("span", {}, `${formatBytes(j.downloaded||0)} / ${formatBytes(j.total||0)}`),
          h("span", {style:{color:"var(--accent)", fontWeight:600}}, `${Math.floor(j.progress||0)}%`),
          h("span", {}, `剩余 ${j.eta || "?"}`),
        ),
      ),
      h("div", {class:"dl-prog-num-row"},
        h("div", {class:"dl-prog-stat accent"},
          h("div", {class:"lbl"}, "网速"),
          h("div", {class:"val", id:"dl-stat-speed", html: formatSpeed(j.speed || "—")}),
        ),
        h("div", {class:"dl-prog-stat"},
          h("div", {class:"lbl"}, "已下载"),
          h("div", {class:"val", id:"dl-stat-downloaded", html: formatBytes(j.downloaded||0)}),
        ),
        h("div", {class:"dl-prog-stat"},
          h("div", {class:"lbl"}, "格式"),
          h("div", {class:"val", style:{fontSize:16, lineHeight:1.2}}, tier.fmt || "—",
            h("small", {}, ` · ${tier.vcodec || ""}`)),
        ),
        h("div", {class:"dl-prog-stat"},
          h("div", {class:"lbl"}, "音频"),
          h("div", {class:"val", style:{fontSize:16, lineHeight:1.2}}, "AAC",
            h("small", {}, ` · ${tier.acodec || ""}`)),
        ),
      ),
      (function () {
        const log = h("div", {class:"log"});
        (j.logs || []).forEach(e => {
          const lvlMap = {dl:"DL", ok:"OK", inf:"INF", run:"RUN", warn:"WRN"};
          log.appendChild(h("div", {class:"log-line"},
            h("span", {class:"ts"}, `[${e.ts}]`),
            h("span", {class:`tag ${e.level}`}, lvlMap[e.level] || e.level.toUpperCase()),
            h("span", {}, e.msg),
          ));
        });
        return log;
      })(),
    );
    wrap.appendChild(card);
    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  function renderDlComplete() {
    const j = state.dl.job || {};
    const filename = j.file_path ? j.file_path.split("/").pop() : "(?)";
    const wrap = document.createDocumentFragment();

    const pane = h("div", {class:"dl-done-pane"},
      h("div", {class:"dl-done-hero"},
        (() => { const c = h("div", {class:"dl-done-check"}); c.appendChild(icon("Check",{size:26, stroke:3})); return c; })(),
        h("div", {class:"dl-done-text"},
          h("div", {class:"l1"}, `下载完成 · ${formatBytes(j.total || 0)}`),
          h("div", {class:"l2"},
            "耗时 ", h("b", {}, fmtDuration(j.elapsed_seconds)),
            " · 平均 ", h("b", {}, j.speed || "—"),
            j.subtitle_paths?.length ? ` · 含 ${j.subtitle_paths.length} 个字幕` : "",
          ),
        ),
        j.file_path
          ? h("button", {class:"btn-secondary", style:{height:36, padding:"0 14px"},
              onClick: () => api.dlReveal(j.file_path)},
              icon("ChevRight",{size:13}), "在 Finder 中显示")
          : null,
      ),

      h("div", {class:"file-card"},
        h("div", {class:"dl-thumb"}, h("div", {class:"dl-thumb-badge"}, fmtDuration(j.duration))),
        h("div", {class:"fc-info"},
          h("div", {class:"fc-name"}, filename),
          h("div", {class:"fc-meta"},
            j.format_id ? h("span", {class:"tag"}, state.dl.selectedTier?.label || "") : null,
            h("span", {class:"tag"}, (state.dl.selectedTier?.vcodec || "?") + " + " + (state.dl.selectedTier?.acodec || "AAC")),
            h("span", {}, formatBytes(j.total || 0)),
            h("span", {}, "·"),
            h("span", {}, new Date((j.completed_at || 0)*1000).toLocaleString("zh-CN")),
          ),
          j.subtitle_paths?.length ? h("div", {class:"fc-side"},
            "同时保存：",
            ...j.subtitle_paths.map(p => h("span", {style:{fontFamily:"var(--font-mono)", color:"var(--fg-2)", marginLeft:8}}, "· " + p.split("/").pop())),
          ) : null,
        ),
      ),

      h("div", {class:"dl-done-actions"},
        h("div", {class:"dl-done-action", onClick: () => j.file_path && api.dlReveal(j.file_path)},
          (() => { const i = h("div", {class:"ico"}); i.appendChild(icon("Play",{size:16})); return i; })(),
          h("div", {class:"nm"}, "在 Finder 中显示"),
          h("div", {class:"sub"}, "用默认应用打开"),
        ),
        h("div", {class:"dl-done-action", onClick: () => copyText(j.file_path || "")},
          (() => { const i = h("div", {class:"ico"}); i.appendChild(icon("Copy",{size:16})); return i; })(),
          h("div", {class:"nm"}, "复制路径"),
          h("div", {class:"sub"}, (j.file_path || "").length > 24 ? "…" + (j.file_path || "").slice(-24) : (j.file_path || "")),
        ),
        h("div", {class:"dl-done-action", onClick: () => copyText(j.url || "")},
          (() => { const i = h("div", {class:"ico"}); i.appendChild(icon("Link",{size:16})); return i; })(),
          h("div", {class:"nm"}, "复制原链接"),
          h("div", {class:"sub"}, "分享给别人"),
        ),
        h("div", {class:"dl-done-action", onClick: () => {
          state.url=""; state.dl.probe=null; state.dl.selectedTier=null; state.dl.job=null;
          state.flow="empty"; render();
        }},
          (() => { const i = h("div", {class:"ico"}); i.appendChild(icon("Plus",{size:16})); return i; })(),
          h("div", {class:"nm"}, "再下一个"),
          h("div", {class:"sub"}, "回到空状态"),
        ),
      ),

      h("div", {class:"crosslink"},
        h("div", {class:"ico"},
          h("span", {class:"ai-text-badge sm"}, "AI"),
        ),
        h("div", {class:"txt", html:
          "<b>顺便转成文字？</b><br/>" +
          "音频已经在本地了，转录跳过下载步骤、直接进识别——约 1 分钟。"
        }),
        h("button", {onClick: () => handleCrosslinkTranscribe(j)},
          "切换到 转录文字"),
      ),
    );
    wrap.appendChild(pane);
    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  function formatUploadDate(d) {
    if (!d || d.length !== 8) return d;
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  }

  // ============================================================
  // Chain B: handlers
  // ============================================================
  async function handleStartDownload() {
    if (!state.dl.selectedTier) { alert("请选择画质"); return; }
    try {
      const r = await api.dlCreate({
        url: state.url,
        format_id: state.dl.selectedTier.format_id,
        audio_format_id: state.dl.probe?.audio_format_id,
        save_dir: state.dl.settings?.save_dir,
        name_template: state.dl.settings?.name_template,
        extras: state.dl.extras,
        cookies_browser: state.advanced?.cookiesBrowser || null,
      });
      state.dl.job = {id: r.job_id, status: "downloading", progress: 0, url: state.url,
                      title: state.dl.probe?.title, duration: state.dl.probe?.duration,
                      thumbnail: state.dl.probe?.thumbnail, video_id: state.dl.probe?.video_id,
                      format_id: state.dl.selectedTier.format_id, logs: []};
      state.flow = "dl-progress";
      render();
      openDlStream(r.job_id);
    } catch (err) {
      alert("下载失败：" + _readableError(err));
    }
  }

  async function handleCrosslinkTranscribe(dlJob) {
    if (!dlJob?.file_path) { alert("找不到下载文件"); return; }
    // Switch to transcribe mode and start a job with local_file
    closeStreams();
    state.mode = "transcribe";
    localStorage.setItem("mode", "transcribe");
    try {
      const r = await api.createJob({
        url: dlJob.url || "",
        model: state.model,
        lang: state.lang,
        fmt: state.fmt,
        advanced: state.advanced,
        local_file: dlJob.file_path,
      });
      state.job = {id: r.job_id, status: "extracting", progress: 0, stage: "extract",
                   url: dlJob.url || "", model: state.model, title: dlJob.title,
                   duration: dlJob.duration, video_id: dlJob.video_id, logs: [], segments: []};
      state.flow = "extracting";
      render();
      openJobStream(r.job_id);
    } catch (err) {
      alert("转录启动失败：" + _readableError(err));
    }
  }

  // ============================================================
  // AI: API methods
  // ============================================================
  Object.assign(api, {
    async getAIConfig() {
      const r = await fetch("/api/ai/config");
      return await r.json();
    },
    async saveAIConfig(cfg) {
      const r = await fetch("/api/ai/config", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify(cfg)
      });
      if (!r.ok) throw await r.json().catch(() => ({}));
      return await r.json();
    },
    async testAI(cfg) {
      const r = await fetch("/api/ai/test", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify(cfg)
      });
      return await r.json();
    },
  });

  // ============================================================
  // AI: streaming POST → SSE parser
  // ============================================================
  async function streamPostSSE(url, body, handlers, signal) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      if (handlers.error) handlers.error({error: `HTTP ${resp.status}`});
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      let read;
      try { read = await reader.read(); }
      catch (e) { if (handlers.error) handlers.error({error: String(e)}); break; }
      const {done, value} = read;
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message", data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { payload = {raw: data}; }
        if (handlers[event]) handlers[event](payload);
      }
    }
    if (handlers.end) handlers.end();
  }

  // ============================================================
  // Markdown → HTML (tiny renderer)
  // ============================================================
  function renderMarkdown(md) {
    if (!md) return "";
    const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const lines = md.split("\n");
    const out = [];
    let inCode = false, codeLang = "", inList = false, inOL = false;
    const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } if (inOL) { out.push("</ol>"); inOL = false; } };
    for (let raw of lines) {
      // Code fence
      const fence = raw.match(/^```(\w*)\s*$/);
      if (fence) {
        if (inCode) { out.push("</code></pre>"); inCode = false; }
        else { closeList(); codeLang = fence[1] || ""; out.push(`<pre><code class="lang-${esc(codeLang)}">`); inCode = true; }
        continue;
      }
      if (inCode) { out.push(esc(raw)); continue; }

      // HR
      if (/^\s*---+\s*$/.test(raw)) { closeList(); out.push("<hr/>"); continue; }
      // Headers
      const hM = raw.match(/^(#{1,6})\s+(.*)$/);
      if (hM) { closeList(); const lvl = hM[1].length; out.push(`<h${lvl}>${inline(hM[2])}</h${lvl}>`); continue; }
      // Blockquote
      if (raw.startsWith("> ")) { closeList(); out.push(`<blockquote>${inline(raw.slice(2))}</blockquote>`); continue; }
      // UL
      const ulM = raw.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ulM) {
        if (!inList) { closeList(); out.push("<ul>"); inList = true; }
        out.push(`<li>${inline(ulM[2])}</li>`);
        continue;
      }
      // OL
      const olM = raw.match(/^(\s*)\d+\.\s+(.*)$/);
      if (olM) {
        if (!inOL) { closeList(); out.push("<ol>"); inOL = true; }
        out.push(`<li>${inline(olM[2])}</li>`);
        continue;
      }
      // Empty
      if (raw.trim() === "") { closeList(); continue; }
      // Paragraph
      closeList();
      out.push(`<p>${inline(raw)}</p>`);
    }
    if (inCode) out.push("</code></pre>");
    closeList();

    function inline(s) {
      s = esc(s);
      // bold **x**
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      // italic *x*
      s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
      // inline code `x`
      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
      // timestamp [mm:ss] or [HH:MM:SS] highlight
      s = s.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="md-ts">[$1]</span>');
      return s;
    }
    return out.join("\n");
  }

  // ============================================================
  // AI: settings page
  // ============================================================
  async function loadAIConfig(force = false) {
    if (state.ai.config && !force) return;
    try {
      state.ai.config = await api.getAIConfig();
      state.ai.configDraft = {
        provider: state.ai.config.provider,
        base_url: state.ai.config.base_url,
        api_key: "",   // empty unless user types
        model: state.ai.config.model,
        prompts: {...state.ai.config.prompts},
      };
      render();
    } catch (e) { console.error(e); }
  }

  function renderSettings() {
    if (!state.ai.config) {
      return h("div", {class:"err-pane"}, h("div", {}, "加载配置中…"));
    }
    const cfg = state.ai.config;
    const draft = state.ai.configDraft;
    const presets = cfg.presets || {};
    const wrap = document.createDocumentFragment();

    wrap.appendChild(h("div", {class:"settings-hd"},
      h("h2", {class:"settings-title"}, "AI 服务配置"),
      h("p", {class:"settings-sub"},
        "选好服务商后，「完成页」、「批量队列」、「历史」三处的「✨ AI 整理」就能用。"),
    ));

    const body = h("div", {class:"settings-body"});

    // Provider preset
    body.appendChild(h("div", {class:"settings-field"},
      h("label", {}, "服务商预设"),
      h("select", {
        class:"settings-input",
        onChange: (e) => {
          const k = e.target.value;
          const p = presets[k];
          draft.provider = k;
          state.ai.useCustomModel = false;   // 切服务商时回到下拉模式
          if (p) {
            if (p.base_url) draft.base_url = p.base_url;
            if (p.model)    draft.model    = p.model;
          }
          render();
        }
      },
        Object.entries(presets).map(([k, p]) =>
          h("option", {value:k, selected: draft.provider === k}, p.label)
        )
      ),
    ));

    // Base URL
    body.appendChild(h("div", {class:"settings-field"},
      h("label", {}, "Base URL",
        h("span", {class:"settings-hint"}, " — DeepSeek 用 https://api.deepseek.com/v1；Anthropic 用 https://api.anthropic.com")),
      h("input", {
        type:"text", class:"settings-input",
        value: draft.base_url || "",
        placeholder:"https://api.deepseek.com/v1",
        onInput: (e) => { draft.base_url = e.target.value; }
      }),
    ));

    // API Key
    body.appendChild(h("div", {class:"settings-field"},
      h("label", {}, "API Key",
        cfg.has_key ? h("span", {class:"settings-hint"}, ` — 已保存（${cfg.api_key_masked}），留空表示沿用`) : null),
      h("input", {
        type:"password", class:"settings-input",
        value: draft.api_key || "",
        placeholder: cfg.has_key ? "（已保存，留空沿用旧值）" : "sk-...",
        onInput: (e) => { draft.api_key = e.target.value; }
      }),
    ));

    // Model — dropdown of presets when available + custom override
    const modelList = (cfg.models || {})[draft.provider] || [];
    const knownIds = new Set(modelList.map(m => m.id));
    const isCustomModel = draft.model && !knownIds.has(draft.model);
    const customSelected = state.ai.useCustomModel || isCustomModel;
    const selectedInfo = modelList.find(m => m.id === draft.model);

    if (modelList.length > 0) {
      body.appendChild(h("div", {class:"settings-field"},
        h("label", {}, "模型",
          selectedInfo ? h("span", {class:"settings-hint"}, ` — ${selectedInfo.desc}`) : null),
        h("select", {
          class:"settings-input",
          onChange: (e) => {
            const v = e.target.value;
            if (v === "__custom__") {
              state.ai.useCustomModel = true;
            } else {
              state.ai.useCustomModel = false;
              draft.model = v;
            }
            render();
          }
        },
          modelList.map(m =>
            h("option", {value: m.id, selected: !customSelected && draft.model === m.id},
              `${m.label}  —  ${m.desc}`)
          ),
          h("option", {value:"__custom__", selected: customSelected}, "其他 · 手动输入模型 ID...")
        ),
      ));
      if (customSelected) {
        body.appendChild(h("div", {class:"settings-field"},
          h("input", {
            type:"text", class:"settings-input",
            value: draft.model || "",
            placeholder:"输入模型 ID（如新发布的预览版还未列入预设）",
            onInput: (e) => { draft.model = e.target.value; }
          }),
        ));
      }
    } else {
      body.appendChild(h("div", {class:"settings-field"},
        h("label", {}, "模型",
          h("span", {class:"settings-hint"},
            draft.provider === "ollama"
              ? " — 填 `ollama list` 显示的本地模型名，如 llama3.1 / qwen3 / deepseek-r1"
              : " — 输入 OpenAI 兼容服务的模型 ID")),
        h("input", {
          type:"text", class:"settings-input",
          value: draft.model || "",
          placeholder: draft.provider === "ollama" ? "llama3.1" : "model-id",
          onInput: (e) => { draft.model = e.target.value; }
        }),
      ));
    }

    // Test + Save
    const actionRow = h("div", {class:"settings-actions"});
    actionRow.appendChild(h("button", {
      class:"btn-secondary",
      disabled: state.ai.testing,
      onClick: handleTestAI,
    }, icon("Sparkle",{size:14}), state.ai.testing ? "测试中…" : "测试连接"));
    actionRow.appendChild(h("button", {
      class:"btn-primary", style:{width:"auto", padding:"0 22px", height:36, fontSize:13, boxShadow:"none"},
      onClick: handleSaveAI,
    }, icon("Check",{size:14}), "保存"));
    actionRow.appendChild(h("div", {style:{flex:1}}));
    if (state.ai.testResult) {
      const r = state.ai.testResult;
      actionRow.appendChild(h("div", {
        class: `settings-test-result ${r.ok ? "ok" : "err"}`,
      }, r.ok ? `✓ ${(r.reply||"OK").slice(0,80)}` : `✗ ${(r.error||"测试失败").slice(0,120)}`));
    }
    body.appendChild(actionRow);

    // ---- Download settings ----
    body.appendChild(h("div", {class:"settings-section-hd"}, "下载视频",
      h("span", {class:"settings-hint"}, " — 在「下载视频」模式下生效")));
    const dls = state.dl.settings || {save_dir: "~/Movies/拾字", name_template: "{title}_{uploader}_{id}"};
    body.appendChild(h("div", {class:"settings-field"},
      h("label", {}, "视频保存位置",
        h("span", {class:"settings-hint"}, " — 支持 ~ 展开到 HOME")),
      h("input", {
        type:"text", class:"settings-input",
        value: dls.save_dir, id: "dl-save-dir",
        placeholder:"~/Movies/拾字",
      }),
    ));
    body.appendChild(h("div", {class:"settings-field"},
      h("label", {}, "命名模板",
        h("span", {class:"settings-hint"}, " — 变量：{title} / {uploader} / {id} / {ext}（自动加扩展名）")),
      h("input", {
        type:"text", class:"settings-input",
        value: dls.name_template, id: "dl-name-template",
        placeholder:"{title}_{uploader}_{id}",
      }),
    ));
    body.appendChild(h("button", {
      class:"btn-secondary", style:{alignSelf:"flex-start"},
      onClick: async () => {
        const saveDir = document.getElementById("dl-save-dir").value;
        const tmpl    = document.getElementById("dl-name-template").value;
        try {
          await api.dlSettingsSet({save_dir: saveDir, name_template: tmpl});
          await loadDlSettings();
          const toast = h("div", {style:{
            position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
            background:"var(--ranepa-green)", color:"white",
            padding:"10px 18px", borderRadius:8, fontSize:13, zIndex:9999,
            boxShadow:"var(--shadow-pop)"
          }}, "✓ 已保存下载设置");
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 1400);
        } catch (e) { alert("保存失败：" + e); }
      }
    }, icon("Check",{size:14}), "保存下载设置"));

    // Prompts editor (collapsed sections)
    body.appendChild(h("div", {class:"settings-section-hd"}, "Prompt 模板",
      h("span", {class:"settings-hint"}, " — 默认值已经够用，需要个性化可在此修改")));
    const modes = [
      {k:"smart-doc", l:"整理文档"},
      {k:"notes",     l:"学习笔记"},
      {k:"qa",        l:"Q&A 卡片"},
      {k:"mindmap",   l:"思维导图"},
    ];
    modes.forEach(m => {
      body.appendChild(h("div", {class:"settings-field"},
        h("label", {}, m.l, h("span", {class:"settings-hint"}, ` — 占位符 {TEXT} 会被转录原文替换`)),
        h("textarea", {
          class:"settings-input", rows: 5,
          value: draft.prompts[m.k] || "",
          onInput: (e) => { draft.prompts[m.k] = e.target.value; }
        }),
      ));
    });

    wrap.appendChild(body);

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0, overflowY:"auto"}});
    container.appendChild(wrap);
    return container;
  }

  async function handleTestAI() {
    const d = state.ai.configDraft;
    if (!d.base_url || !d.model) { alert("Base URL 和 模型 都要填"); return; }
    state.ai.testing = true; state.ai.testResult = null; render();
    try {
      const r = await api.testAI({
        provider: d.provider, base_url: d.base_url,
        api_key: d.api_key || "**保留原值**", model: d.model,
      });
      state.ai.testResult = r;
    } catch (e) {
      state.ai.testResult = {ok:false, error: String(e)};
    } finally {
      state.ai.testing = false; render();
    }
  }

  async function handleSaveAI() {
    const d = state.ai.configDraft;
    if (!d.base_url || !d.model) { alert("Base URL 和 模型 都要填"); return; }
    try {
      await api.saveAIConfig({
        provider: d.provider, base_url: d.base_url,
        api_key: d.api_key || "**保留原值**", model: d.model,
        prompts: d.prompts,
      });
      // Reload
      state.ai.config = null;
      await loadAIConfig(true);
      // Mini toast
      const toast = h("div", {style:{
        position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
        background:"var(--ranepa-green)", color:"white",
        padding:"10px 18px", borderRadius:8, fontSize:13, zIndex:9999,
        boxShadow:"var(--shadow-pop)"
      }}, "✓ 已保存");
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 1400);
    } catch (e) {
      alert("保存失败：" + JSON.stringify(e));
    }
  }

  // ============================================================
  // AI: organize view
  // ============================================================
  const MODE_LABELS = {
    "smart-doc": {label: "整理文档", ic: "Doc",       desc: "去口语化 · 分章节 · 时间戳标注"},
    "notes":     {label: "学习笔记", ic: "Notes",     desc: "要点 + 关键词 + 一句话总结"},
    "qa":        {label: "Q&A 卡片", ic: "Clipboard", desc: "问答对，可导入 Anki"},
    "mindmap":   {label: "思维导图", ic: "MindMap",   desc: "Markdown 缩进树"},
  };

  function renderAIOrganize() {
    const a = state.ai;
    const m = MODE_LABELS[a.organizeMode] || MODE_LABELS["smart-doc"];
    const src = a.organizeSource || {};
    const wrap = document.createDocumentFragment();

    // Header
    wrap.appendChild(h("div", {class:"complete-hd", style:{padding:"18px 28px"}},
      h("div", {class:"complete-thumb ai-thumb"},
        h("span", {class:"ai-text-badge on-accent lg"}, "AI"),
      ),
      h("div", {class:"complete-info"},
        h("div", {class:"complete-title"},
          `${m.label} · ${(src.title || "").slice(0, 40)}`),
        h("div", {class:"complete-meta"},
          a.organizeMeta ? h("span", {}, `${a.organizeMeta.provider} · ${a.organizeMeta.model}`) : h("span", {}, "等待 AI 响应…"),
          h("span", {class:"dot"}, "·"),
          h("span", {}, m.desc),
          a.organizing ? [h("span", {class:"dot"}, "·"), h("span", {style:{color:"var(--accent)"}}, "生成中")] : null,
        ),
      ),
      h("div", {class:"complete-actions"},
        h("button", {class:"btn-secondary", disabled: !a.organizeText, onClick: () => copyText(a.organizeText)},
          icon("Copy",{size:13}), "复制 Markdown"),
        h("button", {class:"btn-secondary", disabled: !a.organizeText, onClick: () => downloadAsFile(a.organizeText, `${(src.title || "ai").slice(0,40)}.${a.organizeMode}.md`, "text/markdown")},
          icon("Download",{size:13}), "下载 .md"),
        a.organizing
          ? h("button", {class:"btn-secondary", style:{color:"var(--accent)", borderColor:"var(--accent)"}, onClick: handleAIOrganizeCancel},
              icon("Stop",{size:13}), "停止")
          : h("button", {class:"btn-secondary", style:{color:"var(--accent)", borderColor:"var(--accent)"}, onClick: () => handleAIOrganize(src.job_id, a.organizeMode, src.title)},
              "重新生成"),
      ),
    ));

    // Mode tabs
    wrap.appendChild(h("div", {class:"tabs"},
      Object.entries(MODE_LABELS).map(([k, info]) =>
        h("div", {
          class: `tab ${a.organizeMode === k ? "is-on" : ""}`,
          onClick: () => { if (!a.organizing) handleAIOrganize(src.job_id, k, src.title); }
        }, icon(info.ic, {size:13}), info.label)
      ),
      h("div", {style:{flex:1}}),
      h("div", {class:"tab", onClick: () => goBackFromAI()}, icon("Close",{size:13}), "关闭")
    ));

    // Body: rendered Markdown
    const md = h("div", {class:"ai-doc"});
    if (a.organizeError) {
      md.innerHTML = `<div class="ai-error">⚠ ${escapeHtml(a.organizeError)}</div>`;
    } else if (!a.organizeText && !a.organizing) {
      md.innerHTML = `<div style="color:var(--fg-3); padding:32px; text-align:center;">点击上方任一标签开始整理</div>`;
    } else {
      md.innerHTML = renderMarkdown(a.organizeText) + (a.organizing ? '<span class="ai-cursor">▍</span>' : "");
    }
    wrap.appendChild(md);

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  function goBackFromAI() {
    handleAIOrganizeCancel();
    state.flow = state.job?.status === "done" ? "complete" : (state.batch ? "batch" : "empty");
    render();
  }

  async function handleAIOrganize(jobIdOrText, mode, title) {
    // Check config first
    if (!state.ai.config) await loadAIConfig(true);
    if (!state.ai.config || !state.ai.config.has_key) {
      if (confirm("还没配置 AI Key。去「设置」配置？")) {
        state.view = "settings"; render();
      }
      return;
    }
    state.flow = "ai-organizing";
    state.ai.organizing = true;
    state.ai.organizeText = "";
    state.ai.organizeError = null;
    state.ai.organizeMode = mode || "smart-doc";
    state.ai.organizeMeta = null;
    state.ai.organizeSource = {job_id: typeof jobIdOrText === "string" && !jobIdOrText.includes("\n") ? jobIdOrText : null,
                                title: title};
    const body = typeof jobIdOrText === "string" && jobIdOrText.includes("\n")
      ? {text: jobIdOrText, mode: state.ai.organizeMode, title}
      : {job_id: jobIdOrText, mode: state.ai.organizeMode, title};
    state.ai.organizeAbort = new AbortController();
    render();

    streamPostSSE("/api/ai/organize", body, {
      meta: (d) => { state.ai.organizeMeta = d; render(); },
      token: (d) => {
        state.ai.organizeText += d.text || "";
        // patch body only without full re-render for speed
        const md = document.querySelector(".ai-doc");
        if (md) md.innerHTML = renderMarkdown(state.ai.organizeText) + (state.ai.organizing ? '<span class="ai-cursor">▍</span>' : "");
      },
      error: (d) => { state.ai.organizeError = d.error || String(d); state.ai.organizing = false; render(); },
      done: () => { state.ai.organizing = false; render(); },
      end:  () => { state.ai.organizing = false; render(); },
    }, state.ai.organizeAbort.signal).catch(e => {
      if (e.name !== "AbortError") {
        state.ai.organizeError = String(e); state.ai.organizing = false; render();
      }
    });
  }

  function handleAIOrganizeCancel() {
    if (state.ai.organizeAbort) {
      try { state.ai.organizeAbort.abort(); } catch (e) {}
      state.ai.organizeAbort = null;
    }
    state.ai.organizing = false;
  }

  function downloadAsFile(text, filename, mime) {
    const blob = new Blob([text], {type: mime || "text/plain"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  // ============================================================
  // Tweaks
  // ============================================================
  function renderTweaksFAB() {
    return h("button", {
      class:"tweaks-fab",
      onClick: () => { state.tweaksOpen = !state.tweaksOpen; render(); }
    }, icon("Cog",{size:18}), "偏好设置");
  }
  function renderTweaksPanel() {
    const close = () => { state.tweaksOpen = false; render(); };
    const panel = h("div", {class:"tweaks-panel"},
      h("div", {class:"tweaks-hd"},
        h("div", {}, "偏好设置"),
        h("button", {class:"btn-ghost", onClick: close}, icon("Close",{size:14}))
      ),
      h("div", {class:"tweaks-body"},
        // Theme
        h("div", {class:"tweaks-section"},
          h("div", {class:"tweaks-section-hd"}, "主题"),
          renderSeg([{k:"light", l:"浅色"}, {k:"dark", l:"深色"}], state.tweaks.theme, v => { state.tweaks.theme = v; applyTweaks(); render(); }),
          h("div", {class:"tweaks-row"},
            h("div", {class:"tweaks-label"}, "主题色"),
            h("div", {class:"tweaks-colors"},
              ["#A30236","#061A6C","#1F2937"].map(c =>
                h("button", {
                  class:`tone-swatch ${state.tweaks.accent === c ? "is-on" : ""}`,
                  style:{background: c},
                  onClick: () => { state.tweaks.accent = c; applyTweaks(); render(); }
                })
              )
            )
          ),
        ),
        // Typography
        h("div", {class:"tweaks-section"},
          h("div", {class:"tweaks-section-hd"}, "字号"),
          // UI scale
          h("div", {class:"tweaks-row"},
            h("div", {class:"tweaks-label"}, "界面字号"),
            h("input", {
              type:"range", min:80, max:150, step:5,
              value: Math.round(state.tweaks.uiScale * 100),
              onInput: (e) => {
                state.tweaks.uiScale = e.target.value / 100;
                applyTweaks();
                const v = document.getElementById("ui-scale-val");
                if (v) v.textContent = `${Math.round(state.tweaks.uiScale * 100)}%`;
              }
            }),
            h("div", {class:"tweaks-value", id:"ui-scale-val"}, `${Math.round(state.tweaks.uiScale * 100)}%`),
          ),
          // Text scale
          h("div", {class:"tweaks-row"},
            h("div", {class:"tweaks-label"}, "转录文本"),
            h("input", {
              type:"range", min:80, max:200, step:5,
              value: Math.round(state.tweaks.textScale * 100),
              onInput: (e) => {
                state.tweaks.textScale = e.target.value / 100;
                applyTweaks();
                const v = document.getElementById("text-scale-val");
                if (v) v.textContent = `${Math.round(state.tweaks.textScale * 100)}%`;
              }
            }),
            h("div", {class:"tweaks-value", id:"text-scale-val"}, `${Math.round(state.tweaks.textScale * 100)}%`),
          ),
          // Reset button
          h("button", {
            class:"btn-ghost",
            style:{fontSize:11, alignSelf:"flex-start", padding:"4px 8px", marginTop:2},
            onClick: () => {
              state.tweaks.uiScale = 1;
              state.tweaks.textScale = 1;
              applyTweaks();
              render();
            }
          }, "↺ 重置字号"),
        ),
        // Density
        h("div", {class:"tweaks-section"},
          h("div", {class:"tweaks-section-hd"}, "排版密度"),
          renderSeg([{k:"comfy", l:"舒适"}, {k:"compact", l:"紧凑"}], state.tweaks.density, v => { state.tweaks.density = v; applyTweaks(); render(); }),
        ),
        // Advanced
        h("div", {class:"tweaks-section"},
          h("div", {class:"tweaks-section-hd"}, "界面"),
          h("div", {class:"tweaks-row"},
            h("div", {class:"tweaks-label"}, "默认展开高级选项"),
            (() => {
              const s = h("span", {class:`switch ${state.showAdvanced ? "is-on" : ""}`,
                onClick: () => { state.showAdvanced = !state.showAdvanced; render(); }});
              return s;
            })(),
          ),
        ),
      )
    );
    return panel;
  }

  // ============================================================
  // Event handlers
  // ============================================================
  function _routeErrorFlow(kind) {
    // 需要 cookies 帮助的错误 → 走 err-login（带浏览器选择栅格）
    if (kind === "login_required" || kind === "rate_limited") return "err-login";
    return "err-invalid";
  }

  function _readableError(err) {
    // err 可能是：HTTPException detail、Error 实例、普通对象、字符串
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    if (err.detail?.msg) return err.detail.msg;
    if (err.msg) return err.msg;
    if (err.message) return err.message;
    if (err instanceof Error) return err.toString();
    try {
      const s = JSON.stringify(err);
      return s === "{}" ? "未知错误（无详情）" : s;
    } catch { return String(err); }
  }

  async function handleProbe() {
    if (!state.url || !state.url.trim()) return;
    if (state.mode === "download") {
      try {
        state.dl.probe = null;
        const info = await api.dlProbe(state.url.trim(), state.advanced?.cookiesBrowser);
        state.dl.probe = info;
        state.dl.selectedTier = info.tiers?.find(t => t.recommended) || info.tiers?.[info.tiers.length - 1] || null;
        state.flow = "dl-detected";
        render();
      } catch (err) {
        const kind = err.kind || "other";
        state.flow = _routeErrorFlow(kind);
        const errInfo = {
          error: err.msg || "未知错误",
          error_kind: kind,
          scannable: !!err.scannable,
          url_type: err.type || null,
        };
        state.dl.job = {...errInfo};
        state.job    = {...errInfo};  // err-invalid 读 state.job
        render();
      }
      return;
    }
    try {
      state.probe = null;
      const info = await api.probe(state.url.trim());
      state.probe = info;
      if (info.is_collection && info.parts && info.parts.length > 0) {
        state.flow = "collection";
        state.selectedEpisodes = info.parts.map((_, i) => i);
      } else {
        state.flow = "filled";
      }
      render();
    } catch (err) {
      const kind = err.kind || "other";
      state.flow = _routeErrorFlow(kind);
      state.job = {
        error: err.msg || "未知错误",
        error_kind: kind,
        scannable: !!err.scannable,
        url_type: err.type || null,
      };
      render();
    }
  }

  // ============================================================
  // 手动粘贴多条链接 — 绕开 B 站 412/352 风控的逃生通道
  // ============================================================
  function parseManualUrls(text) {
    const lines = String(text || "").split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const raw of lines) {
      // BV / av / YouTube / 完整 URL
      let id = "";
      let url = "";
      let title = "";
      const bvMatch = raw.match(/(BV[0-9A-Za-z]{10})/);
      const avMatch = raw.match(/\bav(\d{4,})/i);
      const ytMatch = raw.match(/[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/);
      const bvBare  = /^BV[0-9A-Za-z]{10}$/.test(raw);
      if (bvBare) {
        id = raw; url = `https://www.bilibili.com/video/${raw}`; title = raw;
      } else if (raw.startsWith("http")) {
        url = raw;
        id = bvMatch?.[1] || avMatch?.[0] || ytMatch?.[1] || ytMatch?.[2] || raw.split("/").filter(Boolean).pop() || raw;
        title = id;
      } else if (bvMatch) {
        id = bvMatch[1]; url = `https://www.bilibili.com/video/${id}`; title = id;
      } else if (avMatch) {
        id = avMatch[0]; url = `https://www.bilibili.com/video/${id}`; title = id;
      } else {
        // 跳过无法解析的行
        continue;
      }
      out.push({id, url, title, duration: null, thumbnail: null});
    }
    // 去重
    const seen = new Set();
    return out.filter(v => {
      const k = v.url || v.id;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  function renderManualPaste() {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(h("div", {style:{padding:"24px 32px 16px", borderBottom:"var(--border-hair)"}},
      h("h2", {style:{fontFamily:"var(--font-display)", fontSize:22, fontWeight:700, margin:"0 0 8px"}},
        "手动粘贴 · 跳过扫描"),
      h("p", {style:{fontSize:13, color:"var(--fg-3)", lineHeight:1.7, margin:0}},
        "如果 B 站扫描反复触发风控（412/352），可以在 浏览器里打开 UP 主主页，把想要的视频链接逐条复制下来粘到这里。每行一条，可以是完整 URL，也可以只是 BV 号。"),
    ));

    const ta = h("textarea", {
      id:"manual-urls-ta",
      placeholder: "BV1xxxxxxxx\nhttps://www.bilibili.com/video/BV1yyyyyyy\nav123456\nhttps://www.youtube.com/watch?v=abc123\n…",
      value: state.manualPasteText || "",
      onInput: (e) => { state.manualPasteText = e.target.value; updateManualPasteCount(); },
      style:{
        flex:1, minHeight:200, padding:"14px 18px",
        background:"var(--bg-muted)", border:"1.5px solid transparent",
        borderRadius:"var(--radius-md)",
        fontFamily:"var(--font-mono)", fontSize:13, lineHeight:1.6,
        color:"var(--fg-1)", outline:"none", resize:"vertical",
      },
    });

    const bodyWrap = h("div", {style:{padding:"18px 32px", display:"flex", flexDirection:"column", gap:12, flex:1, minHeight:0}});
    bodyWrap.appendChild(ta);
    bodyWrap.appendChild(h("div", {style:{display:"flex", alignItems:"center", gap:12, fontSize:12, color:"var(--fg-3)"}},
      h("span", {id:"manual-paste-count"}, "尚未粘贴"),
      h("div", {style:{flex:1}}),
      h("span", {}, "支持：B 站 BV/av · YouTube · 任意 yt-dlp 支持的 URL"),
    ));
    bodyWrap.appendChild(h("div", {style:{display:"flex", gap:10}},
      h("button", {class:"btn-secondary", onClick: () => {
        state.flow = state.url ? "err-invalid" : "empty";
        render();
      }}, "取消"),
      h("div", {style:{flex:1}}),
      h("button", {class:"btn-primary", style:{width:"auto", padding:"0 22px", height:38, fontSize:13},
        onClick: handleManualConfirm,
      }, icon("Check",{size:14}), "继续 · 进入挑选"),
    ));

    wrap.appendChild(bodyWrap);

    setTimeout(updateManualPasteCount, 0);
    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }
  function updateManualPasteCount() {
    const el = document.getElementById("manual-paste-count");
    if (!el) return;
    const items = parseManualUrls(state.manualPasteText || "");
    el.textContent = items.length ? `已识别 ${items.length} 条`
                                  : (state.manualPasteText ? "无法识别，请检查格式" : "尚未粘贴");
    el.style.color = items.length ? "var(--ranepa-green)" : (state.manualPasteText ? "var(--ranepa-orange)" : "var(--fg-3)");
  }
  function handleManualConfirm() {
    const vids = parseManualUrls(state.manualPasteText || "");
    if (vids.length === 0) { alert("至少粘一条有效的 BV 号或视频 URL"); return; }
    state.channel.probe = {
      channel: {
        name: "手动收集",
        id: "manual",
        url: "manual://",
        platform: vids[0].url?.includes("bilibili") ? {name:"Bilibili", kind:"bili", color:"#FB7299"}
                : vids[0].url?.includes("youtube") || vids[0].url?.includes("youtu.be") ? {name:"YouTube", kind:"yt", color:"#FF0000"}
                : {name:"多平台", kind:"local", color:"#6D6D75"},
        total: vids.length,
      },
      videos: vids,
      limited_to: vids.length,
      has_more: false,
    };
    state.channel.selected = vids.map((_, i) => i);
    state.flow = "channel-detect";
    render();
  }

  // ============================================================
  // 渲染：channel-detect — UP 主主页/播放列表/收藏夹的批量挑选界面
  // ============================================================
  function renderChannelDetect() {
    const probe = state.channel.probe;
    if (!probe) return renderEmpty();
    const vids = probe.videos || [];
    const ch = probe.channel || {};
    const selected = state.channel.selected;
    const allOn = selected.length === vids.length && vids.length > 0;
    const wrap = document.createDocumentFragment();

    // Header
    const platformBg = ch.platform?.kind === "yt" ? "linear-gradient(135deg, #FF0000, #8B0000)"
                     : ch.platform?.kind === "tw" ? "linear-gradient(135deg, #1DA1F2, #000)"
                     : "linear-gradient(135deg, #00AEEC, #FB7299)";
    wrap.appendChild(h("div", {class:"coll-hd"},
      h("div", {class:"coll-cover", style:{background: platformBg}},
        h("div", {class:"ep-badge"}, `${vids.length}${probe.has_more ? "+" : ""} 个视频`)),
      h("div", {class:"coll-info"},
        h("div", {class:"coll-eyebrow"}, icon("Search",{size:11}), `${ch.platform?.name || ""} · 已扫描`),
        h("h2", {class:"coll-title"}, ch.name || "(无名)"),
        h("div", {class:"coll-meta"},
          ch.id ? `ID: ${ch.id} · ` : "",
          `已列出 ${vids.length} 条${probe.has_more ? `（仅前 ${probe.limited_to} 条，再扫描可加载更多）` : ""}`,
        ),
      ),
    ));

    // Toolbar
    const toolbar = h("div", {class:"coll-toolbar"},
      (() => {
        const cb = h("div", {class:`checkbox ${allOn ? "is-on" : ""}`,
          onClick: () => { state.channel.selected = allOn ? [] : vids.map((_, i) => i); render(); }});
        if (allOn) cb.appendChild(icon("Check",{size:10, stroke:3}));
        return cb;
      })(),
      h("div", {class:"sel-label", html: `已选 <b>${selected.length}</b> / ${vids.length}`}),
      h("button", {class:"btn-ghost", onClick: () => { state.channel.selected = vids.map((_, i) => i); render(); }}, "全选"),
      h("button", {class:"btn-ghost", onClick: () => {
        state.channel.selected = vids.map((_, i) => i).filter(i => !selected.includes(i));
        render();
      }}, "反选"),
      h("button", {class:"btn-ghost", onClick: () => { state.channel.selected = []; render(); }}, "清空"),
      h("div", {style:{flex:1}}),
      // 重新扫描
      h("button", {class:"btn-ghost", title:"重新扫描这个页面",
        onClick: handleScanChannel,
        disabled: state.channel.scanning,
      }, icon("Search",{size:12}), state.channel.scanning ? "扫描中…" : "重新扫描"),
    );
    wrap.appendChild(toolbar);

    // List
    const list = h("div", {class:"coll-list"});
    vids.forEach((v, i) => {
      const sel = selected.includes(i);
      const hueSeed = (i + 1) * 37 % 360;
      const row = h("div", {class:`ep-row ${sel ? "is-selected" : ""}`,
        onClick: () => {
          if (sel) state.channel.selected = selected.filter(x => x !== i);
          else state.channel.selected = [...selected, i];
          render();
        }
      });
      const cb = h("div", {class:`checkbox ${sel ? "is-on" : ""}`});
      if (sel) cb.appendChild(icon("Check",{size:10, stroke:3}));
      row.appendChild(cb);
      row.appendChild(h("div", {class:"ep-num"}, String(i + 1).padStart(2, "0")));
      // 缩略图 — 用真实 thumbnail，没有就走渐变占位
      const thumb = h("div", {class:"ep-thumb",
        style: v.thumbnail
          ? {background: `#000 center/cover url("${v.thumbnail}")`}
          : {background: `linear-gradient(135deg, hsl(${hueSeed},60%,55%), hsl(${(hueSeed+60)%360},70%,45%))`}
      });
      if (v.duration) thumb.appendChild(h("div", {class:"dur"}, fmtDuration(v.duration)));
      row.appendChild(thumb);
      // 标题如果就是 BV/视频 ID，则只显示 ID（避免「BV1xxx / BV1xxx」重复）
      const titleIsId = v.title && v.id && v.title === v.id;
      row.appendChild(h("div", {},
        h("div", {class:"ep-title", style: titleIsId ? {fontFamily:"var(--font-mono)", color:"var(--fg-2)"} : null},
          titleIsId ? v.id : v.title),
        h("div", {class:"ep-sub"},
          titleIsId
            ? h("span", {style:{color:"var(--ranepa-orange)"}}, "扫描没拿到标题，开始处理时再取")
            : (v.upload_date ? h("span", {}, formatUploadDate(v.upload_date)) : null),
          v.view_count && !titleIsId ? h("span", {}, `· ${Number(v.view_count).toLocaleString()} 观看`) : null,
          !titleIsId && v.id ? h("span", {style:{fontFamily:"var(--font-mono)", color:"var(--fg-4)"}}, `· ${v.id}`) : null,
        ),
      ));
      row.appendChild(h("div", {class:"ep-sub", style:{margin:0, fontFamily:"var(--font-mono)"}},
        v.duration ? fmtDuration(v.duration) : "—"));
      row.appendChild(h("div", {style:{color:"var(--fg-4)"}}, "···"));
      list.appendChild(row);
    });
    wrap.appendChild(list);

    // 下载模式：画质上限选择
    if (state.mode === "download") {
      wrap.appendChild(h("div", {class:"output-mode-strip", style:{padding:"14px 28px"}},
        h("div", {class:"output-mode-hd"}, "画质上限（按视频实际可用挑最佳）"),
        h("div", {style:{display:"flex", gap:8}},
          [
            {v: 720,  l: "720P"},
            {v: 1080, l: "1080P · 默认"},
            {v: 2160, l: "4K"},
            {v: 9999, l: "不限"},
          ].map(o => h("button", {
            class: `seg-opt ${state.channel.qualityMax === o.v ? "is-on" : ""}`,
            style:{flex:"none", padding:"8px 16px", height:34, borderRadius:"var(--radius-md)", border:"1px solid var(--ranepa-line)"},
            onClick: () => { state.channel.qualityMax = o.v; render(); }
          }, o.l)),
        ),
      ));
    }

    // Footer: 估时 + 主按钮
    const totalDur = selected.reduce((s, i) => s + (vids[i]?.duration || 0), 0);
    const isDownload = state.mode === "download";
    const labelMain = isDownload
      ? "开始批量下载"
      : "开始批量转录";
    const etaMin = isDownload
      ? Math.max(1, Math.ceil((totalDur || 0) / 60 / 4))   // 下载粗估 1:4
      : Math.max(1, Math.ceil((totalDur || 0) / 60 / 8));  // 识别 1:8
    wrap.appendChild(h("div", {class:"coll-footer"},
      h("div", {class:"est", html:
        `预计 <b>${selected.length}</b> 个视频`
        + (totalDur ? ` · 总时长 <b>${fmtDuration(totalDur)}</b>` : "")
        + ` · ${isDownload ? "估算" : "预计耗时"} <b>约 ${etaMin} 分钟</b><br/>
        <span style="color:var(--fg-4); font-size:11px;">
        ${isDownload
          ? `画质上限 ${state.channel.qualityMax >= 9999 ? "不限" : state.channel.qualityMax + "P"} · 保存到 ${state.dl.settings?.save_dir || "~/Movies/拾字"}`
          : `mlx-whisper ${state.model} · ${state.lang === "auto" ? "自动语言检测" : state.lang}`
        }
        </span>`}),
      h("button", {class:"btn-go",
        disabled: selected.length === 0,
        onClick: handleStartChannelBatch,
      }, icon(isDownload ? "Download" : "Play", {size:13}), labelMain),
    ));

    const container = h("div", {style:{display:"flex", flexDirection:"column", height:"100%", minHeight:0}});
    container.appendChild(wrap);
    return container;
  }

  // ============================================================
  // Channel / playlist scan (UP 主主页、播放列表批量)
  // ============================================================
  async function handleScanChannel() {
    if (!state.url) return;
    // 记下"这是个频道/列表"，扫描失败时让重试按钮还能找回扫描动作
    const priorUrlType = state.job?.url_type || "channel";
    state.channel.scanning = true;
    state.channel.probe = null;
    state.channel.selected = [];
    render();
    try {
      const data = await api.channelProbe(
        state.url.trim(),
        state.advanced?.cookiesBrowser || null,
        50,
      );
      state.channel.probe = data;
      // 默认全选前 10 条
      state.channel.selected = data.videos.slice(0, 10).map((_, i) => i);
      state.flow = "channel-detect";
    } catch (err) {
      const kind = err.kind || "other";
      state.flow = _routeErrorFlow(kind);
      state.job = {
        error: _readableError(err) || "扫描失败",
        error_kind: kind,
        scannable: true,        // 保留这个标志，让 err-invalid 仍能显示「扫描」按钮
        url_type: priorUrlType, // 让 err-login 的重试按钮知道这是频道，要继续扫描
      };
    } finally {
      state.channel.scanning = false;
      render();
    }
  }

  async function handleStartChannelBatch() {
    const sel = state.channel.selected;
    const vids = state.channel.probe?.videos || [];
    if (sel.length === 0) { alert("至少选一个视频"); return; }
    const urls = sel.map(i => vids[i].url).filter(Boolean);
    if (urls.length === 0) { alert("选中的视频没有有效 URL"); return; }

    if (state.mode === "download") {
      try {
        const r = await api.dlBatch({
          urls,
          height_max: state.channel.qualityMax,
          save_dir: state.dl.settings?.save_dir,
          name_template: state.dl.settings?.name_template,
          extras: state.dl.extras,
          cookies_browser: state.advanced?.cookiesBrowser || null,
        });
        alert(`已加入下载队列：${r.job_ids.length} 个视频\n保存到：${state.dl.settings?.save_dir || "~/Movies/拾字"}\n\n（队列在后台跑，目前没有总览界面，可在终端看 server 日志或检查保存目录）`);
        // 重置回空状态
        state.url = ""; state.channel.probe = null; state.channel.selected = [];
        state.flow = "empty";
        render();
      } catch (err) {
        alert("批量下载启动失败：" + _readableError(err));
      }
    } else {
      // 转录模式：复用现有 batch 逻辑
      try {
        const r = await api.createBatch({
          urls, model: state.model, lang: state.lang, fmt: state.fmt,
          advanced: state.advanced,
        });
        state.batch = {id: r.batch_id, items: urls.map((u, i) => ({
          id: r.job_ids[i], url: u, status: "pending", progress: 0,
          title: vids[sel[i]].title, duration: vids[sel[i]].duration,
        }))};
        state.flow = "batch";
        render();
        openBatchStream(r.batch_id);
      } catch (err) {
        alert("批量转录启动失败：" + _readableError(err));
      }
    }
  }
  function handleLocalFilePick() {
    // 创建隐藏的 file input，触发系统文件选择器
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".mp3,.m4a,.mp4,.wav,.mkv,.webm,.mov,.aac,.flac,.ogg,.opus,.wma,.aif,.aiff,.avi,audio/*,video/*";
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", async () => {
      const file = inp.files?.[0];
      inp.remove();
      if (!file) return;
      await handleLocalFileUpload(file);
    });
    inp.click();
  }

  async function handleLocalFileUpload(file) {
    // 上传 toast
    const toast = h("div", {style:{
      position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
      background:"var(--fg-1)", color:"var(--bg-card)",
      padding:"12px 18px", borderRadius:8, fontSize:13, zIndex:9999,
      boxShadow:"var(--shadow-pop)",
      display:"flex", alignItems:"center", gap:10
    }});
    toast.innerHTML = `<span>上传中… <b id="up-pct">0</b>%</span>`;
    document.body.appendChild(toast);

    try {
      // XHR 用于真实上传进度
      const upRes = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const p = Math.round(e.loaded / e.total * 100);
            const el = document.getElementById("up-pct");
            if (el) el.textContent = p;
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new Error("解析响应失败")); }
          } else {
            reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
          }
        };
        xhr.onerror = () => reject(new Error("网络错误"));
        xhr.open("POST", "/api/upload");
        const fd = new FormData();
        fd.append("file", file);
        xhr.send(fd);
      });
      toast.remove();

      // 上传成功 → 创建本地文件转录任务
      const r = await api.createJob({
        url: "",                       // 没有 URL
        local_file: upRes.path,
        model: state.model,
        lang: state.lang,
        fmt: state.fmt,
        advanced: state.advanced,
      });
      state.url = "📁 " + upRes.name;   // 让 URL 框显示文件名
      state.probe = {
        platform: {name: "本地文件", kind: "local", color: "#6D6D75"},
        title: upRes.title,
        video_id: upRes.name,
        duration: null,
      };
      state.job = {
        id: r.job_id,
        status: "extracting",          // 本地文件跳过下载，直接进 extract 阶段
        stage: "extract",
        progress: 0,
        url: "",
        model: state.model,
        title: upRes.title,
        logs: [],
        segments: []
      };
      state.flow = "extracting";
      render();
      openJobStream(r.job_id);
    } catch (err) {
      toast.remove();
      alert("上传失败：" + err.message);
    }
  }

  async function handleStart() {
    if (!state.url) return;
    try {
      const r = await api.createJob({
        url: state.url,
        model: state.model,
        lang: state.lang,
        fmt: state.fmt,
        advanced: state.advanced,
      });
      state.job = {id: r.job_id, status: "downloading", progress: 0, stage: "download", url: state.url, model: state.model, logs: [], segments: []};
      state.flow = "downloading";
      render();
      openJobStream(r.job_id);
    } catch (err) {
      alert("启动失败：" + _readableError(err));
    }
  }
  async function handleStartBatch() {
    if (state.selectedEpisodes.length === 0 || !state.probe?.parts) return;
    const urls = state.selectedEpisodes.map(i => state.probe.parts[i].url).filter(Boolean);
    if (urls.length === 0) { alert("没有可用的视频链接"); return; }
    try {
      const r = await api.createBatch({
        urls, model: state.model, lang: state.lang, fmt: state.fmt, advanced: state.advanced,
      });
      state.batch = {id: r.batch_id, items: urls.map((u, i) => ({
        id: r.job_ids[i], url: u, status: "pending", progress: 0,
        title: state.probe.parts[state.selectedEpisodes[i]].title,
        duration: state.probe.parts[state.selectedEpisodes[i]].duration,
      }))};
      state.flow = "batch";
      render();
      openBatchStream(r.batch_id);
    } catch (err) {
      alert("启动批量失败：" + _readableError(err));
    }
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      // Tiny toast
      const toast = h("div", {style:{
        position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)",
        background:"var(--fg-1)", color:"var(--bg-card)",
        padding:"10px 16px", borderRadius:8, fontSize:13, zIndex:9999,
        boxShadow:"var(--shadow-pop)"
      }}, "已复制");
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 1400);
    } catch (e) {}
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // ============================================================
  // Init
  // ============================================================
  applyTweaks();

  async function loadDlSettings() {
    try {
      state.dl.settings = await api.dlSettingsGet();
    } catch (e) { state.dl.settings = {save_dir: "~/Movies/拾字", name_template: "{title}_{uploader}_{id}"}; }
  }

  // Auto-load history / AI config / dl settings on first relevant render
  let _lastView = null, _dlSettingsLoaded = false;
  const _origRender = render;
  render = function () {
    if (state.view === "history"  && _lastView !== "history")  loadHistory();
    if (state.view === "settings" && _lastView !== "settings") loadAIConfig();
    if (!_dlSettingsLoaded) { _dlSettingsLoaded = true; loadDlSettings().then(render); }
    _lastView = state.view;
    return _origRender.apply(this, arguments);
  };

  render();
})();
