import { useEffect, useState } from 'react'
import { AlertTriangle, Box, Boxes, Layers, RotateCcw, Server } from 'lucide-react'
import { api, type Overview } from '../api'
import { useApp } from '../store'
import { cls, fmtBytes, fmtCpu, timeAgo } from '../util'

export function OverviewView() {
  const app = useApp()
  const [ov, setOv] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .overview(app.ctx, app.ns)
      .then((o) => {
        if (!alive) return
        setOv(o)
        setErr(null)
      })
      .catch((e) => {
        if (!alive) return
        setErr(e.message)
        app.fail(e)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.ctx, app.ns, app.tick])

  useEffect(() => setOv(null), [app.ctx])

  if (!ov) {
    return loading ? <Skeleton /> : <div className="empty"><AlertTriangle size={36} /><p>{err}</p></div>
  }

  const ready = ov.nodes.filter((n) => n.ready).length
  const running = ov.podPhases['Running'] ?? 0
  const phases = ['Running', 'Succeeded', 'Pending', 'Failed', 'Unknown'].filter((p) => ov.podPhases[p])
  const totCpu = ov.nodes.reduce((a, n) => a + n.cpuAllocMilli, 0)
  const totMem = ov.nodes.reduce((a, n) => a + n.memAllocBytes, 0)
  const useCpu = ov.metrics ? ov.nodes.reduce((a, n) => a + (n.usage?.cpuMilli ?? 0), 0) : ov.nodes.reduce((a, n) => a + n.cpuReqMilli, 0)
  const useMem = ov.metrics ? ov.nodes.reduce((a, n) => a + (n.usage?.memBytes ?? 0), 0) : ov.nodes.reduce((a, n) => a + n.memReqBytes, 0)

  return (
    <div className="overview">
      <div className="page-head">
        <div>
          <h1>{app.ctx}</h1>
          <div className="muted small">
            {app.ctxInfo?.eksCluster && <>EKS <b>{app.ctxInfo.eksCluster}</b> · </>}
            {app.ctxInfo?.region && <>{app.ctxInfo.region} · </>}
            Kubernetes {ov.version} {app.ns && <>· namespace <b>{app.ns}</b></>}
          </div>
        </div>
      </div>

      <div className="stats">
        <Stat icon={Server} label="Nodes" value={`${ready}/${ov.nodes.length}`} tone={ov.nodes.length && ready < ov.nodes.length ? 'warn' : 'ok'} onClick={() => app.go('nodes')} />
        <Stat icon={Box} label="Pods running" value={`${running}/${ov.podTotal}`} tone={ov.problems.length ? 'warn' : 'ok'} onClick={() => app.go('pods')} />
        <Stat icon={Boxes} label="Deployments OK" value={`${ov.deployOk}/${ov.deployTotal}`} tone={ov.degraded.length ? 'bad' : 'ok'} onClick={() => app.go('deployments.apps')} />
        <Stat icon={RotateCcw} label="Restarts" value={String(ov.restarts)} tone={ov.restarts > 50 ? 'warn' : ''} />
        <Stat icon={Layers} label="Namespaces" value={String(ov.namespaces || '—')} onClick={() => app.go('namespaces')} />
      </div>

      {ov.nodes.length > 0 && (
        <div className="grid2">
          <div className="card pad">
            <div className="card-title">CPU {ov.metrics ? 'utilisé' : 'demandé (requests)'}</div>
            <Meter value={useCpu} max={totCpu} label={`${fmtCpu(useCpu)} / ${fmtCpu(totCpu)} cores`} />
          </div>
          <div className="card pad">
            <div className="card-title">Mémoire {ov.metrics ? 'utilisée' : 'demandée (requests)'}</div>
            <Meter value={useMem} max={totMem} label={`${fmtBytes(useMem)} / ${fmtBytes(totMem)}`} />
          </div>
        </div>
      )}

      {ov.podTotal > 0 && (
        <div className="card pad">
          <div className="card-title">Phases des pods</div>
          <div className="phasebar">
            {phases.map((p) => (
              <div key={p} className={cls('phase', `ph-${p.toLowerCase()}`)} style={{ flex: ov.podPhases[p] }} title={`${p}: ${ov.podPhases[p]}`} />
            ))}
          </div>
          <div className="legend">
            {phases.map((p) => (
              <span key={p}>
                <i className={cls('sw', `ph-${p.toLowerCase()}`)} /> {p} <b>{ov.podPhases[p]}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <div className="card-title pad-x">Pods en difficulté <span className="count">{ov.problems.length}</span></div>
          <div className="list">
            {ov.problems.length === 0 && <div className="list-empty">Rien à signaler ✓</div>}
            {ov.problems.map((p) => (
              <div key={p.namespace + p.name} className="list-row click" onClick={() => app.open({ res: 'pods', name: p.name, namespace: p.namespace, kind: 'Pod' })}>
                <span className={cls('pill', p.reason === 'Restarts' ? 'warn' : 'bad')}>{p.reason}</span>
                <div className="grow ellipsis">
                  <div className="ellipsis">{p.name}</div>
                  <div className="muted small">{p.namespace}</div>
                </div>
                {p.restarts > 0 && <span className="muted small">↻ {p.restarts}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title pad-x">Deployments dégradés <span className="count">{ov.degraded.length}</span></div>
          <div className="list">
            {ov.degraded.length === 0 && <div className="list-empty">Tous disponibles ✓</div>}
            {ov.degraded.map((d) => (
              <div key={d.namespace + d.name} className="list-row click" onClick={() => app.open({ res: 'deployments.apps', name: d.name, namespace: d.namespace, kind: 'Deployment' })}>
                <span className={cls('pill', d.ready === 0 ? 'bad' : 'warn')}>{d.ready}/{d.desired}</span>
                <div className="grow ellipsis">
                  <div className="ellipsis">{d.name}</div>
                  <div className="muted small">{d.namespace}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {ov.nodes.length > 0 && (
        <div className="card">
          <div className="card-title pad-x">Nodes</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nom</th><th>État</th><th>Type</th><th>Zone</th><th>Groupe</th><th>Pods</th>
                  <th>CPU {ov.metrics ? 'usage' : 'req'}</th><th>Mém {ov.metrics ? 'usage' : 'req'}</th><th>Version</th><th>Âge</th>
                </tr>
              </thead>
              <tbody>
                {ov.nodes.map((n) => {
                  const cpu = ov.metrics ? n.usage?.cpuMilli ?? 0 : n.cpuReqMilli
                  const mem = ov.metrics ? n.usage?.memBytes ?? 0 : n.memReqBytes
                  return (
                    <tr key={n.name} className="click" onClick={() => app.open({ res: 'nodes', name: n.name, kind: 'Node' })}>
                      <td className="mono">{n.name}</td>
                      <td>
                        <span className={cls('pill', n.ready ? (n.unschedulable ? 'warn' : 'ok') : 'bad')}>
                          {n.ready ? (n.unschedulable ? 'Cordoned' : 'Ready') : 'NotReady'}
                        </span>
                      </td>
                      <td>{n.instanceType}{n.capacityType && <span className="muted small"> · {n.capacityType.toLowerCase()}</span>}</td>
                      <td>{n.zone}</td>
                      <td className="ellipsis" style={{ maxWidth: 180 }}>{n.group}</td>
                      <td>{n.pods}/{n.podsAlloc}</td>
                      <td><MiniBar v={cpu} max={n.cpuAllocMilli} /></td>
                      <td><MiniBar v={mem} max={n.memAllocBytes} /></td>
                      <td className="muted">{n.version}</td>
                      <td className="muted">{timeAgo(n.created)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title pad-x">Warnings récents <span className="count">{ov.warnings.length}</span></div>
        <div className="list">
          {ov.warnings.length === 0 && <div className="list-empty">Aucun warning ✓</div>}
          {ov.warnings.map((e, i) => (
            <div key={i} className="list-row">
              <span className="pill warn">{e.reason}</span>
              <div className="grow">
                <div className="small">
                  <b>{e.kind}/{e.name}</b> <span className="muted">· {e.namespace}</span>
                </div>
                <div className="muted small wrap">{e.message}</div>
              </div>
              <span className="muted small nowrap">{e.count > 1 && `×${e.count} · `}{timeAgo(e.last)}</span>
            </div>
          ))}
        </div>
      </div>

      {ov.errors.length > 0 && (
        <div className="muted small">
          Données partielles (RBAC) : {ov.errors.map((e) => e.split(':')[0]).join(', ')}
        </div>
      )}
    </div>
  )
}

function Stat({ icon: Icon, label, value, tone, onClick }: { icon: typeof Box; label: string; value: string; tone?: string; onClick?(): void }) {
  return (
    <div className={cls('stat card', onClick && 'click')} onClick={onClick}>
      <div className="stat-icon"><Icon size={18} /></div>
      <div>
        <div className={cls('stat-value', tone)}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="meter">
      <div className="meter-track">
        <div className={cls('meter-fill', pct > 85 ? 'bad' : pct > 65 ? 'warn' : 'ok')} style={{ width: `${pct}%` }} />
      </div>
      <div className="meter-label">
        <b>{pct.toFixed(0)}%</b> <span className="muted">{label}</span>
      </div>
    </div>
  )
}

function MiniBar({ v, max }: { v: number; max: number }) {
  const pct = max ? Math.min(100, (v / max) * 100) : 0
  return (
    <div className="minibar" title={`${pct.toFixed(0)}%`}>
      <div className="minibar-track">
        <div className={cls('minibar-fill', pct > 85 ? 'bad' : pct > 65 ? 'warn' : 'ok')} style={{ width: `${pct}%` }} />
      </div>
      <span>{pct.toFixed(0)}%</span>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="overview">
      <div className="stats">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="stat card skel" />
        ))}
      </div>
      <div className="card skel" style={{ height: 120 }} />
      <div className="card skel" style={{ height: 260 }} />
    </div>
  )
}
