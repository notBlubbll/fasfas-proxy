// fasfas-proxy/index.js — OpenCode V2 plugin: local OpenAI-compatible proxy
// for an ai.coffeevps.com-style gateway.
//
// It does two things:
//   1. RATE LIMITING — the gateway enforces a hard per-model cap and answers
//      429 when a turn fans out (subagents, retries). The proxy paces requests
//      per model with a sliding window, so the cap is never hit. Limits are
//      configurable and are also learned from the gateway's own 429 text.
//   2. VISION HANDOFF — models that cannot accept images get their image parts
//      captioned by a vision model and replaced with the caption text, so a
//      text-only model answers normally. One request in, one stream out.
//
// Everything else is a transparent passthrough: the inbound `authorization`
// header is forwarded upstream unchanged and the request body (including the
// model id) is forwarded byte-exact.
//
// rev: 1 — plugin contract, hot-reload guard, crash guards, EADDRINUSE
//         retry-listen, raw http(s) sockets, streaming passthrough,
//         per-model sliding-window limiter, 429 learn + retry,
//         model-based vision handoff, /healthz + /status.

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "[fasfas-proxy]";
const UPSTREAM_DEFAULT = "https://ai.coffeevps.com/v1";
const LISTEN_HOST = "127.0.0.1";
const PORT_DEFAULT = 17331;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const UPSTREAM = (() => {
  try { return new URL(process.env.FASFAS_PROXY_UPSTREAM || UPSTREAM_DEFAULT); }
  catch { return new URL(UPSTREAM_DEFAULT); }
})();

// ---- rate limits -----------------------------------------------------------
// Sliding window per model id. Env format (FASFAS_PROXY_LIMITS):
//   "sonnet-5.5=6/60s,haiku-5.5=20/60s,*=0"
// `*` is the fallback for models without an explicit entry; 0 = unlimited.
// A model with no entry and no `*` is unlimited.
//
// Defaults measured against the live gateway: sonnet-5.5 answers 429 after 6
// requests in a minute, qwen3.8-27b / glm-5.3-flash / haiku-5.5 after 20, and
// deepseek-v4.1-flash was still serving after 30 (left unlimited).
const LIMITS_DEFAULT =
  "sonnet-5.5=6/60s,qwen3.8-27b=20/60s,glm-5.3-flash=20/60s,haiku-5.5=20/60s,deepseek-v4.1-flash=0";

// Retries after an upstream 429 before the 429 is handed to the client.
const MAX_429_RETRIES = 6;
// Wall-clock ceiling for 429 waits on a single request.
const RATE_LIMIT_BUDGET_MS = Number(process.env.FASFAS_PROXY_RL_BUDGET_MS) || 10 * 60 * 1000;
// Never trust a retry-after beyond this; a stuck upstream must not park a turn.
const RETRY_AFTER_CAP_MS = 120000;
// Log a line when a request had to wait this long for a slot.
const QUEUE_LOG_MS = 5000;

const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".fasfas-proxy.log");

function log(msg) {
  const line = `${new Date().toISOString()} ${TAG} ${msg}`;
  console.log(line);
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.truncateSync(LOG_FILE, 0);
    } catch {}
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---- limit parsing ---------------------------------------------------------

function parseWindow(spec) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(String(spec).trim());
  if (!m) return null;
  const unit = (m[2] || "s").toLowerCase();
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
}

function parseLimits(src) {
  const out = new Map();
  for (const part of String(src).split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    if (eq < 0) continue;
    const model = entry.slice(0, eq).trim();
    const spec = entry.slice(eq + 1).trim();
    const slash = spec.indexOf("/");
    if (!model || slash < 0) continue;
    const max = Number(spec.slice(0, slash));
    const windowMs = parseWindow(spec.slice(slash + 1));
    if (!Number.isFinite(max) || !windowMs) {
      log(`ignoring malformed limit entry "${entry}"`);
      continue;
    }
    out.set(model, { max, windowMs });
  }
  return out;
}

const LIMITS = parseLimits(process.env.FASFAS_PROXY_LIMITS || LIMITS_DEFAULT);
const LIMIT_FALLBACK = LIMITS.get("*") || null;

class ModelLimiter {
  constructor(model, max, windowMs) {
    this.model = model;
    this.max = max;
    this.windowMs = windowMs;
    this.stamps = [];              // dispatch times inside the window
    this.blockedUntil = 0;         // set by an upstream 429
    this.tail = Promise.resolve(); // FIFO reservation chain
    this.total = 0;
    this.throttled = 0;
    this.retries = 0;
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  // milliseconds the caller must wait; 0 means a slot is free now
  waitTime(now) {
    this.prune(now);
    if (this.blockedUntil > now) return this.blockedUntil - now;
    if (this.stamps.length < this.max) return 0;
    return this.stamps[0] + this.windowMs - now;
  }

  reserve(now) {
    this.prune(now);
    this.stamps.push(now);
    this.total++;
  }

  blockFor(ms, now) {
    this.blockedUntil = Math.max(this.blockedUntil, now + ms);
  }

  snapshot(now) {
    this.prune(now);
    return {
      max: this.max,
      windowMs: this.windowMs,
      used: this.stamps.length,
      blockedMs: Math.max(0, this.blockedUntil - now),
      total: this.total,
      throttled: this.throttled,
      retries: this.retries,
    };
  }
}

const limiters = new Map();

function limiterFor(model) {
  if (!model) return null;
  let lim = limiters.get(model);
  if (lim) return lim;
  const cfg = LIMITS.get(model) || LIMIT_FALLBACK;
  if (!cfg || cfg.max <= 0) return null;
  lim = new ModelLimiter(model, cfg.max, cfg.windowMs);
  limiters.set(model, lim);
  return lim;
}

// Strict FIFO: each caller awaits the previous reservation. Reservation is
// instant, so this serializes slots rather than requests.
function acquire(model) {
  const lim = limiterFor(model);
  if (!lim) return Promise.resolve(null);
  const run = lim.tail.then(async () => {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      const wait = lim.waitTime(now);
      if (wait <= 0) {
        lim.reserve(now);
        const waited = now - start;
        if (waited > 0) {
          lim.throttled++;
          if (waited > QUEUE_LOG_MS) {
            log(`throttled ${model} for ${(waited / 1000).toFixed(1)}s (limit ${lim.max}/${lim.windowMs / 1000}s)`);
          }
        }
        return;
      }
      await sleep(Math.min(wait, 1000));
    }
  });
  lim.tail = run.catch(() => {});
  return run.then(() => lim);
}

// ---- vision handoff --------------------------------------------------------
// A text-only target that receives image parts cannot see them. Each image is
// captioned with the vision model, the image part is replaced by the caption
// text, and the request continues to the ORIGINAL model. Captions are cached by
// image hash, so a screenshot resent on a later turn costs nothing.
const VISION_MODEL_DEFAULT = "glm-5.3-flash";
const VISION_TARGETS_DEFAULT = "haiku-5.5,sonnet-5.5";
const VISION_PROMPT_DEFAULT =
  "Describe this image in full detail for a text-only assistant that cannot see it. " +
  "Transcribe all text, code, UI labels, error messages, tables and diagrams exactly. " +
  "Be complete but concise.";
const VISION_CACHE_TTL_MS = 60 * 60 * 1000;
const VISION_CACHE_MAX = 200;
const VISION_ENABLED = !/^(0|false|off)$/i.test(process.env.FASFAS_PROXY_VISION || "");
const VISION_MODEL = process.env.FASFAS_PROXY_VISION_MODEL || VISION_MODEL_DEFAULT;
const VISION_TARGETS = (process.env.FASFAS_PROXY_VISION_TARGETS || VISION_TARGETS_DEFAULT)
  .split(",").map((s) => s.trim()).filter(Boolean);
const VISION_PROMPT = process.env.FASFAS_PROXY_VISION_PROMPT || VISION_PROMPT_DEFAULT;
const visionCache = new Map();

function visionCacheGet(key) {
  const e = visionCache.get(key);
  if (!e) return null;
  if (Date.now() - e.time > VISION_CACHE_TTL_MS) { visionCache.delete(key); return null; }
  return e.text;
}

function visionCacheSet(key, text) {
  if (visionCache.size >= VISION_CACHE_MAX) {
    try { visionCache.delete(visionCache.keys().next().value); } catch {}
  }
  visionCache.set(key, { text, time: Date.now() });
}

function isImagePart(p) {
  if (!p || typeof p !== "object") return false;
  return p.type === "image_url" || p.type === "image" || p.type === "input_image";
}

function imageUrlOf(p) {
  if (p.type === "image_url") {
    if (typeof p.image_url === "string") return p.image_url;
    if (p.image_url && typeof p.image_url.url === "string") return p.image_url.url;
    return null;
  }
  if (p.type === "image") {
    if (p.source && typeof p.source.data === "string") {
      return `data:${p.source.media_type || "image/png"};base64,${p.source.data}`;
    }
    return p.url || null;
  }
  if (p.type === "input_image") return typeof p.image_url === "string" ? p.image_url : null;
  return null;
}

function collectImageParts(body) {
  const out = [];
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let mi = 0; mi < msgs.length; mi++) {
    const c = msgs[mi]?.content;
    if (!Array.isArray(c)) continue;
    for (let pi = 0; pi < c.length; pi++) {
      if (isImagePart(c[pi])) {
        const url = imageUrlOf(c[pi]);
        if (url) out.push({ mi, pi, url });
      }
    }
  }
  return out;
}

function targetMatches(model) {
  return VISION_TARGETS.some((t) =>
    t === "*" || t === model || (t.endsWith("*") && model.startsWith(t.slice(0, -1))));
}

// One non-streaming vision call against the same upstream and credentials.
async function analyzeImage({ auth, url }) {
  const payload = {
    model: VISION_MODEL,
    stream: false,
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: VISION_PROMPT },
        { type: "image_url", image_url: { url } },
      ],
    }],
  };
  const headers = { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await acquire(VISION_MODEL);
      const res = await postJson("/chat/completions", headers, payload);
      if (res.status >= 400) {
        lastErr = new Error(`vision status ${res.status}: ${res.text.slice(0, 200)}`);
      } else {
        const j = JSON.parse(res.text);
        const content = j?.choices?.[0]?.message?.content;
        if (typeof content === "string" && content.trim()) return content.trim();
        if (Array.isArray(content)) {
          const joined = content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
          if (joined) return joined;
        }
        lastErr = new Error(`vision response had no content: ${res.text.slice(0, 160)}`);
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 3) await sleep(400 * attempt);
  }
  throw lastErr || new Error("vision analysis failed");
}

// Replace every image part in `rawBody` with its caption. Returns the original
// buffer untouched when the model is not a configured target.
async function visionHandoff(rawBody, model, auth) {
  if (!VISION_ENABLED || !model || model === VISION_MODEL) return rawBody;
  if (!targetMatches(model)) return rawBody;

  let json;
  try { json = JSON.parse(rawBody.toString("utf8")); } catch { return rawBody; }
  const imgs = collectImageParts(json);
  if (imgs.length === 0) return rawBody;

  const origSize = rawBody.length;
  let analyzed = 0, cached = 0, failed = 0;
  for (const img of imgs) {
    const key = createHash("sha256").update(img.url).digest("hex");
    let desc = visionCacheGet(key);
    if (desc) {
      cached++;
    } else {
      try {
        desc = await analyzeImage({ auth, url: img.url });
        visionCacheSet(key, desc);
        analyzed++;
      } catch (e) {
        log(`vision handoff failed: ${e?.message || e}`);
        desc = null;
        failed++;
      }
    }
    const msgs = json.messages;
    if (msgs?.[img.mi]?.content) {
      msgs[img.mi].content[img.pi] = {
        type: "text",
        text: desc
          ? `[Image attached by the user — description produced by ${VISION_MODEL}:]\n${desc}`
          : "[Image attached by the user — vision analysis unavailable]",
      };
    }
  }
  const out = Buffer.from(JSON.stringify(json), "utf8");
  log(`vision handoff model=${model} images=${imgs.length} analyzed=${analyzed} cached=${cached} failed=${failed} bytes ${origSize}->${out.length}`);
  return out;
}

// ---- upstream plumbing -----------------------------------------------------

const PROXY_STATE = { active: 0, queued: 0, started: Date.now(), requests: 0, retries: 0 };

function upstreamRequest(target, opts) {
  const mod = target.protocol === "https:" ? httpsRequest : httpRequest;
  return mod({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: opts.method,
    headers: opts.headers,
    agent: false,
  });
}

function targetUrl(urlPath) {
  const base = UPSTREAM.pathname.replace(/\/$/, "");
  const suffix = urlPath.replace(/^\/v1(?=\/)/, "");
  return new URL(base + suffix, UPSTREAM);
}

function postJson(urlPath, headers, payload, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = upstreamRequest(targetUrl(urlPath), {
      method: "POST",
      headers: { ...headers, "content-length": String(body.length) },
    });
    const timer = setTimeout(() => { try { req.destroy(); } catch {} reject(new Error("vision request timed out")); }, timeoutMs);
    req.on("response", (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { if (size < 1 << 20) { chunks.push(c); size += c.length; } });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode || 502, text: Buffer.concat(chunks).toString("utf8") }); });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { chunks.push(c); size += c.length; });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

function buildForwardHeaders(inbound, bodyLength) {
  const out = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(key)) continue;
    if (key.startsWith("x-fasfas-")) continue; // local control headers
    out[k] = v;
  }
  out["content-length"] = String(bodyLength);
  return out;
}

function parseRetryAfterMs(headers) {
  const raw = headers["retry-after"];
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Learn the limit from the gateway's own error text, e.g.
//   "sonnet-5.5 request limit reached (6 requests per minute). Try again in 29s."
const LIMIT_RE = /\((\d+)\s+requests?\s+per\s+(minute|hour)\)/i;
const RETRY_HINT_RE = /try again in\s+(\d+)\s*(s|sec|ms)/i;

function learnFrom429(model, headers, text) {
  let retryMs = parseRetryAfterMs(headers);
  let discovered = null;

  const m = LIMIT_RE.exec(text || "");
  if (m) {
    discovered = { max: Number(m[1]), windowMs: m[2].toLowerCase() === "hour" ? 3600000 : 60000 };
  }
  if (retryMs == null) {
    const h = RETRY_HINT_RE.exec(text || "");
    if (h) retryMs = Number(h[1]) * (h[2].toLowerCase() === "ms" ? 1 : 1000);
  }
  if (retryMs == null) retryMs = 15000;
  retryMs = Math.min(retryMs, RETRY_AFTER_CAP_MS);

  let lim = limiterFor(model);
  if (discovered) {
    if (!lim) {
      lim = new ModelLimiter(model, discovered.max, discovered.windowMs);
      limiters.set(model, lim);
    } else if (lim.max !== discovered.max || lim.windowMs !== discovered.windowMs) {
      log(`learned ${model} limit from upstream: ${discovered.max}/${discovered.windowMs / 1000}s`);
      lim.max = discovered.max;
      lim.windowMs = discovered.windowMs;
    }
  }
  if (lim) {
    lim.blockFor(retryMs, Date.now());
    lim.retries++;
  }
  return { limiter: lim, retryMs };
}

function parseModel(body) {
  try {
    const j = JSON.parse(body.toString("utf8"));
    return typeof j?.model === "string" ? j.model : null;
  } catch {
    return null;
  }
}

// ---- request handling ------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${LISTEN_HOST}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, "text/plain", "fasfas-proxy OK\n");
  }
  if (req.method === "GET" && url.pathname === "/status") {
    const now = Date.now();
    const models = {};
    for (const lim of limiters.values()) models[lim.model] = lim.snapshot(now);
    return send(res, 200, "application/json", JSON.stringify({
      proxy: "fasfas-proxy",
      upstream: UPSTREAM.href,
      uptimeMs: now - PROXY_STATE.started,
      active: PROXY_STATE.active,
      queued: PROXY_STATE.queued,
      requests: PROXY_STATE.requests,
      retries429: PROXY_STATE.retries,
      vision: {
        enabled: VISION_ENABLED,
        model: VISION_MODEL,
        targets: VISION_TARGETS,
        cachedCaptions: visionCache.size,
      },
      limits: Object.fromEntries(
        [...LIMITS].filter(([k]) => k !== "*").map(([k, v]) => [k, `${v.max}/${v.windowMs / 1000}s`])),
      models,
      updated: now,
    }, null, 2) + "\n", { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }

  let body = await readBody(req);
  let model = parseModel(body);
  const isChat = url.pathname.includes("/chat/completions");

  PROXY_STATE.requests++;
  PROXY_STATE.active++;
  try {
    if (isChat && model) {
      body = await visionHandoff(body, model, req.headers.authorization);
      model = parseModel(body) || model;
    }

    if (isChat && model && limiterFor(model)) {
      const started = Date.now();
      PROXY_STATE.queued++;
      try { await acquire(model); } finally { PROXY_STATE.queued--; }
      const waited = Date.now() - started;
      if (waited > QUEUE_LOG_MS) log(`slot for ${model} after ${(waited / 1000).toFixed(1)}s`);
    }

    const maxAttempts = MAX_429_RETRIES + 1;
    const budgetStart = Date.now();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await forward(req, res, url, body, model, isChat);
      if (result.done) return;
      if (Date.now() - budgetStart > RATE_LIMIT_BUDGET_MS) {
        log(`429 budget exhausted for ${model}, forwarding the 429`);
        return sendJson(res, result.status, result.text);
      }
      const { retryMs } = learnFrom429(model, result.headers, result.text);
      PROXY_STATE.retries++;
      log(`upstream 429 for ${model}; waiting ${Math.round(retryMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(retryMs);
    }
  } finally {
    PROXY_STATE.active--;
  }
}

// One upstream attempt. Resolves {done:true} when the client has been answered,
// or {retry:true,status,headers,text} when the 429 should be absorbed.
function forward(req, res, url, body, model, isChat) {
  return new Promise((resolve) => {
    const headers = buildForwardHeaders(req.headers, body.length);

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    let up;
    try {
      up = upstreamRequest(targetUrl(url.pathname + url.search), { method: req.method, headers });
    } catch (err) {
      log(`upstream request failed: ${err?.message || err}`);
      send(res, 502, "text/plain", `fasfas-proxy: ${err?.message || err}\n`);
      return finish({ done: true });
    }

    up.on("error", (err) => {
      if (res.headersSent) { try { res.end(); } catch {} return finish({ done: true }); }
      log(`upstream error: ${err?.message || err}`);
      send(res, 502, "text/plain", `fasfas-proxy upstream error: ${err?.message || err}\n`);
      finish({ done: true });
    });

    up.on("response", (upRes) => {
      const status = upRes.statusCode || 502;
      const hdrs = { ...upRes.headers };
      delete hdrs["transfer-encoding"];
      delete hdrs["content-length"];
      delete hdrs.connection;

      if (status === 429 && isChat && model) {
        const chunks = [];
        let size = 0;
        upRes.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
        upRes.on("end", () => finish({ retry: true, status, headers: upRes.headers, text: Buffer.concat(chunks).toString("utf8") }));
        upRes.on("error", () => finish({ retry: true, status, headers: upRes.headers, text: "" }));
        return;
      }

      res.writeHead(status, hdrs);
      upRes.pipe(res);
      upRes.on("end", () => finish({ done: true }));
      upRes.on("error", () => { try { res.end(); } catch {} finish({ done: true }); });
    });

    res.on("close", () => { if (!res.writableEnded) { try { up.destroy(); } catch {} } });
    up.end(body);
  });
}

function send(res, status, type, text, extra = {}) {
  try {
    res.writeHead(status, { "content-type": type, ...extra });
    res.end(text);
  } catch {}
}

function sendJson(res, status, text) {
  let type = "application/json";
  try { JSON.parse(text); } catch { type = "text/plain"; }
  send(res, status, type, text || `{"error":{"message":"upstream ${status}"}}`);
}

// ---- server ----------------------------------------------------------------

async function startServer(port, mode) {
  const server = createServer();
  server.on("request", (req, res) => {
    handle(req, res).catch((err) => {
      log(`handler crash: ${err?.stack || err}`);
      try {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`fasfas-proxy error: ${err?.message || err}`);
      } catch {}
    });
  });
  server.on("checkContinue", (req, res) => {
    try { res.writeContinue(); } catch {}
    handle(req, res).catch(() => {});
  });
  server.on("clientError", (err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
  });

  let listenRetryTimer = null;
  let shuttingDown = false;
  const scheduleListenRetry = () => {
    if (shuttingDown || listenRetryTimer) return;
    listenRetryTimer = setTimeout(() => { listenRetryTimer = null; if (!shuttingDown) listen(); }, 5000);
    try { listenRetryTimer.unref?.(); } catch {}
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (listenRetryTimer) { clearTimeout(listenRetryTimer); listenRetryTimer = null; }
    try { server.closeAllConnections?.(); } catch {}
    try { server.close(() => {}); } catch {}
  };
  server.__fasfasShutdown = shutdown;

  // hot-reload safety: a previous instance must release the port first
  try {
    const prev = globalThis.__fasfasProxyServer;
    globalThis.__fasfasProxyServer = null;
    if (prev) {
      try { prev.__fasfasShutdown?.(); } catch {}
      try { prev.closeAllConnections?.(); } catch {}
      await new Promise((resolve) => { try { prev.close(resolve); } catch { resolve(); } });
    }
  } catch {}
  globalThis.__fasfasProxyServer = server;

  const listen = () => {
    if (shuttingDown) return;
    server.listen(port, LISTEN_HOST, () => {
      if (listenRetryTimer) { clearTimeout(listenRetryTimer); listenRetryTimer = null; }
      const lim = [...LIMITS].filter(([k]) => k !== "*")
        .map(([k, v]) => `${k}=${v.max}/${v.windowMs / 1000}s`).join(" ");
      log(`listening (${mode}) on http://${LISTEN_HOST}:${port} -> ${UPSTREAM.href}`);
      log(`limits: ${lim || "none"}${LIMIT_FALLBACK ? ` (fallback ${LIMIT_FALLBACK.max}/${LIMIT_FALLBACK.windowMs / 1000}s)` : ""}`);
      log(`vision: ${VISION_ENABLED ? `on model=${VISION_MODEL} targets=${VISION_TARGETS.join(",")}` : "off"}`);
    });
  };
  server.on("error", (err) => {
    if (shuttingDown) return;
    if (err && err.code === "EADDRINUSE") {
      log(`port ${port} busy — retrying every 5s`);
      scheduleListenRetry();
    } else {
      log(`server error: ${err?.stack || err}`);
    }
  });
  listen();

  if (!globalThis.__fasfasProxyCrashGuards) {
    globalThis.__fasfasProxyCrashGuards = true;
    process.on("unhandledRejection", (reason) => {
      try { log(`swallowed unhandledRejection: ${(reason && (reason.stack || reason.message)) || reason}`); } catch {}
    });
    process.on("uncaughtException", (err) => {
      try { log(`swallowed uncaughtException: ${(err && (err.stack || err.message)) || err}`); } catch {}
    });
  }
}

export default {
  id: "fasfas-proxy",
  async setup(ctx) {
    startServer(Number(process.env.FASFAS_PROXY_PORT) || PORT_DEFAULT, "plugin")
      .catch((e) => log(`startServer failed: ${e?.stack || e}`));
  },
};

// Runs as a standalone daemon (`node index.js`, `bun index.js`) as well as a plugin.
const invokedDirectly = import.meta.main === true ||
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
  startServer(Number(process.env.FASFAS_PROXY_PORT) || PORT_DEFAULT, "standalone")
    .catch((e) => log(`startServer failed: ${e?.stack || e}`));
}
