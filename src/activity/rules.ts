/**
 * Daily activity: who played, and what they did.
 *
 * The game keeps every player's lifetime counters in `permstats`, and every
 * change to them goes through one of two actions on `players.ale`:
 *
 *   * `updpermstat` — one stat, one amount (a recruit, a quest, a mine).
 *   * `updpstatmap` — several at once, which is how a fight reports:
 *     `dungeons_played`, `dungeons_won`, `arenas_played`, damage, knockouts.
 *
 * Between them they are a complete record of play. Summed per UTC day they
 * give the daily figures; the set of players in them gives daily actives.
 *
 * Pure — the reads are in `queries.ts`, and the collector and the browser
 * both summarise through here, so a day means the same thing in both.
 */

export interface StatChange {
  /** Unique per change: the action's global sequence, plus its index in a map. */
  key: string
  time: number
  player: string
  stat: string
  value: number
}

export interface DaySummary {
  /** UTC date, `YYYY-MM-DD`. */
  date: string
  /** Players who did something themselves that day. */
  active: number
  /** Their wallets, so a week or a month can be counted without double-counting. */
  players: string[]
  /** Every stat's total for the day, in the chain's own units. */
  stats: Record<string, number>
}

/**
 * Stats that can move without the player doing anything.
 *
 * A landowner is credited TLM and shards whenever someone else uses their
 * building, so counting those would make every landowner "active" every
 * day. They still count towards the day's totals — they just do not make a
 * player active.
 */
export const PASSIVE_STATS: ReadonlySet<string> = new Set(['tlm_earned', 'shards_earned'])

/** The stats the dashboard reads, with their units. */
export const STAT_SCALE: Record<string, number> = {
  tlm_earned: 10_000,
  shards_earned: 10,
  wax_earned: 100_000_000,
}

/** A stat in the units a person reads: TLM from its 4 places, shards from 1. */
export function statValue(stats: Record<string, number>, stat: string): number {
  return (stats[stat] ?? 0) / (STAT_SCALE[stat] ?? 1)
}

export const DAY_MS = 86_400_000

/** `YYYY-MM-DD` for a UTC instant. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Midnight UTC of a `YYYY-MM-DD`. */
export function dayStart(date: string): number {
  return Date.parse(date + 'T00:00:00Z')
}

/**
 * The game's own contracts, which the stat log also credits.
 *
 * Money on its way to players passes through some of them — the Candle's
 * `recovery.ale`, the arena's `arena.ale` — and each hop is logged as that
 * contract "earning" it, before the player is credited again on arrival.
 * Counting them would count the same TLM twice, so only real players count.
 */
export function isGameContract(wallet: string): boolean {
  return CONTRACT_SUFFIXES.some((s) => wallet.endsWith(s))
}

/**
 * Accounts that belong to a game rather than a player: Alien Legends' own
 * (`*.ale`), Mission Control's (`*.mc`, e.g. `game.mc`, `emporium.mc`) and
 * Alien Worlds' (`*.worlds`). None of them is ever counted as a player.
 */
export const CONTRACT_SUFFIXES = ['.ale', '.mc', '.worlds']

/**
 * Whether an action was sent by Alien Legends.
 *
 * Only Alien Legends' own contracts write these stats and payments. Checking
 * the sender keeps anything another game routes through a shared account —
 * Mission Control's Emporium sends shards through `shards.mc` too — from
 * ever being counted as Alien Legends activity.
 */
export function sentByAlienLegends(sender: string): boolean {
  return sender.endsWith('.ale')
}

export function summariseDay(date: string, changes: StatChange[]): DaySummary {
  const stats: Record<string, number> = {}
  const players = new Set<string>()
  for (const c of changes) {
    if (isGameContract(c.player)) continue
    stats[c.stat] = (stats[c.stat] ?? 0) + c.value
    if (!PASSIVE_STATS.has(c.stat)) players.add(c.player)
  }
  return { date, active: players.size, players: [...players].sort(), stats }
}

export interface RangeSummary {
  days: number
  /** Distinct players active on any day of the range. */
  uniqueActive: number
  /** Mean of the daily active counts. */
  avgDaily: number
  peak: { date: string; active: number } | null
  totals: Record<string, number>
}

export function summariseRange(days: DaySummary[]): RangeSummary {
  const who = new Set<string>()
  const totals: Record<string, number> = {}
  let peak: RangeSummary['peak'] = null
  for (const d of days) {
    for (const p of d.players) who.add(p)
    for (const [k, v] of Object.entries(d.stats)) totals[k] = (totals[k] ?? 0) + v
    if (!peak || d.active > peak.active) peak = { date: d.date, active: d.active }
  }
  return {
    days: days.length,
    uniqueActive: who.size,
    avgDaily: days.length ? days.reduce((n, d) => n + d.active, 0) / days.length : 0,
    peak,
    totals,
  }
}

/** The file the collector writes and the site reads. */
export interface DailyFile {
  generatedAt: string
  days: DaySummary[]
}

/** Merge new days into a file's, replacing any date already there, oldest first. */
export function mergeDays(existing: DaySummary[], fresh: DaySummary[]): DaySummary[] {
  const by = new Map(existing.map((d) => [d.date, d]))
  for (const d of fresh) by.set(d.date, d)
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/* ---------- players, from the table ---------- */

export interface PlayerRow {
  wallet: string
  signup: number
  lastAction: number
  legendUntil: number
  /** The in-game name, where one is set. */
  tag?: string
  /** This player's own lifetime counters, raw units. */
  stats?: Record<string, number>
}

/** New signups per UTC day, for every day in `dates` (zero where none). */
export function signupsByDay(players: PlayerRow[], dates: string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(dates.map((d) => [d, 0]))
  for (const p of players) {
    const d = dayOf(p.signup)
    if (d in out) out[d] += 1
  }
  return out
}

export function legendCount(players: PlayerRow[], now = Date.now()): number {
  return players.filter((p) => p.legendUntil > now).length
}

/** Every date from `first` to `last` inclusive, `YYYY-MM-DD`. */
export function dateRange(first: string, last: string): string[] {
  const out: string[] = []
  for (let t = dayStart(first); t <= dayStart(last); t += DAY_MS) out.push(dayOf(t))
  return out
}

/* ---------- per player ---------- */

/** One day's stat changes per player: wallet → stat → amount (raw units). */
export type PlayerDay = Record<string, Record<string, number>>

export interface PlayersDailyFile {
  generatedAt: string
  days: { date: string; players: PlayerDay }[]
}

/** Each player's own totals for a day. Game contracts are left out, as in the day totals. */
export function summarisePlayers(changes: StatChange[]): PlayerDay {
  const out: PlayerDay = {}
  for (const c of changes) {
    if (isGameContract(c.player)) continue
    const p = (out[c.player] ??= {})
    p[c.stat] = (p[c.stat] ?? 0) + c.value
  }
  return out
}

/** One player's days, as day summaries the charts already understand. */
export function playerDays(file: PlayersDailyFile, wallet: string, dates: string[]): DaySummary[] {
  const by = new Map(file.days.map((d) => [d.date, d.players[wallet]]))
  return dates.map((date) => {
    const stats = by.get(date) ?? {}
    const active = Object.keys(stats).some((k) => !PASSIVE_STATS.has(k)) ? 1 : 0
    return { date, active, players: active ? [wallet] : [], stats }
  })
}
