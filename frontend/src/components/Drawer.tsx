import { useEffect, useMemo, useState } from 'react'
import {
  Ban, CirclePlay, Copy, Download, Eye, EyeOff, FileText, Maximize2, Minimize2, Pause, Pencil, Play, RotateCw, Save, Scaling,
  TerminalSquare, Trash2, X,
} from 'lucide-react'
import { api, type EventItem, type TableResp } from '../api'
import { useApp, type Selection } from '../store'
import { cls, download, ratioTone, timeAgo, toneOf } from '../util'
import { KIND_TO_RES, RESTARTABLE, SCALABLE } from '../resources'
import { cordonNode, deleteObject, restartObject, scaleObject, suspendCron, triggerCron } from '../actions'
import { EventList } from './EventsView'
import { LogsTab } from './Logs'
import { ShellTab } from './Shell'
import { Act } from './ResourceView'

/* eslint-disable @typescript-eslint/no-explicit-any */

export function Drawer({ sel, onClose, onTab }: { sel: Selection; onClose(): void; onTab(t: string): void }) {
  const app = useApp()
  const [obj, setObj] = useState<any>(null)
  const [yaml, setYaml] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [big, setBig] = useState(false)
  const isPod = sel.res === 'pods'
  const tab = sel.tab ?? 'info'
  const ro = app.settings.readOnly

  useEffect(() => {
    setObj(null)
    setYaml('')
    setErr(null)
  }, [sel.res, sel.name, sel.namespace])

  useEffect(() => {
    let alive = true
    api
      .get(app.ctx, sel.res, sel.name, sel.namespace)
      .then((r) => {
        if (!alive) return
        setObj(r.object)
        setYaml(r.yaml)
        setErr(null)
      })
      .catch((e) => alive && setErr(e.message))
    return () => {
      alive = false
    }
  }, [app.ctx, sel.res, sel.name, sel.namespace, app.tick])

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const containers: string[] = useMemo(
    () => [...(obj?.spec?.containers ?? []), ...(obj?.spec?.initContainers ?? []), ...(obj?.spec?.ephemeralContainers ?? [])].map((c: any) => c.name),
    [obj],
  )
  const kind = obj?.kind ?? sel.kind ?? ''
  const tabs = [
    ['info', 'Infos'],
    ['yaml', 'YAML'],
    ['events', 'Events'],
    ...(isPod ? [['logs', 'Logs'], ['shell', 'Shell']] : []),
  ]
  const ns = sel.namespace

  return (
    <div className="drawer-back" onMouseDown={onClose}>
      <aside className={cls('drawer', big && 'big')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="grow ellipsis">
            <div className="muted small">
              {kind}
              {ns && <> · {ns}</>}
            </div>
            <h2 className="ellipsis mono">{sel.name}</h2>
          </div>
          <div className="row-actions">
            {isPod && <Act icon={FileText} title="Logs" onClick={() => onTab('logs')} />}
            {isPod && <Act icon={TerminalSquare} title="Shell" disabled={ro} onClick={() => onTab('shell')} />}
            {SCALABLE.has(sel.res) && <Act icon={Scaling} title="Scale" disabled={ro} onClick={() => scaleObject(app, sel.res, sel.name, ns, obj?.spec?.replicas)} />}
            {RESTARTABLE.has(sel.res) && <Act icon={RotateCw} title="Rollout restart" disabled={ro} onClick={() => restartObject(app, sel.res, sel.name, ns)} />}
            {sel.res === 'cronjobs.batch' && ns && (
              <>
                <Act icon={CirclePlay} title="Lancer maintenant" disabled={ro} onClick={() => triggerCron(app, sel.name, ns)} />
                {obj?.spec?.suspend ? (
                  <Act icon={Play} title="Réactiver" disabled={ro} onClick={() => suspendCron(app, sel.name, ns, false)} />
                ) : (
                  <Act icon={Pause} title="Suspendre" disabled={ro} onClick={() => suspendCron(app, sel.name, ns, true)} />
                )}
              </>
            )}
            {sel.res === 'nodes' && obj && (
              <Act icon={Ban} title={obj.spec?.unschedulable ? 'Uncordon' : 'Cordon'} disabled={ro} onClick={() => cordonNode(app, sel.name, !obj.spec?.unschedulable)} />
            )}
            {sel.res !== 'nodes' && sel.res !== 'namespaces' && (
              <Act
                icon={Trash2}
                title="Supprimer"
                danger
                disabled={ro}
                onClick={async () => {
                  if (await deleteObject(app, sel.res, sel.name, ns, kind)) onClose()
                }}
              />
            )}
            <span className="sep" />
            <button className="icon-btn" onClick={() => setBig(!big)} title="Agrandir">
              {big ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button className="icon-btn" onClick={onClose} title="Fermer (Esc)">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={cls('tab', tab === id && 'active')} onClick={() => onTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className={cls('drawer-body', (tab === 'logs' || tab === 'shell') && 'flush')}>
          {err && <div className="banner bad small">{err}</div>}
          {tab === 'info' && obj && <InfoTab obj={obj} res={sel.res} />}
          {tab === 'yaml' && obj && <YamlTab yaml={yaml} sel={sel} onSaved={(y, o) => { setYaml(y); setObj(o) }} />}
          {tab === 'events' && <ObjEvents sel={sel} kind={kind} />}
          {tab === 'logs' && isPod && ns && (containers.length ? <LogsTab ns={ns} pod={sel.name} containers={containers} /> : <Loading />)}
          {tab === 'shell' && isPod && ns && (containers.length ? <ShellTab ns={ns} pod={sel.name} containers={obj?.spec?.containers.map((c: any) => c.name) ?? []} /> : <Loading />)}
          {!obj && !err && tab !== 'events' && <Loading />}
        </div>
      </aside>
    </div>
  )
}

function Loading() {
  return <div className="list-empty">Chargement…</div>
}

// ---------------------------------------------------------------- Info

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  if (children === undefined || children === null || children === '') return null
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className="v">{children}</div>
    </div>
  )
}

function Labels({ m }: { m?: Record<string, string> }) {
  if (!m || !Object.keys(m).length) return <span className="muted">—</span>
  return (
    <div className="chips">
      {Object.entries(m).map(([k, v]) => (
        <span key={k} className="chip static mono" title={`${k}=${v}`}>
          {k}
          {v && <span className="muted">={v}</span>}
        </span>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  )
}

function InfoTab({ obj, res }: { obj: any; res: string }) {
  const app = useApp()
  const md = obj.metadata ?? {}
  const st = obj.status ?? {}
  const spec = obj.spec ?? {}
  const [showAnn, setShowAnn] = useState(false)
  const annotations = { ...(md.annotations ?? {}) }
  delete annotations['kubectl.kubernetes.io/last-applied-configuration']

  return (
    <div className="info">
      <Section title="Métadonnées">
        <KV k="Namespace">{md.namespace}</KV>
        <KV k="Créé">{md.creationTimestamp && <>{new Date(md.creationTimestamp).toLocaleString()} <span className="muted">({timeAgo(md.creationTimestamp)})</span></>}</KV>
        <KV k="Propriétaire">
          {md.ownerReferences?.map((o: any) => (
            <button key={o.uid} className="link" onClick={() => KIND_TO_RES[o.kind] && app.open({ res: KIND_TO_RES[o.kind], name: o.name, namespace: md.namespace, kind: o.kind })}>
              {o.kind}/{o.name}
            </button>
          ))}
        </KV>
        <KV k="Labels"><Labels m={md.labels} /></KV>
        {Object.keys(annotations).length > 0 && (
          <KV k="Annotations">
            <button className="link" onClick={() => setShowAnn(!showAnn)}>
              {showAnn ? 'masquer' : `afficher (${Object.keys(annotations).length})`}
            </button>
            {showAnn && <Labels m={annotations} />}
          </KV>
        )}
      </Section>

      {res === 'pods' && <PodInfo obj={obj} />}
      {(SCALABLE.has(res) || res === 'daemonsets.apps') && <WorkloadInfo obj={obj} res={res} />}
      {res === 'services' && (
        <Section title="Service">
          <KV k="Type">{spec.type}</KV>
          <KV k="Cluster IP">{spec.clusterIP}</KV>
          <KV k="LoadBalancer">{st.loadBalancer?.ingress?.map((i: any) => i.hostname || i.ip).join(', ')}</KV>
          <KV k="Ports">
            {spec.ports?.map((p: any) => (
              <div key={p.port + p.protocol} className="mono small">
                {p.name && <span className="muted">{p.name}: </span>}
                {p.port}→{p.targetPort}/{p.protocol}
                {p.nodePort && <span className="muted"> (node {p.nodePort})</span>}
              </div>
            ))}
          </KV>
          <KV k="Selector"><Labels m={spec.selector} /></KV>
          {spec.selector && <PodsOf ns={md.namespace} selector={spec.selector} />}
        </Section>
      )}
      {res === 'ingresses.networking.k8s.io' && (
        <Section title="Règles">
          <KV k="Class">{spec.ingressClassName}</KV>
          <KV k="Adresse">{st.loadBalancer?.ingress?.map((i: any) => i.hostname || i.ip).join(', ')}</KV>
          {spec.rules?.map((r: any, i: number) => (
            <div key={i} className="kv">
              <div className="k mono">{r.host ?? '*'}</div>
              <div className="v">
                {r.http?.paths?.map((p: any, j: number) => (
                  <div key={j} className="mono small">
                    {p.path ?? '/'} → {p.backend?.service?.name}:{p.backend?.service?.port?.number ?? p.backend?.service?.port?.name}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}
      {res === 'nodes' && <NodeInfo obj={obj} />}
      {res === 'configmaps' && <DataView data={obj.data} />}
      {res === 'secrets' && <DataView data={obj.data} secret />}
      {Array.isArray(st.conditions) && st.conditions.length > 0 && (
        <Section title="Conditions">
          {st.conditions.map((c: any) => (
            <div key={c.type} className="cond">
              <span className={cls('pill', c.status === 'True' ? (/pressure|unavailable/i.test(c.type) ? 'bad' : 'ok') : /pressure/i.test(c.type) ? 'ok' : 'warn')}>{c.type}</span>
              <span className="small">{c.reason}</span>
              <span className="muted small grow wrap">{c.message}</span>
              <span className="muted tiny nowrap">{timeAgo(c.lastTransitionTime)}</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function stateOf(cs: any): [string, string] {
  if (!cs) return ['—', 'muted']
  if (cs.state?.running) return ['Running', cs.ready ? 'ok' : 'warn']
  if (cs.state?.waiting) return [cs.state.waiting.reason ?? 'Waiting', toneOf(cs.state.waiting.reason) || 'warn']
  if (cs.state?.terminated) return [cs.state.terminated.reason ?? 'Terminated', cs.state.terminated.exitCode === 0 ? 'muted' : 'bad']
  return ['?', 'muted']
}

function PodInfo({ obj }: { obj: any }) {
  const app = useApp()
  const st = obj.status ?? {}
  const statuses = new Map<string, any>([...(st.initContainerStatuses ?? []), ...(st.containerStatuses ?? [])].map((c: any) => [c.name, c]))
  const all = [...(obj.spec.initContainers ?? []).map((c: any) => ({ ...c, init: true })), ...obj.spec.containers]
  return (
    <>
      <Section title="Pod">
        <KV k="Phase"><span className={cls('pill', toneOf(st.phase))}>{st.phase}</span> {st.reason && <span className="muted small">{st.reason}</span>}</KV>
        <KV k="Node">{obj.spec.nodeName && <button className="link" onClick={() => app.open({ res: 'nodes', name: obj.spec.nodeName, kind: 'Node' })}>{obj.spec.nodeName}</button>}</KV>
        <KV k="IP pod">{st.podIP}</KV>
        <KV k="QoS">{st.qosClass}</KV>
        <KV k="ServiceAccount">{obj.spec.serviceAccountName}</KV>
        <KV k="Démarré">{st.startTime && timeAgo(st.startTime)}</KV>
      </Section>
      <Section title="Conteneurs">
        {all.map((c: any) => {
          const cs = statuses.get(c.name)
          const [s, tone] = stateOf(cs)
          const req = c.resources?.requests ?? {}
          const lim = c.resources?.limits ?? {}
          return (
            <div key={c.name} className="container-card">
              <div className="row gap">
                <b className="mono">{c.name}</b>
                {c.init && <span className="badge">init</span>}
                <span className={cls('pill', tone)}>{s}</span>
                {cs?.restartCount > 0 && <span className="pill warn">↻ {cs.restartCount}</span>}
                <div className="spacer" />
              </div>
              <div className="mono small muted ellipsis" title={c.image}>{c.image}</div>
              <div className="small muted">
                req {req.cpu ?? '—'} / {req.memory ?? '—'} · lim {lim.cpu ?? '—'} / {lim.memory ?? '—'}
                {c.ports?.length ? <> · ports {c.ports.map((p: any) => p.containerPort).join(', ')}</> : null}
              </div>
              {cs?.lastState?.terminated && (
                <div className="small bad-text">
                  Dernier arrêt : {cs.lastState.terminated.reason} (exit {cs.lastState.terminated.exitCode}) · {timeAgo(cs.lastState.terminated.finishedAt)}
                </div>
              )}
              {cs?.state?.waiting?.message && <div className="small warn-text wrap">{cs.state.waiting.message}</div>}
            </div>
          )
        })}
      </Section>
    </>
  )
}

function WorkloadInfo({ obj, res }: { obj: any; res: string }) {
  const spec = obj.spec ?? {}
  const st = obj.status ?? {}
  const images: string[] = (spec.template?.spec?.containers ?? []).map((c: any) => c.image)
  const desired = res === 'daemonsets.apps' ? st.desiredNumberScheduled : spec.replicas ?? 1
  const ready = res === 'daemonsets.apps' ? st.numberReady : st.readyReplicas ?? 0
  return (
    <Section title="Workload">
      <KV k="Réplicas">
        <span className={cls('pill', ratioTone(`${ready ?? 0}/${desired ?? 0}`))}>{ready ?? 0}/{desired ?? 0} ready</span>{' '}
        <span className="muted small">
          {st.updatedReplicas !== undefined && `${st.updatedReplicas} à jour · `}
          {st.availableReplicas !== undefined && `${st.availableReplicas} disponibles`}
        </span>
      </KV>
      <KV k="Stratégie">{spec.strategy?.type ?? spec.updateStrategy?.type}</KV>
      <KV k="Images">
        {images.map((i) => (
          <div key={i} className="mono small ellipsis" title={i}>{i}</div>
        ))}
      </KV>
      <KV k="Selector"><Labels m={spec.selector?.matchLabels} /></KV>
      {spec.selector?.matchLabels && <PodsOf ns={obj.metadata.namespace} selector={spec.selector.matchLabels} />}
    </Section>
  )
}

function PodsOf({ ns, selector }: { ns: string; selector: Record<string, string> }) {
  const app = useApp()
  const [t, setT] = useState<TableResp | null>(null)
  const sel = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')
  useEffect(() => {
    api.list(app.ctx, 'pods', ns, sel).then(setT).catch(() => setT(null))
  }, [app.ctx, ns, sel, app.tick])
  if (!t) return null
  const idx = (n: string) => t.columns.findIndex((c) => c.name === n)
  const [iS, iR, iRe, iA] = [idx('Status'), idx('Ready'), idx('Restarts'), idx('Age')]
  return (
    <div className="kv">
      <div className="k">Pods ({t.rows.length})</div>
      <div className="v">
        {t.rows.map((r) => (
          <div key={r.name} className="pod-line click" onClick={() => app.open({ res: 'pods', name: r.name, namespace: ns, kind: 'Pod' })}>
            <span className={cls('pill', toneOf(r.cells[iS]))}>{String(r.cells[iS])}</span>
            <span className="mono small grow ellipsis">{r.name}</span>
            <span className={cls('small', ratioTone(r.cells[iR]) + '-text')}>{String(r.cells[iR])}</span>
            <span className="muted small">↻{String(r.cells[iRe]).split(' ')[0]}</span>
            <span className="muted small">{String(r.cells[iA])}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function NodeInfo({ obj }: { obj: any }) {
  const ni = obj.status?.nodeInfo ?? {}
  const cap = obj.status?.capacity ?? {}
  const alloc = obj.status?.allocatable ?? {}
  return (
    <Section title="Node">
      <KV k="Adresses">{obj.status?.addresses?.map((a: any) => `${a.type}: ${a.address}`).join(' · ')}</KV>
      <KV k="Kubelet">{ni.kubeletVersion}</KV>
      <KV k="OS">{ni.osImage} · {ni.kernelVersion} · {ni.architecture}</KV>
      <KV k="Runtime">{ni.containerRuntimeVersion}</KV>
      <KV k="Capacité">cpu {cap.cpu} · mem {cap.memory} · pods {cap.pods}</KV>
      <KV k="Allouable">cpu {alloc.cpu} · mem {alloc.memory} · pods {alloc.pods}</KV>
      <KV k="Taints">
        {obj.spec?.taints?.map((t: any) => (
          <div key={t.key + t.effect} className="mono small">{t.key}{t.value && `=${t.value}`}:{t.effect}</div>
        )) ?? <span className="muted">—</span>}
      </KV>
    </Section>
  )
}

function DataView({ data, secret }: { data?: Record<string, string>; secret?: boolean }) {
  const [shown, setShown] = useState<Record<string, boolean>>({})
  if (!data || !Object.keys(data).length) return <Section title="Data"><span className="muted">vide</span></Section>
  const decode = (v: string) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))
    } catch {
      return v
    }
  }
  return (
    <Section title={`Data (${Object.keys(data).length})`}>
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="data-item">
          <div className="row gap">
            <b className="mono small">{k}</b>
            <div className="spacer" />
            {secret && (
              <button className="icon-btn" onClick={() => setShown((s) => ({ ...s, [k]: !s[k] }))} title={shown[k] ? 'Masquer' : 'Révéler'}>
                {shown[k] ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
            <button className="icon-btn" title="Copier" onClick={() => navigator.clipboard?.writeText(secret ? decode(v) : v)}>
              <Copy size={13} />
            </button>
          </div>
          <pre className="code small">{secret ? (shown[k] ? decode(v) : '••••••••') : v}</pre>
        </div>
      ))}
    </Section>
  )
}

// ---------------------------------------------------------------- YAML

function YamlTab({ yaml, sel, onSaved }: { yaml: string; sel: Selection; onSaved(y: string, o: any): void }) {
  const app = useApp()
  const [edit, setEdit] = useState(false)
  const [draft, setDraft] = useState(yaml)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!edit) setDraft(yaml)
  }, [yaml, edit])

  const save = async () => {
    if (app.ctxInfo?.prod && !(await app.confirm({ title: 'Appliquer en PROD', message: <>Mettre à jour <b>{sel.name}</b> ?</>, typeToConfirm: sel.name, confirmLabel: 'Appliquer' }))) return
    setSaving(true)
    try {
      const r = await api.update(app.ctx, sel.res, sel.name, sel.namespace, draft)
      onSaved(r.yaml, r.object)
      setEdit(false)
      app.toast(`${sel.name} mis à jour`, 'ok')
      app.refresh()
    } catch (e) {
      app.fail(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="yaml">
      <div className="toolbar">
        {edit ? (
          <>
            <button className="btn small primary" onClick={save} disabled={saving}>
              <Save size={13} /> {saving ? 'Application…' : 'Appliquer'}
            </button>
            <button className="btn small ghost" onClick={() => setEdit(false)}>Annuler</button>
            <span className="muted small">Auto-refresh suspendu pendant l'édition</span>
          </>
        ) : (
          <button className="btn small" onClick={() => setEdit(true)} disabled={app.settings.readOnly}>
            <Pencil size={13} /> Éditer
          </button>
        )}
        <div className="spacer" />
        <button className="icon-btn" title="Copier" onClick={() => navigator.clipboard?.writeText(edit ? draft : yaml)}>
          <Copy size={14} />
        </button>
        <button className="icon-btn" title="Télécharger" onClick={() => download(`${sel.name}.yaml`, edit ? draft : yaml)}>
          <Download size={14} />
        </button>
      </div>
      {edit ? (
        <textarea className="code editor" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <pre className="code">{yaml.split('\n').map((l, i) => <YamlLine key={i} l={l} />)}</pre>
      )}
    </div>
  )
}

const KEY_RE = /^(\s*(?:- )?)([^\s:#][^:#]*?)(:)(\s|$)(.*)$/
function YamlLine({ l }: { l: string }) {
  const m = KEY_RE.exec(l)
  if (!m) return <div className={cls(/^\s*- /.test(l) && 'y-item')}>{l || ' '}</div>
  const v = m[5]
  return (
    <div>
      {m[1]}
      <span className="y-key">{m[2]}</span>
      {m[3]}
      {m[4]}
      <span className={/^(true|false|null|\d+(\.\d+)?)$/.test(v) ? 'y-lit' : /^["']/.test(v) ? 'y-str' : 'y-val'}>{v}</span>
    </div>
  )
}

// ---------------------------------------------------------------- Events

function ObjEvents({ sel, kind }: { sel: Selection; kind: string }) {
  const app = useApp()
  const [items, setItems] = useState<EventItem[] | null>(null)
  useEffect(() => {
    api
      .events(app.ctx, { ns: sel.namespace, name: sel.name, kind })
      .then(setItems)
      .catch(app.fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.ctx, sel.name, sel.namespace, kind, app.tick])
  if (!items) return <Loading />
  return <EventList items={items} />
}
