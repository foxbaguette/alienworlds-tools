import { useEffect, useState } from 'react'
import { fmtCountdown, isoMinute } from '../format'

/**
 * The time to a DAO's next election.
 *
 * One interval for the whole page rather than one per clock: a dozen cards each
 * holding their own timer is a dozen renders a second for the same tick. This
 * subscribes to a single shared one.
 */
const listeners = new Set<(t: number) => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(fn: (t: number) => void) {
  listeners.add(fn)
  if (!timer) {
    timer = setInterval(() => {
      const now = Date.now()
      for (const l of listeners) l(now)
    }, 1000)
  }
  return () => {
    listeners.delete(fn)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function Countdown({ due, periodLength }: { due: number | null; periodLength?: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribe(setNow), [])

  if (!due) return null
  const left = due - now
  const pending = left <= 0

  return (
    <span
      className={`dao-clock${pending ? ' is-pending' : ''}${left > 0 && left < 3_600_000 ? ' is-soon' : ''}`}
      title={`Next election due ${isoMinute(due)} UTC${
        periodLength ? ` · period is ${Math.round(periodLength / 86_400)} days` : ''
      }`}
    >
      {fmtCountdown(left)}
    </span>
  )
}
