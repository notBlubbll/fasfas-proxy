// desktop-usage-panel — OpenCode Desktop GUI part.
//
// Adds a "Fasfas usage" tab to the session side region: summary cards, a
// per-model table with input/output/reasoning/cached tokens, average output
// TPS, average latency and estimated cost, plus a titled totals row. Windows:
// 24h / 7d / 30d / all. Data comes from the proxy's GET /usage endpoint.
//
// Loaded by the desktop from this prebuilt CommonJS bundle:
//   Function("require","module","exports", code)(sharedRequire, module, module.exports)
// `@opencode/plugin/gui` and `solid-js` are provided by the app at runtime.
//
// Plain DOM, no JSX and no build step: the panel builds its nodes once and
// updates them in place.
const { Plugin, Panel, MenuItem, Command, ComposerPill } = require("@opencode/plugin/gui");
const { createSignal } = require("solid-js");

// Live retry state from the proxy's /status, read by the composer pill. One
// signal for every window, refreshed once a second.
const [proxyStatus, setProxyStatus] = createSignal(null);
// One shared 1s ticker; reading `tick()` in a pill makes the host re-run it.
const [tick, setTick] = createSignal(0);

function formatSeconds(total) {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// Elapsed time of the routed session, or null when it is not working.
function elapsedSeconds(session) {
  const data = session && session.server && session.server.data;
  if (!data) return null;
  const id = session.id;
  let running = false;
  try {
    running = typeof data.session.status === "function" && data.session.status(id) === "running";
  } catch {}
  const info = data.session.get(id);
  const busy = info && info.time && info.time.busy;
  const idle = info && info.time && info.time.idle;
  const byTime = typeof busy === "number" && (typeof idle !== "number" || busy > idle);
  if (!running && !byTime) return null;
  if (typeof busy !== "number") return 0;
  const elapsed = Math.floor((Date.now() - busy) / 1000);
  return elapsed >= 0 && elapsed < 24 * 60 * 60 ? elapsed : 0;
}

const WINDOWS = ["24h", "7d", "30d", "all"];
const COLUMNS = [
  { key: "model", label: "Model", align: "left" },
  { key: "requests", label: "Req", align: "right" },
  { key: "input", label: "In", align: "right" },
  { key: "output", label: "Out", align: "right" },
  { key: "reasoning", label: "Reason", align: "right" },
  { key: "cached", label: "Cached", align: "right" },
  { key: "avgTps", label: "tok/s", align: "right" },
  { key: "avgMs", label: "avg", align: "right" },
  { key: "cost", label: "$", align: "right" },
];

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function money(n) {
  const v = Number(n) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

const BORDER = "1px solid rgba(127,127,127,.18)";

function buildPanel(endpoint, refreshMs, headingText) {
  const root = document.createElement("div");
  root.style.cssText = [
    "padding:14px",
    "font:12px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif",
    "color:inherit",
    "height:100%",
    "overflow:auto",
    "box-sizing:border-box",
    "display:flex",
    "flex-direction:column",
    "gap:12px",
    // The app disables selection on chrome-like surfaces; keep the numbers
    // copyable with the mouse.
    "user-select:text",
    "-webkit-user-select:text",
    "cursor:auto",
  ].join(";");

  // ---- header -------------------------------------------------------------
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";

  const heading = document.createElement("div");
  heading.textContent = headingText || "Usage";
  heading.style.cssText = "font-weight:650;font-size:13px;margin-right:auto;letter-spacing:.01em";
  head.appendChild(heading);

  let win = "24h";
  const buttons = {};
  for (const w of WINDOWS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = w;
    b.style.cssText = [
      "padding:3px 9px",
      "border-radius:999px",
      "border:1px solid rgba(127,127,127,.3)",
      "background:transparent",
      "color:inherit",
      "cursor:pointer",
      "font:inherit",
      "line-height:1.5",
      "transition:background .12s",
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
    "padding:3px 9px",
    "border-radius:999px",
    "border:1px solid rgba(127,127,127,.3)",
    "background:transparent",
    "color:inherit",
    "cursor:pointer",
    "font:inherit",
    "line-height:1.5",
  ].join(";");
  refreshBtn.onclick = () => { refresh(); };
  head.appendChild(refreshBtn);
  root.appendChild(head);

  // ---- summary cards ------------------------------------------------------
  const cards = document.createElement("div");
  cards.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px";
  root.appendChild(cards);

  const cardValues = {};
  for (const [key, label] of [["requests", "Requests"], ["input", "Input"], ["output", "Output"], ["cost", "Cost"]]) {
    const card = document.createElement("div");
    card.style.cssText = [
      "padding:9px 11px",
      "border-radius:9px",
      "background:rgba(127,127,127,.08)",
      "border:" + BORDER,
      "min-width:0",
    ].join(";");
    const k = document.createElement("div");
    k.textContent = label;
    k.style.cssText = "font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55";
    const v = document.createElement("div");
    v.textContent = "—";
    v.style.cssText = "font-size:16px;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap";
    card.appendChild(k);
    card.appendChild(v);
    cards.appendChild(card);
    cardValues[key] = v;
  }

  // ---- table --------------------------------------------------------------
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;user-select:text;-webkit-user-select:text";
  root.appendChild(table);

  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:auto;padding-top:6px;opacity:.5;font-size:11px";
  root.appendChild(footer);

  let data = null;
  let error = null;

  function th(text, align) {
    const el = document.createElement("th");
    el.textContent = text;
    el.style.cssText = [
      "text-align:" + align,
      "padding:6px 8px",
      "border-bottom:1px solid rgba(127,127,127,.28)",
      "font-weight:600",
      "font-size:11px",
      "opacity:.6",
      "white-space:nowrap",
    ].join(";");
    return el;
  }

  function td(text, align, opts = {}) {
    const el = document.createElement("td");
    el.textContent = text;
    el.style.cssText = [
      "text-align:" + align,
      "padding:6px 8px",
      "border-bottom:" + (opts.last ? "none" : BORDER),
      "white-space:nowrap",
      opts.strong ? "font-weight:650" : "",
      opts.muted ? "opacity:.6" : "",
      opts.model ? "max-width:130px;overflow:hidden;text-overflow:ellipsis" : "",
    ].join(";");
    if (opts.model) el.title = text;
    return el;
  }

  function paint() {
    for (const [k, b] of Object.entries(buttons)) {
      b.style.background = k === win ? "rgba(127,127,127,.22)" : "transparent";
      b.style.fontWeight = k === win ? "650" : "400";
    }

    table.textContent = "";
    if (error) {
      for (const v of Object.values(cardValues)) v.textContent = "—";
      footer.textContent = "";
      const row = document.createElement("div");
      row.textContent = "proxy offline: " + error;
      row.style.cssText = "opacity:.7;padding:8px 0";
      table.appendChild(row);
      return;
    }
    if (!data) {
      cardValues.requests.textContent = "…";
      return;
    }

    const w = data.windows && data.windows[win];
    if (!w) { footer.textContent = "no data yet for " + win; return; }

    cardValues.requests.textContent = String(w.requests);
    cardValues.input.textContent = fmt(w.input);
    cardValues.output.textContent = fmt(w.output);
    cardValues.cost.textContent = money(w.cost);

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const c of COLUMNS) hr.appendChild(th(c.label, c.align));
    thead.appendChild(hr);
    table.appendChild(thead);

    const body = document.createElement("tbody");
    const models = (data.models && data.models[win]) || {};
    const rows = Object.entries(models).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0) || (b[1].output || 0) - (a[1].output || 0));
    for (const [name, m] of rows) {
      const tr = document.createElement("tr");
      tr.appendChild(td(name, "left", { model: true }));
      tr.appendChild(td(String(m.requests), "right"));
      tr.appendChild(td(fmt(m.input), "right"));
      tr.appendChild(td(fmt(m.output), "right"));
      tr.appendChild(td(fmt(m.reasoning), "right"));
      tr.appendChild(td(fmt(m.cached), "right"));
      tr.appendChild(td(String(m.avgTps || 0), "right", { muted: !m.avgTps }));
      tr.appendChild(td(m.avgMs ? m.avgMs + "ms" : "—", "right", { muted: !m.avgMs }));
      tr.appendChild(td(money(m.cost), "right"));
      body.appendChild(tr);
    }
    table.appendChild(body);

    // totals
    const tfoot = document.createElement("tfoot");
    const tr = document.createElement("tr");
    tr.style.background = "rgba(127,127,127,.06)";
    const sumReq = rows.reduce((n, [, m]) => n + (m.requests || 0), 0);
    tr.appendChild(td("Total", "left", { strong: true, last: true }));
    tr.appendChild(td(String(sumReq), "right", { strong: true, last: true }));
    tr.appendChild(td(fmt(w.input), "right", { strong: true, last: true }));
    tr.appendChild(td(fmt(w.output), "right", { strong: true, last: true }));
    tr.appendChild(td(fmt(w.reasoning), "right", { strong: true, last: true }));
    tr.appendChild(td(fmt(w.cached), "right", { strong: true, last: true }));
    tr.appendChild(td(String(w.avgTps || 0), "right", { strong: true, last: true }));
    tr.appendChild(td(w.avgMs ? w.avgMs + "ms" : "—", "right", { strong: true, last: true }));
    tr.appendChild(td(money(w.cost), "right", { strong: true, last: true }));
    tfoot.appendChild(tr);
    table.appendChild(tfoot);

    footer.textContent =
      `auto ${Math.round(refreshMs / 1000)}s · updated ${new Date(data.updated || Date.now()).toLocaleTimeString()}` +
      (w.seeded ? ` · ${w.seeded} imported` : "");
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
    i18n: { en: { title: "Fasfas usage", heading: "Usage" } },
    setup(ctx) {
      const endpoint = (ctx.options && ctx.options.usageEndpoint) || "http://127.0.0.1:17331/usage";
      const refreshMs = Math.max(1000, Number(ctx.options && ctx.options.refreshMs) || 5000);
      const key = `${ctx.id}:usage`;
      const statusUrl = endpoint.replace(/\/usage\/?$/, "/status");

      // Proxy retry state for the pill: poll /status once a second.
      const statusTimer = setInterval(async () => {
        try {
          const r = await fetch(statusUrl, { cache: "no-store" });
          setProxyStatus(r.ok ? await r.json() : null);
        } catch {
          setProxyStatus(null);
        }
      }, 1000);

      // Composer pill, the working timer: elapsed time for the routed session,
      // plus the proxy's retry state when it is re-sending a request.
      const tickTimer = setInterval(() => setTick((n) => n + 1), 1000);

      ctx.add(ComposerPill, {
        id: "working",
        order: 5,
        show: (input) => {
          tick();
          const seconds = elapsedSeconds(input.session);
          if (seconds === null) return undefined;
          const s = proxyStatus();
          const e = s && s.sessions && input.session ? s.sessions[input.session.id] : null;
          const suffix = e ? ` · retrying ${e.retries} · HTTP ${e.status}` : "";
          return {
            label: `Working (${formatSeconds(seconds)}${suffix})`,
            icon: "status",
            tone: e ? "warning" : undefined,
            title: e
              ? `${e.model || "request"} returned ${e.status}; the proxy is retrying`
              : "Session is running",
          };
        },
      });

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
        render: () => buildPanel(endpoint, refreshMs, ctx.t("heading")),
      });

      ctx.add(MenuItem, () => ({
        menu: "session.panel",
        id: "usage",
        title: ctx.t("title"),
        icon: "status",
        description: "tokens · cost · tps",
        run: open,
      }));

      ctx.add(Command, () => ({
        id: "usage",
        title: ctx.t("title"),
        section: "navigation",
        run: open,
      }));

      return () => {
        clearInterval(statusTimer);
        clearInterval(tickTimer);
      };
    },
  }),
};
