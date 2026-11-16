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
import { fileURLToPath, pathToFileURL } from "node:url";

// Set by hotReload() on the copy of this file that is being replaced. That copy
// keeps finishing the requests it already has, but it must not write keys.json or
// the usage snapshot again: the new copy owns them, and a late write from the old
// one (a debounced save) would put stale state back.
let retired = false;
// Identifies this copy of the module, so a status call shows which copy answered.
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
// Responses this copy is still writing, so a hot reload can mark them to close
// their connection when they finish.
const activeResponses = new Set();


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
// Defaults measured against the live gateway (dashboard + 429 probes):
//   sonnet-5.5          6 req/min
//   qwen3.8-27b        20 req/min
//   glm-5.3-flash      20 req/min
//   haiku-5.5          20 req/min
//   deepseek-v4.1-flash 40 req/min, 2,000,000 tokens/min
// Per key, as measured on one key. The account total is these caps times the
// number of configured keys, so a second key doubles what the panel shows.
const LIMITS_DEFAULT =
  "sonnet-5.5=6/60s,qwen3.8-27b=20/60s,glm-5.3-flash=20/60s,haiku-5.5=20/60s,deepseek-v4.1-flash=40/60s";

// Token-per-minute budget per model, straight from the gateway dashboard.
// Env format (FASFAS_PROXY_TOKEN_LIMITS): "haiku-5.5=2000000/60s".
// Unlisted models have no token budget.
const TOKEN_LIMITS_DEFAULT =
  "qwen3.8-27b=3000000/60s,deepseek-v4.1-flash=2000000/60s,glm-5.3-flash=2000000/60s," +
  "haiku-5.5=2000000/60s,sonnet-5.5=1000000/60s";

// USD per 1M tokens, from the OpenCode Go table (off-peak where a model has
// peak/off-peak pricing) and the Console table for models Go does not list.
// qwen3.8-27b is not published anywhere, so it uses the Qwen3.8 Flash rates.
// Override with FASFAS_PROXY_PRICING="model=in/out/cached,...".
const PRICING_DEFAULT = {
  "deepseek-v4.1-flash": { in: 0.15, out: 0.60, cached: 0.003 },
  "glm-5.3-flash": { in: 0.15, out: 0.50, cached: 0.03 },
  "haiku-5.5": { in: 0.10, out: 0.50, cached: 0.01 },
  "sonnet-5.5": { in: 2.00, out: 10.00, cached: 0.10 },
  "qwen3.8-27b": { in: 0.15, out: 0.47, cached: 0.016 },
};

function parsePricing(src) {
  const out = {};
  for (const entry of String(src).split(",")) {
    const e = entry.trim();
    if (!e) continue;
    const eq = e.indexOf("=");
    if (eq < 0) continue;
    const model = e.slice(0, eq).trim();
    const parts = e.slice(eq + 1).split("/").map((n) => Number(n));
    if (!model || parts.length < 2 || parts.some((n) => !Number.isFinite(n))) continue;
    out[model] = { in: parts[0], out: parts[1], cached: parts[2] ?? parts[0] };
  }
  return out;
}

const PRICING = { ...PRICING_DEFAULT, ...parsePricing(process.env.FASFAS_PROXY_PRICING || "") };

// Cost of one record. Cached tokens are part of the prompt count and are billed
// at the cached-read rate instead of the full input rate.
function recordCost(r) {
  const p = PRICING[r.m];
  if (!p) return 0;
  const cached = Math.min(r.c || 0, r.i || 0);
  const fresh = Math.max(0, (r.i || 0) - cached);
  return (fresh * p.in + cached * p.cached + (r.o || 0) * p.out) / 1e6;
}

// Retries after an upstream 429 before the 429 is handed to the client.
const MAX_429_RETRIES = 6;
// Retries for transient 5xx (502/503/504/520/522/524) before giving up.
const MAX_5XX_RETRIES = 5;
// Wall-clock ceiling for 429 waits on a single request.
const RATE_LIMIT_BUDGET_MS = Number(process.env.FASFAS_PROXY_RL_BUDGET_MS) || 10 * 60 * 1000;
// Never trust a retry-after beyond this; a stuck upstream must not park a turn.
const RETRY_AFTER_CAP_MS = 120000;
// Log a line when a request had to wait this long for a slot.
const QUEUE_LOG_MS = 5000;

// ---- usage accounting -------------------------------------------------------
// Every completed chat request appends one compact record to a JSONL file and
// to an in-memory ring, so /usage can report 24h / 7d / 30d / all-time windows.
// Records are pruned at 30 days; lifetime totals live in the JSON snapshot.
const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const usage = { since: Date.now(), records: [], lifetime: {}, loaded: false };

function loadUsage() {
  if (usage.loaded) return;
  usage.loaded = true;
  try {
    const snap = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (snap?.since) usage.since = snap.since;
    if (snap?.lifetime) usage.lifetime = snap.lifetime;
  } catch {}
  try {
    const cutoff = Date.now() - USAGE_RETENTION_MS;
    const lines = fs.readFileSync(USAGE_LOG, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.t >= cutoff) usage.records.push(r);
      } catch {}
    }
  } catch {}

  // Records written before the first-token method carry a generation time that
  // started at the first byte and ran to the end, and was divided by every output
  // token. Those rates are wrong, so the timing is dropped (tokens, requests and
  // cost stay). The new method always writes `sr`, which is how the two are told
  // apart, so this runs once and then finds nothing.
  let cleared = 0;
  for (const r of usage.records) {
    if (!r.seed && !("sr" in r) && r.gm) {
      delete r.gm;
      cleared++;
    }
  }
  if (cleared > 0) {
    for (const lt of Object.values(usage.lifetime)) if (lt) lt.genMs = 0;
    try {
      fs.writeFileSync(USAGE_LOG, usage.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      fs.writeFileSync(USAGE_FILE, JSON.stringify({ since: usage.since, lifetime: usage.lifetime }));
    } catch (e) {
      log(`could not rewrite usage log: ${e?.message || e}`);
    }
    log(`cleared the tok/s timing from ${cleared} record(s) measured by the old method`);
  }
}

let usageSaveTimer = null;
function saveUsageSoon() {
  if (usageSaveTimer) return;
  usageSaveTimer = setTimeout(() => {
    usageSaveTimer = null;
    if (retired) return;
    try {
      fs.writeFileSync(USAGE_FILE, JSON.stringify({ since: usage.since, lifetime: usage.lifetime }));
    } catch {}
  }, 2000);
  try { usageSaveTimer.unref?.(); } catch {}
}

function appendUsageRecord(rec) {
  usage.records.push(rec);
  try {
    try {
      if (fs.statSync(USAGE_LOG).size > USAGE_LOG_MAX_BYTES) fs.truncateSync(USAGE_LOG, 0);
    } catch {}
    fs.appendFileSync(USAGE_LOG, JSON.stringify(rec) + "\n");
  } catch {}
  const lt = (usage.lifetime[rec.m] = usage.lifetime[rec.m] || { requests: 0, input: 0, output: 0, reasoning: 0, cached: 0, genMs: 0 });
  lt.requests++;
  lt.input += rec.i || 0;
  lt.output += rec.o || 0;
  lt.reasoning += rec.r || 0;
  lt.cached += rec.c || 0;
  lt.genMs += rec.gm || 0;
  saveUsageSoon();
}

// Stored per request:
//   ttft - request sent -> first frame carrying model text (time to first token)
//   gm   - first -> last text frame (the generation window). Zero when there were
//          fewer than two text frames, which leaves the request out of tok/s.
//   ms   - total wall time, kept for latency only.
function recordUsage(model, result, ms) {
  if (!model || !result || result.status !== 200) return;
  const u = parseUsageFromText(result.tail);
  if (!u) return;
  const t = result.timing || {};
  const ttft = t.firstTokenAt && t.sentAt ? Math.max(0, t.firstTokenAt - t.sentAt) : 0;
  const gm = t.firstTokenAt && t.lastTokenAt && t.tokenFrames >= 2
    ? Math.max(0, t.lastTokenAt - t.firstTokenAt)
    : 0;
  appendUsageRecord({
    t: Date.now(),
    m: model,
    i: u.prompt,
    o: u.completion,
    r: u.reasoning,
    c: u.cached,
    gm,
    ttft,
    sr: t.sawReasoning ? 1 : 0,
    ms: Math.max(0, Math.round(ms)),
  });
}

function parseUsageFromText(text) {  if (!text) return null;
  const num = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g");
    let last = null, m;
    while ((m = re.exec(text))) last = Number(m[1]);
    return last;
  };
  const prompt = num("prompt_tokens");
  const completion = num("completion_tokens");
  if (prompt == null && completion == null) return null;
  return {
    prompt: prompt || 0,
    completion: completion || 0,
    reasoning: num("reasoning_tokens") || 0,
    cached: num("cached_tokens") || 0,
  };
}

function pruneUsage() {
  const cutoff = Date.now() - USAGE_RETENTION_MS;
  if (usage.records.length === 0) return;
  let i = 0;
  while (i < usage.records.length && usage.records[i].t < cutoff) i++;
  if (i > 0) usage.records.splice(0, i);
}

// Requests shorter than this are left out of tok/s: a handful of tokens over a few
// milliseconds is dominated by network framing, not by the model's decode speed.
const MIN_TPS_TOKENS = 16;
const MIN_TPS_WINDOW_MS = 250;

function windowStats(model, since) {
  const acc = { requests: 0, input: 0, output: 0, reasoning: 0, cached: 0, seeded: 0, cost: 0 };
  let realMs = 0, realReq = 0;
  let realIn = 0, realCache = 0;
  let tpsTokens = 0, tpsMs = 0, tpsN = 0;
  let ttftSum = 0, ttftN = 0;
  const rates = [];
  let lastRate = 0;
  for (const r of usage.records) {
    if (r.t < since) continue;
    if (model && r.m !== model) continue;
    acc.requests += r.n || 1;
    acc.input += r.i || 0;
    acc.output += r.o || 0;
    acc.reasoning += r.r || 0;
    acc.cached += r.c || 0;
    acc.cost += recordCost(r);
    if (r.seed) {
      // Imported aggregate: real token counts, no timing to average.
      acc.seeded++;
      continue;
    }
    realReq++;
    realMs += r.ms || 0;
    realIn += r.i || 0;
    realCache += r.c || 0;

    if (r.ttft > 0) { ttftSum += r.ttft; ttftN++; }

    // Decode speed: tokens produced after the first one, over the span between
    // the first and last text frame. Reasoning that was never streamed happened
    // before the first frame, so it is taken out of the count.
    if (r.gm >= MIN_TPS_WINDOW_MS) {
      const hidden = r.r > 0 && !r.sr ? r.r : 0;
      const n = (r.o || 0) - hidden - 1;
      if (n >= MIN_TPS_TOKENS) {
        tpsTokens += n;
        tpsMs += r.gm;
        tpsN++;
        lastRate = n / (r.gm / 1000);
        rates.push(lastRate);
      }
    }
  }
  acc.cost = +acc.cost.toFixed(6);
  // Token-weighted: total tokens over total time, so a long answer counts for
  // more than a short one.
  acc.avgTps = tpsMs > 0 ? +(tpsTokens / (tpsMs / 1000)).toFixed(1) : 0;
  // The plain mean of each request's own rate, the latest request's rate, and the
  // median: all reported so the tooltip can show how the figure was reached.
  acc.meanTps = rates.length ? +(rates.reduce((s, v) => s + v, 0) / rates.length).toFixed(1) : 0;
  acc.lastTps = +lastRate.toFixed(1);
  rates.sort((a, b) => a - b);
  acc.medTps = rates.length ? +rates[Math.floor(rates.length / 2)].toFixed(1) : 0;
  acc.tpsN = tpsN;
  acc.ttftMs = ttftN > 0 ? Math.round(ttftSum / ttftN) : 0;
  acc.ttftN = ttftN;
  acc.avgMs = realReq > 0 ? Math.round(realMs / realReq) : 0;
  // Cached share of the prompt. Prompt tokens already include the cached ones.
  // Imported history has no cache data, so only requests the proxy carried count.
  acc.cachedReal = realCache;
  acc.inputReal = realIn;
  acc.cachedPct = realIn > 0 ? +((realCache / realIn) * 100).toFixed(1) : 0;
  return acc;
}

function usageReport() {
  pruneUsage();
  const now = Date.now();
  const windows = {
    "24h": now - 24 * 60 * 60 * 1000,
    "7d": now - 7 * 24 * 60 * 60 * 1000,
    "30d": now - 30 * 24 * 60 * 60 * 1000,
    all: 0,
  };
  const out = { since: usage.since, updated: now, pricing: PRICING, windows: {}, models: {} };
  for (const [key, since] of Object.entries(windows)) {
    out.windows[key] = windowStats(null, since);
    out.models[key] = {};
    const names = new Set(usage.records.filter((r) => r.t >= since).map((r) => r.m));
    for (const m of names) out.models[key][m] = windowStats(m, since);
  }
  // all-time also includes records pruned from disk, via the lifetime snapshot
  out.lifetime = usage.lifetime;
  return out;
}

const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".fasfas-proxy.log");
const USAGE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".fasfas-usage.json");
const USAGE_LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), ".fasfas-usage.jsonl");
const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

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
const TOKEN_LIMITS = parseLimits(process.env.FASFAS_PROXY_TOKEN_LIMITS || TOKEN_LIMITS_DEFAULT);
const LIMIT_FALLBACK = LIMITS.get("*") || null;
const TOKEN_FALLBACK = TOKEN_LIMITS.get("*") || null;

class ModelLimiter {
  constructor(model, max, windowMs, tokenMax, tokenWindowMs) {
    this.model = model;
    this.max = max;
    this.windowMs = windowMs;
    this.tokenMax = tokenMax;
    this.tokenWindowMs = tokenWindowMs;
    this.stamps = [];              // dispatch times inside the window
    this.tokens = [];              // { t, n } token reservations inside the window
    this.blockedUntil = 0;         // set by an upstream 429
    this.tail = Promise.resolve(); // FIFO reservation chain
    this.total = 0;
    this.throttled = 0;
    this.retries = 0;
    this.shed = 0;                 // times a caller waited on the token budget
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
    if (this.tokenMax > 0) {
      const tc = now - this.tokenWindowMs;
      while (this.tokens.length && this.tokens[0].t <= tc) this.tokens.shift();
    }
  }

  tokenSum() {
    let n = 0;
    for (const e of this.tokens) n += e.n;
    return n;
  }

  // milliseconds the caller must wait; 0 means a slot is free now
  waitTime(now, estTokens = 0) {
    this.prune(now);
    if (this.blockedUntil > now) return this.blockedUntil - now;
    if (this.max > 0 && this.stamps.length >= this.max) {
      return this.stamps[0] + this.windowMs - now;
    }
    if (this.tokenMax > 0 && estTokens > 0) {
      // A single request can exceed the whole budget (a huge compaction
      // prompt). It must still be admitted, or it would wait forever: clamp
      // the estimate to the budget and only queue behind existing traffic.
      const est = Math.min(estTokens, this.tokenMax);
      const used = this.tokenSum();
      if (used + est > this.tokenMax) {
        // wait until enough of the oldest reservations age out
        let need = used + est - this.tokenMax;
        let acc = 0;
        for (const e of this.tokens) {
          acc += e.n;
          if (acc >= need) return e.t + this.tokenWindowMs - now;
        }
        return this.tokenWindowMs;
      }
    }
    return 0;
  }

  reserve(now, estTokens) {
    this.prune(now);
    if (this.max > 0) {
      this.stamps.push(now);
      this.total++;
    }
    let entry = null;
    if (this.tokenMax > 0 && estTokens > 0) {
      entry = { t: now, n: Math.min(estTokens, this.tokenMax) };
      this.tokens.push(entry);
    }
    return entry;
  }

  // Replace a reservation's estimate with what the request actually used.
  reconcile(entry, actualTokens) {
    if (!entry || !Number.isFinite(actualTokens) || actualTokens <= 0) return;
    entry.n = Math.max(1, Math.round(actualTokens));
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
      tokenMax: this.tokenMax,
      tokenWindowMs: this.tokenWindowMs,
      tokensUsed: this.tokenSum(),
      blockedMs: Math.max(0, this.blockedUntil - now),
      total: this.total,
      throttled: this.throttled,
      retries: this.retries,
      shed: this.shed,
    };
  }
}

const limiters = new Map();

function limiterFor(model, slot = 0) {
  if (!model) return null;
  // Each key has its own per-model windows, so the limiter is keyed by both.
  const mapKey = slot ? `${slot}|${model}` : model;
  let lim = limiters.get(mapKey);
  if (lim) return lim;
  const cfg = LIMITS.get(model) || LIMIT_FALLBACK;
  const tok = TOKEN_LIMITS.get(model) || TOKEN_FALLBACK;
  const max = cfg ? cfg.max : 0;
  const tokenMax = tok ? tok.max : 0;
  if (max <= 0 && tokenMax <= 0) return null;
  lim = new ModelLimiter(
    model,
    max,
    cfg ? cfg.windowMs : 60000,
    tokenMax,
    tok ? tok.windowMs : 60000,
  );
  limiters.set(mapKey, lim);
  return lim;
}

// Strict FIFO: each caller awaits the previous reservation. Reservation is
// instant, so this serializes slots rather than requests.
//
// With `maxWaitMs`, a caller gives up its place instead of waiting longer than
// that and resolves `{ spill: true }` without reserving anything, so the caller
// can send the request somewhere else (see the overflow rules below).
function acquire(model, estTokens = 0, maxWaitMs = 0, slot = 0) {
  const lim = limiterFor(model, slot);
  if (!lim) return Promise.resolve(null);
  const calledAt = Date.now();
  let cancelled = false;
  const run = lim.tail.then(async () => {
    if (cancelled) return { spill: true };
    const start = Date.now();
    for (;;) {
      if (cancelled) return { spill: true };
      const now = Date.now();
      const wait = lim.waitTime(now, estTokens);
      if (wait > 0 && maxWaitMs > 0 && now + wait - calledAt > maxWaitMs) {
        cancelled = true;
        return { spill: true };
      }
      if (wait <= 0) {
        const entry = lim.reserve(now, estTokens);
        const waited = now - start;
        if (waited > 0) {
          lim.throttled++;
          if (waited > QUEUE_LOG_MS) {
            log(`throttled ${model} for ${(waited / 1000).toFixed(1)}s (${lim.max}/${lim.windowMs / 1000}s` +
              `${lim.tokenMax > 0 ? `, ${lim.tokenSum()}/${lim.tokenMax} tokens` : ""})`);
          }
        }
        return { limiter: lim, entry };
      }
      await sleep(Math.min(wait, 1000));
    }
  });
  lim.tail = run.catch(() => {});
  if (!maxWaitMs) return run;
  // Also leave the queue at the deadline even when whoever is ahead of us is
  // still waiting, so one slow caller cannot hold the others past their limit.
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cancelled = true; resolve({ spill: true }); }, maxWaitMs);
    run.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve({ spill: true }); });
  });
}

// ---- overflow spill ---------------------------------------------------------
// A model that is saturated (sonnet-5.5: 6 requests/minute) makes every extra
// request wait for a slot. With a rule, a request that would wait longer than
// the threshold is sent to a fallback model instead of queueing.
// Format (FASFAS_PROXY_OVERFLOW): "sonnet-5.5=haiku-5.5:20s,other=target:5s".
// Off by default: it swaps the model mid-conversation, so it is opt-in.
const OVERFLOW_DEFAULT_WAIT_MS = 20000;

function parseOverflow(src) {
  const out = new Map();
  for (const part of String(src).split(",")) {
    const e = part.trim();
    if (!e) continue;
    const eq = e.indexOf("=");
    if (eq < 0) continue;
    const from = e.slice(0, eq).trim();
    const [to, wait] = e.slice(eq + 1).split(":").map((s) => s.trim());
    const maxWaitMs = wait ? parseWindow(wait) : OVERFLOW_DEFAULT_WAIT_MS;
    if (!from || !to || from === to || !maxWaitMs) {
      log(`ignoring malformed overflow rule "${e}"`);
      continue;
    }
    out.set(from, { to, maxWaitMs });
  }
  return out;
}

const OVERFLOW = parseOverflow(process.env.FASFAS_PROXY_OVERFLOW || "");
const overflowStats = new Map(); // from -> { to, count }
// Overflow traffic that is in flight right now: target -> { count, from: Set }.
// The panel marks those models with a * while they are serving someone else's
// requests.
const overflowActive = new Map();

function markOverflowActive(target, from) {
  const e = overflowActive.get(target) || { count: 0, from: new Set() };
  e.count++;
  e.from.add(from);
  overflowActive.set(target, e);
}

function clearOverflowActive(target, from) {
  const e = overflowActive.get(target);
  if (!e) return;
  e.count = Math.max(0, e.count - 1);
  if (e.count === 0) {
    e.from.delete(from);
    if (e.from.size === 0) overflowActive.delete(target);
  }
}

// ---- key pool ---------------------------------------------------------------
// The gateway meters each key separately, so a second key means a second set of
// per-model windows. Keys are added from the panel and stored next to the
// plugin. One session is one key: it is pinned on first sight to the key with the
// fewest sessions, and every request it makes is charged to that key's windows
// and no other. There is no round-robin.
// FASFAS_PROXY_KEYS_FILE moves the file (the tests use a throwaway one).
const KEYS_FILE = process.env.FASFAS_PROXY_KEYS_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "keys.json");
// The file used to be hidden; it is moved to keys.json on first start.
const LEGACY_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".fasfas-keys.json");
const MAX_KEYS = 8;
const CORS_HEADERS = { "cache-control": "no-store", "access-control-allow-origin": "*" };
let keyPool = [];
let keyCursor = 0;
// sessionId -> 1-based key slot. A session is glued to one key: its requests
// follow that key's windows, and a second session on another key has its own.
const sessionKeyPins = new Map();
// A session counts toward its key's load only while it is live: seen within the
// last half hour. Pins of sessions that stopped long ago must not push new ones
// away from a key that is actually idle. Pins are forgotten after two weeks.
const SESSION_LIVE_MS = 30 * 60 * 1000;
const SESSION_PIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// sessionId -> { last, active, requests, model }. `last` is persisted so a
// restart does not make every live session look dead.
const sessionActivity = new Map();

function touchSession(sid, model) {
  const a = sessionActivity.get(sid) || { last: 0, active: 0, requests: 0, model: null };
  a.last = Date.now();
  a.requests++;
  if (model) a.model = model;
  sessionActivity.set(sid, a);
  saveKeysSoon();
  return a;
}

let keysSaveTimer = null;
function saveKeysSoon() {
  if (keysSaveTimer) return;
  keysSaveTimer = setTimeout(() => { keysSaveTimer = null; saveKeys(); }, 30000);
  try { keysSaveTimer.unref?.(); } catch {}
}

// After key `removed` (1-based) is deleted, later keys shift down one slot. Pins
// follow their key rather than their number, so a session never silently moves
// onto a different credential; sessions that were on the removed key are
// reassigned on their next request.
function remapPinsAfterRemoval(removed) {
  for (const [sid, slot] of [...sessionKeyPins]) {
    if (slot === removed) sessionKeyPins.delete(sid);
    else if (slot > removed) sessionKeyPins.set(sid, slot - 1);
  }
}

function loadKeys() {
  let fromFile = [];
  let migrate = false;
  let source = KEYS_FILE;
  if (!fs.existsSync(KEYS_FILE) && fs.existsSync(LEGACY_KEYS_FILE)) {
    source = LEGACY_KEYS_FILE;
    migrate = true;
  }
  try {
    const j = JSON.parse(fs.readFileSync(source, "utf8"));
    if (Array.isArray(j.keys)) fromFile = j.keys;
    if (j && typeof j.pins === "object" && j.pins) {
      for (const [sid, slot] of Object.entries(j.pins)) {
        if (typeof sid === "string" && Number.isInteger(slot)) sessionKeyPins.set(sid, slot);
      }
    }
    if (j && typeof j.seen === "object" && j.seen) {
      for (const [sid, ts] of Object.entries(j.seen)) {
        if (Number.isFinite(ts)) sessionActivity.set(sid, { last: ts, active: 0, requests: 0, model: null });
      }
    }
  } catch {}
  {
    const now = Date.now();
    for (const sid of [...sessionKeyPins.keys()]) {
      const a = sessionActivity.get(sid);
      if (!a) {
        // pinned by an older file with no timestamp: keep it, but not as live
        sessionActivity.set(sid, { last: now - SESSION_LIVE_MS - 1, active: 0, requests: 0, model: null });
      } else if (now - a.last > SESSION_PIN_TTL_MS) {
        sessionKeyPins.delete(sid);
        sessionActivity.delete(sid);
      }
    }
  }
  const fromEnv = String(process.env.FASFAS_PROXY_KEYS || "").split(",");
  keyPool = [...new Set([...fromEnv, ...fromFile].map((k) => String(k || "").trim()).filter(Boolean))].slice(0, MAX_KEYS);

  if (migrate) {
    saveKeys();
    if (fs.existsSync(KEYS_FILE)) {
      try { fs.unlinkSync(LEGACY_KEYS_FILE); } catch {}
      log(`moved ${path.basename(LEGACY_KEYS_FILE)} -> ${path.basename(KEYS_FILE)} (${keyPool.length} key(s) kept)`);
    }
  }
}

function saveKeys() {
  if (retired) return;
  try {
    const pins = {};
    const seen = {};
    for (const [sid, slot] of sessionKeyPins) {
      pins[sid] = slot;
      const a = sessionActivity.get(sid);
      if (a && a.last) seen[sid] = a.last;
    }
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: keyPool, pins, seen }, null, 2) + "\n", "utf8");
    try { fs.chmodSync(KEYS_FILE, 0o600); } catch {}
  } catch (e) {
    log(`could not save keys: ${e?.message || e}`);
  }
}

function maskKey(k) {
  const s = String(k || "");
  return s.length <= 4 ? "…" : "…" + s.slice(-4);
}

// Which key slot a session uses: an explicit pin, or the least-pinned slot,
// which is then remembered so the session stays on it for good.
function keySlotForSession(sessionId) {
  if (keyPool.length === 0) return 0;
  if (!sessionId) return 1;

  const pinned = sessionKeyPins.get(sessionId);
  if (Number.isInteger(pinned) && pinned >= 1 && pinned <= keyPool.length) return pinned;

  // Only live sessions count: one that stopped hours ago is not load.
  const counts = liveSessionCounts();
  const slot = counts.indexOf(Math.min(...counts)) + 1;
  sessionKeyPins.set(sessionId, slot);
  saveKeys();
  return slot;
}

function liveSessionCounts() {
  const counts = new Array(keyPool.length).fill(0);
  const now = Date.now();
  for (const [sid, slot] of sessionKeyPins) {
    const a = sessionActivity.get(sid);
    if (!a || now - a.last > SESSION_LIVE_MS) continue;
    if (Number.isInteger(slot) && slot >= 1 && slot <= keyPool.length) counts[slot - 1]++;
  }
  return counts;
}

function pickKey(sessionId) {
  const slot = keySlotForSession(sessionId);
  if (slot >= 1 && slot <= keyPool.length) return keyPool[slot - 1];
  return keyPool[0] || null;
}

function keysReport() {
  const now = Date.now();
  const pins = {};
  for (const [sid, slot] of sessionKeyPins) pins[sid] = slot;
  const live = liveSessionCounts();

  // Sessions seen recently, with the key each one is glued to. Active ones
  // (a request in flight) first, then most recently used.
  const sessions = [];
  for (const [id, a] of sessionActivity) {
    if (now - a.last > SESSION_LIVE_MS) continue;
    sessions.push({
      id,
      key: sessionKeyPins.get(id) || 0,
      active: a.active,
      requests: a.requests,
      model: a.model,
      idleMs: Math.max(0, now - a.last),
    });
  }
  sessions.sort((x, y) => (y.active > 0) - (x.active > 0) || x.idleMs - y.idleMs);

  return {
    keys: keyPool.map((k, i) => ({ index: i + 1, hint: maskKey(k), sessions: live[i] || 0 })),
    pins,
    sessions,
    max: MAX_KEYS,
    file: KEYS_FILE,
  };
}

// ---- manual model ping -----------------------------------------------------
// POST /ping sends one tiny prompt to each model, so the panel can show which
// model is alive and what it calls itself. Pings obey the same limiters as real
// traffic, requests and tokens both: a ping waits for a free slot instead of
// jumping the queue, and it is only skipped if the wait would outlast any window
// (three minutes).
const PING_PROMPT = "State the model you are and reply in exactly this form: I run <model name>, pong";
const PING_MAX_WAIT_MS = Number(process.env.FASFAS_PROXY_PING_WAIT_MS) || 180000;
let lastAuthHeader = null; // most recent gateway credential seen on a real request

async function pingModel(model, auth) {
  const started = Date.now();
  // Include the reply budget so the token reservation cannot push a window over
  // its cap: the limiter sees prompt + max_tokens up front.
  const estTokens = Math.ceil((PING_PROMPT.length + 64) / 4) + 60;
  // A ping is not a session, so it runs on key 1 and never touches a pinned
  // session's windows on another key.
  const pingSlot = keyPool.length ? 1 : 0;
  const lim = limiterFor(model, pingSlot);
  let reservation = null;
  let queueMs = 0;

  if (lim) {
    PROXY_STATE.queued++;
    try { reservation = await acquire(model, estTokens, PING_MAX_WAIT_MS, pingSlot); } finally { PROXY_STATE.queued--; }
    queueMs = Date.now() - started;
    if (reservation && reservation.spill) {
      const waitMs = lim.waitTime(Date.now(), estTokens);
      return { model, ok: false, skipped: true, queueMs, ms: Date.now() - started, error: `no free slot within ${Math.round(PING_MAX_WAIT_MS / 1000)}s, next in ${Math.ceil(waitMs / 1000)}s` };
    }
  }

  try {
    const payload = { model, stream: false, max_tokens: 60, messages: [{ role: "user", content: PING_PROMPT }] };
    const res = await postJson("/chat/completions", { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, payload, 60000);
    const ms = Date.now() - started;
    if (res.status >= 400) {
      return { model, ok: false, queueMs, ms, error: `HTTP ${res.status}: ${res.text.replace(/\s+/g, " ").slice(0, 140)}` };
    }
    const j = JSON.parse(res.text);
    const text = (j?.choices?.[0]?.message?.content || "").trim();
    const u = parseUsageFromText(res.text);
    // A non-streaming reply has no first-token time, so it carries no gm/ttft and
    // stays out of tok/s; it still counts toward requests and tokens.
    if (u) appendUsageRecord({ t: Date.now(), m: model, i: u.prompt, o: u.completion, r: u.reasoning, c: u.cached, ms: Math.max(0, ms - queueMs) });
    reconcileTokens(reservation, estTokens, Buffer.byteLength(res.text));
    return { model, ok: true, queueMs, ms, text };
  } catch (e) {
    return { model, ok: false, queueMs, ms: Date.now() - started, error: String(e?.message || e) };
  }
}

// One limiter per model, so the models are pinged concurrently and a busy model
// only delays its own row.
async function pingModels(models, auth) {
  return Promise.all(models.map((m) => pingModel(m, auth)));
}

// ---- vision handoff --------------------------------------------------------
// A text-only target that receives image parts cannot see them. Each image is
// captioned with the vision model, the image part is replaced by the caption
// text, and the request continues to the ORIGINAL model. Captions are cached by
// image hash, so a screenshot resent on a later turn costs nothing.
const VISION_MODEL_DEFAULT = "glm-5.3-flash";
// Every model on this gateway accepts images natively (verified: haiku and
// sonnet name all four quadrants of a 64x64 image), so no model is captioned by
// default. Captioning throws the pixels away, which breaks anything that needs
// the actual image. List a model here only if it really cannot see.
// A rejected image request still falls back to captions automatically.
const VISION_TARGETS_DEFAULT = "";
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

// ---- compaction handling ---------------------------------------------------
// Compaction is the one request whose failure kills the whole turn: OpenCode
// maps a content-filter finish to "Compaction summary was blocked by the
// provider" and gives up. Compaction is a single big request that carries no
// tools, so it is both easy to recognise and worth protecting:
//   - it waits until no other request is in flight (no quota contention);
//   - if the provider blocks it (content filter, error, unknown finish, 4xx),
//     the same body is re-dispatched to a handoff model instead.
const COMPACTION_ENABLED = !/^(0|false|off)$/i.test(process.env.FASFAS_PROXY_COMPACTION || "1");
const COMPACTION_MODEL = process.env.FASFAS_PROXY_COMPACTION_MODEL || "glm-5.3-flash";
const COMPACTION_MIN_CHARS = Number(process.env.FASFAS_PROXY_COMPACTION_MIN_BYTES) || 20000;
// Finish reasons that mean "the provider refused", not "the answer ended".
const BLOCKED_FINISH_RE = /^(content[-_]?filter|contentfilter|safety|blocked|refusal|sensitive)$/i;

function looksLikeCompaction(meta) {
  if (!COMPACTION_ENABLED || !meta.json) return false;
  if (meta.model === COMPACTION_MODEL) return false;
  const tools = meta.json.tools;
  if (Array.isArray(tools) && tools.length > 0) return false; // normal tool turn
  return meta.chars >= COMPACTION_MIN_CHARS;
}

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
async function analyzeImage({ auth, url, slot = 0 }) {
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
      await acquire(VISION_MODEL, 0, 0, slot);
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
async function visionHandoff(rawBody, model, auth, force = false, slot = 0) {
  if (!VISION_ENABLED || !model || model === VISION_MODEL) return rawBody;
  if (!force && !targetMatches(model)) return rawBody;

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
        desc = await analyzeImage({ auth, url: img.url, slot });
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

const PROXY_STATE = { active: 0, queued: 0, started: Date.now(), requests: 0, retries: 0, retries5xx: 0 };

// Live retry state per OpenCode session, for the composer pill. Keyed by the
// x-opencode-session-id header OpenCode sends with every request.
const sessionRetries = new Map();

function noteSessionRetry(sessionId, status, model) {
  if (!sessionId) return;
  const e = sessionRetries.get(sessionId) || { retries: 0, status: status, model: model, since: Date.now(), updated: Date.now() };
  e.retries++;
  e.status = status;
  e.model = model;
  e.updated = Date.now();
  sessionRetries.set(sessionId, e);
}

function clearSessionRetry(sessionId) {
  if (sessionId) sessionRetries.delete(sessionId);
}

function sessionRetryReport(now) {
  const out = {};
  for (const [id, e] of sessionRetries) {
    if (now - e.updated > 5 * 60 * 1000) { sessionRetries.delete(id); continue; }
    out[id] = { retries: e.retries, status: e.status, model: e.model, ageMs: now - e.since };
  }
  return out;
}

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

function learnFrom429(model, headers, text, slot = 0) {
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

  // Only the session's own key slot is blocked: a 429 on key 1 must not stall
  // a session pinned to key 2.
  let lim = limiterFor(model, slot);
  if (discovered) {
    if (!lim) {
      lim = new ModelLimiter(model, discovered.max, discovered.windowMs);
      limiters.set(slot ? `${slot}|${model}` : model, lim);
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

function readRequest(body) {
  let json = null;
  try { json = JSON.parse(body.toString("utf8")); } catch {}
  return {
    json,
    model: typeof json?.model === "string" ? json.model : null,
    stream: json?.stream === true,
    maxTokens: json?.max_tokens ?? json?.max_completion_tokens ?? null,
    // Inline images are base64: a single screenshot would otherwise make an
    // ordinary vision request look like a huge compaction prompt.
    chars: json ? JSON.stringify(json.messages || []).replace(/data:[^"\\]+/g, "data:image").length : 0,
  };
}

// ---- request handling ------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${LISTEN_HOST}`);

  // After a hot reload this copy only drains. Its connections must not stay open
  // for the client to reuse, or the next request would still reach the old code.
  activeResponses.add(res);
  res.on("close", () => activeResponses.delete(res));
  if (retired) { try { res.setHeader("connection", "close"); } catch {} }

  // CORS preflight for the panel's POST /ping.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    });
    return res.end();
  }

  // Replace the running code with the current index.js, no service restart. The
  // custom header makes this a non-simple request, so a web page cannot trigger
  // it: our CORS preflight does not allow the header.
  if (req.method === "POST" && url.pathname === "/admin/reload") {
    if (req.headers["x-fasfas-admin"] !== "1") {
      return sendJson(res, 403, JSON.stringify({ error: "send the x-fasfas-admin: 1 header" }));
    }
    res.on("finish", () => setTimeout(() => { hotReload().catch((e) => log(`hot reload failed: ${e?.stack || e}`)); }, 100));
    return send(res, 200, "application/json", JSON.stringify({ reloading: true }) + "\n", { "cache-control": "no-store" });
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, "text/plain", "fasfas-proxy OK\n");
  }
  if (req.method === "GET" && url.pathname === "/keys/reveal") {
    // The only route that returns a full key. It answers one key per request,
    // only to loopback, and refuses browser pages (http/https origins), so a web
    // page open in a browser cannot read a key from here.
    const origin = req.headers.origin || "";
    const ra = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra) || /^https?:\/\//i.test(origin)) {
      return sendJson(res, 403, JSON.stringify({ error: "not available to this origin" }));
    }
    const slot = Number(url.searchParams.get("slot"));
    if (!Number.isInteger(slot) || slot < 1 || slot > keyPool.length) {
      return sendJson(res, 404, JSON.stringify({ error: "no such key" }));
    }
    return send(res, 200, "application/json", JSON.stringify({ slot, key: keyPool[slot - 1] }) + "\n",
      { "cache-control": "no-store", "access-control-allow-origin": origin || "null" });
  }

  if (url.pathname === "/keys") {
    if (req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify(keysReport(), null, 2) + "\n", CORS_HEADERS);
    }
    if (req.method === "POST") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {}

      if (Array.isArray(body.keys)) {
        keyPool = [...new Set(body.keys.map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_KEYS);
      } else if (Number.isInteger(body.set) && typeof body.key === "string" && body.key.trim()) {
        // Address one slot directly, which is what the panel's Key 1 / Key 2
        // fields use.
        const n = body.set;
        if (n < 1 || n > MAX_KEYS) return sendJson(res, 400, JSON.stringify({ error: `slot must be 1..${MAX_KEYS}` }));
        const k = body.key.trim();
        while (keyPool.length < n) keyPool.push("");
        keyPool[n - 1] = k;
        keyPool = keyPool.filter(Boolean).slice(0, MAX_KEYS);
      } else if (body.pin && typeof body.pin.session === "string" && Number.isInteger(body.pin.key)) {
        const slot = body.pin.key;
        if (slot < 1 || slot > keyPool.length) {
          return sendJson(res, 400, JSON.stringify({ error: `no key ${slot}; ${keyPool.length} configured` }));
        }
        sessionKeyPins.set(body.pin.session, slot);
        log(`pinned session ${body.pin.session} to key ${slot}`);
      } else if (typeof body.unpin === "string") {
        sessionKeyPins.delete(body.unpin);
        log(`unpinned session ${body.unpin}`);
      } else if (typeof body.add === "string" && body.add.trim()) {        const k = body.add.trim();
        if (keyPool.includes(k)) return sendJson(res, 409, JSON.stringify({ error: "key already configured" }));
        if (keyPool.length >= MAX_KEYS) return sendJson(res, 409, JSON.stringify({ error: `at most ${MAX_KEYS} keys` }));
        keyPool.push(k);
      } else if (Number.isInteger(body.remove) && body.remove >= 1) {
        if (body.remove <= keyPool.length) {
          keyPool.splice(body.remove - 1, 1);
          remapPinsAfterRemoval(body.remove);
        }
      } else {
        return sendJson(res, 400, JSON.stringify({ error: 'send {"keys":[...]}, {"add":"<key>"} or {"remove":<index>}' }));
      }

      saveKeys();
      log(`keys updated: ${keyPool.length} configured (${keyPool.map(maskKey).join(", ") || "none"})`);
      return send(res, 200, "application/json", JSON.stringify(keysReport(), null, 2) + "\n", CORS_HEADERS);
    }
  }

  if (req.method === "POST" && url.pathname === "/ping") {
    const raw = await readBody(req);
    let requested = null;
    try {
      const parsed = JSON.parse(raw.toString("utf8") || "{}");
      if (Array.isArray(parsed.models)) requested = parsed.models.filter((m) => typeof m === "string" && m);
    } catch {}

    const models = requested && requested.length
      ? [...new Set(requested)]
      : [...new Set([
        ...[...LIMITS].filter(([k]) => k !== "*").map(([k]) => k),
        ...[...TOKEN_LIMITS].filter(([k]) => k !== "*").map(([k]) => k),
      ])].sort();

    const auth = pickKey(null) || req.headers.authorization || lastAuthHeader;
    log(`ping ${models.length} model(s) via POST /ping: ${models.join(" ")}`);
    const results = await pingModels(models, auth);
    log(`ping done: ${results.map((r) => `${r.model}=${r.ok ? "ok" : r.skipped ? "skipped" : "fail"}`).join(" ")}`);
    return send(res, 200, "application/json", JSON.stringify({ updated: Date.now(), prompt: PING_PROMPT, results }, null, 2) + "\n",
      { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }
  if (req.method === "GET" && url.pathname === "/usage") {
    return send(res, 200, "application/json", JSON.stringify(usageReport(), null, 2) + "\n",
      { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }
  if (req.method === "GET" && url.pathname === "/status") {
    const now = Date.now();
    // Each key slot has its own windows at the gateway's real per-key cap. The
    // account total is that cap times the number of keys: usage is summed across
    // slots, the cap is not. One key reports 6, two keys report 12.
    const accountKeys = Math.max(1, keyPool.length);
    const models = {};
    for (const lim of limiters.values()) {
      const snap = lim.snapshot(now);
      const cur = models[lim.model];
      if (!cur) { models[lim.model] = { ...snap }; continue; }
      cur.used += snap.used;
      cur.tokensUsed += snap.tokensUsed;
      cur.total += snap.total;
      cur.throttled += snap.throttled;
      cur.retries += snap.retries;
      cur.shed += snap.shed;
      cur.blockedMs = Math.max(cur.blockedMs, snap.blockedMs);
    }
    for (const [name, m] of Object.entries(models)) {
      const cfg = LIMITS.get(name) || LIMIT_FALLBACK;
      const tok = TOKEN_LIMITS.get(name) || TOKEN_FALLBACK;
      m.max = cfg ? cfg.max * accountKeys : 0;
      m.tokenMax = tok ? tok.max * accountKeys : 0;
    }
    return send(res, 200, "application/json", JSON.stringify({
      proxy: "fasfas-proxy",
      instance: INSTANCE_ID,
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
      overflow: {
        rules: Object.fromEntries([...OVERFLOW].map(([k, v]) => [k, `${v.to}:${v.maxWaitMs / 1000}s`])),
        spills: Object.fromEntries(overflowStats),
        active: Object.fromEntries([...overflowActive].map(([k, v]) => [k, { count: v.count, from: [...v.from] }])),
      },
      sessions: sessionRetryReport(now),
      retries5xx: PROXY_STATE.retries5xx || 0,
      compaction: {
        enabled: COMPACTION_ENABLED,
        handoffModel: COMPACTION_MODEL,
        minPromptChars: COMPACTION_MIN_CHARS,
        handoffs: PROXY_STATE.compactionHandoffs || 0,
      },
      keys: accountKeys,
      // Account totals: the per-key caps times the configured key count.
      limits: Object.fromEntries(
        [...LIMITS].filter(([k]) => k !== "*").map(([k, v]) => [k, `${v.max * accountKeys}/${v.windowMs / 1000}s`])),
      tokenLimits: Object.fromEntries(
        [...TOKEN_LIMITS].filter(([k]) => k !== "*").map(([k, v]) => [k, `${v.max * accountKeys}/${v.windowMs / 1000}s`])),
      models,
      updated: now,
    }, null, 2) + "\n", { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }

  let body = await readBody(req);
  let meta = readRequest(body);
  let model = meta.model;
  const isChat = url.pathname.includes("/chat/completions");
  const sessionId = req.headers["x-opencode-session-id"] || req.headers["x-opencode-session"] || null;
  // With a key pool configured, this request goes out on the key its session is
  // pinned to, and follows that key's windows rather than the shared ones.
  const keySlot = keySlotForSession(sessionId);
  if (keySlot >= 1 && keySlot <= keyPool.length) {
    req.headers.authorization = `Bearer ${keyPool[keySlot - 1]}`;
  }
  const started = Date.now();

  log(`req ${req.method} ${url.pathname} model=${model || "-"} stream=${meta.stream} bytes=${body.length} max_tokens=${meta.maxTokens ?? "default"} key=${keySlot || "-"}`);

  PROXY_STATE.requests++;
  PROXY_STATE.active++;
  let spill = null; // { target, from } while this request is served by a fallback
  // Mark the session live, with a request in flight, for the panel's session list.
  const sessionAct = sessionId ? touchSession(sessionId, model) : null;
  if (sessionAct) sessionAct.active++;
  try {
    if (req.headers.authorization) lastAuthHeader = req.headers.authorization;
    if (isChat && model) {
      body = await visionHandoff(body, model, req.headers.authorization, false, keySlot);
      const after = readRequest(body);
      if (after.model) meta = after;
      model = after.model || model;
    }

    // Compaction: no tools + a large prompt. Wait for other requests to settle
    // so it does not compete for the per-minute window, then run it with a
    // fallback model if the provider blocks the summary.
    if (isChat && model && looksLikeCompaction(meta)) {
      await deferWhileBusy(model);
      const finished = await runCompaction(req, res, url, body, model, keySlot);
      if (finished) return;
      meta = readRequest(body);
      model = meta.model || model;
    }

    const estTokens = estimateTokens(body);
    let reservation = null;
    let spilledFrom = null;

    // Send this request to the overflow model instead of waiting on `model`.
    const spillOver = async (why) => {
      const rule = OVERFLOW.get(model);
      if (!rule || spilledFrom) return false;
      spilledFrom = model;
      const stat = overflowStats.get(model) || { to: rule.to, count: 0 };
      stat.to = rule.to;
      stat.count++;
      overflowStats.set(model, stat);
      log(`overflow ${model} -> ${rule.to} (${why})`);
      body = rewriteModel(body, rule.to);
      const from = model;
      model = rule.to;
      spill = { target: rule.to, from };
      markOverflowActive(rule.to, from);
      reservation = null;
      if (limiterFor(model, keySlot)) {
        PROXY_STATE.queued++;
        try { reservation = await acquire(model, estTokens, 0, keySlot); } finally { PROXY_STATE.queued--; }
      }
      return true;
    };

    if (isChat && model && limiterFor(model, keySlot)) {
      const rule = OVERFLOW.get(model);
      const queuedAt = Date.now();
      PROXY_STATE.queued++;
      try { reservation = await acquire(model, estTokens, rule ? rule.maxWaitMs : 0, keySlot); } finally { PROXY_STATE.queued--; }
      if (reservation && reservation.spill) {
        await spillOver(`a slot would take over ${rule.maxWaitMs / 1000}s`);
      } else {
        const waited = Date.now() - queuedAt;
        if (waited > QUEUE_LOG_MS) log(`slot for ${model} after ${(waited / 1000).toFixed(1)}s`);
      }
    }

    // A request that carries images may be refused upstream; if so it is retried
    // once with the images captioned. Only possible when a vision model exists.
    const reqJson = isChat && VISION_ENABLED ? readRequest(body).json : null;
    let imageFallback = !!reqJson && model !== VISION_MODEL && collectImageParts(reqJson).length > 0;

    const maxAttempts = MAX_429_RETRIES + 2;
    let serverAttempts = 0;
    const budgetStart = Date.now();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await forward(req, res, url, body, model, isChat, {
        headers: spilledFrom ? { "x-fasfas-overflow": `${spilledFrom}->${model}` } : {},
        imageFallback,
        retry5xx: true,
      });
      if (result.done) {
        reconcileTokens(reservation, estTokens, result.bytes);
        recordUsage(model, result, Date.now() - started);
        return;
      }
      if (result.visionFallback) {
        imageFallback = false;
        log(`upstream rejected an image request for ${model} (400); retrying with captions :: ${String(result.text).replace(/\s+/g, " ").slice(0, 160)}`);
        body = await visionHandoff(body, model, req.headers.authorization, true, keySlot);
        continue;
      }
      if (result.serverError) {
        // 5xx from the gateway or its CDN. Usually transient; retry the same
        // body with backoff, and record it per session for the UI.
        const attemptNo = (serverAttempts += 1);
        PROXY_STATE.retries5xx = (PROXY_STATE.retries5xx || 0) + 1;
        noteSessionRetry(sessionId, result.status, model);
        if (attemptNo > MAX_5XX_RETRIES || Date.now() - budgetStart > RATE_LIMIT_BUDGET_MS) {
          log(`upstream ${result.status} for ${model} after ${attemptNo - 1} retries; forwarding it (${body.length} bytes)`);
          clearSessionRetry(sessionId);
          return sendJson(res, result.status, result.text);
        }
        const wait = Math.min(500 * 2 ** (attemptNo - 1), 15000);
        log(`upstream ${result.status} for ${model} (${body.length} bytes); retrying in ${wait / 1000}s (attempt ${attemptNo}/${MAX_5XX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      if (Date.now() - budgetStart > RATE_LIMIT_BUDGET_MS) {
        log(`429 budget exhausted for ${model}, forwarding the 429`);
        return sendJson(res, result.status, result.text);
      }
      const { retryMs } = learnFrom429(model, result.headers, result.text, keySlot);
      PROXY_STATE.retries++;
      const rule = OVERFLOW.get(model);
      if (rule && !spilledFrom && retryMs > rule.maxWaitMs) {
        await spillOver(`upstream 429, retry in ${Math.round(retryMs / 1000)}s`);
        continue;
      }
      log(`upstream 429 for ${model}; waiting ${Math.round(retryMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(retryMs);
    }
  } finally {
    if (spill) clearOverflowActive(spill.target, spill.from);
    if (sessionAct) sessionAct.active = Math.max(0, sessionAct.active - 1);
    clearSessionRetry(sessionId);
    PROXY_STATE.active--;
    log(`done ${url.pathname} model=${model || "-"} in ${Date.now() - started}ms`);
  }
}

// One upstream attempt. Resolves {done:true} when the client has been answered,
// or {retry:true,status,headers,text} when the 429 should be absorbed.
function forward(req, res, url, body, model, isChat, opts = {}) {
  return new Promise((resolve) => {
    const headers = buildForwardHeaders(req.headers, body.length);

    let settled = false;
    let respBytes = 0;
    let firstByteAt = 0;
    // Timing for tok/s. The clock starts at the first frame that carries model
    // text, not the first byte: SSE keep-alives and role-only frames are not
    // generation, and counting them makes slow starts look like slow decoding.
    let firstTokenAt = 0;
    let lastTokenAt = 0;
    let tokenFrames = 0;
    let sawReasoning = false;
    const sentAt = Date.now();
    let tail = "";
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
      upRes.on("data", (c) => {
        respBytes += c.length;
        if (!firstByteAt) firstByteAt = Date.now();
        if (status === 200) {
          const text = c.toString("utf8");
          tail = (tail + text).slice(-8192);
          // A frame counts as generation when it carries content or reasoning.
          if (/"(content|reasoning|reasoning_content|text)"\s*:\s*"[^"]/.test(text)) {
            const now = Date.now();
            if (!firstTokenAt) firstTokenAt = now;
            lastTokenAt = now;
            tokenFrames++;
            if (/"(reasoning|reasoning_content)"\s*:\s*"[^"]/.test(text)) sawReasoning = true;
          }
        }
      });
      const hdrs = { ...upRes.headers, ...(opts.headers || {}) };
      delete hdrs["transfer-encoding"];
      delete hdrs["content-length"];
      delete hdrs.connection;

      if (status !== 200) {
        // Always leave a trace of a non-2xx: this is what makes a failed turn
        // attributable instead of an opaque "blocked by the provider".
        const ct = String(hdrs["content-type"] || "");
        if (!ct.includes("event-stream")) {
          const chunks = [];
          let size = 0;
          upRes.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
          upRes.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            log(`res ${status} model=${model || "-"} :: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
            if (status === 429 && isChat && model) return finish({ retry: true, status, headers: upRes.headers, text });
            // Transient 5xx: let the caller retry the same body.
            if (status >= 500 && isChat && opts.retry5xx) return finish({ serverError: true, status, headers: upRes.headers, text });
            // The upstream refused a request that carries images: let the caller
            // retry once with the images captioned instead of failing the turn.
            if (status === 400 && opts.imageFallback) return finish({ visionFallback: true, status, text });
            res.writeHead(status, hdrs);
            res.end(text);
            finish({ done: true });
          });
          upRes.on("error", () => {
            if (status === 429 && isChat && model) return finish({ retry: true, status, headers: upRes.headers, text: "" });
            try { res.end(); } catch {}
            finish({ done: true });
          });
          return;
        }
      }

      log(`res ${status} model=${model || "-"} ct=${hdrs["content-type"] || "-"}`);
      res.writeHead(status, hdrs);
      upRes.pipe(res);
      const timing = () => ({ sentAt, firstTokenAt, lastTokenAt, tokenFrames, sawReasoning });
      upRes.on("end", () => finish({ done: true, status, bytes: respBytes, tail, timing: timing() }));
      upRes.on("error", () => { try { res.end(); } catch {} finish({ done: true, status, bytes: respBytes, tail, timing: timing() }); });
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        log(`client closed mid-stream model=${model || "-"} (upstream ${up.res?.statusCode || "pending"})`);
        try { up.destroy(); } catch {}
      }
    });
    up.end(body);
  });
}

// ---- compaction path -------------------------------------------------------

function reconcileTokens(reservation, estTokens, respBytes) {
  if (!reservation) return;
  const actual = estTokens + Math.ceil((respBytes || 0) / 4);
  reservation.limiter.reconcile(reservation.entry, actual);
}

// Rough prompt size, with inline data URLs collapsed so a screenshot is not
// counted as hundreds of thousands of text tokens before it reaches upstream.
function estimateTokens(body) {
  let text = body.toString("utf8");
  if (text.includes("data:")) text = text.replace(/data:[^"\\]+/g, "data:image");
  return Math.ceil(text.length / 4);
}

// Wait until no other request is in flight. The compaction request is the one
// whose failure costs a whole turn, so it gets a quiet window instead of racing
// long turns for the same per-minute budget.
async function deferWhileBusy(model) {
  const t0 = Date.now();
  while (PROXY_STATE.active > 1) {
    await sleep(250);
    if (Date.now() - t0 > 120000) break; // never park a turn forever
  }
  const waited = Date.now() - t0;
  if (waited > 500) log(`deferred compaction ${model} ${(waited / 1000).toFixed(1)}s until in-flight requests settled`);
}

function rewriteModel(body, model) {
  try {
    const json = JSON.parse(body.toString("utf8"));
    json.model = model;
    return Buffer.from(JSON.stringify(json), "utf8");
  } catch {
    return body;
  }
}

// One upstream attempt, fully buffered. Used only for compaction: the response
// is small enough to hold, and we must see the finish reason before deciding to
// forward it or hand off to the fallback model.
function forwardBuffered(req, url, body, model) {
  return new Promise((resolve) => {
    const headers = buildForwardHeaders(req.headers, body.length);
    let up;
    try {
      up = upstreamRequest(targetUrl(url.pathname + url.search), { method: req.method, headers });
    } catch (err) {
      return resolve({ status: 502, headers: {}, text: `fasfas-proxy: ${err?.message || err}`, finish: null });
    }
    up.on("error", (err) => resolve({ status: 502, headers: {}, text: `fasfas-proxy upstream error: ${err?.message || err}`, finish: null }));
    up.on("response", (upRes) => {
      const chunks = [];
      let size = 0;
      upRes.on("data", (c) => { chunks.push(c); size += c.length; });
      upRes.on("end", () => {
        const text = Buffer.concat(chunks, size).toString("utf8");
        const hdrs = { ...upRes.headers };
        resolve({
          status: upRes.statusCode || 502,
          headers: hdrs,
          text,
          finish: extractFinish(upRes.headers["content-type"], text),
        });
      });
      upRes.on("error", (err) => resolve({ status: 502, headers: {}, text: `fasfas-proxy stream error: ${err?.message || err}`, finish: null }));
    });
    up.end(body);
  });
}

function extractFinish(contentType, text) {
  if (String(contentType || "").includes("event-stream")) {
    let last = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const m = /"finish_reason"\s*:\s*"([^"]+)"/.exec(t);
      if (m) last = m[1];
    }
    return last;
  }
  try {
    const j = JSON.parse(text);
    const r = j?.choices?.[0]?.finish_reason;
    if (typeof r === "string") return r;
    if (j?.error) return "error";
  } catch {}
  return null;
}

function isBlockedCompaction(r) {
  if (r.finish && BLOCKED_FINISH_RE.test(r.finish)) return true;
  if (r.finish === "error") return true;
  if (r.status >= 400) return true; // 429 is handled before this point
  return false;
}

function writeBuffered(res, r) {
  const hdrs = { ...r.headers };
  delete hdrs["transfer-encoding"];
  delete hdrs["content-length"];
  delete hdrs.connection;
  try {
    res.writeHead(r.status, hdrs);
    res.end(r.text);
  } catch {}
}

// Runs one compaction request: quiet window, then the original model, then the
// handoff model if the provider blocked it. Returns true when the client has
// been answered.
async function runCompaction(req, res, url, body, model, slot = 0) {
  const estTokens = estimateTokens(body);
  let reservation = null;
  if (limiterFor(model, slot)) {
    PROXY_STATE.queued++;
    try { reservation = await acquire(model, estTokens, 0, slot); } finally { PROXY_STATE.queued--; }
  }
  const settle = (r) => reconcileTokens(reservation, estTokens, usageTokens(r.text) || r.text.length);

  const budgetStart = Date.now();
  for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
    const r = await forwardBuffered(req, url, body, model);

    if (r.status === 429) {
      const { retryMs } = learnFrom429(model, r.headers, r.text, slot);
      PROXY_STATE.retries++;
      log(`upstream 429 for ${model} (compaction, key ${slot || "-"}); waiting ${Math.round(retryMs / 1000)}s (attempt ${attempt})`);
      if (Date.now() - budgetStart > RATE_LIMIT_BUDGET_MS) {
        writeBuffered(res, r);
        return true;
      }
      await sleep(retryMs);
      continue;
    }

    if (!isBlockedCompaction(r)) {
      log(`compaction ok model=${model} status=${r.status} finish=${r.finish || "-"} bytes=${r.text.length}`);
      settle(r);
      writeBuffered(res, r);
      return true;
    }

    log(`compaction blocked model=${model} status=${r.status} finish=${r.finish || "-"}; handing off to ${COMPACTION_MODEL}`);
    settle(r);
    PROXY_STATE.compactionHandoffs = (PROXY_STATE.compactionHandoffs || 0) + 1;
    const handoffBody = rewriteModel(body, COMPACTION_MODEL);
    let handoffReservation = null;
    if (limiterFor(COMPACTION_MODEL, slot)) handoffReservation = await acquire(COMPACTION_MODEL, estimateTokens(handoffBody), 0, slot);
    const r2 = await forwardBuffered(req, url, handoffBody, COMPACTION_MODEL);
    reconcileTokens(handoffReservation, estimateTokens(handoffBody), usageTokens(r2.text) || r2.text.length);
    log(`compaction handoff model=${COMPACTION_MODEL} status=${r2.status} finish=${r2.finish || "-"} bytes=${r2.text.length}`);
    writeBuffered(res, r2);
    return true;
  }
  return false;
}

function usageTokens(text) {
  const re = /"total_tokens"\s*:\s*(\d+)/g;
  let last = null, m;
  while ((m = re.exec(text))) last = Number(m[1]);
  return last;
}

function send(res, status, type, text, extra = {}) {  try {
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

  // OpenCode loads a plugin once per open location, and again on every config
  // reload. Killing the previous instance here would drop streams that are in
  // flight (a compaction or a long turn dies as a provider error), so the first
  // live instance keeps serving and later setup() calls become no-ops.
  // Consequence: updating plugin code needs a service restart, not a reload.
  const existing = globalThis.__fasfasProxyServer;
  if (existing && existing.listening && existing.__fasfasPort === port) {
    log(`reusing the running instance on port ${port} (a reload does not restart it)`);
    return;
  }
  // Only the copy that will serve loads the state files. A duplicate copy stops
  // above and never reads or writes them.
  loadUsage();
  loadKeys();
  globalThis.__fasfasProxyServer = server;
  server.__fasfasPort = port;

  const listen = () => {
    if (shuttingDown) return;
    server.listen(port, LISTEN_HOST, () => {
      if (listenRetryTimer) { clearTimeout(listenRetryTimer); listenRetryTimer = null; }
      const lim = [...LIMITS].filter(([k]) => k !== "*")
        .map(([k, v]) => `${k}=${v.max}/${v.windowMs / 1000}s`).join(" ");
      log(`listening (${mode}) on http://${LISTEN_HOST}:${port} -> ${UPSTREAM.href}`);
      log(`limits: ${lim || "none"}${LIMIT_FALLBACK ? ` (fallback ${LIMIT_FALLBACK.max}/${LIMIT_FALLBACK.windowMs / 1000}s)` : ""}`);
      log(`vision: ${VISION_ENABLED ? `on model=${VISION_MODEL} targets=${VISION_TARGETS.join(",")}` : "off"}`);
      log(`compaction: ${COMPACTION_ENABLED ? `on handoff=${COMPACTION_MODEL} minPrompt=${COMPACTION_MIN_CHARS} chars` : "off"}`);
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

// Swap in new code without restarting the OpenCode service. The new index.js is
// imported and checked FIRST: if it fails to load, the running proxy is left
// exactly as it was. Only then does the old copy stop taking new connections (the
// requests it already has run to completion on the old code) and the new copy
// bind the same port.
//
// What carries over: keys, pins and usage history (files). What does not: the
// in-memory rate windows, which start empty, so the first minute after a reload
// can send a little more than a key's cap upstream; the 429 retry absorbs that.
async function hotReload() {
  const old = globalThis.__fasfasProxyServer;
  if (!old) { log("hot reload: nothing is running to replace"); return false; }

  const href = pathToFileURL(fileURLToPath(import.meta.url)).href + `?reload=${Date.now()}`;
  let mod;
  globalThis.__fasfasHotReloading = true; // stops the new copy auto-starting itself
  try {
    mod = await import(href);
  } catch (e) {
    log(`hot reload aborted: the new index.js did not load (${e?.message || e}); still serving the old code`);
    return false;
  } finally {
    globalThis.__fasfasHotReloading = false;
  }
  if (typeof mod?.default?.setup !== "function") {
    log("hot reload aborted: the new index.js has no plugin entry; still serving the old code");
    return false;
  }

  log("hot reload: handing the port to the new code");
  saveKeys();
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ since: usage.since, lifetime: usage.lifetime })); } catch {}
  retired = true;
  // Requests already being served finish on this copy, and then close their
  // connection (headers not sent yet can still carry the instruction).
  for (const r of activeResponses) {
    try { if (!r.headersSent) r.setHeader("connection", "close"); } catch {}
  }
  globalThis.__fasfasProxyServer = null;
  try { old.close(); } catch {}              // stop listening, keep in-flight requests
  // Keep-alive sockets that were busy at this moment become idle when their
  // request finishes, and would otherwise stay attached to the old copy for good.
  // Sweep them for a while so clients move to the new copy.
  const sweep = () => { try { old.closeIdleConnections?.(); } catch {} };
  sweep();
  const sweeper = setInterval(sweep, 250);
  try { sweeper.unref?.(); } catch {}
  setTimeout(() => clearInterval(sweeper), 60000).unref?.();
  // Give the listening socket a moment to release, so the new copy binds on the
  // first try. If it still races, the bind retry (every 5s) picks it up.
  await new Promise((r) => setTimeout(r, 300));
  try {
    await mod.default.setup({});
  } catch (e) {
    log(`hot reload: the new copy failed to start: ${e?.stack || e}`);
    return false;
  }
  return true;
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
// A hot reload re-imports this file; the flag stops that copy from also starting
// itself as a standalone server (hotReload starts it through setup()).
if (invokedDirectly && !globalThis.__fasfasHotReloading) {
  startServer(Number(process.env.FASFAS_PROXY_PORT) || PORT_DEFAULT, "standalone")
    .catch((e) => log(`startServer failed: ${e?.stack || e}`));
}
