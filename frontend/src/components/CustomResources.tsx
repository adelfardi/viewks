import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { api, type APIResource } from '../api'
import { useApp } from '../store'
import { useLocalStorage } from '../util'
import { ResourceView } from './ResourceView'

export function CustomResources() {
  const app = useApp()
  const [list, setList] = useState<APIResource[] | null>(null)
  const [picked, setPicked] = useLocalStorage<string>('viewks.custom', '')
  const [q, setQ] = useState('')

  useEffect(() => {
    api.apiResources(app.ctx).then(setList).catch(app.fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.ctx])

  const groups = useMemo(() => {
    const t = q.toLowerCase()
    const m = new Map<string, APIResource[]>()
    for (const r of list ?? []) {
      if (t && !`${r.name} ${r.kind} ${r.group} ${(r.shortNames ?? []).join(' ')}`.toLowerCase().includes(t)) continue
      const g = r.group || 'core'
      m.set(g, [...(m.get(g) ?? []), r])
    }
    return [...m.entries()]
  }, [list, q])

  if (picked) {
    const r = list?.find((x) => (x.group ? `${x.name}.${x.group}` : x.name) === picked)
    return (
      <div>
        <button className="btn ghost small back" onClick={() => setPicked('')}>
          <ArrowLeft size={14} /> Ressources
        </button>
        <ResourceView key={picked + app.ctx} res={picked} title={r?.kind ?? picked} />
      </div>
    )
  }

  return (
    <div className="resource">
      <div className="page-head">
        <div>
          <h1>API resources {list && <span className="count big">{list.length}</span>}</h1>
          <div className="muted small">Toutes les ressources listables du cluster, CRDs incluses</div>
        </div>
        <div className="spacer" />
        <div className="search">
          <Search size={14} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer (kind, groupe, shortname)…" />
        </div>
      </div>
      {!list && <div className="card skel" style={{ height: 300 }} />}
      <div className="api-groups">
        {groups.map(([g, rs]) => (
          <div key={g} className="card pad">
            <div className="card-title">{g}</div>
            <div className="chips">
              {rs.map((r) => {
                const id = r.group ? `${r.name}.${r.group}` : r.name
                return (
                  <button key={id} className="chip" onClick={() => setPicked(id)} title={`${r.group || 'core'}/${r.version} · ${r.namespaced ? 'namespaced' : 'cluster'}`}>
                    {r.kind}
                    {r.shortNames?.length ? <span className="muted"> ({r.shortNames[0]})</span> : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
