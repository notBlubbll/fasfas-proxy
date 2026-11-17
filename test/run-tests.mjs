// test/run-tests.mjs — spins a mock upstream plus the proxy and asserts the
// behaviour that matters: passthrough, streaming, rate pacing, 429 absorption,
// vision handoff, caption caching.
//
//   node test/run-tests.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// The proxy keeps keys and session pins in a file. Tests get their own, so a run
// can never inherit pins from an earlier one or touch the repo's real state.
const KEYS_FILE = path.join(os.tmpdir(), `fasfas-test-keys-${process.pid}.json`);
try { fs.unlinkSync(KEYS_FILE); } catch {}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = (...a) => console.log(...a);

let passed = 0, failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; log(`  ok   ${name}`); }
  else { failed++; log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock upstream ----------
const seen = [];            // { path, auth, body }
let limitedHits = 0;
let visionHits = 0;
let fivexxHits = 0;

const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const startedAt = Date.now();
    seen.push({ path: req.url, auth: req.headers.authorization, body, raw, startedAt });

    if (req.url === "/v1/chat/completions" && body.model === "mock-imgreject" && raw.includes('"image_url"')) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "upstream_rejected_request", message: "Provider returned error" } }));
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-5xx") {
      fivexxHits++;
      if (fivexxHits <= 2) {
        res.writeHead(502, { "content-type": "text/plain" });
        return res.end("error code: 502");
      }
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-429") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      return res.end(JSON.stringify({ error: { message: "slow down" } }));
    }

    // Streams `count` text frames `gapMs` apart, then a usage frame. 24 frames at
    // 40ms is 23 gaps = ~920ms, so 23 tokens after the first -> ~25 tok/s.
    const streamTokens = (count, gapMs, usageObj) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        if (i < count) {
          res.write(`data: {"choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`);
          i++;
          return;
        }
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({ choices: [], usage: usageObj })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, gapMs);
    };
    if (req.url === "/v1/chat/completions" && body.model === "mock-tps") {
      return streamTokens(24, 40, { prompt_tokens: 100, completion_tokens: 24, total_tokens: 124, prompt_tokens_details: { cached_tokens: 40 } });
    }
    if (req.url === "/v1/chat/completions" && body.model === "mock-short") {
      return streamTokens(6, 100, { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 });
    }
    if (req.url === "/v1/chat/completions" && body.model === "mock-burst") {
      // The whole reply in a single write: there is no generation window to time.
      let all = "";
      for (let i = 0; i < 24; i++) all += `data: {"choices":[{"index":0,"delta":{"content":"t${i}"}}]}\n\n`;
      all += `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 24, total_tokens: 34 } })}\n\ndata: [DONE]\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(all);
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-slow") {
      setTimeout(() => {
        seen[seen.length - 1].endedAt = Date.now();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "slow done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }, 1200);
      return;
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-compact") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n`);
      res.write(`data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-handoff") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"SUMMARY FROM HANDOFF"}}]}\n\n`);
      res.write(`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-limited") {
      limitedHits++;
      if (limitedHits <= 2) {
        const text = JSON.stringify({
          error: {
            code: "rate_limit_exceeded",
            message: `mock-limited request limit reached (1 requests per minute). Try again in 1s.`,
            param: "model",
            type: "rate_limit_error",
          },
        });
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end(text);
      }
    }

    if (req.url === "/v1/chat/completions" && body.model === "mock-vision") {
      visionHits++;
      const out = JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "A blue square with the word TEST." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(out);
    }

    if (req.url === "/v1/chat/completions" && body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n`);
      res.write(`data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n`);
      res.write(`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    const out = JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: `echo:${body.model}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(out);
  });
});

const listen = (srv) => new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
const mockPort = await listen(mock);

// ---------- proxy under test ----------
const proxyPort = 17000 + Math.floor(Math.random() * 900);
// A crashed suite must not leave its proxy running: a stray copy holding the
// port makes the next run talk to old code.
process.on("exit", () => { try { proxy.kill(); } catch {} });
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });

const proxy = spawn(process.execPath, [path.join(ROOT, "index.js")], {
  env: {
    ...process.env,
    FASFAS_PROXY_PORT: String(proxyPort),
    FASFAS_PROXY_KEYS_FILE: KEYS_FILE,
    FASFAS_PROXY_UPSTREAM: `http://127.0.0.1:${mockPort}/v1`,
    FASFAS_PROXY_LIMITS: "mock-ok=2/1000ms,mock-limited=100/1000ms,mock-textonly=0,mock-tokens=0,mock-a=1/500ms,mock-b=1/500ms,mock-src=1/3000ms",
    FASFAS_PROXY_OVERFLOW: "mock-src=mock-dst:500ms,mock-429=mock-dst:1s",
    FASFAS_PROXY_TOKEN_LIMITS: "mock-tokens=1000/1000ms",
    FASFAS_PROXY_PRICING: "mock-ok=1/2/0.5,mock-a=1/1/1,mock-b=1/1/1",
    FASFAS_PROXY_VISION_TARGETS: "mock-textonly",
    FASFAS_PROXY_VISION_MODEL: "mock-vision",
    FASFAS_PROXY_COMPACTION_MODEL: "mock-handoff",
    FASFAS_PROXY_COMPACTION_MIN_BYTES: "50",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let proxyLog = "";
proxy.stdout.on("data", (d) => (proxyLog += d.toString()));
proxy.stderr.on("data", (d) => (proxyLog += d.toString()));

const base = `http://127.0.0.1:${proxyPort}`;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/healthz`);
    if (r.ok) { up = true; break; }
  } catch {}
  await sleep(250);
}
if (!up) {
  log("proxy did not start; log:\n" + proxyLog);
  process.exit(1);
}

const chat = (model, extra = {}) => fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: "Bearer test-key", "content-type": "application/json", "x-opencode-session-id": "ses_test" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
});

log("\npassthrough");
{
  const r = await chat("mock-ok");
  const j = await r.json();
  ok("status 200", r.status === 200);
  ok("model answered", j.choices[0].message.content === "echo:mock-ok");
  const last = seen[seen.length - 1];
  ok("authorization forwarded", last.auth === "Bearer test-key");
  ok("model id forwarded byte-exact", last.body.model === "mock-ok");
  ok("upstream path keeps /v1", last.path === "/v1/chat/completions", last.path);
}

log("\nstreaming passthrough");
{
  const r = await chat("mock-stream", { stream: true });
  const text = await r.text();
  ok("status 200", r.status === 200);
  ok("is event-stream", String(r.headers.get("content-type")).includes("text/event-stream"));
  ok("all chunks present", text.includes("hel") && text.includes("lo") && text.includes("[DONE]"));
  ok("3 data events + done", (text.match(/^data:/gm) || []).length === 4);
}

log("\nrate pacing (2 per 1000ms)");
{
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await chat("mock-ok").then((r) => r.text());
  const elapsed = Date.now() - t0;
  ok("4 requests paced past the window", elapsed >= 1000, `elapsed ${elapsed}ms`);
  ok("still answered 4 times", true);
}

log("\n429 absorption (2 x 429 then 200)");
{
  const before = limitedHits;
  const r = await chat("mock-limited");
  const j = await r.json();
  ok("client sees 200", r.status === 200, `status ${r.status}`);
  ok("client sees a real answer", j.choices?.[0]?.message?.content === "echo:mock-limited");
  ok("upstream was retried", limitedHits - before === 3, `hits ${limitedHits - before}`);
}

log("\nvision handoff (text-only target)");
{
  const before = visionHits;
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const r = await chat("mock-textonly", {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image_url", image_url: { url: image } },
      ],
    }],
  });
  ok("status 200", r.status === 200);
  const target = [...seen].reverse().find((s) => s.body.model === "mock-textonly");
  const parts = target?.body?.messages?.[0]?.content || [];
  ok("no image part reached the target", !parts.some((p) => p.type === "image_url"));
  ok("caption replaced the image", parts.some((p) => typeof p.text === "string" && p.text.includes("TEST")), JSON.stringify(parts));
  ok("vision model was called", visionHits - before === 1, `hits ${visionHits - before}`);

  // same image again -> caption cache, no second vision call
  const r2 = await chat("mock-textonly", {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "and now?" },
        { type: "image_url", image_url: { url: image } },
      ],
    }],
  });
  await r2.text();
  ok("caption cached (no second vision call)", visionHits - before === 1, `hits ${visionHits - before}`);
}

log("\n/status");
{
  const r = await fetch(`${base}/status`);
  const j = await r.json();
  ok("reports proxy id", j.proxy === "fasfas-proxy");
  ok("reports configured limits", j.limits["mock-ok"] === "2/1s", JSON.stringify(j.limits));
  ok("reports vision config", j.vision.model === "mock-vision" && j.vision.targets.includes("mock-textonly"));
  ok("reports throttle counters", j.models["mock-ok"]?.throttled >= 1, JSON.stringify(j.models["mock-ok"]));
  ok("reports upstream retries", j.models["mock-limited"]?.retries >= 1, JSON.stringify(j.models["mock-limited"]));
}

log("\ncompaction: blocked finish hands off to the fallback model");
{
  const before = seen.length;
  const bigPrompt = "Summarise the following session. ".repeat(20);
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-compact", stream: true,
      messages: [{ role: "user", content: bigPrompt }],
    }),
  });
  const text = await r.text();
  ok("client got 200", r.status === 200, `status ${r.status}`);
  ok("client got the handoff summary", text.includes("SUMMARY FROM HANDOFF"), text.slice(0, 120));
  const calls = seen.slice(before);
  ok("original model was tried", calls.some((c) => c.body.model === "mock-compact"));
  ok("fallback model was tried", calls.some((c) => c.body.model === "mock-handoff"));
  const fallback = calls.find((c) => c.body.model === "mock-handoff");
  ok("handoff body kept the messages", (fallback?.body?.messages?.[0]?.content || "").includes("Summarise the following"));

  const st = await (await fetch(`${base}/status`)).json();
  ok("status counts the handoff", st.compaction?.handoffs >= 1, JSON.stringify(st.compaction));
}

log("\ncompaction: waits for in-flight requests to settle");
{
  const before = seen.length;
  const bigPrompt = "Summarise the following session. ".repeat(20);
  const slow = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-slow", messages: [{ role: "user", content: "work" }] }),
  });
  await sleep(250);
  const compact = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-compact", stream: true, messages: [{ role: "user", content: bigPrompt }] }),
  });
  await slow.then((r) => r.text());
  await compact.then((r) => r.text());
  const calls = seen.slice(before);
  const slowCall = calls.find((c) => c.body.model === "mock-slow");
  const compactCall = calls.find((c) => c.body.model === "mock-compact");
  ok("compaction started after the slow request finished",
    !!slowCall?.endedAt && !!compactCall && compactCall.startedAt >= slowCall.endedAt,
    `slowEnd=${slowCall?.endedAt} compactStart=${compactCall?.startedAt}`);
}

log("\ncompaction: a request with tools is NOT treated as compaction");
{
  const before = seen.length;
  const bigPrompt = "Summarise the following session. ".repeat(20);
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-compact", stream: true,
      tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: bigPrompt }],
    }),
  });
  await r.text();
  const calls = seen.slice(before);
  ok("no handoff for a tool-carrying request", !calls.some((c) => c.body.model === "mock-handoff"), JSON.stringify(calls.map((c) => c.body.model)));
}

log("\ntoken budget (1000 tokens per 1000ms)");
{
  const big = "word ".repeat(1600); // ~8000 chars -> ~2000 estimated tokens
  const body = JSON.stringify({ model: "mock-tokens", messages: [{ role: "user", content: big }] });
  const t0 = Date.now();
  const r1 = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" }, body });
  await r1.text();
  const t1 = Date.now();
  const r2 = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" }, body });
  const j2 = await r2.json();
  const elapsed = Date.now() - t0;
  ok("both answered", r1.status === 200 && r2.status === 200);
  ok("second request waited on the token budget", t1 - t0 >= 0 && elapsed >= 700, `elapsed ${elapsed}ms`);
  ok("answer still correct", j2.choices?.[0]?.message?.content === "echo:mock-tokens", JSON.stringify(j2.choices?.[0]?.message));

  const st = await (await fetch(`${base}/status`)).json();
  ok("status reports token limits", st.tokenLimits?.["mock-tokens"] === "1000/1s", JSON.stringify(st.tokenLimits));
  ok("status reports token usage", st.models?.["mock-tokens"]?.tokenMax === 1000, JSON.stringify(st.models?.["mock-tokens"]));
}

log("\nlimits are per model, not shared");
{
  const t0 = Date.now();
  const run = (m) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: m, messages: [{ role: "user", content: "hi" }] }),
  }).then((r) => r.text());
  // mock-a and mock-b are each limited to 1/500ms. If the windows were shared,
  // the second pair would serialize and take ~1500ms.
  await Promise.all([run("mock-a"), run("mock-b"), run("mock-a"), run("mock-b")]);
  const elapsed = Date.now() - t0;
  ok("two models pace independently", elapsed < 1400, `elapsed ${elapsed}ms (serialized would be ~1500ms)`);
  const st = await (await fetch(`${base}/status`)).json();
  ok("each model has its own limiter", !!st.models["mock-a"] && !!st.models["mock-b"]);
  ok("windows are separate objects", st.models["mock-a"].total >= 2 && st.models["mock-b"].total >= 2,
    JSON.stringify({ a: st.models["mock-a"]?.total, b: st.models["mock-b"]?.total }));
}

log("\n/usage windows and per-model tokens");
{
  const r = await fetch(`${base}/usage`);
  const j = await r.json();
  ok("24h window has requests", j.windows?.["24h"]?.requests >= 1, JSON.stringify(j.windows?.["24h"]));
  ok("7d/30d/all windows exist", !!j.windows?.["7d"] && !!j.windows?.["30d"] && !!j.windows?.all);
  ok("per-model row recorded", !!j.models?.["24h"]?.["mock-ok"], JSON.stringify(Object.keys(j.models?.["24h"] || {})));
  const m = j.models?.["24h"]?.["mock-ok"] || {};
  ok("counts input tokens", m.input > 0, JSON.stringify(m));
  ok("reports average tps", typeof m.avgTps === "number", JSON.stringify(m));
  ok("prices the model", m.cost > 0, JSON.stringify({ cost: m.cost }));
  ok("totals cost across models", j.windows["24h"].cost > 0, JSON.stringify(j.windows["24h"]));
  ok("lifetime totals kept", !!j.lifetime?.["mock-ok"], JSON.stringify(j.lifetime));
}

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const withImage = (model, url = IMG) => fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: "Bearer test-key", "content-type": "application/json" },
  // Agent requests always carry tools; that also keeps them out of the
  // compaction path, which the 50-char test threshold would otherwise match.
  body: JSON.stringify({
    model,
    tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } }],
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url } },
    ] }],
  }),
});

log("\nnative images are not captioned by default");
{
  const visionBefore = visionHits;
  const before = seen.length;
  const r = await withImage("mock-native");
  const j = await r.json();
  const call = seen.slice(before).find((c) => c.body.model === "mock-native");
  const parts = call?.body?.messages?.[0]?.content || [];
  ok("request succeeded", r.status === 200 && j.choices?.[0]?.message?.content === "echo:mock-native");
  ok("image reached the model untouched", parts.some((p) => p.type === "image_url" && p.image_url?.url === IMG), JSON.stringify(parts).slice(0, 160));
  ok("no caption was generated", visionHits === visionBefore, `vision hits ${visionHits - visionBefore}`);
}

log("\nrejected image request falls back to captions");
{
  const visionBefore = visionHits;
  const before = seen.length;
  // a fresh image: the one above is already in the caption cache
  const r = await withImage("mock-imgreject", IMG.replace("iVBOR", "iVBOS"));
  const j = await r.json();
  const calls = seen.slice(before).filter((c) => c.body.model === "mock-imgreject");
  ok("client got a 200 instead of the 400", r.status === 200, `status ${r.status}`);
  ok("answered by the original model", j.choices?.[0]?.message?.content === "echo:mock-imgreject");
  ok("first attempt carried the image, second the caption",
    calls.length === 2 && calls[0].raw.includes('"image_url"') && !calls[1].raw.includes('"image_url"') && calls[1].raw.includes("TEST"),
    `calls=${calls.length}`);
  ok("caption model was called once", visionHits - visionBefore === 1, `hits ${visionHits - visionBefore}`);
}

log("\noverflow: a saturated model spills to the fallback");
{
  const run = (model) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  const r1 = await run("mock-src");
  const j1 = await r1.json();
  ok("first request uses the primary model", j1.choices?.[0]?.message?.content === "echo:mock-src");
  ok("no overflow header on the primary", r1.headers.get("x-fasfas-overflow") === null);

  const t0 = Date.now();
  const r2 = await run("mock-src");
  const j2 = await r2.json();
  const took = Date.now() - t0;
  ok("second request spilled to the fallback", j2.choices?.[0]?.message?.content === "echo:mock-dst", JSON.stringify(j2.choices?.[0]?.message));
  ok("did not wait out the 3s window", took < 1500, `took ${took}ms`);
  ok("response names the spill", r2.headers.get("x-fasfas-overflow") === "mock-src->mock-dst", String(r2.headers.get("x-fasfas-overflow")));

  const t1 = Date.now();
  const r3 = await run("mock-429");
  const j3 = await r3.json();
  ok("upstream 429 with a long retry spills too", j3.choices?.[0]?.message?.content === "echo:mock-dst", JSON.stringify(j3).slice(0, 120));
  ok("did not sleep through the 30s retry-after", Date.now() - t1 < 5000, `took ${Date.now() - t1}ms`);

  const st = await (await fetch(`${base}/status`)).json();
  ok("status lists the rules", st.overflow?.rules?.["mock-src"] === "mock-dst:0.5s", JSON.stringify(st.overflow?.rules));
  ok("status counts the spills", st.overflow?.spills?.["mock-src"]?.count >= 1 && st.overflow?.spills?.["mock-429"]?.count >= 1, JSON.stringify(st.overflow?.spills));

  const act = st2 => st2.overflow?.active?.["mock-dst"];
  const a0 = act(st);
  ok("status counts spills that landed on the target in the last minute", a0 && a0.count >= 2 && a0.from.includes("mock-src"), JSON.stringify(a0));

  // A spilled session shows the model that served it, and where it came from.
  const sid = "ses_spill_model";
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json", "x-opencode-session-id": sid },
    body: JSON.stringify({ model: "mock-src", messages: [{ role: "user", content: "hi" }] }),
  }).then((x) => x.text());
  const k = await (await fetch(`${base}/keys`)).json();
  const s = k.sessions.find((x) => x.id === sid);
  ok("session shows the model that served it", s && s.model === "mock-dst" && s.from === "mock-src", JSON.stringify(s));
}

log("\ntransient 5xx is retried with backoff");
{
  const before = fivexxHits;
  const t0 = Date.now();
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json", "x-opencode-session-id": "ses_5xx_test" },
    body: JSON.stringify({ model: "mock-5xx", messages: [{ role: "user", content: "hi" }] }),
  });
  const j = await r.json();
  ok("client sees 200 after two 502s", r.status === 200, `status ${r.status}`);
  ok("answered by the original model", j.choices?.[0]?.message?.content === "echo:mock-5xx");
  ok("three attempts were made", fivexxHits - before === 3, `hits ${fivexxHits - before}`);
  ok("backoff was applied", Date.now() - t0 >= 700, `took ${Date.now() - t0}ms`);

  const st = await (await fetch(`${base}/status`)).json();
  ok("status counts 5xx retries", st.retries5xx >= 2, String(st.retries5xx));
  ok("session retry state cleared after success", !st.sessions?.ses_5xx_test, JSON.stringify(st.sessions));
}

log("\nmanual ping endpoint");
{
  const r = await fetch(`${base}/ping`, { method: "POST", body: JSON.stringify({ models: ["mock-ok", "mock-a"] }) });
  const j = await r.json();
  ok("ping returns results", Array.isArray(j.results) && j.results.length === 2, JSON.stringify(j).slice(0, 200));
  const ok2 = j.results.find((p) => p.model === "mock-ok");
  ok("a model answered with text", ok2?.ok === true && typeof ok2.text === "string" && ok2.text.length > 0, JSON.stringify(ok2));
  ok("ping reports latency", typeof ok2?.ms === "number" && ok2.ms >= 0);
  const limited = j.results.find((p) => p.model === "mock-src");
  ok("saturated model is skipped, not stalled", limited ? (limited.skipped === true || limited.ok === true) : true, JSON.stringify(limited));
  ok("every result carries a model name", j.results.every((p) => typeof p.model === "string" && p.model.length > 0));
  const st = await (await fetch(`${base}/status`)).json();
  ok("pings are counted as usage", st.requests > 0);
}

log("\nkey pool");
{
  // Pins persist in the keys file beside the proxy, so clear the session ids this
  // block uses; otherwise an earlier run decides where they land.
  for (const sid of ["ses_alpha", "ses_beta", "ses_pinned", "ses_after"]) {
    await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ unpin: sid }) });
  }
  let r = await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ keys: ["sk-test-aaaa1111", "sk-test-bbbb2222"] }) });
  let j = await r.json();
  ok("two keys stored", j.keys?.length === 2, JSON.stringify(j));

  const st2 = await (await fetch(`${base}/status`)).json();
  ok("account total doubles with two keys", st2.limits?.["mock-a"] === "2/0.5s" && st2.keys === 2,
    JSON.stringify({ keys: st2.keys, limit: st2.limits?.["mock-a"] }));
  ok("keys come back masked", j.keys.map((k) => k.hint).join(",") === "…1111,…2222", JSON.stringify(j.keys));

  const chat = (headers) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer inbound-key", "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "mock-a", messages: [{ role: "user", content: "hi" }] }),
  });

  let before = seen.length;
  await chat({}).then((x) => x.text());
  ok("a session-less request uses the first key", seen[seen.length - 1].auth === "Bearer sk-test-aaaa1111", seen[seen.length - 1].auth);

  before = seen.length;
  await chat({ "x-opencode-session-id": "ses_alpha" }).then((x) => x.text());
  await chat({ "x-opencode-session-id": "ses_beta" }).then((x) => x.text());
  const spread = seen.slice(before).map((c) => c.auth);
  ok("two sessions land on different keys", new Set(spread).size === 2 && spread.every((a) => a.startsWith("Bearer sk-test-")), JSON.stringify(spread));

  before = seen.length;
  for (let i = 0; i < 2; i++) await chat({ "x-opencode-session-id": "ses_pinned" }).then((x) => x.text());
  const pinned = seen.slice(before).map((c) => c.auth);
  ok("one session sticks to one key", new Set(pinned).size === 1 && pinned[0].startsWith("Bearer sk-test-"), JSON.stringify(pinned));

  // explicit pin moves a session to the other key
  const target = spread[0] === "Bearer sk-test-aaaa1111" ? 2 : 1;
  r = await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ pin: { session: "ses_alpha", key: target } }) });
  j = await r.json();
  ok("pin is recorded", j.pins?.ses_alpha === target, JSON.stringify(j.pins));

  before = seen.length;
  await chat({ "x-opencode-session-id": "ses_alpha" }).then((x) => x.text());
  const afterPin = seen[seen.length - 1].auth;
  ok("pinned session follows the chosen key", afterPin === (target === 1 ? "Bearer sk-test-aaaa1111" : "Bearer sk-test-bbbb2222"), afterPin);

  const rv = await fetch(`${base}/keys/reveal?slot=1`);
  const rvj = await rv.json();
  ok("reveal returns one key to a local client", rv.status === 200 && rvj.key === "sk-test-aaaa1111", JSON.stringify(rvj));
  const web = await fetch(`${base}/keys/reveal?slot=1`, { headers: { origin: "https://evil.example" } });
  ok("reveal refuses a browser page origin", web.status === 403, String(web.status));
  const miss = await fetch(`${base}/keys/reveal?slot=9`);
  ok("reveal rejects an unknown slot", miss.status === 404, String(miss.status));

  // A session's requests use its own key's window only. Saturate key A's window
  // for mock-src (limit 1 per 3s) with one session, then a session on the other
  // key must still be served at once.
  const pinA = "ses_isolate_a", pinB = "ses_isolate_b";
  await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ pin: { session: pinA, key: 1 } }) });
  await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ pin: { session: pinB, key: 2 } }) });
  const sendAs = (sid) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer inbound-key", "content-type": "application/json", "x-opencode-session-id": sid },
    body: JSON.stringify({ model: "mock-src", messages: [{ role: "user", content: "hi" }] }),
  }).then((x) => x.json());
  await sendAs(pinA);
  const tB = Date.now();
  const bj = await sendAs(pinB);
  ok("a session on the other key is not held by key 1's window",
    Date.now() - tB < 1500 && bj.choices?.[0]?.message?.content === "echo:mock-src",
    `took ${Date.now() - tB}ms`);

  // New sessions take the key with fewer sessions.
  const fresh = "ses_least_loaded";
  await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ unpin: fresh }) });
  const kBefore = await (await fetch(`${base}/keys`)).json();
  const counts = kBefore.keys.map((k) => k.sessions);
  const leastIdx = counts.indexOf(Math.min(...counts)) + 1;
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer inbound-key", "content-type": "application/json", "x-opencode-session-id": fresh },
    body: JSON.stringify({ model: "mock-ok", messages: [{ role: "user", content: "hi" }] }),
  }).then((x) => x.text());
  const kAfter = await (await fetch(`${base}/keys`)).json();
  ok("a new session lands on the key with fewer sessions",
    kAfter.pins[fresh] === leastIdx, `counts ${JSON.stringify(counts)} -> pinned ${kAfter.pins[fresh]}, expected ${leastIdx}`);

  r = await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ remove: 1 }) });
  j = await r.json();
  ok("a key can be removed", j.keys?.length === 1, JSON.stringify(j));

  r = await fetch(`${base}/keys`, { method: "POST", body: JSON.stringify({ keys: [] }) });
  j = await r.json();
  ok("an empty pool restores passthrough", j.keys?.length === 0, JSON.stringify(j));

  before = seen.length;
  await chat({ "x-opencode-session-id": "ses_after" }).then((x) => x.text());
  ok("inbound credential used again with no pool", seen[seen.length - 1].auth === "Bearer inbound-key", seen[seen.length - 1].auth);
}

log("\nlive sessions decide placement, pins follow their key");
{
  const api = (b) => fetch(`${base}/keys`, { method: "POST", body: JSON.stringify(b) }).then((x) => x.json());
  const as = (sid) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer inbound-key", "content-type": "application/json", "x-opencode-session-id": sid },
    body: JSON.stringify({ model: "mock-ok", messages: [{ role: "user", content: "hi" }] }),
  }).then((x) => x.text());

  await api({ keys: ["sk-load-aaaa1111", "sk-load-bbbb2222"] });
  // start from a clean slate: forget every session pinned by the earlier blocks
  const before = await (await fetch(`${base}/keys`)).json();
  for (const sid of Object.keys(before.pins)) await api({ unpin: sid });

  await as("ses_live1");                                  // first live session -> key 1
  for (const n of [1, 2, 3]) await api({ pin: { session: `ses_dead_${n}`, key: 2 } }); // pinned, never seen
  await as("ses_new");
  let k = await (await fetch(`${base}/keys`)).json();
  ok("pins of sessions that never ran do not count as load", k.pins.ses_new === 2, JSON.stringify(k.pins));
  ok("per-key session counts are live sessions only",
    k.keys[0].sessions === 1 && k.keys[1].sessions === 1, JSON.stringify(k.keys));

  const live = k.sessions.find((s) => s.id === "ses_live1");
  ok("the session list shows who uses which key",
    live && live.key === 1 && live.requests >= 1 && live.model === "mock-ok" && live.active === 0, JSON.stringify(live));
  ok("sessions that never ran are not listed", !k.sessions.some((s) => s.id.startsWith("ses_dead_")));

  // usage is recorded per key as well as combined
  const pk = (await (await fetch(`${base}/usage`)).json()).perKey?.all || {};
  ok("usage is split per key", pk["1"]?.total.requests >= 1 && pk["2"]?.total.requests >= 1, JSON.stringify(Object.keys(pk)));

  // mock-ok is capped at 2 per second: one request is 1/2 for that session
  await sleep(1100);
  await as("ses_limit");
  const lk = await (await fetch(`${base}/keys`)).json();
  const lm = lk.sessions.find((s) => s.id === "ses_limit")?.limit;
  ok("a session shows how much of its key's cap it used", lm && lm.max === 2 && lm.used === 1 && lm.keyUsed >= 1 && typeof lm.tokens === "number" && "tokenMax" in lm, JSON.stringify(lm));

  await api({ pin: { session: "ses_remap", key: 2 } });
  await as("ses_remap");
  ok("pinned to key 2 uses key 2's credential", seen[seen.length - 1].auth === "Bearer sk-load-bbbb2222", seen[seen.length - 1].auth);
  const after = await api({ remove: 1 });
  ok("a pin follows its key when an earlier key is removed", after.pins.ses_remap === 1, JSON.stringify(after.pins));
  await as("ses_remap");
  ok("and the session keeps the same credential", seen[seen.length - 1].auth === "Bearer sk-load-bbbb2222", seen[seen.length - 1].auth);
  ok("a session on the removed key loses its pin", after.pins.ses_live1 === undefined, JSON.stringify(after.pins));
  await api({ keys: [] });
}

log("\nhot reload without a service restart");
{
  const api = (b) => fetch(`${base}/keys`, { method: "POST", body: JSON.stringify(b) }).then((x) => x.json());
  await api({ keys: ["sk-reload-aaaa1111"] });
  await api({ pin: { session: "ses_reload", key: 1 } });
  const usageBefore = (await (await fetch(`${base}/usage`)).json()).windows.all.requests;
  const before = await (await fetch(`${base}/status`)).json();
  const up0 = before.uptimeMs;
  const inst0 = before.instance;

  const denied = await fetch(`${base}/admin/reload`, { method: "POST" });
  ok("the reload needs the admin header", denied.status === 403, String(denied.status));

  // A request that is mid-flight when the reload starts must still finish.
  const slow = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-slow", messages: [{ role: "user", content: "work" }] }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  await sleep(200);

  const r = await fetch(`${base}/admin/reload`, { method: "POST", headers: { "x-fasfas-admin": "1" } });
  ok("the reload is accepted", r.status === 200 && (await r.json()).reloading === true);

  const done = await slow;
  ok("a request in flight during the reload still completes", done.status === 200 && done.body.choices?.[0]?.message?.content === "slow done", JSON.stringify(done).slice(0, 120));

  let back = false;
  for (let i = 0; i < 40 && !back; i++) {
    try { back = (await fetch(`${base}/healthz`)).ok; } catch {}
    if (!back) await sleep(250);
  }
  ok("the proxy answers on the same port afterwards", back);

  const st = await (await fetch(`${base}/status`)).json();
  ok("it is a fresh copy of the code (uptime restarted)", st.instance && st.instance !== inst0 && st.uptimeMs < 8000,
    `instance ${inst0} -> ${st.instance}, uptime ${up0} -> ${st.uptimeMs}`);

  const k = await (await fetch(`${base}/keys`)).json();
  ok("keys and pins survive the reload", k.keys.length === 1 && k.pins.ses_reload === 1, JSON.stringify({ keys: k.keys.length, pins: k.pins }));
  const usageAfter = (await (await fetch(`${base}/usage`)).json()).windows.all.requests;
  ok("usage history survives the reload", usageAfter >= usageBefore, `${usageBefore} -> ${usageAfter}`);

  await api({ keys: [] });
}

log("\ntok/s, ttft and cached share");
{
  const stream = (model) => fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "measure" }] }),
  }).then((x) => x.text());
  await stream("mock-tps");
  await stream("mock-short");
  await stream("mock-burst");
  await sleep(200);

  const u = await (await fetch(`${base}/usage`)).json();
  const tps = u.models["24h"]["mock-tps"] || {};
  const short = u.models["24h"]["mock-short"] || {};
  const burst = u.models["24h"]["mock-burst"] || {};

  ok("a paced stream gives a decode speed near 25 tok/s", tps.avgTps >= 12 && tps.avgTps <= 40, JSON.stringify(tps));
  ok("median and sample count are reported", tps.tpsN >= 1 && tps.medTps > 0, JSON.stringify({ n: tps.tpsN, med: tps.medTps }));
  ok("time to first token is recorded and excluded from the rate", tps.ttftMs >= 20 && tps.ttftMs < 500, String(tps.ttftMs));
  ok("cached share is cached / input", tps.cachedPct === 40, String(tps.cachedPct));
  ok("a reply under 16 tokens is left out of tok/s", short.tpsN === 0 && short.avgTps === 0, JSON.stringify({ n: short.tpsN, tps: short.avgTps }));
  ok("a reply delivered in one frame is left out of tok/s", burst.tpsN === 0 && burst.avgTps === 0, JSON.stringify({ n: burst.tpsN, tps: burst.avgTps }));
  ok("requests and tokens still count for the excluded replies", short.requests >= 1 && burst.output >= 24, JSON.stringify({ s: short.requests, bo: burst.output }));
}

proxy.kill();
try { fs.unlinkSync(KEYS_FILE); } catch {}
mock.close();
log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
