import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A panel over the page.
 *
 * A native `<dialog>` rather than a positioned div: it brings the backdrop,
 * Escape, focus trapping and the top layer with it, and a hand-rolled version
 * of those is where modals usually go wrong — a form you can tab out of into
 * the page behind it is worse than no modal.
 *
 * Opened by being mounted. The caller decides when it exists; this only has to
 * tell the caller when it should stop.
 */
export function Overlay({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    /* showModal rather than the `open` attribute: only the former puts it in
       the top layer and gives it a backdrop. */
    if (el && !el.open) el.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className="ov"
      /* `cancel` is Escape; `close` is anything that closed it. Both end up
         telling the caller, which is what unmounts this. */
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClose={onClose}
      /* The dialog element IS the backdrop as far as events go — a click that
         lands on it rather than on the panel inside is a click outside. */
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="ov__panel">
        <header className="ov__head">
          <div>
            <h2 className="ov__title">{title}</h2>
            {subtitle ? <p className="ov__sub">{subtitle}</p> : null}
          </div>
          <button className="btn" type="button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <div className="ov__body">{children}</div>
      </div>
    </dialog>
  )
}
