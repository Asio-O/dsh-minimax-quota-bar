// pkg-16 client: MiniMax / MiniMaxi Token Plan coding_plan/remains display.
//
// Audit fix vs pkg-15: capture the styles.insert disposer and call it
// from the Slot teardown so the CSS is removed when the Slot occupant
// unmounts (Plugin stop / update / navigation away).

return {
  inject: ['timer'],
  apply(ctx) {
    function formatReset(remainsMs) {
      if (!isFinite(remainsMs) || remainsMs <= 0) return ''
      const totalSec = Math.round(remainsMs / 1000)
      const h = Math.floor(totalSec / 3600)
      const m = Math.floor((totalSec % 3600) / 60)
      if (h > 0) return h + 'h' + m + 'm'
      if (m > 0) return m + 'm'
      return 'soon'
    }

    function Bar() {
      const [state, setState] = React.useState({
        ok: false,
        reason: 'loading',
        usedPct: null,
        remaining: null,
        total: null,
        modelName: null,
        remainsMs: null,
        endpoint: null,
      })

      const fetchOnce = React.useCallback(async () => {
        try {
          const result = await host.call('read-token-meter', null)
          if (result && typeof result === 'object') {
            setState({
              ok: !!result.ok,
              reason: result.ok ? null : result.reason || 'unknown',
              usedPct: typeof result.usedPct === 'number' ? result.usedPct : null,
              remaining: typeof result.remaining === 'number' ? result.remaining : null,
              total: typeof result.total === 'number' ? result.total : null,
              modelName: typeof result.modelName === 'string' ? result.modelName : null,
              remainsMs: typeof result.remainsMs === 'number' ? result.remainsMs : null,
              endpoint: result.endpoint || null,
            })
          }
        } catch (err) {
          setState((prev) => ({ ...prev, ok: false, reason: 'rpc-failed' }))
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        fetchOnce()
        const dispose = ctx.interval(() => {
          if (!cancelled) fetchOnce()
        }, 60000)
        return () => {
          cancelled = true
          dispose()
        }
      }, [fetchOnce])

      const fillClass = ['dsh-tkbar-fill']
      let pctText = '—'

      const errorReasons = [
        'no-credentials', 'no-api-key', 'auth', 'curl-failed',
        'exception', 'rpc-failed', 'no-success', 'no-model-remains',
        'no-valid-model-remains', 'api-error', 'bad-json', 'bad-payload',
      ]
      if (errorReasons.indexOf(state.reason) !== -1) {
        fillClass.push('idle')
        pctText = '?'
      } else if (state.reason === 'loading') {
        fillClass.push('idle')
        pctText = '…'
      } else if (state.ok && state.usedPct !== null) {
        const pct = state.usedPct
        pctText = Math.round(pct) + '%'
        if (pct > 85) fillClass.push('danger')
        else if (pct > 65) fillClass.push('warn')
      }

      const reset = formatReset(state.remainsMs)
      const fillWidth = (state.ok && state.usedPct !== null)
        ? Math.max(0, Math.min(100, state.usedPct))
        : 0

      return React.createElement(
        'div',
        { className: 'dsh-tkbar' },
        React.createElement(
          'div',
          { className: 'dsh-tkbar-track' },
          React.createElement('div', {
            className: fillClass.join(' '),
            style: { width: fillWidth + '%' },
          })
        ),
        React.createElement('span', { className: 'dsh-tkbar-text' }, pctText),
        reset
          ? React.createElement('span', {
              className: 'dsh-tkbar-text',
              style: { minWidth: 'auto', marginLeft: '4px', opacity: 0.7 },
            }, reset)
          : null
      )
    }

    const slots = ctx.get('slots')
    if (!slots) return undefined

    // Insert styles once at the Slot injection callback. The disposer
    // is returned by styles.insert and runs when we tear the occupant down.
    const stylesDispose = styles.insert(`
.dsh-tkbar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 11px;
  color: var(--dsh-fg-muted, #8a8f99);
  user-select: none;
}
.dsh-tkbar .dsh-tkbar-track {
  position: relative;
  width: 96px;
  height: 6px;
  border-radius: 3px;
  background: rgba(127, 127, 127, 0.18);
  overflow: hidden;
}
.dsh-tkbar .dsh-tkbar-fill {
  height: 100%;
  width: 0;
  background: #3aa856;
  border-radius: 3px;
  transition: width 200ms ease, background-color 200ms ease;
}
.dsh-tkbar .dsh-tkbar-fill.warn { background: #e0a020; }
.dsh-tkbar .dsh-tkbar-fill.danger { background: #d9444f; }
.dsh-tkbar .dsh-tkbar-fill.idle { background: rgba(127,127,127,0.25); }
.dsh-tkbar .dsh-tkbar-text {
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--dsh-fg, #e6e8ee);
}
`)

    // Register the Slot occupant. When the Slot tears the registration
    // down (Plugin stop / update / navigation away), it also drops our CSS.
    slots.inject('conversation.input.left', () => {
      const innerDispose = slots.register(
        { name: 'conversation.input.left', id: 'token-plan-window', order: 0, label: 'Token Plan Quota' },
        () => React.createElement(Bar)
      )
      return () => {
        try { innerDispose && innerDispose() } catch (err) {}
        try { stylesDispose && stylesDispose() } catch (err) {}
      }
    })

    return undefined
  },
}
