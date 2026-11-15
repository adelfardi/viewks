import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cls } from '../util'

export interface PickItem {
  key: string
  label: string
  sub?: string
  group?: string
  badge?: string
  badgeTone?: 'bad' | 'info' | 'ok'
  /** small status dot before the label (e.g. cluster reachable or not) */
  dot?: 'ok' | 'bad' | 'muted'
  dotTitle?: string
}

interface Props {
  label: string
  value: string
  items: PickItem[]
  placeholder?: string
  width?: number
  disabled?: boolean
  /** Enter on a search with no match picks the raw text (restricted RBAC: unlisted namespaces) */
  allowFree?: boolean
  onPick(key: string): void
  onOpen?(): void
}

export function Picker({ label, value, items, placeholder, width = 360, disabled, allowFree, onPick, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((i) => terms.every((t) => `${i.label} ${i.sub ?? ''} ${i.group ?? ''}`.toLowerCase().includes(t)))
  }, [items, q])

  useEffect(() => setIdx(0), [q, open])
  useEffect(() => {
    listRef.current?.querySelector('.pick-item.hl')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const current = items.find((i) => i.key === value)
  const pick = (k: string) => {
    onPick(k)
    setOpen(false)
    setQ('')
  }

  let lastGroup: string | undefined
  return (
    <div className="picker" ref={ref}>
      <button
        className={cls('picker-btn', open && 'open')}
        disabled={disabled}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen(!open)
        }}
      >
        <span className="picker-label">{label}</span>
        {current?.dot && <span className={cls('dot', current.dot)} title={current.dotTitle} />}
        <span className="picker-value">{current?.label ?? (value || placeholder)}</span>
        {current?.badge && <span className={cls('badge', current.badgeTone)}>{current.badge}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="picker-pop" style={{ width }}>
          <div className="picker-search">
            <Search size={14} />
            <input
              autoFocus
              value={q}
              placeholder="Rechercher…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setIdx((i) => Math.min(i + 1, filtered.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setIdx((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  if (filtered[idx]) pick(filtered[idx].key)
                  else if (allowFree && q.trim()) pick(q.trim())
                } else if (e.key === 'Escape') setOpen(false)
              }}
            />
          </div>
          <div className="picker-list" ref={listRef}>
            {filtered.length === 0 && (
              <div className="pick-empty muted small">{allowFree && q ? `Entrée pour utiliser « ${q} »` : 'Aucun résultat'}</div>
            )}
            {filtered.map((it, i) => {
              const header = it.group && it.group !== lastGroup ? it.group : null
              lastGroup = it.group
              return (
                <div key={it.key || '__all'}>
                  {header && <div className="pick-group">{header}</div>}
                  <div
                    className={cls('pick-item', i === idx && 'hl', it.key === value && 'sel')}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => pick(it.key)}
                  >
                    {it.dot && <span className={cls('dot', it.dot)} title={it.dotTitle} />}
                    <div className="grow ellipsis">
                      <div className="ellipsis">{it.label}</div>
                      {it.sub && <div className="pick-sub ellipsis">{it.sub}</div>}
                    </div>
                    {it.badge && <span className={cls('badge', it.badgeTone)}>{it.badge}</span>}
                    {it.key === value && <Check size={14} className="accent" />}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
