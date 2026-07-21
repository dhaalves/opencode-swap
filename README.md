# oswap

**opencode-go account/key rotator** — a tiny local proxy that automatically rotates between multiple `opencode-go` API keys when you hit rate limits. Zero dependencies, one Node runtime, works on Windows/macOS/Linux.

## The problem

opencode retries rate-limited (HTTP 429) requests with the **same API key** — there is no built-in mechanism to fail over to another account. If you have multiple opencode-go accounts/keys, hitting the per-key usage limit means stopping work (or waiting) even though another key has quota left.

## The fix

oswap sits between opencode and the upstream API (`https://opencode.ai/zen/go`) as a local HTTP proxy. It holds a pool of your keys and:

- **Round-robins** requests across all ready keys
- **Rotates instantly on 429** — the throttled key goes into cooldown (honoring `Retry-After` / `retry-after-ms`), and the request is retried with the next key *before your client ever sees an error*
- **Cools down bad keys** — 401/403 responses park a key for 1 hour; 5xx/network errors park it for 30s
- **Waits when everything is cooling** — if all keys are rate-limited, oswap waits for the earliest key to recover (up to `--max-wait-ms`, default 30s) instead of failing
- **Streams SSE byte-for-byte** — retries only ever happen before the first response byte, so streams are never half-duplicated
- **Persists state** — cooldowns and per-key stats survive restarts in `keys.json`

Rotation is transport-layer only: model names, request bodies, and streaming behavior pass through untouched. `/model` switching, agent configs, and fallback chains in opencode keep working exactly as before.

## How it works

```
opencode ──► http://127.0.0.1:8788/v1 ──► https://opencode.ai/zen/go/v1
                 │                            ▲
                 │  Authorization: key A ─429─┘
                 │  Authorization: key B ────► (retry, transparent)
                 ▼
            keys.json (pool: keys, cooldowns, stats)
```

The `baseURL` override is set on the **provider**, so every `opencode-go/*` model routes through the pool automatically.

## Requirements

- Node.js ≥ 20 (developed on v22; no npm dependencies)
- One or more opencode-go API keys

## Install

```sh
git clone https://github.com/<you>/oswap.git
cd oswap
npm link        # puts the `oswap` command on your PATH
```

## Quick start

```sh
oswap import        # pull existing opencode-go keys from auth.json + account.json
oswap add sk-...    # add more accounts (--label work)
oswap test          # verify every key against the live upstream
oswap install       # point opencode.json at the proxy (backs up first)
oswap serve         # run the proxy — keep it alive while using opencode
```

Then restart opencode. That's it — from now on, rate limits rotate keys instead of blocking you.

Watch rotation live:

```sh
oswap status
```

```
id        label  key           state          requests  rateLimits  failures
c1bda1c9  work   sk-3H...cxnH  cooling 42s    87        1           0
dab9c869  home   sk-PR...NWp6  ready          85        0           0
```

## CLI reference

| Command | Description |
|---|---|
| `oswap serve` | Run the rotation proxy (default `127.0.0.1:8788`) |
| `oswap status` | Live pool state from the running proxy (falls back to saved file) |
| `oswap add <key>` | Add a key (`--label name`) |
| `oswap remove <id>` | Remove a key by id or id prefix |
| `oswap list` | List keys (masked) with stats |
| `oswap reset [id]` | Clear cooldown on one key, or all |
| `oswap import` | Import opencode-go keys from `auth.json` + `account.json` (`--dry-run`) |
| `oswap test` | Check every key against the upstream `/v1/models` |
| `oswap install` | Set `provider.opencode-go.options.baseURL` in `opencode.json` (makes `.oswap-bak` backup) |
| `oswap uninstall` | Remove the baseURL override |

| Option | Default | Description |
|---|---|---|
| `--port <n>` | `8788` | Proxy port |
| `--host <h>` | `127.0.0.1` | Bind host |
| `--upstream <url>` | `https://opencode.ai/zen/go` | Upstream base URL |
| `--max-wait-ms <n>` | `30000` | Max wait for a cooling key before returning 429 |
| `--keys <path>` | `./keys.json` | Pool file location |
| `--provider <id>` | `opencode-go` | Provider id for `import` |

## Rotation semantics

| Upstream response | What oswap does |
|---|---|
| `429` | Cools key for `retry-after-ms` / `Retry-After` (default 60s), retries with next key |
| `401` / `403` | Cools key 1 hour (probably dead, not throttled), retries with next key |
| `5xx` | Cools key 30s, retries with next key |
| Network error | Cools key 30s, retries with next key |
| All keys cooling | Waits for earliest recovery, up to `--max-wait-ms`; else returns 429 with `Retry-After` |
| Other 4xx | Passed through untouched (it's a client error, rotation won't help) |

## Monitoring endpoints

On the proxy port:

- `GET /oswap/health` → `{ ok, upstream }`
- `GET /oswap/status` → per-key state, cooldowns, and counters (keys always masked)

## Configuration file

`keys.json` (created by `oswap import` / `oswap add`) — **contains secrets, keep it out of git** (it's in `.gitignore`):

```json
{
  "version": 1,
  "keys": [
    {
      "id": "c1bda1c9",
      "key": "sk-...",
      "label": "work",
      "cooldownUntil": 0,
      "disabled": false,
      "stats": { "requests": 87, "rateLimits": 1, "failures": 0 }
    }
  ]
}
```

## What `oswap install` changes

It adds this to your `opencode.json` (after copying the original to `opencode.json.oswap-bak`):

```json
{
  "provider": {
    "opencode-go": {
      "options": { "baseURL": "http://127.0.0.1:8788/v1" }
    }
  }
}
```

The key in `auth.json` stays as-is — oswap replaces the `Authorization` header with pool keys, so the configured credential is ignored by the proxy but still keeps the provider enabled. `oswap uninstall` removes the override.

## Keeping the proxy running

The proxy must be alive whenever you use opencode. Options:

- **pm2**: `pm2 start "oswap serve" --name oswap && pm2 save`
- **Windows Task Scheduler**: run `oswap serve` at logon
- Or just leave a terminal open

## Notes & limitations

- **No model fallback.** oswap rotates keys, not models. If a model (not your key) is down, use opencode's own fallback config for that.
- **Other providers are untouched.** If you route opencode-go traffic through another local proxy (e.g. a compression proxy on `:8787`), point *that* proxy's upstream at `127.0.0.1:8788/v1` to get rotation there too.
- **Single machine.** The pool is a local JSON file — no distributed coordination.

## Development

```sh
npm test          # node --test: pool unit tests + proxy integration tests (fake upstream)
```

Source layout:

```
src/pool.js   — key pool: round-robin, cooldowns, atomic JSON persistence
src/proxy.js  — HTTP proxy: auth substitution, retry/rotation loop, SSE pass-through
src/cli.js    — command line: serve/status/add/remove/import/install/test/...
test/         — node:test suites, zero network (fake in-process upstream)
```

## License

MIT
