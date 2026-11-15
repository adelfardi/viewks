import { useEffect, useRef, useState } from 'react'

export function useLocalStorage<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {
      /* ignore */
    }
  }, [key, v])
  return [v, setV] as const
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (ms === null) return
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

export function fmtCpu(m: number) {
  if (!m) return '0'
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)}`
}

export function fmtBytes(b: number) {
  if (!b) return '0'
  const u = ['B', 'Ki', 'Mi', 'Gi', 'Ti']
  let i = 0
  let n = b
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)}${u[i]}`
}

export function timeAgo(iso?: string) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) || ''}`
  return `${Math.floor(s / 86400)}d`
}

export function timeUntil(iso?: string) {
  if (!iso) return ''
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  if (s <= 0) return 'expiré'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info' | ''

const BAD = /(crashloop|error|failed|backoff|errimage|invalid|oomkilled|notready|evicted|unknown|lost|terminating|false|unavailable|deadline)/i
const WARN = /(pending|creating|initializing|init:|waiting|progress|scaling|cordon|schedulingdisabled|suspended|released)/i
const OK = /^(running|ready|active|bound|true|complete|completed|succeeded|available|normal|healthy)$/i

export function toneOf(v: unknown): Tone {
  const s = String(v ?? '')
  if (!s) return ''
  if (BAD.test(s)) return 'bad'
  if (WARN.test(s)) return 'warn'
  if (OK.test(s)) return 'ok'
  return ''
}

/** "2/3" style ratio cells */
export function ratioTone(v: unknown): Tone {
  const m = /^(\d+)\/(\d+)$/.exec(String(v ?? ''))
  if (!m) return ''
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (b === 0) return 'muted'
  return a >= b ? 'ok' : a === 0 ? 'bad' : 'warn'
}

export function download(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ')
