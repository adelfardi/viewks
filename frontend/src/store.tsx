import { createContext, useContext } from 'react'
import type { ContextInfo, Settings } from './api'

export interface Selection {
  res: string
  name: string
  namespace?: string
  kind?: string
  tab?: string
}

export interface ConfirmOpts {
  title: string
  message: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  /** user must type this text to confirm (used on prod clusters) */
  typeToConfirm?: string
}

export interface PromptOpts {
  title: string
  message?: React.ReactNode
  label?: string
  initial?: string
  type?: 'text' | 'number'
  confirmLabel?: string
}

export interface AppCtx {
  ctx: string
  ctxInfo?: ContextInfo
  ns: string // '' => all namespaces
  settings: Settings
  tick: number
  refresh(): void
  open(sel: Selection): void
  go(view: string): void
  toast(msg: string, tone?: 'ok' | 'bad' | 'info'): void
  fail(e: unknown): void
  confirm(o: ConfirmOpts): Promise<boolean>
  prompt(o: PromptOpts): Promise<string | null>
}

export const Ctx = createContext<AppCtx | null>(null)

export function useApp() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}
