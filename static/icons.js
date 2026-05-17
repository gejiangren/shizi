// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 gejiangren <https://github.com/gejiangren>
/* 拾字 — Inline SVG icons (vanilla JS port of app-icons.jsx)
   每个 icon 函数返回一个 SVG 元素，或 svg 字符串。
*/

(function () {
  const NS = "http://www.w3.org/2000/svg";

  function svgEl(d, opts = {}) {
    const size = opts.size ?? 16;
    const stroke = opts.stroke ?? 1.75;
    const fill = opts.fill ?? "none";
    const viewBox = opts.viewBox ?? "0 0 24 24";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", fill);
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", stroke);
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (opts.className) svg.setAttribute("class", opts.className);
    if (opts.style) svg.setAttribute("style", opts.style);
    if (typeof d === "string") {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    } else if (Array.isArray(d)) {
      for (const node of d) svg.appendChild(node);
    } else if (d instanceof Node) {
      svg.appendChild(d);
    }
    return svg;
  }

  function path(d, attrs = {}) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    for (const k in attrs) p.setAttribute(k, attrs[k]);
    return p;
  }
  function rect(attrs) {
    const r = document.createElementNS(NS, "rect");
    for (const k in attrs) r.setAttribute(k, attrs[k]);
    return r;
  }
  function poly(points, attrs = {}) {
    const p = document.createElementNS(NS, "polygon");
    p.setAttribute("points", points);
    for (const k in attrs) p.setAttribute(k, attrs[k]);
    return p;
  }
  function g(children, attrs = {}) {
    const e = document.createElementNS(NS, "g");
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    for (const c of children) e.appendChild(c);
    return e;
  }
  function circle(attrs) {
    const c = document.createElementNS(NS, "circle");
    for (const k in attrs) c.setAttribute(k, attrs[k]);
    return c;
  }

  const make = (d) => (opts) => svgEl(d, opts);

  const Icons = {
    Link:     make("M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"),
    Play:     (o) => svgEl(poly("6 4 20 12 6 20 6 4", { fill: "currentColor", stroke: "none" }), o),
    Pause:    (o) => svgEl(g([
                rect({ x: 6, y: 4, width: 4, height: 16, fill: "currentColor", stroke: "none" }),
                rect({ x: 14, y: 4, width: 4, height: 16, fill: "currentColor", stroke: "none" })
              ]), o),
    Stop:     (o) => svgEl(rect({ x: 5, y: 5, width: 14, height: 14, fill: "currentColor", stroke: "none", rx: 2 }), o),
    Download: make("M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"),
    Copy:     make("M9 3h10v14H9zM15 21H5V7"),
    Check:    make("M4 12l5 5L20 6"),
    Close:    make("M5 5l14 14M19 5L5 19"),
    ChevDown: make("M5 9l7 7 7-7"),
    ChevRight:make("M9 5l7 7-7 7"),
    History:  make("M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2"),
    Home:     make("M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"),
    Cog:      make("M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"),
    Waveform: make("M4 12h2M8 8v8M12 5v14M16 9v6M20 12h-2"),
    Doc:      make("M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 13h8M8 17h8M8 9h3"),
    Alert:    make("M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 0 0 1.73 3h16.9a2 2 0 0 0 1.73-3L13.7 3.86a2 2 0 0 0-3.4 0z"),
    Lock:     make("M5 11h14v10H5zM8 11V7a4 4 0 1 1 8 0v4"),
    Search:   make("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3"),
    Upload:   make("M12 21V9m0 0L8 13m4-4l4 4M5 3h14"),
    Trash:    make("M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"),
    Sparkle:  make("M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM5 14l.7 1.5 1.5.7-1.5.7L5 18.4l-.7-1.5L2.8 16l1.5-.7z"),
    Plus:     make("M12 5v14M5 12h14"),
    Clipboard: make("M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z"),
    Notes:     make("M4 6h10M4 12h16M4 18h12M18 6h2M18 12h2M18 18h2"),
    MindMap:  (o) => svgEl(g([
                circle({ cx: 12, cy: 6, r: 2 }),
                circle({ cx: 6, cy: 14, r: 2 }),
                circle({ cx: 18, cy: 14, r: 2 }),
                circle({ cx: 9, cy: 20, r: 1.5 }),
                circle({ cx: 15, cy: 20, r: 1.5 }),
                path("M12 8v3M12 11l-5 2M12 11l5 2M6 16l2 3M18 16l-2 3"),
              ]), o),
  };

  window.Icons = Icons;
  window.iconHTML = (name, opts = {}) => {
    const el = Icons[name](opts);
    return el.outerHTML;
  };
})();
