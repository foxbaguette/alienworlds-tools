import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SECTIONS, type Section } from '../sections'

/**
 * Switching between the site's tools.
 *
 * A segmented control was wrong for this. Segments are for two or three short,
 * equal, cheap-to-flip options — a date range, light/dark — and these are none
 * of those: the labels are different lengths, they wrapped onto a second line
 * as soon as there were three, and switching moves you to a different part of
 * the site rather than filtering what you are looking at.
 *
 * So: the pattern every suite of tools uses, a switcher that IS the brand.
 * It states where you are, and opens a menu of where else you could be. One
 * line however many sections there are, and each gets room for a sentence
 * saying what it holds.
 */
export function SectionSwitcher({ section }: { section: Section }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  /* A menu that can only be closed by picking something is a trap, so: click
     anywhere else, or press Escape. `mousedown` rather than `click` so it
     closes on the press, before any underlying control reacts to the release. */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as globalThis.Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        root.current?.querySelector<HTMLButtonElement>('.switcher__button')?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (s: Section) => {
    setOpen(false)
    navigate(s.home)
  }

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="switcher__mark" aria-hidden="true">
          AW
        </span>
        <span className="switcher__text">
          <b>{section.label}</b>
          <small>{section.blurb}</small>
        </span>
        <svg className="switcher__chev" viewBox="0 0 12 12" aria-hidden="true">
          {/* Two chevrons, up and down: this opens a list to pick from, not a
              disclosure that reveals more of the same thing. */}
          <path d="M3 4.5 6 1.5 9 4.5M3 7.5 6 10.5 9 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open ? (
        <div className="switcher__menu" id={menuId} role="menu">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="menuitemradio"
              aria-checked={s.key === section.key}
              onClick={() => pick(s)}
            >
              <span className="switcher__text">
                <b>{s.label}</b>
                <small>{s.blurb}</small>
              </span>
              {s.key === section.key ? (
                <svg className="switcher__tick" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
