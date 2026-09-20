import { useEffect, useMemo, useRef, useState } from 'react'

export interface PickablePlayer {
  wallet: string
  tag?: string
  /** A number that says how active they are, for ordering and a hint on the right. */
  activity: number
  /** What that number means, e.g. "dungeons". */
  activityLabel: string
}

const SHOWN = 10

/**
 * Choose one player out of hundreds.
 *
 * A search field, not a dropdown: type part of a gamertag or wallet and the
 * best matches appear under it — names starting with what you typed first,
 * then names containing it, busiest players first within each. With nothing
 * typed it offers the most active players, so a click is enough for the usual
 * case. Arrow keys move, Enter picks, Escape closes.
 */
export function PlayerPicker({
  players,
  value,
  onChange,
}: {
  players: PickablePlayer[]
  value: string | null
  onChange: (wallet: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [editing, setEditing] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const chosen = value ? players.find((p) => p.wallet === value) : undefined

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byActivity = (a: PickablePlayer, b: PickablePlayer) =>
      b.activity - a.activity || (a.tag ?? a.wallet).localeCompare(b.tag ?? b.wallet)
    if (!q) return [...players].sort(byActivity)
    const rank = (p: PickablePlayer) => {
      const tag = (p.tag ?? '').toLowerCase()
      if (tag === q || p.wallet === q) return 0
      if (tag.startsWith(q)) return 1
      if (p.wallet.startsWith(q)) return 2
      if (tag.includes(q)) return 3
      if (p.wallet.includes(q)) return 4
      return 9
    }
    return players
      .map((p) => ({ p, r: rank(p) }))
      .filter((x) => x.r < 9)
      .sort((a, b) => a.r - b.r || byActivity(a.p, b.p))
      .map((x) => x.p)
  }, [players, query])

  const shown = matches.slice(0, SHOWN)

  useEffect(() => setActive(0), [query])

  /* A click anywhere else closes the list. */
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const pick = (p: PickablePlayer) => {
    onChange(p.wallet)
    setQuery('')
    setOpen(false)
    setEditing(false)
  }

  if (chosen && !editing) {
    return (
      <div className="ppick ppick--chosen">
        <span className="ppick__who">
          <strong>{chosen.tag ?? chosen.wallet}</strong>
          {chosen.tag && <span className="mono faint">{chosen.wallet}</span>}
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setEditing(true)
            setOpen(true)
            setTimeout(() => input.current?.focus(), 0)
          }}
        >
          Change
        </button>
        <button type="button" className="btn" onClick={() => onChange(null)}>
          All players
        </button>
      </div>
    )
  }

  const listId = 'ppick-list'

  return (
    <div className="ppick" ref={box}>
      <input
        ref={input}
        className="input ppick__input"
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && shown[active] ? `ppick-${shown[active].wallet}` : undefined}
        aria-autocomplete="list"
        aria-label="Find a player by gamertag or wallet"
        placeholder="Find a player — gamertag or wallet"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(i + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (shown[active]) pick(shown[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
            if (editing) setEditing(false)
          }
        }}
      />
      {editing && (
        <button type="button" className="btn" onClick={() => setEditing(false)}>
          Cancel
        </button>
      )}

      {open && (
        <div className="ppick__panel">
          <p className="ppick__head">
            {query.trim()
              ? matches.length
                ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
                : `No player matches “${query.trim()}”`
              : 'Most active players'}
          </p>
          <ul className="ppick__list" id={listId} role="listbox">
            {shown.map((p, i) => (
              <li
                key={p.wallet}
                id={`ppick-${p.wallet}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'is-active' : undefined}
                onPointerEnter={() => setActive(i)}
                onPointerDown={(e) => {
                  e.preventDefault()
                  pick(p)
                }}
              >
                <span className="ppick__who">
                  <strong>{p.tag ?? p.wallet}</strong>
                  {p.tag && <span className="mono faint">{p.wallet}</span>}
                </span>
                <span className="ppick__hint">
                  {p.activity.toLocaleString('en-US')} {p.activityLabel}
                </span>
              </li>
            ))}
          </ul>
          {matches.length > SHOWN && (
            <p className="ppick__more">{matches.length - SHOWN} more — keep typing to narrow it down.</p>
          )}
        </div>
      )}
    </div>
  )
}
