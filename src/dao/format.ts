/** Formatting shared by the DAO routes. */

/** Whole tokens. The fraction is dropped rather than rounded, and so is the symbol. */
export function fmtAmount(asset: string | null | undefined): string {
  const whole = String(asset ?? '0').split(' ')[0].split('.')[0]
  const n = Number(whole)
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
}

export const assetCode = (a: string | null | undefined) => String(a ?? '').split(' ')[1] ?? ''

/** Whole days. 'voted 341d ago' is the question; a decimal on it is noise. */
export const fmtAge = (ms: number) => `${Math.max(0, Math.floor(ms / 86_400_000))}d`

/**
 * The election clock. Seconds only appear under an hour, where they are the
 * thing you are watching; above it they are just a number that never settles.
 */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms <= 0) return 'pending'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}

/** Days, at the precision the number deserves. */
export function fmtDays(seconds: number | null | undefined): string {
  const n = Number(seconds)
  if (!Number.isFinite(n)) return '—'
  const days = n / 86_400
  const shown = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10
  return `${shown} day${shown === 1 ? '' : 's'}`
}

/**
 * `new Date(NaN).toISOString()` THROWS rather than returning anything useful,
 * so every date printed from chain data goes through here. One unparseable
 * timestamp was once enough to take a whole screen down with it.
 */
export function isoDay(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  try {
    return new Date(ms).toISOString().slice(0, 10)
  } catch {
    return '—'
  }
}

export function isoMinute(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  } catch {
    return '—'
  }
}

export const EXPLORER = 'https://waxblock.io/account/'
