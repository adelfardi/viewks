export interface Profile {
  name: string
  type: 'sso' | 'static' | 'assume-role' | 'other'
  region?: string
  ssoSession?: string
  ssoStartUrl?: string
  ssoRegion?: string
  accountId?: string
  roleName?: string
  roleArn?: string
  sourceProfile?: string
}

export interface ProfileStatus {
  profile: string
  loggedIn: boolean
  ssoExpiresAt?: string
  account?: string
  arn?: string
  error?: string
  requiresSso: boolean
}

export interface LoginState {
  id: string
  profile: string
  status: 'pending' | 'success' | 'error' | 'expired'
  error?: string
  verificationUri: string
  userCode: string
  expiresAt: string
}

export interface Settings {
  activeProfile: string
  forceProfile: boolean
  readOnly: boolean
}

export interface ContextInfo {
  name: string
  cluster: string
  user: string
  namespace?: string
  server?: string
  file: string
  isEks: boolean
  eksCluster?: string
  region?: string
  roleArn?: string
  awsProfile?: string
  effectiveProfile?: string
  prod: boolean
}

export interface TableColumn { name: string; type: string; format?: string; priority: number; description?: string }
export interface TableRow { name: string; namespace?: string; created?: string; labels?: Record<string, string>; cells: unknown[] }
export interface TableResp { kind: string; resource: string; group: string; namespaced: boolean; columns: TableColumn[]; rows: TableRow[] }

export interface Usage { cpuMilli: number; memBytes: number }
export interface EventItem { type: string; reason: string; message: string; kind: string; name: string; namespace: string; count: number; last: string; source?: string }

export interface NodeSummary {
  name: string; ready: boolean; unschedulable: boolean; roles: string; version: string
  instanceType?: string; zone?: string; group?: string; capacityType?: string
  cpuAllocMilli: number; memAllocBytes: number; cpuReqMilli: number; memReqBytes: number
  pods: number; podsAlloc: number; created: string; usage?: Usage
}

export interface Overview {
  version?: string; platform?: string; namespace?: string; namespaces: number
  nodes: NodeSummary[]; podPhases: Record<string, number>; podTotal: number; restarts: number
  problems: { namespace: string; name: string; reason: string; restarts: number; phase: string }[]
  deployTotal: number; deployOk: number
  degraded: { namespace: string; name: string; ready: number; desired: number }[]
  warnings: EventItem[]; metrics: boolean; errors: string[]
}

export interface APIResource { name: string; group: string; version: string; kind: string; namespaced: boolean; shortNames?: string[] }

export class ApiError extends Error {
  constructor(message: string, public status: number, public reason?: string) {
    super(message)
  }
  get isAuth() {
    return this.reason === 'aws_auth' || this.status === 401
  }
}

async function request<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
  const init: RequestInit = { method, headers: {} }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = contentType
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data: any = undefined
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status, data?.reason)
  }
  return data as T
}

const e = encodeURIComponent
export const ctxBase = (ctx: string) => `/api/ctx/${e(ctx)}`
const nsq = (ns?: string) => (ns ? `ns=${e(ns)}` : '')

export const api = {
  profiles: () => request<Profile[]>('GET', '/api/aws/profiles'),
  status: (p: string, identity = true) => request<ProfileStatus>('GET', `/api/aws/status?profile=${e(p)}&identity=${identity ? 1 : 0}`),
  login: (p: string) => request<LoginState>('POST', '/api/aws/login', { profile: p }),
  loginPoll: (id: string) => request<LoginState>('GET', `/api/aws/login/${e(id)}`),
  logout: (p: string) => request('POST', '/api/aws/logout', { profile: p }),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Settings) => request<Settings>('PUT', '/api/settings', s),

  contexts: () => request<{ contexts: ContextInfo[]; current: string; errors: string[] }>('GET', '/api/contexts'),
  reachability: (refresh = false) =>
    request<Record<string, { reachable: boolean; error?: string; ms: number }>>('GET', `/api/contexts/reachability${refresh ? '?refresh=1' : ''}`),
  namespaces: (ctx: string) => request<{ items: string[]; restricted: boolean }>('GET', `${ctxBase(ctx)}/namespaces`),
  apiResources: (ctx: string) => request<APIResource[]>('GET', `${ctxBase(ctx)}/api-resources`),
  overview: (ctx: string, ns: string) => request<Overview>('GET', `${ctxBase(ctx)}/overview?${nsq(ns)}`),
  list: (ctx: string, res: string, ns: string, labelSelector = '') =>
    request<TableResp>('GET', `${ctxBase(ctx)}/r/${e(res)}?${nsq(ns)}${labelSelector ? `&labelSelector=${e(labelSelector)}` : ''}`),
  get: (ctx: string, res: string, name: string, ns?: string) =>
    request<{ yaml: string; object: any; kind: string }>('GET', `${ctxBase(ctx)}/r/${e(res)}/${e(name)}?${nsq(ns)}`),
  update: (ctx: string, res: string, name: string, ns: string | undefined, yaml: string) =>
    request<{ yaml: string; object: any }>('PUT', `${ctxBase(ctx)}/r/${e(res)}/${e(name)}?${nsq(ns)}`, yaml, 'application/yaml'),
  patch: (ctx: string, res: string, name: string, ns: string | undefined, patch: unknown, type: 'merge' | 'json' | 'strategic' = 'merge') =>
    request('PATCH', `${ctxBase(ctx)}/r/${e(res)}/${e(name)}?${nsq(ns)}`, { type, patch }),
  del: (ctx: string, res: string, name: string, ns?: string, force = false) =>
    request('DELETE', `${ctxBase(ctx)}/r/${e(res)}/${e(name)}?${nsq(ns)}${force ? '&force=1' : ''}`),
  events: (ctx: string, q: { ns?: string; name?: string; kind?: string; type?: string; limit?: number }) => {
    const p = new URLSearchParams()
    Object.entries(q).forEach(([k, v]) => v !== undefined && v !== '' && p.set(k, String(v)))
    return request<EventItem[]>('GET', `${ctxBase(ctx)}/events?${p}`)
  },
  metrics: (ctx: string, kind: 'pods' | 'nodes', ns = '') =>
    request<{ available: boolean; items: Record<string, Usage> }>('GET', `${ctxBase(ctx)}/metrics/${kind}?${nsq(ns)}`),
  triggerCron: (ctx: string, ns: string, name: string) =>
    request<{ job: string }>('POST', `${ctxBase(ctx)}/cronjobs/${e(ns)}/${e(name)}/trigger`),
}
