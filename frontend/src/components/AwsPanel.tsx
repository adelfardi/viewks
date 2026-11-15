import { useState } from 'react'
import { Cloud, Copy, ExternalLink, Loader2, LogIn, LogOut, RefreshCw, X } from 'lucide-react'
import type { LoginState, Profile, ProfileStatus, Settings } from '../api'
import { cls, timeUntil } from '../util'

interface Props {
  profiles: Profile[]
  settings: Settings
  status: ProfileStatus | null
  login: LoginState | null
  onSettings(s: Settings): void
  onLogin(profile: string): void
  onLogout(profile: string): void
  onCancelLogin(): void
  onRefresh(): void
}

export function AwsPanel({ profiles, settings, status, login, onSettings, onLogin, onLogout, onCancelLogin, onRefresh }: Props) {
  const [copied, setCopied] = useState(false)
  const p = profiles.find((x) => x.name === settings.activeProfile)
  const connected = !!status?.loggedIn
  const pending = login?.status === 'pending'

  return (
    <div className="aws card">
      <div className="aws-head">
        <Cloud size={15} />
        <span>AWS</span>
        <span className={cls('dot', connected ? 'ok' : status ? 'bad' : 'muted')} />
        <span className="muted small grow">
          {connected ? (status?.ssoExpiresAt ? `SSO · ${timeUntil(status.ssoExpiresAt)}` : 'connecté') : status ? 'déconnecté' : '…'}
        </span>
        <button className="icon-btn" onClick={onRefresh} title="Vérifier">
          <RefreshCw size={13} />
        </button>
      </div>

      <select
        className="select"
        value={settings.activeProfile}
        onChange={(e) => onSettings({ ...settings, activeProfile: e.target.value })}
      >
        {profiles.length === 0 && <option value="">aucun profil</option>}
        {profiles.map((x) => (
          <option key={x.name} value={x.name}>
            {x.name}
          </option>
        ))}
      </select>

      {p && (
        <div className="aws-meta">
          {p.accountId && <span title="Compte">{p.accountId}</span>}
          {p.roleName && <span title="Rôle">{p.roleName}</span>}
          {p.region && <span title="Région">{p.region}</span>}
          {!p.accountId && <span>{p.type}</span>}
        </div>
      )}
      {connected && status?.arn && (
        <div className="aws-arn" title={status.arn}>
          {status.arn.replace(/^arn:aws:sts::/, '')}
        </div>
      )}
      {!connected && status?.error && !pending && <div className="aws-err">{status.error}</div>}

      {pending && login ? (
        <div className="device">
          <div className="small muted">Valide la connexion dans l'onglet ouvert. Code :</div>
          <div className="device-code">
            {login.userCode}
            <button
              className="icon-btn"
              onClick={() => {
                navigator.clipboard?.writeText(login.userCode)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              title="Copier"
            >
              <Copy size={13} />
            </button>
          </div>
          <div className="row gap">
            <a className="btn small" href={login.verificationUri} target="_blank" rel="noreferrer">
              <ExternalLink size={13} /> Rouvrir le lien
            </a>
            <button className="btn small ghost" onClick={onCancelLogin}>
              <X size={13} /> Annuler
            </button>
          </div>
          <div className="small muted row gap">
            <Loader2 size={12} className="spin" /> en attente… {copied && '· copié'}
          </div>
        </div>
      ) : (
        <div className="row gap">
          <button
            className={cls('btn grow', connected ? 'ghost' : 'primary')}
            disabled={!settings.activeProfile || (p && p.type !== 'sso' && !p.sourceProfile)}
            onClick={() => onLogin(settings.activeProfile)}
          >
            <LogIn size={14} /> {connected ? 'Reconnecter' : 'Se connecter'}
          </button>
          {connected && p?.type === 'sso' && (
            <button className="btn ghost" title="Supprimer la session SSO" onClick={() => onLogout(settings.activeProfile)}>
              <LogOut size={14} />
            </button>
          )}
        </div>
      )}

      <label className="switch small" title="Utiliser ce profil pour tous les clusters EKS au lieu du AWS_PROFILE défini dans le kubeconfig">
        <input
          type="checkbox"
          checked={settings.forceProfile}
          onChange={(e) => onSettings({ ...settings, forceProfile: e.target.checked })}
        />
        <span className="switch-ui" />
        Forcer ce profil sur les clusters
      </label>
    </div>
  )
}
