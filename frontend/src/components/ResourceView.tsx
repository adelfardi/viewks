import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, Ban, CirclePlay, Columns3, FileText, Pause, Play, RotateCw, Scaling, Search, TerminalSquare, Trash2,
} from 'lucide-react'
import { api, type TableResp, type Usage } from '../api'
import { useApp } from '../store'
import { cls, fmtBytes, fmtCpu, ratioTone, toneOf, useLocalStorage } from '../util'
import { navLabel, RESTARTABLE, SCALABLE } from '../resources'
import { cordonNode, deleteObject, restartObject, scaleObject, suspendCron, triggerCron } from '../actions'

const STATUS_COLS = new Set(['status', 'phase', 'ready', 'conditions', 'available', 'suspend', 'completions', 'state'])

export function ResourceView({ res, title }: { res: string; title?: string }) {
  const app = useApp()
  const [data, setData] = useState<TableResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [wide, setWide] = useLocalStorage('viewks.wide', false)
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const [metrics, setMetrics] = useState<Record<string, Usage> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .list(app.ctx, res, app.ns)
      .then((d) => {
        if (!alive) return
        setData(d)
        setErr(null)
      })
      .catch((e) => {
        if (!alive) return
        setErr(e.message)
        if (e.status !== 403) app.fail(e)
      })
      .finally(() => alive && setLoading(false))
    if (res === 'pods' || res === 'nodes') {
      api
        .metrics(app.ctx, res, app.ns)
        .then((m) => alive && setMetrics(m.available ? m.items : null))
        .catch(() => alive && setMetrics(null))
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.ctx, app.ns, app.tick, res])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const showNs = !!data?.namespaced && !app.ns
  const cols = useMemo(() => {
    if (!data) return []
    return data.columns.map((c, i) => ({ ...c, i })).filter((c) => wide || c.priority === 0)
  }, [data, wide])

  const rows = useMemo(() => {
    if (!data) return []
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    let rs = data.rows.filter((r) =>
      terms.every((t) => {
        const eq = t.indexOf('=')
        if (eq > 0 && r.labels) {
          const [k, v] = [t.slice(0, eq), t.slice(eq + 1)]
          return Object.entries(r.labels).some(([lk, lv]) => lk.toLowerCase() === k && lv.toLowerCase().includes(v))
        }
        return `${r.namespace ?? ''} ${r.cells.join(' ')}`.toLowerCase().includes(t)
      }),
    )
    if (sort) {
      const ci = data.columns.findIndex((c) => c.name === sort.col)
      const key = (r: (typeof rs)[number]): string | number => {
        if (sort.col === '__ns') return r.namespace ?? ''
        if (sort.col === 'Age') return -new Date(r.created ?? 0).getTime()
        if (sort.col === '__cpu' || sort.col === '__mem') {
          const u = metrics?.[r.namespace ? `${r.namespace}/${r.name}` : r.name]
          return u ? (sort.col === '__cpu' ? u.cpuMilli : u.memBytes) : -1
        }
        const v = r.cells[ci]
        if (typeof v === 'number') return v
        const s = String(v ?? '')
        const n = Number(s.split('/')[0])
        return s !== '' && !Number.isNaN(n) && /^\d/.test(s) ? n : s.toLowerCase()
      }
      rs = [...rs].sort((a, b) => {
        const [x, y] = [key(a), key(b)]
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
      })
    }
    return rs
  }, [data, q, sort, metrics])

  const toggleSort = (col: string) =>
    setSort((s) => (s?.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }))

  const SortIcon = ({ col }: { col: string }) =>
    sort?.col === col ? (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null

  const kind = data?.kind ?? ''
  const ro = app.settings.readOnly
  const cellOf = (r: TableResp['rows'][number], name: string) => {
    const i = data?.columns.findIndex((c) => c.name === name) ?? -1
    return i >= 0 ? String(r.cells[i] ?? '') : ''
  }

  return (
    <div className="resource">
      <div className="page-head">
        <div>
          <h1>
            {title ?? navLabel(res)} {data && <span className="count big">{rows.length}{rows.length !== data.rows.length && `/${data.rows.length}`}</span>}
          </h1>
          <div className="muted small">
            {data?.namespaced ? (app.ns ? <>namespace <b>{app.ns}</b></> : 'tous les namespaces') : 'ressource cluster'}
            {loading && ' · chargement…'}
          </div>
        </div>
        <div className="spacer" />
        <div className="search">
          <Search size={14} />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer…  (app=api, /)" />
        </div>
        <button className={cls('btn ghost', wide && 'on')} onClick={() => setWide(!wide)} title="Colonnes étendues (-o wide)">
          <Columns3 size={14} /> wide
        </button>
      </div>

      {err && !data && <div className="banner bad small">{err}</div>}

      {data && (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {showNs && (
                    <th onClick={() => toggleSort('__ns')}>
                      Namespace <SortIcon col="__ns" />
                    </th>
                  )}
                  {cols.map((c) => (
                    <th key={c.i} title={c.description} onClick={() => toggleSort(c.name)}>
                      {c.name} <SortIcon col={c.name} />
                    </th>
                  ))}
                  {metrics && (
                    <>
                      <th onClick={() => toggleSort('__cpu')}>CPU <SortIcon col="__cpu" /></th>
                      <th onClick={() => toggleSort('__mem')}>Mém <SortIcon col="__mem" /></th>
                    </>
                  )}
                  <th className="actions-col" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={cols.length + 4} className="list-empty">
                      {data.rows.length ? 'Aucun résultat pour ce filtre' : 'Aucune ressource'}
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const ns = r.namespace || undefined
                  const u = metrics?.[ns ? `${ns}/${r.name}` : r.name]
                  const open = (tab?: string) => app.open({ res, name: r.name, namespace: ns, kind, tab })
                  return (
                    <tr key={(ns ?? '') + '/' + r.name} className="click" onClick={() => open()}>
                      {showNs && <td className="muted">{r.namespace}</td>}
                      {cols.map((c, j) => {
                        const v = r.cells[c.i]
                        const lname = c.name.toLowerCase()
                        const tone = STATUS_COLS.has(lname) ? ratioTone(v) || toneOf(v) : lname === 'restarts' && parseInt(String(v)) > 0 ? 'warn' : ''
                        return (
                          <td key={c.i} className={cls(j === 0 && 'mono strong', c.name === 'Age' && 'muted')}>
                            {tone ? <span className={cls('pill', tone)}>{String(v ?? '')}</span> : fmtCell(v)}
                          </td>
                        )
                      })}
                      {metrics && (
                        <>
                          <td className="mono">{u ? fmtCpu(u.cpuMilli) : '—'}</td>
                          <td className="mono">{u ? fmtBytes(u.memBytes) : '—'}</td>
                        </>
                      )}
                      <td className="actions-col" onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          {res === 'pods' && (
                            <>
                              <Act icon={FileText} title="Logs" onClick={() => open('logs')} />
                              <Act icon={TerminalSquare} title="Shell" disabled={ro} onClick={() => open('shell')} />
                            </>
                          )}
                          {SCALABLE.has(res) && (
                            <Act icon={Scaling} title="Scale" disabled={ro} onClick={() => scaleObject(app, res, r.name, ns, Number(cellOf(r, 'Ready').split('/')[1] || cellOf(r, 'Desired') || 1))} />
                          )}
                          {RESTARTABLE.has(res) && <Act icon={RotateCw} title="Rollout restart" disabled={ro} onClick={() => restartObject(app, res, r.name, ns)} />}
                          {res === 'cronjobs.batch' && ns && (
                            <>
                              <Act icon={CirclePlay} title="Lancer maintenant" disabled={ro} onClick={() => triggerCron(app, r.name, ns)} />
                              {cellOf(r, 'Suspend') === 'True' ? (
                                <Act icon={Play} title="Réactiver" disabled={ro} onClick={() => suspendCron(app, r.name, ns, false)} />
                              ) : (
                                <Act icon={Pause} title="Suspendre" disabled={ro} onClick={() => suspendCron(app, r.name, ns, true)} />
                              )}
                            </>
                          )}
                          {res === 'nodes' && (
                            <Act
                              icon={Ban}
                              title={cellOf(r, 'Status').includes('SchedulingDisabled') ? 'Uncordon' : 'Cordon'}
                              disabled={ro}
                              onClick={() => cordonNode(app, r.name, !cellOf(r, 'Status').includes('SchedulingDisabled'))}
                            />
                          )}
                          {res !== 'nodes' && res !== 'namespaces' && (
                            <Act icon={Trash2} title="Supprimer" danger disabled={ro} onClick={() => deleteObject(app, res, r.name, ns, kind)} />
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtCell(v: unknown) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function Act({ icon: Icon, title, onClick, danger, disabled }: { icon: typeof Trash2; title: string; onClick(): void; danger?: boolean; disabled?: boolean }) {
  return (
    <button className={cls('icon-btn', danger && 'danger')} title={disabled ? `${title} (lecture seule)` : title} disabled={disabled} onClick={onClick}>
      <Icon size={14} />
    </button>
  )
}
