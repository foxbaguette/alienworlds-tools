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
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(read)
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    try {
      if (theme === DEFAULT_THEME) localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, theme)
    } catch {
      /* A private window: it just won't be remembered. */
    }
  }, [theme])
  return (
    <div className="seg" role="group" aria-label="Colour theme">
      {(['light', 'dark', 'system'] as Theme[]).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
          {t[0].toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  )
}
