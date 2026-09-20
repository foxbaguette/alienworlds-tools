import { useSyncExternalStore } from 'react'

/**
 * The period every overview shows — one choice for all of them.
 *
 * Picking 30 days on one overview shows 30 days on the others too, and the
 * choice is kept for the next visit. It lives in this module, so every page
 * sees a change at once, and in localStorage, so it outlasts the tab.
 */
export const PERIODS = ['7', '14', '30', '90', 'all'] as const
export type PeriodKey = (typeof PERIODS)[number]

const KEY = 'alestats.period'
const DEFAULT: PeriodKey = '7'

const isPeriod = (v: unknown): v is PeriodKey => PERIODS.includes(v as PeriodKey)

function stored(): PeriodKey {
  try {
    const v = localStorage.getItem(KEY)
    return isPeriod(v) ? v : DEFAULT
  } catch {
    return DEFAULT
  }
}

let current: PeriodKey = stored()
const listeners = new Set<() => void>()

export function setPeriod(p: PeriodKey): void {
  current = p
  try {
    if (p === DEFAULT) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    /* Private windows may refuse; the choice still holds for this visit. */
  }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  /* Another tab of the site changed it. */
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    current = stored()
    l()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(l)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePeriod(): [PeriodKey, (p: PeriodKey) => void] {
  return [useSyncExternalStore(subscribe, () => current), setPeriod]
}
