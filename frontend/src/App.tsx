import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Eye, Hexagon, LogIn, Monitor, Moon, Pause, Play, RefreshCw, ShieldAlert, Sun } from 'lucide-react'
import { api, ApiError, type ContextInfo, type LoginState, type Profile, type ProfileStatus, type Settings } from './api'
import { Ctx, type AppCtx, type ConfirmOpts, type PromptOpts, type Selection } from './store'
import { cls, useInterval, useLocalStorage } from './util'
import { NAV } from './resources'
import { AwsPanel } from './components/AwsPanel'
import { Picker } from './components/Picker'
import { OverviewView } from './components/Overview'
import { ResourceView } from './components/ResourceView'
import { EventsView } from './components/EventsView'
import { CustomResources } from './components/CustomResources'
import { Drawer } from './components/Drawer'
import { Dialog, type DialogState } from './components/Dialog'

interface Toast { id: number; msg: string; tone: 'ok' | 'bad' | 'info' }

export default function App() {
  const [settings, setSettingsState] = useState<Settings>({ activeProfile: '', forceProfile: false, readOnly: false })
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [contexts, setContexts] = useState<ContextInfo[]>([])
  const [kubeErrors, setKubeErrors] = useState<string[]>([])
  const [ctx, setCtx] = useLocalStorage('viewks.ctx', '')
  const [nsByCtx, setNsByCtx] = useLocalStorage<Record<string, string>>('viewks.ns', {})
  const [view, setView] = useLocalStorage('viewks.view', 'overview')
  const [auto, setAuto] = useLocalStorage('viewks.auto', true)
  const [sel, setSel] = useState<Selection | null>(null)
  const [tick, setTick] = useState(0)
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [authIssue, setAuthIssue] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [status, setStatus] = useState<ProfileStatus | null>(null)
  const [login, setLogin] = useState<LoginState | null>(null)
  const [statusTick, setStatusTick] = useState(0)
  const [reach, setReach] = useState<Record<string, { reachable: boolean; error?: string; ms: number }>>({})
  const toastId = useRef(0)
  const [theme, setTheme] = useLocalStorage<'system' | 'light' | 'dark'>('viewks.theme', 'system')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toast = useCallback((msg: string, tone: 'ok' | 'bad' | 'info' = 'info') => {
    const id = ++toastId.current
    setToasts((t) => [...t.slice(-4), { id, msg, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 8000 : 4000)
  }, [])

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.isAuth) {
        setAuthIssue(e.message)
        return
      }
      toast(e instanceof Error ? e.message : String(e), 'bad')
    },
    [toast],
  )

  // ---------------------------------------------------------------- bootstrap
  const loadContexts = useCallback(async () => {
    try {
      const r = await api.contexts()
      setContexts(r.contexts)
      setKubeErrors(r.errors ?? [])
      setCtx((cur) => (cur && r.contexts.some((c) => c.name === cur) ? cur : r.current || r.contexts[0]?.name || ''))
    } catch (e) {
      fail(e)
    }
  }, [fail, setCtx])

  const loadReach = useCallback((refresh = false) => {
    api.reachability(refresh).then(setReach).catch(() => setReach({}))
  }, [])
  useEffect(() => loadReach(), [loadReach])
  useInterval(() => loadReach(), 60_000)

  useEffect(() => {
    api.settings().then(setSettingsState).catch(fail)
    api.profiles().then(setProfiles).catch(fail)
    loadContexts()
  }, [fail, loadContexts])

  const saveSettings = async (s: Settings) => {
    try {
      setSettingsState(await api.saveSettings(s))
      setAuthIssue(null)
      loadContexts()
      setStatusTick((t) => t + 1)
      setTick((t) => t + 1)
    } catch (e) {
      fail(e)
    }
  }

  // ---------------------------------------------------------------- AWS status & login
  useEffect(() => {
    if (!settings.activeProfile) return
    let alive = true
    api
      .status(settings.activeProfile)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null))
    return () => {
      alive = false
    }
  }, [settings.activeProfile, statusTick])
  useInterval(() => setStatusTick((t) => t + 1), 60_000)

  const startLogin = async (profile: string) => {
    // open the tab synchronously (popup blockers), then point it at the SSO page
    const win = window.open('', '_blank')
    try {
      const st = await api.login(profile)
      if (win) win.location.href = st.verificationUri
      else window.open(st.verificationUri, '_blank')
      setLogin(st)
    } catch (e) {
      win?.close()
      fail(e)
    }
  }

  useInterval(
    async () => {
      if (!login) return
      try {
        const st = await api.loginPoll(login.id)
        setLogin(st)
        if (st.status === 'success') {
          toast('Connecté à AWS SSO', 'ok')
          setAuthIssue(null)
          setStatusTick((t) => t + 1)
          setTick((t) => t + 1)
          setTimeout(() => setLogin(null), 3000)
        } else if (st.status !== 'pending') {
          toast(st.error || 'Connexion échouée', 'bad')
        }
      } catch (e) {
        fail(e)
        setLogin(null)
      }
    },
    login?.status === 'pending' ? 2000 : null,
  )

  const logout = async (profile: string) => {
    try {
      await api.logout(profile)
      toast('Session SSO supprimée', 'info')
      setStatusTick((t) => t + 1)
    } catch (e) {
      fail(e)
    }
  }

  // ---------------------------------------------------------------- context / namespace
  const ctxInfo = contexts.find((c) => c.name === ctx)
  const ns = ctx in nsByCtx ? nsByCtx[ctx] : ctxInfo?.namespace ?? ''

  // reset the view only when the context really changes
  useEffect(() => {
    setSel(null)
    setAuthIssue(null)
    setNamespaces([])
  }, [ctx])

  // (re)load namespaces on context change and after AWS status checks (e.g. re-login);
  // must not touch the open drawer: statusTick fires every 60 s
  useEffect(() => {
    if (!ctx) return
    let alive = true
    api
      .namespaces(ctx)
      .then((r) => alive && setNamespaces(r.items))
      .catch(fail)
    return () => {
      alive = false
    }
  }, [ctx, fail, statusTick])

  useInterval(() => setTick((t) => t + 1), auto ? 10_000 : null)

  // ---------------------------------------------------------------- dialogs
  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', opts, resolve })),
    [],
  )
  const prompt = useCallback(
    (opts: PromptOpts) => new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', opts, resolve })),
    [],
  )

  const appCtx: AppCtx = useMemo(
    () => ({
      ctx,
      ctxInfo,
      ns,
      settings,
      tick,
      refresh: () => setTick((t) => t + 1),
      open: setSel,
      go: (v: string) => {
        setView(v)
        setSel(null)
      },
      toast,
      fail,
      confirm,
      prompt,
    }),
    [ctx, ctxInfo, ns, settings, tick, toast, fail, confirm, prompt, setView],
  )

  const ctxProfile = ctxInfo?.effectiveProfile
  const reconnectProfile = ctxProfile || settings.activeProfile

  // ---------------------------------------------------------------- render
  const content = !ctx ? (
    <EmptyState errors={kubeErrors} />
  ) : view === 'overview' ? (
    <OverviewView />
  ) : view === 'events' ? (
    <EventsView />
  ) : view === 'custom' ? (
    <CustomResources />
  ) : (
    <ResourceView key={view + ctx} res={view} />
  )

  return (
    <Ctx.Provider value={appCtx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">
              <Hexagon size={18} />
            </div>
            <div>
              <div className="brand-name">viewks</div>
              <div className="brand-sub">EKS console</div>
            </div>
          </div>

          <AwsPanel
            profiles={profiles}
            settings={settings}
            status={status}
            login={login}
            onSettings={saveSettings}
            onLogin={startLogin}
            onLogout={logout}
            onCancelLogin={() => setLogin(null)}
            onRefresh={() => setStatusTick((t) => t + 1)}
          />

          <nav className="nav">
            {NAV.map((g) => (
              <div key={g.title} className="nav-group">
                <div className="nav-title">{g.title}</div>
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    className={cls('nav-item', view === it.id && 'active')}
                    onClick={() => appCtx.go(it.id)}
                    disabled={!ctx}
                  >
                    <it.icon size={15} />
                    <span>{it.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidebar-foot">
            <label className="switch" title="Bloque toute action modifiante (delete, scale, edit, shell…)">
              <input
                type="checkbox"
                checked={settings.readOnly}
                onChange={(e) => saveSettings({ ...settings, readOnly: e.target.checked })}
              />
              <span className="switch-ui" />
              <Eye size={14} /> Lecture seule
            </label>
          </div>
        </aside>

        <main className={cls('main', ctxInfo?.prod && 'is-prod')}>
          <header className="topbar">
            <Picker
              label="Contexte"
              value={ctx}
              placeholder="Choisir un contexte"
              width={460}
              items={contexts.map((c) => ({
                key: c.name,
                label: c.name,
                sub: [c.eksCluster, c.region, c.effectiveProfile && `profil ${c.effectiveProfile}`].filter(Boolean).join(' · ') || c.server,
                group: c.file,
                badge: c.prod ? 'PROD' : c.isEks ? 'EKS' : undefined,
                badgeTone: c.prod ? 'bad' : 'info',
                dot: !reach[c.name] ? 'muted' : reach[c.name].reachable ? 'ok' : 'bad',
                dotTitle: !reach[c.name] ? 'test en cours…' : reach[c.name].reachable ? `joignable (${reach[c.name].ms} ms)` : `injoignable : ${reach[c.name].error}`,
              }))}
              onPick={(k) => setCtx(k)}
              onOpen={() => {
                loadContexts()
                loadReach(true)
              }}
            />
            <Picker
              label="Namespace"
              value={ns}
              allowFree
              placeholder="Tous les namespaces"
              width={320}
              items={[{ key: '', label: 'Tous les namespaces' }, ...namespaces.map((n) => ({ key: n, label: n }))]}
              onPick={(k) => setNsByCtx((m) => ({ ...m, [ctx]: k }))}
              disabled={!ctx}
            />
            {ctxInfo?.prod && (
              <span className="pill bad strong">
                <ShieldAlert size={13} /> PRODUCTION
              </span>
            )}
            {settings.readOnly && (
              <span className="pill info">
                <Eye size={13} /> lecture seule
              </span>
            )}
            <div className="spacer" />
            <button className={cls('btn ghost', auto && 'on')} onClick={() => setAuto(!auto)} title="Rafraîchissement auto (10s)">
              {auto ? <Pause size={14} /> : <Play size={14} />} Auto
            </button>
            <button
              className="btn ghost"
              onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
              title={`Thème : ${theme === 'system' ? 'système' : theme === 'light' ? 'clair' : 'sombre'} (cliquer pour changer)`}
            >
              {theme === 'system' ? <Monitor size={14} /> : theme === 'light' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button className="btn ghost" onClick={() => setTick((t) => t + 1)} title="Rafraîchir">
              <RefreshCw size={14} />
            </button>
          </header>

          {authIssue && (
            <div className="banner bad">
              <AlertTriangle size={16} />
              <div className="grow">
                <b>Authentification AWS requise</b>
                <div className="muted small">{authIssue}</div>
              </div>
              <button className="btn primary" onClick={() => startLogin(reconnectProfile)} disabled={!reconnectProfile}>
                <LogIn size={14} /> Se reconnecter {reconnectProfile && <span className="muted">({reconnectProfile})</span>}
              </button>
            </div>
          )}

          <section className="content">{content}</section>
        </main>

        {sel && <Drawer sel={sel} onClose={() => setSel(null)} onTab={(tab) => setSel({ ...sel, tab })} />}

        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={cls('toast', t.tone)}>
              {t.msg}
            </div>
          ))}
        </div>
        {dialog && <Dialog state={dialog} onDone={() => setDialog(null)} />}
      </div>
    </Ctx.Provider>
  )
}

function EmptyState({ errors }: { errors: string[] }) {
  return (
    <div className="empty">
      <Hexagon size={42} />
      <h2>Aucun contexte Kubernetes</h2>
      <p className="muted">Aucun fichier <code>config*</code> exploitable trouvé dans <code>~/.kube</code>.</p>
      {errors.map((e) => (
        <div key={e} className="pill bad">
          {e}
        </div>
      ))}
    </div>
  )
}
