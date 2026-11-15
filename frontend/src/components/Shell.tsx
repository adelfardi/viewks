import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ctxBase } from '../api'
import { useApp } from '../store'
import { cls } from '../util'

export function ShellTab({ ns, pod, containers }: { ns: string; pod: string; containers: string[] }) {
  const app = useApp()
  const [container, setContainer] = useState(containers[0] ?? '')
  const [session, setSession] = useState(0)
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containers.length && !containers.includes(container)) setContainer(containers[0])
  }, [containers, container])

  useEffect(() => {
    if (!ref.current || !container || app.settings.readOnly) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#070a10', foreground: '#d7dde8', cursor: '#22d3ee', selectionBackground: '#22d3ee44' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}${ctxBase(app.ctx)}/exec/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}?container=${encodeURIComponent(container)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    setState('connecting')
    const resize = () => {
      fit.fit()
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onopen = () => {
      setState('open')
      resize()
      term.focus()
    }
    ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data))
    ws.onclose = () => {
      setState('closed')
      term.write('\r\n\x1b[90m[déconnecté]\x1b[0m\r\n')
    }
    const sub = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'stdin', data: d })))
    const ro = new ResizeObserver(() => resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      sub.dispose()
      ws.close()
      term.dispose()
    }
  }, [app.ctx, app.settings.readOnly, ns, pod, container, session])

  if (app.settings.readOnly) {
    return <div className="list-empty">Shell désactivé en mode lecture seule.</div>
  }

  return (
    <div className="shell">
      <div className="toolbar">
        {containers.length > 1 && (
          <select className="select small" value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <span className="small muted">
          <span className={cls('dot', state === 'open' ? 'ok' : state === 'closed' ? 'bad' : 'muted')} /> {state === 'open' ? 'connecté' : state === 'closed' ? 'fermé' : 'connexion…'}
          {app.ctxInfo?.prod && <b className="bad-text"> · PRODUCTION</b>}
        </span>
        <div className="spacer" />
        <button className="btn small ghost" onClick={() => setSession((s) => s + 1)}>
          <RotateCw size={13} /> Nouvelle session
        </button>
      </div>
      <div className="term" ref={ref} />
    </div>
  )
}
