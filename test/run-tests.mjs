// test/run-tests.mjs — spins a mock upstream plus the proxy and asserts the
// behaviour that matters: passthrough, streaming, rate pacing, 429 absorption,
// vision handoff, caption caching.
//
//   node test/run-tests.mjs

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    seen.push({ path: req.url, auth: req.headers.authorization, body, raw });

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
const proxy = spawn(process.execPath, [path.join(ROOT, "index.js")], {
  env: {
    ...process.env,
    FASFAS_PROXY_PORT: String(proxyPort),
    FASFAS_PROXY_UPSTREAM: `http://127.0.0.1:${mockPort}/v1`,
    FASFAS_PROXY_LIMITS: "mock-ok=2/1000ms,mock-limited=100/1000ms,mock-textonly=0",
    FASFAS_PROXY_VISION_TARGETS: "mock-textonly",
    FASFAS_PROXY_VISION_MODEL: "mock-vision",
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

proxy.kill();
mock.close();
log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
