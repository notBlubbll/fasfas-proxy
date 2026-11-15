# fasfas-proxy

An OpenCode V2 plugin (and standalone daemon) that sits between OpenCode and an
OpenAI-compatible gateway and does two jobs:

1. **Per-model rate limiting.** The gateway enforces a hard request cap per model
   and answers `429` when a turn bursts past it — which happens constantly with
   subagents, retries and parallel tool calls. The proxy paces requests with a
   sliding window, so the cap is never reached and the turn never fails.
2. **Vision handoff.** Models that cannot accept images get their image parts
   captioned by a vision model and replaced with the caption text, so a
   text-only model answers normally. One request in, one stream out.
3. **Compaction protection.** Compaction is the one request whose failure costs
   the whole turn, so it waits for a quiet window and, if the provider blocks
   the summary, is re-dispatched to a handoff model.

Everything else is a transparent passthrough: the inbound `authorization`
header is forwarded unchanged, the request body (including the model id) is
forwarded byte-exact, and the response streams back untouched.

No credentials are stored in this repository.

## Measured limits

Read from the gateway dashboard and confirmed by burst probes:

| Model | Requests/min | Tokens/min |
| --- | --- | --- |
| `qwen3.8-27b` | 20 | 3,000,000 |
| `deepseek-v4.1-flash` | 40 | 2,000,000 |
| `glm-5.3-flash` | 20 | 2,000,000 |
| `haiku-5.5` | 20 | 2,000,000 |
| `sonnet-5.5` | 6 | 1,000,000 |
| **aggregate** | **106** | **10,000,000** |

**The limits are per model, not shared.** Each model has its own independent
window, so saturating one does not consume another's budget — the proxy gives
every model its own limiter and its own FIFO queue. Verified: saturating
`sonnet-5.5` to a hard 429 left `deepseek-v4.1-flash` answering `200`, and 30
parallel `qwen3.8-27b` calls yielded exactly 20 × 200 + 10 × 429 regardless of
other traffic.

Notes from the probes:

- Limits are **per model**, not per key or shared: the aggregate ceiling is
  106 requests/min and 10M tokens/min, reached only by using every model at
  once.
- No token-per-minute limit was ever hit with a single 150k-token prompt, but
  the dashboard shows the budgets above and the proxy now paces on them.
- The `429` body names the limit and the wait:
  `"... request limit reached (6 requests per minute). Try again in 49s."`
- `retry-after` was accurate to the second in every sample (waited 50s → `200`).
- No token-per-minute throttling was observed: 3 back-to-back ~150k-token
  prompts on `haiku-5.5` all returned `200`.
- `GET /models` does not consume the chat budget.
- Eight parallel `sonnet-5.5` calls produced 5 × `200` and 3 × `429` — the
  window is shared, not per connection.

The proxy uses a sliding window (`oldest dispatch + window`), which is the
conservative reading of that behaviour.

## Install

### As an OpenCode V2 plugin

Copy the folder into the global plugin directory:

```
~/.config/opencode/plugins/fasfas-proxy/index.js
```

OpenCode discovers plugins from that directory on server start — no `plugins`
config entry is required. Then point your provider at the proxy:

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

A complete provider block with all five models, limits, capabilities and
variants is in [`opencode.fasfas.json`](./opencode.fasfas.json). It contains
**no keys** — the API key comes from `FASFAS_API_KEY` via
[`{env:...}` substitution](https://opencode.ai/docs/config#env-vars), or from
`opencode auth login`.

Set the key for the server process:

```powershell
# PowerShell
[Environment]::SetEnvironmentVariable("FASFAS_API_KEY", "<key>", "User")
```

```sh
# bash / zsh
export FASFAS_API_KEY="<key>"
```

### As a standalone daemon

The same file runs outside OpenCode:

```
node index.js     # or: bun index.js
```

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `FASFAS_PROXY_PORT` | `17331` | listen port (`127.0.0.1` only) |
| `FASFAS_PROXY_UPSTREAM` | `https://ai.coffeevps.com/v1` | upstream base URL |
| `FASFAS_PROXY_LIMITS` | measured table above | requests per window: `model=max/window`, e.g. `sonnet-5.5=6/60s,*=0` |
| `FASFAS_PROXY_TOKEN_LIMITS` | measured table above | tokens per window: `model=tokens/window`, e.g. `haiku-5.5=2000000/60s` |
| `FASFAS_PROXY_RL_BUDGET_MS` | `600000` | max wall-clock spent absorbing `429`s for one request |
| `FASFAS_PROXY_VISION` | on | `0` disables the vision handoff |
| `FASFAS_PROXY_VISION_TARGETS` | `haiku-5.5,sonnet-5.5` | comma list of text-only models (`*` and `prefix*` supported) |
| `FASFAS_PROXY_VISION_MODEL` | `glm-5.3-flash` | model used to caption images |
| `FASFAS_PROXY_VISION_PROMPT` | built-in | caption prompt override |
| `FASFAS_PROXY_COMPACTION` | on | `0` disables compaction protection |
| `FASFAS_PROXY_COMPACTION_MODEL` | `glm-5.3-flash` | handoff model used when a summary is blocked |
| `FASFAS_PROXY_COMPACTION_MIN_BYTES` | `20000` | prompt size (chars) above which a tool-less request counts as compaction |

`FASFAS_PROXY_LIMITS` uses `model=count/window` with `ms`, `s`, `m` or `h`
windows. `0` means unlimited. `*` is the fallback for unlisted models.

### Retry behaviour

- **Local pacing (default path):** a request that would exceed the model's
  request window *or* its token budget waits for the next free slot, then goes
  upstream. Nothing is dropped. Token reservations use a `chars / 4` estimate
  and are reconciled against the real response size when the turn completes.
- **Upstream `429` (limit changed, shared key, race):** `retry-after` is honoured
  (capped at 120s), the limit in the message is learned and applied to the local
  limiter, and the request is re-dispatched. Up to 6 retries and a 10-minute
  budget; after that the real `429` is forwarded to the client.

## Vision handoff

When a request targets a configured text-only model and carries image parts:

1. each image is captioned by the vision model (`glm-5.3-flash` by default),
2. the image part is replaced by a text part containing the caption,
3. the request continues to the **original** model with the same `stream` flag.

Captions are cached by image hash (1 hour TTL, 200 entries), so the same
screenshot resent on later turns costs nothing.

Accepted image shapes: `{"type":"image_url","image_url":{"url":...}}`,
`{"type":"image","source":{"media_type","data"}}`, `{"type":"input_image"}`.
If the vision call fails, the image is replaced with
`[Image attached by the user — vision analysis unavailable]` so the turn still
proceeds.

> **The target model must advertise image input.** OpenCode filters attachments
> client-side: if a model's `capabilities.input` is `["text"]`, the image is
> stripped before the request is sent and never reaches the proxy. In
> `opencode.fasfas.json` the text-only models therefore declare
> `"input": ["text", "image"]` — the proxy then captions and removes the image,
> so the real model never receives image bytes.
>
> If the proxy is not running, images sent to those models will fail upstream
> with `400`.

Verify:

```
opencode run -m fasfas/haiku-5.5 --file=shot.png "what text is in the image?"
```

The proxy log should show
`vision handoff model=haiku-5.5 images=1 analyzed=1`.

## Compaction protection

Compaction sends the whole session as one large, tool-less request. If the
provider ends that stream with a `content-filter` finish reason, OpenCode aborts
the turn with *"Compaction summary was blocked by the provider"* — which is a
model/upstream safety decision, not a quota or timing problem.

A request is treated as compaction when it carries **no tools** and its messages
exceed `FASFAS_PROXY_COMPACTION_MIN_BYTES` characters. Such a request:

1. **waits for a quiet window** — it will not start while another request is in
   flight, so it never competes for the per-minute budget (max 120s wait);
2. **is buffered**, because the finish reason only arrives at the end and the
   decision depends on it;
3. **fails over** to `FASFAS_PROXY_COMPACTION_MODEL` (`glm-5.3-flash`) when the
   provider blocks it — a content-filter finish, an error finish, or any 4xx.
   A different upstream applies a different classifier, so the same body usually
   summarizes fine.

Both attempts are logged:

```
compaction blocked model=haiku-5.5 status=200 finish=content_filter; handing off to glm-5.3-flash
compaction handoff model=glm-5.3-flash status=200 finish=stop bytes=4821
```

Normal tool-carrying requests are never buffered or rerouted, so streaming
latency is unchanged outside compaction.

## Endpoints

- `GET /healthz` → `fasfas-proxy OK`
- `GET /status` (CORS, `no-store`):

```json
{
  "proxy": "fasfas-proxy",
  "upstream": "https://ai.coffeevps.com/v1",
  "active": 1,
  "queued": 0,
  "requests": 42,
  "retries429": 2,
  "vision": { "enabled": true, "model": "glm-5.3-flash", "targets": ["haiku-5.5", "sonnet-5.5"], "cachedCaptions": 1 },
  "compaction": { "enabled": true, "handoffModel": "glm-5.3-flash", "minPromptChars": 20000, "handoffs": 0 },
  "limits": { "sonnet-5.5": "6/60s", "haiku-5.5": "20/60s" },
  "tokenLimits": { "sonnet-5.5": "1000000/60s", "haiku-5.5": "2000000/60s" },
  "models": {
    "sonnet-5.5": {
      "max": 6, "windowMs": 60000, "used": 4,
      "tokenMax": 1000000, "tokenWindowMs": 60000, "tokensUsed": 174217,
      "blockedMs": 0, "total": 42, "throttled": 3, "retries": 0, "shed": 0
    }
  }
}
```

## Verified against the live gateway

`test/live-check.mjs` run against the real endpoint (real quota, real time):

```
healthz -> fasfas-proxy OK
passthrough -> 200 871ms :: "OK"
streaming -> 200 ct=text/event-stream events=5 done=true 577ms
vision handoff -> 200 5846ms :: "Navy"      # haiku-5.5 answers 400 to this image directly
caption cache -> 200 1871ms                  # same image, no second vision call
pacing 8x sonnet (6/60s) -> [200,200,200,200,200,200,200,200] in 62.0s
status.models["sonnet-5.5"] = { max: 6, used: 5, total: 8, throttled: 1, retries: 0 }
```

Eight requests against a 6-per-minute cap produced **zero 429s**: six went
immediately, the rest waited out the window (one logged a 54.4s throttle).

## Tests

```
node test/run-tests.mjs          # offline, mock upstream, fast
FASFAS_API_KEY=... node test/live-check.mjs   # real gateway, real quota
```

`run-tests.mjs` spins a mock upstream plus the proxy and asserts 40 cases: passthrough (status,
answer, authorization header, byte-exact model id, `/v1` path handling),
streaming passthrough (content-type, every chunk, event count), local pacing
past a 2-per-second window, `429` absorption (two `429`s then `200`, with the
upstream retried three times), vision handoff (image removed, caption inserted,
vision model called once, caption cache preventing a second call), and the
`/status` payload (limits, vision config, throttle and retry counters).

The compaction, token-budget and isolation cases were added with the newer
revisions: a blocked finish hands off to the fallback model (and the handoff body
keeps the messages), compaction waits for in-flight requests to settle, a
tool-carrying request is never treated as compaction, the token budget defers a
second oversized request, and two limited models pace independently instead of
sharing a window.

## Operational notes

- Listen address is fixed to `127.0.0.1`.
- If the port is busy the plugin retries binding every 5s, so a standalone
  instance can hand over to the plugin (or vice versa) without manual steps.
- Logs go to the OpenCode server log plus `.fasfas-proxy.log` next to the plugin
  file, truncated at 2 MB.
- Request bodies are buffered in memory so a retry can replay them.
- A plugin reload closes the previous server instance before rebinding, and
  process-level crash guards keep an unhandled rejection in this plugin from
  taking down the OpenCode server.

## Fix backlog

Deliberately out of scope for this revision; add them only if the gateway
misbehaves in practice:

- SSE chunk schema validation with pre-commit buffering
- transparent retry for 5xx / dropped streams / stalls
- finish-reason injection before `[DONE]`
- buffer-until-complete mode
- mid-stream continuation after a cut
- in-band error payload detection (HTTP 200 carrying a JSON error)
- tool-call text repair for models that print calls instead of emitting them
- keepalive comments while a request is queued

## License

MIT
