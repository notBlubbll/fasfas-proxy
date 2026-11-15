// desktop-usage-panel — OpenCode Desktop GUI part.
//
// Adds a "Fasfas usage" tab to the session side region: per-model requests,
// input/output/reasoning/cached tokens, average output TPS and average latency,
// switchable between 24h, 7d, 30d and all time. Data comes from the proxy's
// GET /usage endpoint, polled every 5s.
//
// Loaded by the desktop from this prebuilt CommonJS bundle:
//   Function("require","module","exports", code)(sharedRequire, module, module.exports)
// `@opencode/plugin/gui` and `solid-js` are provided by the app at runtime.
//
// Written with plain DOM (no JSX, no build step): the panel renders a detached
// element once and updates it in place, which needs no Solid reactivity.
const { Plugin, Panel, MenuItem, Command } = require("@opencode/plugin/gui");

const WINDOWS = ["24h", "7d", "30d", "all"];

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function buildPanel(endpoint, refreshMs) {
  const root = document.createElement("div");
  root.style.cssText = [
    "padding:12px",
    "font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif",
    "color:inherit",
    "height:100%",
    "overflow:auto",
    "box-sizing:border-box",
  ].join(";");

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap";

  const heading = document.createElement("div");
  heading.textContent = "Fasfas usage";
  heading.style.cssText = "font-weight:600;font-size:13px;margin-right:auto;letter-spacing:.01em";
  head.appendChild(heading);

  let win = "24h";
  const buttons = {};
  for (const w of WINDOWS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = w;
    b.style.cssText = [
      "padding:2px 8px",
      "border-radius:999px",
      "border:1px solid rgba(127,127,127,.35)",
      "background:transparent",
      "color:inherit",
      "cursor:pointer",
      "font:inherit",
      "line-height:1.6",
    ].join(";");
    b.onclick = () => { win = w; paint(); };
    buttons[w] = b;
    head.appendChild(b);
  }

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.textContent = "↻";
  refreshBtn.title = "Refresh now";
  refreshBtn.setAttribute("aria-label", "Refresh now");
  refreshBtn.style.cssText = [
    "padding:2px 8px",
    "border-radius:999px",
    "border:1px solid rgba(127,127,127,.35)",
    "background:transparent",
    "color:inherit",
    "cursor:pointer",
    "font:inherit",
    "line-height:1.6",
  ].join(";");
  refreshBtn.onclick = () => { refresh(); };
  head.appendChild(refreshBtn);
  root.appendChild(head);

  const summary = document.createElement("div");
  summary.style.cssText = "margin-bottom:10px;opacity:.72;font-variant-numeric:tabular-nums";
  root.appendChild(summary);

  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums";
  root.appendChild(table);

  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:10px;opacity:.5;font-size:11px";
  root.appendChild(footer);

  let data = null;
  let error = null;

  function paint() {
    for (const [k, b] of Object.entries(buttons)) {
      b.style.background = k === win ? "rgba(127,127,127,.22)" : "transparent";
      b.style.fontWeight = k === win ? "600" : "400";
    }

    table.textContent = "";
    if (error) {
      summary.textContent = "";
      footer.textContent = "";
      const row = document.createElement("div");
      row.textContent = "proxy offline: " + error;
      row.style.cssText = "opacity:.7;padding:8px 0";
      table.appendChild(row);
      return;
    }
    if (!data) {
      summary.textContent = "loading…";
      return;
    }

    const w = data.windows && data.windows[win];
    if (!w) {
      summary.textContent = "no data yet for " + win;
      return;
    }

    summary.textContent =
      `${w.requests} requests · ${fmt(w.input)} in · ${fmt(w.output)} out · ` +
      `${fmt(w.cached)} cached · ${w.avgTps} tok/s avg`;

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const cols = ["Model", "Req", "In", "Out", "Reason", "Cached", "tok/s", "avg"];
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c;
      th.style.cssText = [
        "text-align:" + (c === "Model" ? "left" : "right"),
        "padding:4px 6px",
        "border-bottom:1px solid rgba(127,127,127,.28)",
        "font-weight:600",
        "opacity:.75",
        "white-space:nowrap",
      ].join(";");
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const body = document.createElement("tbody");
    const models = (data.models && data.models[win]) || {};
    const rows = Object.entries(models).sort((a, b) => (b[1].output || 0) - (a[1].output || 0));
    for (const [name, m] of rows) {
      const tr = document.createElement("tr");
      const values = [
        name,
        String(m.requests),
        fmt(m.input),
        fmt(m.output),
        fmt(m.reasoning),
        fmt(m.cached),
        String(m.avgTps),
        m.avgMs + "ms",
      ];
      values.forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v;
        td.style.cssText = [
          "text-align:" + (i === 0 ? "left" : "right"),
          "padding:4px 6px",
          "border-bottom:1px solid rgba(127,127,127,.12)",
          "white-space:nowrap",
          i === 0 ? "max-width:150px;overflow:hidden;text-overflow:ellipsis" : "",
        ].join(";");
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    table.appendChild(body);

    footer.textContent = `auto ${Math.round(refreshMs / 1000)}s · updated ${new Date(data.updated || Date.now()).toLocaleTimeString()}`;
  }

  const born = Date.now();
  let inFlight = false;
  async function refresh() {
    if (!root.isConnected && Date.now() - born > 15000) { clearInterval(timer); return; }
    if (inFlight) return;
    inFlight = true;
    refreshBtn.style.opacity = ".45";
    refreshBtn.textContent = "…";
    try {
      const r = await fetch(endpoint, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
      error = null;
    } catch (e) {
      error = (e && e.message) || "unreachable";
    } finally {
      inFlight = false;
      refreshBtn.style.opacity = "1";
      refreshBtn.textContent = "↻";
    }
    paint();
  }

  const timer = setInterval(refresh, refreshMs);
  paint();
  refresh();
  return root;
}

module.exports = {
  default: Plugin.define({
    i18n: { en: { title: "Fasfas usage" } },
    setup(ctx) {
      const endpoint = (ctx.options && ctx.options.usageEndpoint) || "http://127.0.0.1:17331/usage";
      const refreshMs = Math.max(1000, Number(ctx.options && ctx.options.refreshMs) || 5000);
      const key = `${ctx.id}:usage`;

      const tab = {
        id: "usage",
        get title() { return ctx.t("title"); },
        closable: "compact",
        fallback: true,
      };

      const open = () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open(key, session);
      };

      ctx.add(Panel, {
        id: "usage",
        region: "side",
        width: "narrow",
        mobile: {
          get title() { return ctx.t("title"); },
          order: 40,
          kind: "menu",
          icon: "status",
          cached: true,
        },
        list: (input) => (input.open.includes("usage") ? [tab] : []),
        render: () => buildPanel(endpoint, refreshMs),
      });

      ctx.add(MenuItem, () => ({
        menu: "session.panel",
        id: "usage",
        title: ctx.t("title"),
        icon: "status",
        description: "tokens · tps",
        run: open,
      }));

      ctx.add(Command, () => ({
        id: "usage",
        title: ctx.t("title"),
        section: "navigation",
        run: open,
      }));
    },
  }),
};
