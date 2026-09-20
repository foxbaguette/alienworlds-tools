import { useEffect, useState } from 'react'

type Theme = 'system' | 'light' | 'dark'
const KEY = 'alestats.theme'

/** Light unless the viewer has chosen otherwise. */
export const DEFAULT_THEME: Theme = 'light'

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'system' || v === 'light' || v === 'dark' ? v : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * Light, dark, or whatever the operating system is set to.
 *
 * Light by default. "System" is a choice like the other two, so it is
 * remembered too — it just takes the page's theme off <html> and lets the
 * colour-scheme media query decide.
 *
 * The state is module-level because there are two controls for it: a segmented
 * strip in the sidebar where there is room, and a single icon in the phone top
 * bar where there is not. Two useStates would drift apart the moment either was
 * pressed.
 */
let theme: Theme = read()
const listeners = new Set<(t: Theme) => void>()

function apply(next: Theme) {
  theme = next
  const root = document.documentElement
  if (next === 'system') delete root.dataset.theme
  else root.dataset.theme = next
  try {
    if (next === DEFAULT_THEME) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    /* A private window: it just won't be remembered. */
  }
  for (const fn of listeners) fn(next)
}

function useTheme(): [Theme, (t: Theme) => void] {
  const [held, setHeld] = useState(theme)
  useEffect(() => {
    listeners.add(setHeld)
    /* The inline script in <head> already stamped the attribute before first
       paint; this keeps it true if the value was changed some other way. */
    apply(theme)
    return () => {
      listeners.delete(setHeld)
    }
  }, [])
  return [held, apply]
}

const ORDER: Theme[] = ['light', 'dark', 'system']
const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** The three-way strip, for where there is room to show all three at once. */
export function ThemeSwitch() {
  const [held, set] = useTheme()
  return (
    <div className="seg" role="group" aria-label="Colour theme">
      {ORDER.map((t) => (
        <button key={t} type="button" aria-pressed={held === t} onClick={() => set(t)}>
          {LABEL[t]}
        </button>
      ))}
    </div>
  )
}

/**
 * The same choice as one icon, for the phone top bar.
 *
 * Cycles rather than opening a menu. Three options where two are the common
 * ones is not worth a popover, and a cycle is one tap to the thing most people
 * want — the label under the finger says where the next tap goes.
 */
export function ThemeButton() {
  const [held, set] = useTheme()
  const next = ORDER[(ORDER.indexOf(held) + 1) % ORDER.length]
  return (
    <button
      className="icon-btn"
      type="button"
      aria-label={`Theme: ${LABEL[held]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[held]} — tap for ${LABEL[next]}`}
      onClick={() => set(next)}
    >
      <ThemeIcon theme={held} />
    </button>
  )
}

/** Sun, moon, or the two halved — which is what "follow the system" looks like. */
function ThemeIcon({ theme: t }: { theme: Theme }) {
  if (t === 'dark') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path
          d="M16.5 12.6A7 7 0 0 1 7.4 3.5a7 7 0 1 0 9.1 9.1Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (t === 'system') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 4.8a5.2 5.2 0 0 1 0 10.4Z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4" />
      </g>
    </svg>
  )
}
