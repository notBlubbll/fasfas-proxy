// scripts/seed-usage.mjs — import aggregate usage from a provider dashboard
// into the proxy's usage log, so the panel shows history from before the proxy
// started recording.
//
//   node scripts/seed-usage.mjs --dir <plugin dir> --data <file.json> [--hours 2]
//
// The JSON is a map of model id -> totals:
//   { "haiku-5.5": { "requests": 121, "input": 1916305, "output": 3792 } }
//
// Each entry becomes one `seed` record stamped `--hours` ago (default 2), so it
// lands inside the 24h window. Seeded records contribute tokens but are excluded
// from the TPS and latency averages, which only real observations can describe.
// Re-running replaces the previous seed records instead of duplicating them.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dirArg = arg("dir", path.join(os.homedir(), ".config", "opencode", "plugins", "fasfas-proxy"));
const dir = dirArg.replace(/^~/, os.homedir());
const dataFile = arg("data", null);
const hours = Number(arg("hours", "2"));

if (!dataFile) {
  console.error("usage: node scripts/seed-usage.mjs --dir <plugin dir> --data <file.json> [--hours 2]");
  process.exit(2);
}

const totals = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const logPath = path.join(dir, ".fasfas-usage.jsonl");

const existing = fs.existsSync(logPath)
  ? fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim())
  : [];

const kept = existing.filter((line) => {
  try { return !JSON.parse(line).seed; } catch { return true; }
});

const at = Date.now() - Math.round(hours * 60 * 60 * 1000);
const seeded = [];
for (const [model, t] of Object.entries(totals)) {
  if (!t || typeof t !== "object") continue;
  seeded.push({
    t: at,
    m: model,
    n: Number(t.requests) || 1,
    i: Number(t.input) || 0,
    o: Number(t.output) || 0,
    r: Number(t.reasoning) || 0,
    c: Number(t.cached) || 0,
    gm: 0,
    ms: 0,
    seed: true,
  });
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(logPath, [...kept, ...seeded.map((r) => JSON.stringify(r))].join("\n") + "\n");

const sumReq = seeded.reduce((n, r) => n + (totals[r.m].requests || 0), 0);
const sumIn = seeded.reduce((n, r) => n + r.i, 0);
const sumOut = seeded.reduce((n, r) => n + r.o, 0);
console.log(`seeded ${seeded.length} models into ${logPath}`);
console.log(`  requests=${sumReq} input=${sumIn} output=${sumOut} total=${sumIn + sumOut} (stamped ${hours}h ago)`);
console.log("restart the proxy (or the OpenCode service) so it reloads the log");
