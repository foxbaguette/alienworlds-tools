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

/**
 * Vote power with the contract's own decay applied.
 *
 * `total_vote_power` is a running sum that never ages — a candidate who was
 * voted for two years ago and nobody has touched since still shows the same
 * figure, which is why ranking off it disagrees with the order the chain seats
 * people in.
 *
 * The decayed figure is already on the row, encoded in `rank`:
 *
 *     rank / 10000 = log2(power + 1) + avg_vote_time_stamp / SECONDS_TO_DOUBLE
 *
 * so the power as of NOW is 2 ^ (rank / 10000 - now / SECONDS_TO_DOUBLE). That
 * is the same thing as the raw power halving every thirty days of vote age.
 *
 * SECONDS_TO_DOUBLE is 2592000, verified against five live rows: solving the
 * identity above for it gave exactly that on every one.
 *
 * Computed in log space on purpose. 2 ^ (now / SECONDS_TO_DOUBLE) alone is
 * about 2^690, which is Infinity in a double — the subtraction has to happen
 * before the exponent, not after.
 */
const SECONDS_TO_DOUBLE = 2_592_000

export function decayedPower(rank: string | number, precision: number, now = Date.now()): number {
  const log2p = Number(rank) / 10_000 - now / 1000 / SECONDS_TO_DOUBLE
  if (!Number.isFinite(log2p)) return 0
  return Math.pow(2, log2p) / 10 ** precision
}

/** Short enough to sit in a card's list without pushing the name around. */
/**
 * The vote power a candidate actually holds: the sum of the balances behind
 * every account that voted for them, in the DAO's own token.
 *
 * This is the number people mean by "vote power". decayedPower above is a
 * different thing — it is what the CHAIN seats people on, and it can be an
 * order of magnitude smaller, because it discounts votes by their age.
 */
export const rawPower = (total: string | number, precision: number): number =>
  Number(total) / 10 ** precision

export function fmtPower(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(0)
}
