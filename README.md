# dsh-minimax-quota-bar

DSH dynamic Cordis plugin that shows the **MiniMax / MiniMaxi Token Plan 5-hour coding-plan quota USED percentage** in the composer left row, fetched from the official `/v1/api/openplatform/coding_plan/remains` API.

Layout: a compact colored progress bar + percentage + reset countdown.

![layout: [bar] 38% 3h15m]

## Install

This is a dynamic Cordis plugin — load it via the DSH plugin manager (or paste the host/client halves into the in-session plugin loader).

### Prerequisites

- DSH running with Cordis dynamic plugins enabled.
- One of these credentials configured in `~/.dsh/.credentials.yaml`:
  - `MINIMAX_API_KEY` — international region (api.minimax.io)
  - `MINIMAX_CN_API_KEY` — mainland China region (api.minimaxi.com)
  - `MINIMAX_SUBSCRIPTION_KEY` — subscription key, accepted by either region
- Active MiniMax or MiniMaxi provider selected in the composer model picker.

The plugin auto-detects the regional endpoint by the active provider id:
- `minimax`, `MiniMax` → `https://api.minimax.io/v1/api/openplatform/coding_plan/remains`
- `minimax-cn`, `minimaxi`, `MiniMaxi` → `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`

### Activate

In the DSH GUI:
1. Open the plugin manager (Cordis > Plugins > +).
2. Paste `packages/pkg-13.host.js` into the Host field and `packages/pkg-13.client.js` into the Client field (or load them from this directory if your manager supports file pickers).
3. Approve the first run, then update to it on subsequent revisions.

Or via the in-session plugin loader (replace `CODE_HOST` / `CODE_CLIENT` with the file contents):

```js
await cordis_define({
  plugin: { kind: 'new', idPrefix: 'tkmtr' },
  name: 'MiniMax Token Plan Quota Bar',
  purpose: 'Show MiniMax / MiniMaxi Token Plan 5-hour quota USED %.',
  code: {
    host: CODE_HOST,
    client: CODE_CLIENT,
  },
})
await cordis_run({ pluginId: 'tkmtr-1', packageId: 'pkg-1', mode: 'run' })
```

## How it computes the bar

The endpoint returns one row per model. For each row, the plugin picks `usedPct` in this order:

1. **`current_interval_remaining_percent`** directly — minimaxi.com (mainland China) returns `current_interval_total_count = 0` for subscription plans, so the only authoritative number is `100 - remaining_percent`.
2. Fallback: `(total - remaining) / total` — used when `total > 0` (some billing tiers still expose prompt counts).

Across rows, the plugin surfaces the **highest-used row** as the most constrained window.

The display uses three color thresholds:
- `≤ 65%` → green
- `> 65% && ≤ 85%` → orange
- `> 85%` → red

## Caching and refresh

- The host caches one successful response per (apiKey, endpoint) for **5 minutes**.
- The host listens for `agent/turn-stopping` and **proactively refreshes** the cache at the end of every agent turn. The next client poll sees fresh data without waiting for a fixed interval.
- The client falls back to polling every **60 seconds** to catch edge cases (idle session, model/region change).
- Concurrent refreshes share one `inflight` Promise — no duplicate fetches when RPC and the turn listener fire together.

Worst-case latency to a fresh number after a turn ends is **60s** (the fallback poll interval); typical latency is "the next time the user looks at the screen", usually a few seconds.

## Diagnostics

The plugin writes detailed logs under the `[token-plan-window]` tag to the DSH process stdout. They cover:

- `success` — endpoint, key name, model name, total / remaining / remaining percent, used percent, source (`remaining_percent` vs `total_minus_remaining`), reset timing.
- `all-auth-failed` — every endpoint/key combination rejected by the API.
- `all-curl-failed` — every endpoint/key connection failed (DNS, network, TLS, …) with stderr.
- `no-api-key` — no recognized credential ref is configured.
- `no-credentials` / `exception` — host-level problems.

The Client UI intentionally collapses any failure to a single `?` so it does not leak token-plan internals into the composer.

## Layout

```
.dsh-minimax-quota-bar/
├── package.json
├── README.md
├── CHANGELOG.md
├── .gitignore
└── packages/
    ├── pkg-13.host.js / pkg-13.client.js   # initial release
    └── pkg-15.host.js / pkg-15.client.js   # current: turn-end refresh + 60s fallback
```

Each numbered pair is one immutable Cordis Package. New versions are appended (e.g. `pkg-16.host.js`); existing files are never overwritten. Switch between them with `cordis_run` mode `update`, or roll back with mode `run` against an older Package.

## License

MIT.
