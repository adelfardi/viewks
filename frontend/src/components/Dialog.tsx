import { useState } from 'react'
import type { ConfirmOpts, PromptOpts } from '../store'
import { cls } from '../util'

export type DialogState =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve(v: boolean): void }
  | { kind: 'prompt'; opts: PromptOpts; resolve(v: string | null): void }

export function Dialog({ state, onDone }: { state: DialogState; onDone(): void }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? state.opts.initial ?? '' : '')
  const [typed, setTyped] = useState('')

  const cancel = () => {
    if (state.kind === 'confirm') state.resolve(false)
    else state.resolve(null)
    onDone()
  }
  const must = state.kind === 'confirm' ? state.opts.typeToConfirm : undefined
  const canOk = !must || typed === must
  const ok = () => {
    if (!canOk) return
    if (state.kind === 'confirm') state.resolve(true)
    else state.resolve(value)
    onDone()
  }
  const o = state.opts
  const danger = state.kind === 'confirm' && state.opts.danger

  return (
    <div className="modal-back" onMouseDown={cancel}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          ok()
        }}
        onKeyDown={(e) => e.key === 'Escape' && cancel()}
      >
        <h3>{o.title}</h3>
        {o.message && <div className="modal-msg">{o.message}</div>}
        {state.kind === 'prompt' && (
          <label className="field">
            {state.opts.label && <span>{state.opts.label}</span>}
            <input autoFocus type={state.opts.type ?? 'text'} min={0} value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        {must && (
          <label className="field">
            <span>
              Contexte de <b className="bad-text">production</b> : tape <code>{must}</code> pour confirmer
            </span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={cancel}>
            Annuler
          </button>
          <button type="submit" autoFocus={!must && state.kind === 'confirm'} className={cls('btn', danger ? 'danger' : 'primary')} disabled={!canOk}>
            {o.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}
