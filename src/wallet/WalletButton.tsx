import { useEffect, useRef, useState } from 'react'
import { useSession } from './session'

/**
 * Connect, and who you are connected as.
 *
 * Signed in, this button is how you check which account you are using — so it
 * must not also be how you stop being it. One misplaced click on a control
 * people press to READ something and the session is gone. It opens a small menu
 * instead, and leaving is a deliberate second choice inside it.
 */
export function WalletButton() {
  const { session, actor, busy, error, login, logout } = useSession()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as globalThis.Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!session) {
    return (
      <div className="wallet">
        <button className="btn btn--block" type="button" onClick={() => void login()} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect wallet'}
        </button>
        {error ? <p className="wallet__error">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className="wallet" ref={root}>
      <button
        className="wallet__who"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wallet__dot" aria-hidden="true" />
        <span className="wallet__name">{actor}</span>
      </button>

      {open ? (
        <div className="wallet__menu" role="menu">
          <div className="wallet__kicker">Signed in as</div>
          <div className="wallet__actor">{actor}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void logout()
            }}
          >
            Log out
          </button>
        </div>
      ) : null}
    </div>
  )
}
