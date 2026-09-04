# Changelog

## pkg-16 — audit-driven cleanup

- `cache` and `inflight` are now closure variables inside `apply(ctx)` so each Plugin run owns its own state and is GC'd on stop / update (pkg-13 → pkg-15 had them at module scope).
- Region-aware endpoint ordering: providers like `minimax-cn` / `minimaxi` / `MiniMaxi` try `.com` first; everything else tries `.io` first. The other region is still attempted as a fallback when the first one fails.
- Client captures the `styles.insert()` disposer and calls it when the Slot occupant unmounts, so Plugin stop / update no longer leaks the stylesheet.

## pkg-15 — turn-end proactive refresh + 60s fallback poll

- Host listens for `agent/turn-stopping` and refreshes the cache after every agent turn, so the next client poll sees fresh data without a fixed-interval wait.
- Client fallback poll changed from 30s to **60s** because the host now actively refreshes on turn boundaries; the longer poll is enough to catch idle / selection-change edge cases.
- Concurrent refreshes share one `inflight` Promise — no duplicate fetches when RPC and the turn-stopping listener fire at the same time.
- Sandbox note: ctx is read-only. Trigger tag (`"rpc"` vs `"turn-stopping"`) is passed as a function argument, never written back to ctx.

## pkg-14 — turn-end proactive refresh

- Initial attempt to add turn-end refresh. Hit the sandbox `ctx is read-only` guard because of `ctx.__refreshTrigger = '...'` — never went live.

## pkg-13 — initial release

- Show MiniMax / MiniMaxi Token Plan 5-hour coding-plan quota USED % in the composer left row.
- Auto-detect region from active provider id (minimax vs minimax-cn).
- Try every known credential ref; use the first successful read.
- Cache successful response 5 minutes per (apiKey, endpoint); client polls every 30 seconds.
- Use `current_interval_remaining_percent` directly when `total_count` is 0 (minimaxi.com schema).
- All diagnostic details go to the DSH plugin log under `[token-plan-window]`.

## How to upgrade

In the DSH plugin manager:

1. Add `packages/pkg-15.host.js` and `packages/pkg-15.client.js` as a new Package on the same Plugin id.
2. Activate with `cordis_run` mode `update`. The previous Package (pkg-13 or pkg-14) is preserved; rollback is one mode `run` away.

The on-disk Plugin state caches snapshots per `cache.apiKey + cache.endpoint`, so a model/region switch will trigger a fresh fetch on the next turn.
