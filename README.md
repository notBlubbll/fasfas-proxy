# fasfas-proxy

An OpenCode V2 plugin (and standalone daemon) that sits between OpenCode and an
OpenAI-compatible gateway and makes it behave: **per-model rate limiting**, an
**overflow spill** when the scarce model is saturated, and a **compaction
fallback**. Everything else is a transparent passthrough — the inbound
`authorization` header is forwarded unchanged and the request body (including the
model id) goes upstream byte-exact, images included.

No credentials are stored in this repository.

## Why

The gateway enforces a hard cap **per model** and answers `429` when a turn
bursts past it, which happens constantly with subagents, retries and parallel
tool calls:

```json
{"error":{"code":"rate_limit_exceeded",
  "message":"sonnet-5.5 request limit reached (6 requests per minute). Try again in 49s.",
  "param":"model","type":"rate_limit_error"}}
```

OpenCode surfaces that as a failed turn. The proxy reads the limit out of that
message and paces requests locally instead, so the cap is never reached.

Two smaller jobs ride along: a model that is saturated can spill to a fallback
instead of queueing, and a compaction summary that the provider blocks is re-run
on a different model instead of killing the turn.

## Models

| Model | Context | Output | Image | Tools | Req/min | Tok/min |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 1,048,576 | 65,536 | ✅ native | yes | 40 | 2,000,000 |
| `glm-5.3-flash` | 1,048,576 | 65,536 | ✅ native | yes | 20 | 2,000,000 |
| `glm-5.2` | 1,048,576 | 65,536 | ❌ text only | yes | 10 | 1,000,000 |
| `haiku-5.5` | 1,000,000 | 65,536 | ✅ native | yes | 20 | 2,000,000 |
| `sonnet-5.5` | 1,000,000 | 65,536 | ✅ native | yes | 6 | 1,000,000 |

Image generation (`POST /v1/images/generations`), passed through and counted in the
usage table, with no request or token limits on the gateway:

| Model | Notes |
| --- | --- |
| `mai-image-2.6-flash` | faster, lower cost |
| `mai-image-2.6` | full quality |

> The limits are **per key**: the gateway's real caps, as shown on each key's
> dashboard. The account total is the per-key cap × the number of configured
> keys, so two keys double what `/status` and the panel report. One key shows the
> original numbers.

- The MAI image models are listed in `opencode.fasfas.json`, but OpenCode's
  `experimental_image_generate` tool does not offer them (it only lists image
  models from its own catalog). Call the endpoint directly.
- All the chat models speak tools, streaming and `reasoning_effort`, and expose the variants
  `low` / `medium` / `high` / `xhigh` / `max`.
- **The limits are per model, not shared.** The aggregate ceiling is 96 req/min
  and 8M tok/min, reached only by running every model at once; saturating one
  model leaves the others untouched.
- **Images are passed through untouched.** The other chat models see images natively
  (verified: haiku and sonnet name all four quadrants of a 64×64 image), so the
  proxy only captions an image when the upstream actually rejects it.
- `glm-5.2` is text only: an image request gets `404 No endpoints found that
  support image input` from the gateway. For code it passed a check: it wrote a
  `parseDuration` function that passed 11 of 11 test cases in about 2s, and it
  returned a correct tool call.
- `sonnet-5.5` is the scarcest at 6 requests/minute per key (12 with two keys).
  Point subagents at `deepseek-v4.1-flash` (40/min per key) rather than letting a
  fan-out eat sonnet's budget.

> **Costs** in `/usage` and the panel are estimates using OpenCode's published
> token rates. They are not what this gateway bills (it currently bills nothing).

Everything in the table is overridable by the env vars below.

### Deprecated models

Models the gateway no longer serves. They are not offered, limited or listed in
the panel, and they are not in `opencode.fasfas.json`. Each one's last known
settings are here, so bringing it back is a copy-paste (`git log` also has the old
config entry).

| Model | Context | Output | Image | Req/min | Tok/min | Status | Retired | Why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen3.8-27b` | 1,000,000 | 65,536 | ✅ native | 20 | 3,000,000 | removed | 2026-11-16 | gone from `/v1/models`; calls return `404` |
| `gemini-4hy` (Gemini 4 Hydrogen) | 1,000,000 | 65,536 | not tested | 20 | 3,000,000 | removed | 2026-11-16 | listed briefly; upstream rejected every call (ZDR policy), then it left `/v1/models` |

- In the live OpenCode config a retired model can be kept as `disabled: true`
  instead of deleting it. `qwen3.8-27b` is set that way on the author's machine.
- Requests a retired model already served stay in the usage history with their
  cost (the proxy keeps their price internally), but the panel shows no row for it.
- To restore one: add its limits to `FASFAS_PROXY_LIMITS` / `FASFAS_PROXY_TOKEN_LIMITS`
  and its rates to `PRICING_DEFAULT` in `index.js`, then re-add the model to the
  provider config.

### How the limits were measured

Burst probes against the live gateway, one request at a time, 90s idle before
each model so no window carried leftover traffic:

| Model | `200`s before the first `429` | Message |
| --- | --- | --- |
| `glm-5.3-flash` | 20 | `(20 requests per minute)` |
| `haiku-5.5` | 20 | `(20 requests per minute)` |
| `sonnet-5.5` | 6 | `(6 requests per minute)` |
| `deepseek-v4.1-flash` | 35+ (no failure) | dashboard shows 40/min |

Supporting observations: `retry-after` was accurate to the second (waited 50s →
`200`), 8 parallel `sonnet-5.5` calls produced 5 × `200` + 3 × `429` (the window
is shared, not per connection), saturating one model never throttled another,
`GET /models` does not consume the chat budget, and 3 back-to-back ~150k-token
prompts did not trip a token limit on their own.

## Install

### As an OpenCode plugin

Copy both folders into the global plugin directory:

```sh
cp -r fasfas-proxy        ~/.config/opencode/plugins/fasfas-proxy
cp -r desktop-usage-panel ~/.config/opencode/plugins/fasfas-usage   # optional panel
```

OpenCode discovers plugins there on start — no config entry required. Then point
the provider at the proxy. A complete provider block with all the models,
limits, capabilities and variants is in
[`opencode.fasfas.json`](./opencode.fasfas.json), which contains **no keys**:

```jsonc
{
  "providers": {
    "fasfas": {
      "package": "@opencode-ai/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:17331/v1",
        "apiKey": "{env:FASFAS_API_KEY}",
        "timeout": 1800000,
        "headerTimeout": 600000,
        "chunkTimeout": 600000
      }
    }
  }
}
```

The key lives in the environment of the OpenCode server process, which forwards
it to the proxy, which forwards it upstream:

```powershell
[Environment]::SetEnvironmentVariable("FASFAS_API_KEY", "<key>", "User")   # PowerShell
```

```sh
export FASFAS_API_KEY="<key>"                                              # bash / zsh
```

### As a standalone daemon

The same file runs outside OpenCode, which is handy for testing against the
gateway directly:

```sh
node index.js        # or: bun index.js
```

## How pacing works

Each model gets its own limiter with two sliding windows — requests and tokens.
A request that would exceed either window waits for the next free slot; nothing
is dropped or rejected.

- **Estimates, then reconciles.** Token use is estimated from the prompt size
  (`chars / 4`, with inline data URLs collapsed so a screenshot is not counted as
  text) and reconciled against real usage once the response completes.
- **Upstream `429` is still handled.** If a limit changed, or another client
  shares the key, `retry-after` is honoured (capped at 120s), the limit in the
  message is learned and applied, and the request is re-dispatched — up to 6
  retries inside a 10-minute budget, after which the real `429` reaches the client.
- **A prompt larger than the whole budget is still admitted.** It is clamped to
  the budget and queued behind existing traffic instead of waiting forever.
- **Transient `5xx` is retried** (`502`, `503`, `504`, `520`, `522`, `524`) with
  the same body and a 0.5/1/2/4/8s backoff, up to 5 attempts, then the real error
  is forwarded. The log line carries the body size, so a deterministic
  oversized-body failure is easy to tell apart from a genuine outage.
- **Retries are visible.** `/status` reports `retries5xx` plus a per-session map
  keyed by `x-opencode-session-id`, which the desktop plugin renders as a
  composer pill (`Working (12s · retrying 2 · HTTP 502)`).

## Overflow spill

A saturated model makes every extra request wait for a slot. With a rule, a
request that would wait longer than a threshold is sent to a fallback model
instead of queueing — the same idea as the compaction handoff, applied to
ordinary traffic.

```
FASFAS_PROXY_OVERFLOW="sonnet-5.5=haiku-5.5:20s"
```

- Off by default: it swaps the model mid-conversation, so it is opt-in.
- The rule also applies to upstream `429`s: if the required wait exceeds the
  threshold, the request spills immediately instead of sleeping.
- A spilled response carries `x-fasfas-overflow: sonnet-5.5->haiku-5.5`, and the
  log line is `overflow sonnet-5.5 -> haiku-5.5 (…)`.
- `/status` reports the rules and a spill count per source model.
- A request never spills twice, so a fallback cannot chain.

## Images

Every model on this gateway accepts images natively, so images are forwarded
untouched — no captioning, no loss of pixels. That matters for anything that has
to *see* the picture rather than hear about it.

If an upstream does reject an image request with `400`, the proxy retries that
request **once** with the images captioned by `glm-5.3-flash`, so a text-only
endpoint — or a corrupt image — still gets a usable answer instead of a failed
turn. Captions are cached by image hash (1h TTL, 200 entries).

```
upstream rejected an image request for sonnet-5.5 (400); retrying with captions :: …
```

> A `400` here is usually about the image bytes, not vision support: the
> Anthropic-backed models validate the PNG and reject one whose chunk CRC is
> wrong, while the GLM/Qwen/DeepSeek endpoints accept it silently.

Forcing captioning for a model that is genuinely blind is opt-in:

```
FASFAS_PROXY_VISION_TARGETS="some-text-only-model"
```

Accepted image shapes for that path: `image_url`, `image` with `source.data`, and
`input_image`. If the vision call fails, the image becomes
`[Image attached by the user — vision analysis unavailable]` and the turn proceeds.

## Compaction protection

Compaction sends the whole session as one large, tool-less request. When the
provider ends that stream with a `content-filter` finish reason, OpenCode aborts
with *"Compaction summary was blocked by the provider"* — a safety decision, not a
quota problem.

A request counts as compaction when it carries **no tools** and its messages
exceed `FASFAS_PROXY_COMPACTION_MIN_BYTES` characters. Such a request:

1. **waits for a quiet window** — it will not start while another request is in
   flight, so it never competes for the per-minute budget (120s ceiling);
2. **is buffered**, because the finish reason only arrives at the end and the
   decision depends on it;
3. **fails over** to `FASFAS_PROXY_COMPACTION_MODEL` (`glm-5.3-flash`) on a
   content-filter finish, an error finish, or any `4xx` — a different upstream
   applies a different classifier, so the same body usually summarizes fine.

```
compaction blocked model=haiku-5.5 status=200 finish=content_filter; handing off to glm-5.3-flash
compaction handoff model=glm-5.3-flash status=200 finish=stop bytes=4821
```

Normal tool-carrying requests are never buffered or rerouted, so streaming latency
is unchanged outside compaction.

## Keys

> **One key per user.** Every user should have exactly one key. Using more than
> one is at your own risk: the gateway may treat extra keys as a way around its
> limits, and any consequence of that is yours, not this project's. Multi-key
> support exists because the proxy can handle it, not because it is endorsed.

The gateway meters each key on its own, so a second key is a second set of
per-model windows. Keys are added in the panel's **Keys** section and stored in
`keys.json` next to the plugin (never in the repo, never in `opencode.json`,
which holds only a placeholder credential).

- **One session is one key.** A session is pinned to a key the first time it is
  seen, and every request it makes is charged to that key's windows and no other.
  There is no round-robin and no borrowing: a session on key 1 never spends
  key 2's budget.
- **New sessions take the key with fewer live sessions.** "Live" means seen in the
  last 30 minutes; sessions that ended hours ago do not count as load. Pins are
  forgotten after 14 days.
- **Pins follow their key.** Removing key 1 shifts key 2 down, and its sessions go
  with it. Sessions that were on the removed key are placed again on their next
  request.
- **Totals scale with keys.** `/status` and the panel report the per-key cap times
  the number of keys, so one key shows the original numbers and two show double.
- The panel lists live sessions as a table: session, key, model, **Req** (requests
  this session sent in the last minute out of its key's per-minute cap, e.g. `3/6`),
  **TPM** (its tokens in the last minute as a share of the key's token cap) and
  state. The tooltips add the whole key's use. Both are rolling-minute counts
  recomputed on every poll, so they empty on their own as requests age out. A
  session whose request overflowed shows the model that served it with a `*` (the
  tooltip names the model it was meant for), and the main table marks a model with
  `*N` (N = requests that overflowed onto it in the last minute) while it is
  serving overflow from another. Each key row has **Show**, **Edit**, **Pin** (glue the open session to it) and
  **×**.

The provider's `apiKey` in OpenCode only has to be non-empty once keys are in the panel's Keys section: the proxy replaces the inbound credential with the pooled key for the session. The example uses `{env:FASFAS_API_KEY}`; any placeholder works.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `FASFAS_PROXY_PORT` | `17331` | listen port (`127.0.0.1` only) |
| `FASFAS_PROXY_UPSTREAM` | `https://ai.coffeevps.com/v1` | upstream base URL |
| `FASFAS_PROXY_LIMITS` | table above | requests: `model=max/window`, `*=fallback`, `0` = unlimited |
| `FASFAS_PROXY_TOKEN_LIMITS` | table above | tokens: `model=tokens/window` |
| `FASFAS_PROXY_PRICING` | table above | `model=in/out/cached`, USD per 1M tokens |
| `FASFAS_PROXY_RL_BUDGET_MS` | `600000` | wall-clock ceiling for `429` waits per request |
| `FASFAS_PROXY_VISION` | on | `0` disables the caption fallback |
| `FASFAS_PROXY_VISION_TARGETS` | (none) | models to caption for unconditionally (`*`, `prefix*` allowed) |
| `FASFAS_PROXY_VISION_MODEL` | `glm-5.3-flash` | captioning model |
| `FASFAS_PROXY_VISION_PROMPT` | built-in | caption prompt override |
| `FASFAS_PROXY_OVERFLOW` | (none) | `from=to:wait` spill rules, e.g. `sonnet-5.5=haiku-5.5:20s` |
| `FASFAS_PROXY_COMPACTION` | on | `0` disables compaction protection |
| `FASFAS_PROXY_COMPACTION_MODEL` | `glm-5.3-flash` | fallback for blocked summaries |
| `FASFAS_PROXY_COMPACTION_MIN_BYTES` | `20000` | prompt size that marks a tool-less request as compaction |

Window units are `ms`, `s`, `m`, `h`. A plugin code change needs a service
restart: a config reload deliberately reuses the running instance instead of
closing it, so a reload cannot kill streams that are mid-turn.

## Endpoints

- `GET /healthz` → `fasfas-proxy OK`
- `POST /admin/reload` (header `x-fasfas-admin: 1`) → swaps in the current
  `index.js` without restarting the OpenCode service. The new file is loaded
  first, so a broken edit leaves the running proxy untouched. Requests already in
  flight finish on the old code. Keys, pins and usage history carry over; the
  in-memory rate windows start empty.
- `GET /keys` → masked keys, live session counts per key, the pins, and every
  session seen in the last 30 minutes with its key, state and last model.
  `POST /keys` takes `{"add":…}`, `{"set":n,"key":…}`, `{"remove":n}` or
  `{"pin":{"session":…,"key":n}}`. `GET /keys/reveal?slot=n` returns one full key
  to a local client only, and refuses browser origins.
- `GET /status` → limits, vision config, compaction config, per-model counters
  (`total`, `throttled`, `retries`, `tokensUsed`), CORS enabled, `no-store`
- `GET /usage` → per-model totals for `24h`, `7d`, `30d`, `all`:

```json
{
  "pricing": { "sonnet-5.5": { "in": 2, "out": 10, "cached": 0.1 } },
  "windows": { "24h": { "requests": 643, "input": 9274153, "output": 69089, "cost": 10.1 } },
  "models": {
    "24h": {
      "sonnet-5.5": { "requests": 111, "input": 4578856, "output": 31554, "reasoning": 0,
                      "cached": 0, "cachedPct": 0.4, "inputReal": 147328380,
                      "avgTps": 0, "meanTps": 0, "medTps": 0, "lastTps": 0, "tpsN": 0,
                      "ttftMs": 0, "ttftN": 0, "avgMs": 0, "cost": 9.473252, "seeded": 1 }
    }
  },
  "lifetime": { "sonnet-5.5": { "requests": 111, "input": 4578856, "output": 31554 } }
}
```

Costs bill cached tokens at the cached-read rate instead of the input rate.
Records live in `.fasfas-usage.jsonl` (30-day retention) and lifetime totals in
`.fasfas-usage.json`.

**How the speed numbers are measured**

- **tok/s** is decode speed. The clock starts at the first streamed frame that
  carries model text (not the first byte), and stops at the last one. Output
  tokens after the first are divided by that window. The panel's average is
  token-weighted: all measured tokens over all measured time. The tooltip also
  shows the mean and median of the per-request rates, and the latest one.
  Replies under 16 tokens, replies that arrive in one frame, and non-streamed
  replies are left out, because their timing is noise.
- **TTFT** is time to first token: request sent to the first text frame.
- **cached %** is cached ÷ input, from requests the proxy carried. Imported
  history has no cache data and is left out. Claude models (haiku, sonnet) only
  cache when requests carry `cache_control`, which the example config enables with
  `compatibility.cacheFormat: "anthropic"`. DeepSeek and GLM cache automatically.

### Seeding history

The proxy only knows about requests it carried. Backfill from the provider
dashboard so the panel is not empty on day one:

```sh
node scripts/seed-usage.mjs --dir ~/.config/opencode/plugins/fasfas-proxy \
  --data scripts/billing-2026-11-15.json --hours 2
```

`scripts/billing-2026-11-15.json` holds the snapshot that was imported (641
requests, 9,341,717 tokens). Seeded rows count their full request and token
totals but are excluded from the TPS and latency averages, which only real
observations can describe; re-running replaces the previous seeds.

## Desktop sidebar panel

`desktop-usage-panel/` adds a **Fasfas usage** tab to the session side region:

- summary cards for requests, input, output and cost;
- one row per model — requests, in, out, reasoning, cached, tok/s, latency, cost;
- a totals row with the same padding as the model rows;
- a `24h | 7d | 30d | all` switch, a **↻** refresh button and 5s auto-refresh;
- a composer pill while the routed session is working:
  `Working (12s · retrying 2 · HTTP 502)`, the retry part appearing only when the
  proxy is re-sending a request. This replaces a standalone working-timer plugin —
  install one or the other, never both, or you get two pills;
- opens from the side region's **+** menu or the command palette.

It is an experimental GUI plugin (`gui-experimental.cjs`), prebuilt as CommonJS
with no build step, so it is copied rather than compiled. The desktop reads the
bundle when a window starts — restart the window after copying. Options when the
plugin is listed in `opencode.jsonc`: `refreshMs` (min 1000) and `usageEndpoint`.

## Verified against the live gateway

```
8 requests to sonnet-5.5 (6/min cap)  -> 8 x 200 in 62s, zero 429s (one waited 54.4s)
64x64 four-quadrant image             -> haiku and sonnet named all four colours natively
image request rejected with 400       -> retried once with captions, turn succeeded
compaction blocked by content-filter  -> retried on glm-5.3-flash
657k-token prompt                     -> needle found at 90% depth in 10s
>1,048,576 tokens                     -> 400 with a clear "maximum context length" message
```

## Tests

```sh
node test/run-tests.mjs                        # offline, mock upstream, fast
FASFAS_API_KEY=... node test/live-check.mjs    # real gateway, real quota
```

64 offline assertions cover passthrough and streaming, `/v1` path handling,
request pacing past a 2-per-second window, token budgets, per-model window
isolation, `429` absorption, images forwarded untouched, caption fallback after a
`400`, overflow spill on both queue wait and upstream `429`, compaction
detection/defer/fallback, and `/usage` accounting with pricing.

## Operational notes

- Listen address is fixed to `127.0.0.1`; if the port is busy the plugin retries
  every 5s, so a standalone instance can hand over to the plugin without manual
  steps.
- Logs go to the OpenCode server log plus `.fasfas-proxy.log`, truncated at 2 MB.
  Every request is logged with model, stream flag, bytes, status, finish reason
  and duration; non-2xx bodies are logged in full.
- Request bodies are buffered so retries can replay them and compaction can
  inspect the finish reason before forwarding.
- Process-level crash guards keep a plugin rejection from taking down the server.

## Not implemented yet

Only add these if the gateway misbehaves: SSE chunk schema validation,
transparent retry for 5xx and dropped streams, finish-reason injection,
buffer-until-complete mode, mid-stream continuation, in-band error detection,
tool-call text repair, and keepalive comments while a request is queued.

## License

MIT
