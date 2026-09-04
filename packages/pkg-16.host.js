// pkg-16 host: MiniMax / MiniMaxi Token Plan coding_plan/remains fetcher.
//
// Audit-driven cleanup on top of pkg-15:
// 1. `cache` and `inflight` are closure variables inside `apply(ctx)`,
//    so each Plugin run owns its own state and is GC'd on stop / update.
// 2. Region-aware endpoint ordering: providers like `minimax-cn`,
//    `minimaxi`, `MiniMaxi` try .com first; everything else tries .io
//    first. The other region is still attempted as a fallback.
// 3. Endpoint selection is decided per refresh so a model/region switch
//    is handled on the next turn.
//
// Sandbox note: ctx is read-only. Trigger tag ("rpc" vs "turn-stopping")
// is passed as a function argument, never written back to ctx.
//
// Auth: tries MINIMAX_API_KEY, MINIMAX_CN_API_KEY, MINIMAX_SUBSCRIPTION_KEY,
//       MINIMAX_KEY, MINIMAXI_API_KEY — first non-empty wins.
//
// Field handling:
// - Prefer `current_interval_remaining_percent` directly
//   (minimaxi.com returns total_count=0 for subscription plans).
// - Fallback to (total - remaining) / total when total>0.
//
// All diagnostic details go to the DSH plugin log under [token-plan-window].

const CACHE_MS = 5 * 60 * 1000

const ENDPOINT_IO = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains'
const ENDPOINT_CN = 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains'

const ALL_KEYS = [
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MINIMAX_SUBSCRIPTION_KEY',
  'MINIMAX_KEY',
  'MINIMAXI_API_KEY',
]

function isCnProvider(provider) {
  if (typeof provider !== 'string') return false
  const p = provider.toLowerCase()
  if (p === 'minimax-cn' || p === 'minimaxi') return true
  if (p.indexOf('minimaxi') !== -1) return true
  return false
}

function safeString(v, max) {
  if (v === null || v === undefined) return null
  let s
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch (err) { s = String(v) }
  if (typeof max === 'number' && s.length > max) s = s.slice(0, max) + '…'
  return s
}

function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return NaN
  for (let i = 0; i < keys.length; i += 1) {
    const v = obj[keys[i]]
    if (v === undefined || v === null) continue
    const n = Number(v)
    if (isFinite(n)) return n
  }
  return NaN
}

function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return null
  for (let i = 0; i < keys.length; i += 1) {
    const v = obj[keys[i]]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  return null
}

function deriveUsedPct(m) {
  const remainingPct = pickNum(m, ['current_interval_remaining_percent', 'remaining_percent', 'remainingPercent'])
  const total = pickNum(m, ['current_interval_total_count', 'total_count', 'total', 'total_quota'])
  const remaining = pickNum(m, ['current_interval_usage_count', 'usage_count', 'remaining', 'remaining_count', 'remains'])
  if (!isFinite(total) || total <= 0) {
    if (isFinite(remainingPct) && remainingPct >= 0 && remainingPct <= 100) {
      return { usedPct: Math.max(0, Math.min(100, 100 - remainingPct)), source: 'remaining_percent' }
    }
    return null
  }
  if (!isFinite(remaining)) {
    if (isFinite(remainingPct) && remainingPct >= 0 && remainingPct <= 100) {
      return { usedPct: Math.max(0, Math.min(100, 100 - remainingPct)), source: 'remaining_percent' }
    }
    return null
  }
  const used = Math.max(0, Math.min(total, total - remaining))
  const usedPct = (used * 100) / total
  return { usedPct, source: 'total_minus_remaining' }
}

function parseRemains(bodyText) {
  let payload
  try { payload = JSON.parse(bodyText) } catch (err) { return { ok: false, reason: 'bad-json' } }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-payload' }

  if (payload.base_resp && payload.base_resp.status_code && payload.base_resp.status_code !== 0) {
    return { ok: false, reason: 'api-error', status: payload.base_resp.status_code, message: payload.base_resp.status_msg || '' }
  }
  if (payload.status_code && payload.status_code !== 0) {
    return { ok: false, reason: 'auth', status: payload.status_code, message: payload.status_msg || 'invalid api key' }
  }

  let list = null
  if (Array.isArray(payload.model_remains)) list = payload.model_remains
  else if (Array.isArray(payload.model_remain)) list = payload.model_remain
  else if (Array.isArray(payload.remains)) list = payload.remains

  if (!list || list.length === 0) {
    return {
      ok: false,
      reason: 'no-model-remains',
      rawShape: {
        topKeys: Object.keys(payload),
        modelRemainsType: typeof payload.model_remains,
        modelRemainsIsArr: Array.isArray(payload.model_remains),
        modelRemainsLen: Array.isArray(payload.model_remains) ? payload.model_remains.length : null,
      },
    }
  }

  let best = null
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i]
    if (!m || typeof m !== 'object') continue
    const derived = deriveUsedPct(m)
    if (!derived) continue
    const startMs = pickNum(m, ['start_time', 'window_start'])
    const endMs = pickNum(m, ['end_time', 'window_end'])
    const remainsMs = pickNum(m, ['remains_time', 'remaining_ms', 'reset_in_ms'])
    const modelName = pickStr(m, ['model_name', 'model', 'name']) || 'unknown'
    const total = pickNum(m, ['current_interval_total_count', 'total_count', 'total', 'total_quota'])
    const remaining = pickNum(m, ['current_interval_usage_count', 'usage_count', 'remaining', 'remaining_count', 'remains'])
    const remainingPct = pickNum(m, ['current_interval_remaining_percent', 'remaining_percent'])
    if (!best || derived.usedPct > best.usedPct) {
      best = {
        modelName,
        total: isFinite(total) ? total : 0,
        remaining: isFinite(remaining) ? remaining : 0,
        remainingPct: isFinite(remainingPct) ? remainingPct : null,
        usedPct: derived.usedPct,
        source: derived.source,
        startMs: isFinite(startMs) ? startMs : 0,
        endMs: isFinite(endMs) ? endMs : 0,
        remainsMs: isFinite(remainsMs) ? remainsMs : 0,
      }
    }
  }

  if (!best) return { ok: false, reason: 'no-valid-model-remains', sampleItem: list[0] }
  return { ok: true, best, rawShape: { topKeys: Object.keys(payload), itemKeys: Object.keys(list[0]) } }
}

async function fetchRemains(ctx, endpoint, apiKey) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) return { ok: false, reason: 'no-subprocess' }

  const exec =
    (await subprocess.resolveExecutable('curl.exe', undefined, undefined).catch(() => null)) ||
    (await subprocess.resolveExecutable('curl', undefined, undefined).catch(() => null))
  if (!exec) return { ok: false, reason: 'no-curl', execSearched: 'curl.exe,curl' }

  const handle = subprocess.spawn({
    argv: [exec, '-sS', '-m', '10', '-H', 'Accept: application/json', '-H', 'Authorization: Bearer ' + apiKey, endpoint],
    cwd: '.',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
    graceMs: 12 * 1000,
  })

  const outcome = await handle.done.catch((err) => ({
    exitCode: -1,
    signal: null,
    error: err && err.message ? String(err.message) : String(err),
  }))
  const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : { text: '' }
  const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : { text: '' }

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      reason: 'curl-failed',
      exitCode: outcome.exitCode,
      signal: outcome.signal || null,
      stderr: (stderr && stderr.text) || '',
      spawnError: outcome.error || null,
    }
  }
  return parseRemains((stdout && stdout.text) || '')
}

async function collectCandidateKeys(credentials) {
  const found = []
  const seen = new Set()
  for (let i = 0; i < ALL_KEYS.length; i += 1) {
    const k = ALL_KEYS[i]
    if (seen.has(k)) continue
    seen.add(k)
    try {
      const resolved = await credentials.resolve(k)
      if (resolved && resolved.value) found.push({ name: k, value: resolved.value, source: resolved.source || null })
    } catch (err) {}
  }
  return found
}

function logDiagnostics(tag, payload) {
  try { console.log('[token-plan-window] ' + tag + ' ' + JSON.stringify(payload, null, 2)) }
  catch (err) {
    try { console.log('[token-plan-window] ' + tag + ' (failed to stringify payload)') } catch (err2) {}
  }
}

async function runRefresh(ctx, trigger, orderedEndpoints) {
  try {
    const defaultModel = ctx.get('agentDefaultModel')
    if (!defaultModel) return { ok: false, reason: 'no-service' }
    const selection = defaultModel.currentSelection()
    const provider = selection && selection.provider
    const model = selection && selection.model

    const credentials = ctx.get('credentials')
    if (!credentials) {
      logDiagnostics('no-credentials', { provider, model, trigger })
      return { ok: false, reason: 'no-credentials' }
    }

    const keys = await collectCandidateKeys(credentials)
    if (keys.length === 0) {
      logDiagnostics('no-api-key', { provider, model, tried: ALL_KEYS, trigger })
      return { ok: false, reason: 'no-api-key' }
    }

    const attempts = []
    for (let e = 0; e < orderedEndpoints.length; e += 1) {
      const endpoint = orderedEndpoints[e]
      for (let k = 0; k < keys.length; k += 1) {
        const keyEntry = keys[k]
        let r
        try { r = await fetchRemains(ctx, endpoint, keyEntry.value) }
        catch (innerErr) {
          r = {
            ok: false,
            reason: 'spawn-throw',
            message: innerErr && innerErr.message ? String(innerErr.message) : String(innerErr),
            stack: innerErr && innerErr.stack ? String(innerErr.stack) : null,
          }
        }
        const attempt = {
          endpoint, keyName: keyEntry.name,
          ok: !!r.ok, reason: r.ok ? null : r.reason,
          status: r.status || null,
          message: safeString(r.message, 200),
          exitCode: r.exitCode || null, signal: r.signal || null,
          stderr: safeString(r.stderr, 200),
          spawnError: safeString(r.spawnError, 200),
          spawnStack: safeString(r.stack, 200),
          rawShape: r.rawShape || null,
          sampleItem: r.sampleItem || null,
        }
        attempts.push(attempt)
        if (r.ok) {
          const b = r.best
          logDiagnostics('success', {
            trigger,
            provider, model, endpoint, keyName: keyEntry.name,
            modelName: b.modelName,
            total: b.total, remaining: b.remaining, remainingPct: b.remainingPct,
            usedPct: b.usedPct.toFixed(2), source: b.source,
            startMs: b.startMs, endMs: b.endMs, remainsMs: b.remainsMs,
            keysFound: keys.map((kk) => kk.name),
            rawShape: r.rawShape,
          })
          return {
            ok: true, provider, model, endpoint, keyName: keyEntry.name,
            modelName: b.modelName,
            total: b.total, remaining: b.remaining, remainingPct: b.remainingPct,
            usedPct: b.usedPct, source: b.source,
            startMs: b.startMs, endMs: b.endMs, remainsMs: b.remainsMs,
            attempts, keysFound: keys.map((kk) => kk.name),
          }
        }
      }
    }

    const firstAuthFail = attempts.find((a) => a.reason === 'auth')
    const firstCurlFail = attempts.find((a) => a.reason === 'curl-failed' || a.reason === 'spawn-throw')
    const summary = {
      trigger,
      provider, model,
      keysFound: keys.map((kk) => kk.name),
      attempts,
      summary: {
        successes: attempts.filter((a) => a.ok).length,
        authFails: attempts.filter((a) => a.reason === 'auth').length,
        curlFails: attempts.filter((a) => a.reason === 'curl-failed').length,
        spawnThrows: attempts.filter((a) => a.reason === 'spawn-throw').length,
        otherFails: attempts.filter((a) => !a.ok && a.reason !== 'auth' && a.reason !== 'curl-failed' && a.reason !== 'spawn-throw').length,
      },
    }
    logDiagnostics(firstAuthFail ? 'all-auth-failed' : firstCurlFail ? 'all-curl-failed' : 'no-success', summary)
    return { ok: false, reason: firstAuthFail ? 'auth' : firstCurlFail ? 'curl-failed' : 'no-success', attempts }
  } catch (err) {
    logDiagnostics('exception', {
      trigger,
      message: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack) : null,
    })
    return {
      ok: false,
      reason: 'exception',
      message: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null,
    }
  }
}

function buildPayload(result) {
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    endpoint: result.endpoint,
    keyName: result.keyName,
    modelName: result.modelName,
    total: result.total,
    remaining: result.remaining,
    remainingPct: result.remainingPct,
    usedPct: result.usedPct,
    source: result.source,
    startMs: result.startMs,
    endMs: result.endMs,
    remainsMs: result.remainsMs,
  }
}

return {
  inject: ['credentials'],
  apply(ctx) {
    // Closure-scoped state — owned by this Fiber, GC'd on stop / update.
    let cache = null
    let inflight = null

    function orderedEndpoints(provider) {
      if (isCnProvider(provider)) return [ENDPOINT_CN, ENDPOINT_IO]
      return [ENDPOINT_IO, ENDPOINT_CN]
    }

    function readProvider() {
      try {
        const defaultModel = ctx.get('agentDefaultModel')
        if (!defaultModel) return null
        const sel = defaultModel.currentSelection()
        return sel && sel.provider
      } catch (err) {
        return null
      }
    }

    function startRefresh(trigger, provider) {
      if (inflight) return inflight
      const eps = orderedEndpoints(provider)
      inflight = (async () => {
        try {
          const result = await runRefresh(ctx, trigger, eps)
          if (result && result.ok) {
            const successfulAttempt = result.attempts && result.attempts.find((a) => a.ok)
            cache = {
              apiKey: successfulAttempt ? successfulAttempt.keyName : 'unknown',
              endpoint: result.endpoint,
              fetchedAt: Date.now(),
              payload: buildPayload(result),
            }
            return Object.assign({ cached: false }, cache.payload)
          }
          return result
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    harness.handle('read-token-meter', async () => {
      if (cache && (Date.now() - cache.fetchedAt) < CACHE_MS) {
        return Object.assign({ cached: true }, cache.payload)
      }
      if (inflight) {
        try { return await inflight } catch (err) { /* fall through */ }
      }
      return await startRefresh('rpc', readProvider())
    })

    // Active refresh on turn-stopping: fire-and-forget. The next RPC call
    // (within ≤60s by the client's fallback poll) will see fresh cached data.
    //
    // turn-stopping is a serial listener — must NOT throw or block.
    const offTurnStopping = ctx.on('agent/turn-stopping', (payload) => {
      const agentId = payload && payload.agent ? String(payload.agent.id) : null
      logDiagnostics('turn-stopping-trigger', { agentId })
      try {
        const p = startRefresh('turn-stopping', readProvider())
        p.then((result) => {
          if (result && result.ok) {
            logDiagnostics('turn-stopping-cached', {
              usedPct: result.usedPct != null ? Number(result.usedPct).toFixed(2) : null,
              remainsMs: result.remainsMs,
              endpoint: result.endpoint,
            })
          }
        }).catch((err) => {
          logDiagnostics('turn-stopping-refresh-error', {
            message: err && err.message ? String(err.message) : String(err),
          })
        })
      } catch (err) {
        // Swallow — listener must not throw.
      }
    })

    ctx.effect(() => () => {
      try { offTurnStopping && offTurnStopping() } catch (err) {}
    })
  },
}
