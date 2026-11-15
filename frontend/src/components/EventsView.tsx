import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { api, type EventItem } from '../api'
import { useApp } from '../store'
import { cls, timeAgo } from '../util'
import { KIND_TO_RES } from '../resources'

export function EventsView() {
  const app = useApp()
  const [items, setItems] = useState<EventItem[] | null>(null)
  const [onlyWarn, setOnlyWarn] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    let alive = true
    api
      .events(app.ctx, { ns: app.ns, type: onlyWarn ? 'Warning' : '', limit: 500 })
      .then((e) => alive && setItems(e))
      .catch(app.fail)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.ctx, app.ns, app.tick, onlyWarn])

  const shown = useMemo(() => {
    const t = q.toLowerCase()
    return (items ?? []).filter((e) => !t || `${e.reason} ${e.kind} ${e.name} ${e.namespace} ${e.message}`.toLowerCase().includes(t))
  }, [items, q])

  return (
    <div className="resource">
      <div className="page-head">
        <div>
          <h1>Events {items && <span className="count big">{shown.length}</span>}</h1>
          <div className="muted small">{app.ns ? <>namespace <b>{app.ns}</b></> : 'tous les namespaces'} · 500 plus récents</div>
        </div>
        <div className="spacer" />
        <div className="seg">
          <button className={cls(!onlyWarn && 'on')} onClick={() => setOnlyWarn(false)}>Tous</button>
          <button className={cls(onlyWarn && 'on')} onClick={() => setOnlyWarn(true)}>Warnings</button>
        </div>
        <div className="search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer…" />
        </div>
      </div>
      <div className="card">
        <EventList items={shown} clickable />
      </div>
    </div>
  )
}

export function EventList({ items, clickable }: { items: EventItem[]; clickable?: boolean }) {
  const app = useApp()
  return (
    <div className="list">
      {items.length === 0 && <div className="list-empty">Aucun event</div>}
      {items.map((e, i) => {
        const res = KIND_TO_RES[e.kind]
        return (
          <div
            key={i}
            className={cls('list-row', clickable && res && 'click')}
            onClick={() => clickable && res && app.open({ res, name: e.name, namespace: e.namespace || undefined, kind: e.kind })}
          >
            <span className={cls('pill', e.type === 'Warning' ? 'warn' : 'muted')}>{e.reason}</span>
            <div className="grow">
              {clickable && (
                <div className="small">
                  <b>{e.kind}/{e.name}</b> {e.namespace && <span className="muted">· {e.namespace}</span>}
                </div>
              )}
              <div className="small wrap">{e.message}</div>
            </div>
            <span className="muted small nowrap" title={e.last}>
              {e.count > 1 && `×${e.count} · `}
              {timeAgo(e.last)}
              {e.source && <div className="tiny">{e.source}</div>}
            </span>
          </div>
        )
      })}
    </div>
  )
}
