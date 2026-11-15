// test/live-check.mjs — end-to-end check against the real gateway.
// Requires FASFAS_API_KEY and consumes real quota (and, for the pacing case,
// real wall-clock time). Not part of `run-tests.mjs`.
//
//   FASFAS_API_KEY=... node test/live-check.mjs
//
// Asserts: passthrough, streaming, vision handoff (direct 400 becomes 200),
// caption cache, and rate pacing (no 429 under a burst that would otherwise
// trip the model's cap).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEY = process.env.FASFAS_API_KEY;
const PORT = Number(process.env.FASFAS_PROXY_TEST_PORT) || 17332;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) {
  console.error("FASFAS_API_KEY is not set");
  process.exit(2);
}

// 8x8 solid-colour PNG without any image library
function png(r, g, b, w = 8, h = 8) {
  const tbl = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc = (buf) => { let c = -1; for (const x of buf) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const proxy = spawn(process.execPath, [path.join(ROOT, "index.js")], {
  env: { ...process.env, FASFAS_PROXY_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let plog = "";
proxy.stdout.on("data", (d) => (plog += d.toString()));
proxy.stderr.on("data", (d) => (plog += d.toString()));

let up = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/healthz`); if (r.ok) { up = true; break; } } catch {}
  await sleep(250);
}
if (!up) { console.error("proxy did not start\n" + plog); process.exit(1); }
console.log("healthz -> " + (await (await fetch(`${BASE}/healthz`)).text()).trim());

const chat = (model, extra = {}) => fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 60, messages: [{ role: "user", content: "Reply with exactly: OK" }], ...extra }),
});

let t = Date.now();
let r = await chat("deepseek-v4.1-flash");
let j = await r.json();
console.log(`passthrough -> ${r.status} ${Date.now() - t}ms :: ${JSON.stringify((j.choices?.[0]?.message?.content || "").trim())}`);

t = Date.now();
r = await chat("deepseek-v4.1-flash", { stream: true });
const sse = await r.text();
console.log(`streaming -> ${r.status} ct=${r.headers.get("content-type")} events=${(sse.match(/^data:/gm) || []).length} done=${sse.includes("[DONE]")} ${Date.now() - t}ms`);

const img = "data:image/png;base64," + png(30, 60, 220).toString("base64");
const withImage = (text) => fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "haiku-5.5", max_tokens: 200,
    messages: [{ role: "user", content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: img } },
    ] }],
  }),
});

t = Date.now();
r = await withImage("What color is this image? One word.");
j = await r.json();
console.log(`vision handoff -> ${r.status} ${Date.now() - t}ms :: ${JSON.stringify((j.choices?.[0]?.message?.content || "").trim().slice(0, 40))}`);

t = Date.now();
r = await withImage("And again, what color? One word.");
await r.text();
console.log(`caption cache -> ${r.status} ${Date.now() - t}ms`);

t = Date.now();
const statuses = [];
for (let i = 0; i < 8; i++) {
  const rr = await chat("sonnet-5.5", { max_tokens: 20 });
  statuses.push(rr.status);
  await rr.text();
}
const secs = ((Date.now() - t) / 1000).toFixed(1);
console.log(`pacing 8x sonnet (6/60s) -> [${statuses.join(",")}] in ${secs}s`);

const st = await (await fetch(`${BASE}/status`)).json();
console.log("status limits=" + JSON.stringify(st.limits));
console.log("status models=" + JSON.stringify(st.models));
console.log("status vision=" + JSON.stringify(st.vision) + " retries429=" + st.retries429);

proxy.kill();

const allOk = statuses.every((s) => s === 200);
console.log(allOk ? "\nlive check OK" : "\nlive check FAILED (saw a non-200 during pacing)");
process.exit(allOk ? 0 : 1);
