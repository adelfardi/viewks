import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Download, Eraser, Search, WrapText } from 'lucide-react'
import { ctxBase } from '../api'
import { useApp } from '../store'
import { cls, download } from '../util'

const MAX_LINES = 20000

export function LogsTab({ ns, pod, containers }: { ns: string; pod: string; containers: string[] }) {
  const app = useApp()
  const [container, setContainer] = useState(containers[0] ?? '')
  const [tail, setTail] = useState(500)
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [timestamps, setTimestamps] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [filter, setFilter] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [state, setState] = useState<'connecting' | 'live' | 'ended' | 'error'>('connecting')
  const [err, setErr] = useState('')
  const [stick, setStick] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containers.length && !containers.includes(container)) setContainer(containers[0])
  }, [containers, container])

  useEffect(() => {
    if (!container) return
    setLines([])
    setErr('')
    setState('connecting')
    const p = new URLSearchParams({ container, tail: String(tail), follow: follow ? '1' : '0', previous: previous ? '1' : '0', timestamps: timestamps ? '1' : '0' })
    const es = new EventSource(`${ctxBase(app.ctx)}/logs/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}?${p}`)
    let buf: string[] = []
    const flush = setInterval(() => {
      if (!buf.length) return
      const chunk = buf
      buf = []
      setLines((l) => {
        const n = l.concat(chunk)
        return n.length > MAX_LINES ? n.slice(n.length - MAX_LINES) : n
      })
    }, 150)
    es.onopen = () => setState('live')
    es.onmessage = (e) => buf.push(e.data)
    es.addEventListener('end', () => {
      setState('ended')
      es.close()
    })
    es.addEventListener('failure', (e) => {
      setErr((e as MessageEvent).data)
      setState('error')
      es.close()
    })
    es.onerror = () => {
      es.close()
      setState((s) => (s === 'live' || s === 'connecting' ? 'ended' : s))
    }
    return () => {
      es.close()
      clearInterval(flush)
    }
  }, [app.ctx, ns, pod, container, tail, follow, previous, timestamps])

  useEffect(() => {
    if (stick && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, stick, filter])

  const shown = useMemo(() => {
    if (!filter) return lines
    const f = filter.toLowerCase()
    return lines.filter((l) => l.toLowerCase().includes(f))
  }, [lines, filter])

  return (
    <div className="logs">
      <div className="toolbar">
        {containers.length > 1 && (
          <select className="select small" value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <select className="select small" value={tail} onChange={(e) => setTail(Number(e.target.value))} title="Lignes initiales">
          {[100, 500, 2000, 10000, -1].map((n) => (
            <option key={n} value={n}>
              {n < 0 ? 'tout' : `${n} lignes`}
            </option>
          ))}
        </select>
        <Toggle on={follow} set={setFollow} label="follow" />
        <Toggle on={previous} set={setPrevious} label="previous" />
        <Toggle on={timestamps} set={setTimestamps} label="timestamps" />
        <div className="search small grow">
          <Search size={13} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="grep…" />
        </div>
        <button className={cls('icon-btn', wrap && 'on')} onClick={() => setWrap(!wrap)} title="Retour à la ligne">
          <WrapText size={14} />
        </button>
        <button className={cls('icon-btn', stick && 'on')} onClick={() => setStick(!stick)} title="Suivre le bas">
          <ArrowDownToLine size={14} />
        </button>
        <button className="icon-btn" onClick={() => setLines([])} title="Effacer">
          <Eraser size={14} />
        </button>
        <button className="icon-btn" onClick={() => download(`${pod}-${container}.log`, lines.join('\n'))} title="Télécharger">
          <Download size={14} />
        </button>
      </div>
      <div
        ref={boxRef}
        className={cls('logbox', wrap && 'wrap')}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
          if (atBottom !== stick) setStick(atBottom)
        }}
      >
        {shown.map((l, i) => (
          <div key={i} className={cls('logline', /\b(error|fatal|panic|exception)\b/i.test(l) ? 'bad' : /\bwarn(ing)?\b/i.test(l) && 'warn')}>
            {filter ? highlight(l, filter) : l || ' '}
          </div>
        ))}
        {err && <div className="logline bad">⚠ {err}</div>}
      </div>
      <div className="statusline">
        <span className={cls('dot', state === 'live' ? 'ok pulse' : state === 'error' ? 'bad' : 'muted')} />
        {state === 'live' ? (follow ? 'streaming' : 'chargement') : state === 'ended' ? 'flux terminé' : state === 'error' ? 'erreur' : 'connexion…'}
        <span className="muted"> · {lines.length} lignes{filter && ` · ${shown.length} filtrées`}</span>
      </div>
    </div>
  )
}

function highlight(line: string, f: string) {
  const out: React.ReactNode[] = []
  const low = line.toLowerCase()
  const fl = f.toLowerCase()
  let i = 0
  let k = 0
  while (true) {
    const j = low.indexOf(fl, i)
    if (j < 0) break
    out.push(line.slice(i, j), <mark key={k++}>{line.slice(j, j + f.length)}</mark>)
    i = j + f.length
  }
  out.push(line.slice(i))
  return out
}

function Toggle({ on, set, label }: { on: boolean; set(v: boolean): void; label: string }) {
  return (
    <button className={cls('tog', on && 'on')} onClick={() => set(!on)}>
      {label}
    </button>
  )
}
