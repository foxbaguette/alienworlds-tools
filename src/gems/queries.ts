import { historyGet, iso } from '@/chain/history'
import { cached, getAllRows, nameToUint64 } from '@/chain/rpc'

/**
 * Gems held by players — the balance they are sitting on, not what they earned.
 *
 * Every other gem figure in the report is a flow: gems gained, gems put into
 * the Candle, gems spent on the market. This is the level those flows leave
 * behind, which is the one number that says whether gems are piling up or
 * being used.
 *
 * There is no aggregate row for it. `players.ale` keeps the balance inside
 * each player's own row, in `activestats`, so the total is a sum over every
 * player and a past day has to be read a row at a time. That is affordable
 * only because Alien Legends has a few hundred players: the same approach
 * against Alien Worlds' 1.8 million wallets would be unthinkable.
 */
export const PLAYERS = 'players.ale'

interface ActiveStats {
  gems?: number | string
  unclaimed_gems?: number | string
}

interface PlayerRow {
  wallet: string
  signup_date?: string
  activestats?: ActiveStats
}

/** Gems and unclaimed gems together: both are the player's, claimed or not. */
const gemsIn = (a: ActiveStats | undefined) => (Number(a?.gems) || 0) + (Number(a?.unclaimed_gems) || 0)

export interface PlayerSince {
  wallet: string
  /** The UTC day the row was created, which is the first day it can be read. */
  signup: string
}

/** Every wallet with a player row, and the day that row began. */
export function fetchPlayerWallets(): Promise<PlayerSince[]> {
  return cached('gemwallets', 5 * 60_000, async () => {
    const rows = await getAllRows<PlayerRow>({ code: PLAYERS, scope: PLAYERS, table: 'players', limit: 400 })
    return rows.map((r) => ({ wallet: String(r.wallet), signup: String(r.signup_date ?? '').slice(0, 10) }))
  })
}

/** Gems held right now, across everybody. One page, so it costs a single read. */
export async function fetchGemsHeldNow(): Promise<{ gems: number; players: number }> {
  const rows = await getAllRows<PlayerRow>({ code: PLAYERS, scope: PLAYERS, table: 'players', limit: 400 })
  return { gems: rows.reduce((n, r) => n + gemsIn(r.activestats), 0), players: rows.length }
}

interface PlayerDeltaPage {
  deltas?: { present?: number; data?: { activestats?: ActiveStats } }[]
}

/**
 * One player's gems as their row last stood before `at`.
 *
 * An empty answer is not a failure: a player who had not signed up yet has no
 * row to find, and held no gems. A request that throws is a different thing
 * entirely and is left to the caller, because a player counted as zero when
 * the server merely would not answer quietly understates the day.
 *
 * `present` is the one that bites. A delta records a row being deleted as
 * well as written, and the deleted one still carries the row's last contents.
 * Read without checking it, the alpha's wiped players went on holding their
 * gems for months after their rows were gone — 62 wallets with balances on a
 * day when two had signed up.
 *
 * Nothing at all comes back as undefined rather than nought. A row that
 * existed always has a delta, so an empty answer for a player who had one is
 * a server declining to speak, not an empty purse — and WAX nodes decline by
 * answering emptily rather than by failing. Counted as zero it wiped three
 * days of late April to nobody holding anything, on days when the chain plainly
 * says otherwise.
 */
export async function fetchGemsHeldAt(wallet: string, at: number): Promise<number | undefined> {
  const page = await historyGet<PlayerDeltaPage>('/v2/history/get_deltas', {
    code: PLAYERS,
    scope: PLAYERS,
    table: 'players',
    primary_key: nameToUint64(wallet).toString(),
    before: iso(at),
    limit: 1,
    sort: 'desc',
  })
  const row = page.deltas?.[0]
  if (!row) return undefined
  /* present: 0 is the row being deleted, which really is nothing held. */
  if (row.present === 0) return 0
  return gemsIn(row.data?.activestats)
}

export interface GemsDay {
  date: string
  /** Gems held by every player together at the end of the UTC day. */
  gems: number
  /** How many players had a row by then, so a reader can see the base grow. */
  players: number
}

export interface GemsDailyFile {
  generatedAt: string
  days: GemsDay[]
}

/** The collected days. Missing is not an error — the chart simply waits. */
export function fetchGemsDaily(): Promise<GemsDailyFile> {
  return cached('gemsdaily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/gems-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as GemsDailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}
