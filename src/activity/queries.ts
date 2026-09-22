import { historyGet, historySliced, historyTime, iso } from '@/chain/history'
import { cached, getAllRows, nameToUint64 } from '@/chain/rpc'
import {
  dayOf,
  sentByAlienLegends,
  type DailyFile,
  type PlayerRow,
  type PlayersDailyFile,
  type StatChange,
} from './rules'

/**
 * Reads for the overview: the activity log, the shop's WAX, and the players.
 */

interface Action<D> {
  global_sequence: number
  '@timestamp': string
  act: { name: string; data: D }
}

interface StatData {
  /** The Alien Legends contract that wrote the change. */
  wallet: string
  player: string
  /* updpermstat */
  statname?: string
  statvalue?: string | number
  /* updpstatmap */
  statchange?: { first: string; second: string | number }[]
}

/**
 * Every stat change between two times.
 *
 * About 26,000 rows a day, which is why finished days are read once by the
 * collector and kept in `data/daily.json` rather than crawled on every visit.
 */
export async function fetchStatChanges(from: number, until: number, slices = 6): Promise<StatChange[]> {
  const [rows, levelups] = await Promise.all([
    historySliced<Action<StatData>>(
      '/v2/history/get_actions',
      { account: 'players.ale', filter: 'players.ale:updpermstat,players.ale:updpstatmap' },
      from,
      until,
      (page) => ((page as { actions?: Action<StatData>[] }).actions ?? []),
      (a) => historyTime(a['@timestamp']),
      (a) => a.global_sequence,
      slices,
    ),
    historySliced<Action<{ wallet: string; fighter_ids: unknown[] }>>(
      '/v2/history/get_actions',
      { account: 'fighters.ale', filter: 'fighters.ale:levelup' },
      from,
      until,
      (page) => ((page as { actions?: Action<{ wallet: string; fighter_ids: unknown[] }>[] }).actions ?? []),
      (a) => historyTime(a['@timestamp']),
      (a) => a.global_sequence,
      2,
    ),
  ])
  const out: StatChange[] = []

  /*
     Level-ups are counted from the level-up itself. Levelling several fighters
     at once sends one identical `level_ups +1` record per fighter, and the
     history servers keep only one of a transaction's identical actions — so
     the stat log undercounts every batch. The level-up action lists the
     fighters, which is the true count.
  */
  for (const a of levelups) {
    const time = historyTime(a['@timestamp'])
    if (time < from || time >= until) continue
    out.push({
      key: `lv:${a.global_sequence}`,
      time,
      player: String(a.act.data.wallet),
      stat: 'level_ups',
      value: (a.act.data.fighter_ids ?? []).length,
    })
  }

  for (const a of rows) {
    const time = historyTime(a['@timestamp'])
    if (time < from || time >= until) continue
    const d = a.act.data
    if (!sentByAlienLegends(String(d.wallet))) continue
    const player = String(d.player)
    if (a.act.name === 'updpstatmap') {
      ;(d.statchange ?? []).forEach((s, i) => {
        out.push({ key: `${a.global_sequence}:${i}`, time, player, stat: s.first, value: Number(s.second) || 0 })
      })
    } else if (d.statname && d.statname !== 'level_ups') {
      out.push({ key: String(a.global_sequence), time, player, stat: d.statname, value: Number(d.statvalue) || 0 })
    }
  }
  return out
}

/* ---------- lifetime counters ---------- */

interface CounterDelta {
  deltas?: { data?: { permstats?: { first?: string; key?: string; second?: number | string; value?: number | string }[] } }[]
}

/** One player's lifetime counter as the players table last stood before `at`; undefined if unread. */
async function counterAt(player: string, stat: string, at: number): Promise<number | undefined> {
  const page = await historyGet<CounterDelta>('/v2/history/get_deltas', {
    code: 'players.ale',
    scope: 'players.ale',
    table: 'players',
    primary_key: nameToUint64(player).toString(),
    before: iso(at),
    limit: 1,
    sort: 'desc',
  })
  const row = page.deltas?.[0]
  if (!row) return undefined
  const hit = (row.data?.permstats ?? []).find((x) => (x.first ?? x.key) === stat)
  return Number(hit?.second ?? hit?.value ?? 0) || 0
}

/**
 * A stat's true daily total for the players the stat log shows it moved for,
 * from their lifetime counters: end of day less start of day.
 *
 * The stat log undercounts when one transaction credits the same player the
 * same amount twice — the history servers keep only one of a transaction's
 * identical actions. The counters cannot lose anything. A player whose
 * counters cannot be read, or disagree with the log by more than a merged
 * duplicate could explain, keeps the log's figure.
 */
export async function statFromCounters(
  logged: Record<string, number>,
  stat: string,
  from: number,
  until: number,
): Promise<number> {
  let total = 0
  for (const [player, fromLog] of Object.entries(logged)) {
    let value = fromLog
    try {
      const [a, b] = await Promise.all([counterAt(player, stat, from), counterAt(player, stat, until)])
      if (b !== undefined) {
        const diff = b - (a ?? 0)
        if (diff >= fromLog && diff <= fromLog * 1.5 + 1_000) value = diff
      }
    } catch {
      /* keep the log's figure */
    }
    total += value
  }
  return total
}

/* ---------- the shop ---------- */

export interface ShopPurchase {
  time: number
  wallet: string
  item: string
  wax: number
}

interface Transfer {
  from: string
  to: string
  amount?: number
  quantity?: string
  memo?: string
}

/**
 * WAX paid into the shop.
 *
 * A WAX purchase is a plain `eosio.token::transfer` to `shop.ale` with the
 * memo `purchase,<item>`. The shop forwards each one on, so only transfers
 * *into* it count — otherwise every purchase would be counted twice.
 */
export function fetchShopPurchases(since: number): Promise<ShopPurchase[]> {
  return cached(`shop:${dayOf(since)}`, 5 * 60_000, async () => {
    const rows = await historySliced<Action<Transfer>>(
      '/v2/history/get_actions',
      { account: 'shop.ale', filter: 'eosio.token:transfer' },
      since,
      Date.now(),
      (page) => ((page as { actions?: Action<Transfer>[] }).actions ?? []),
      (a) => historyTime(a['@timestamp']),
      (a) => a.global_sequence,
      2,
    )
    return rows
      .filter((a) => a.act.data.to === 'shop.ale' && String(a.act.data.memo ?? '').startsWith('purchase'))
      .map((a) => ({
        time: historyTime(a['@timestamp']),
        wallet: String(a.act.data.from),
        item: String(a.act.data.memo).split(',')[1] ?? '?',
        wax: Number(a.act.data.amount ?? String(a.act.data.quantity ?? '0').split(' ')[0]) || 0,
      }))
  })
}

/** The shop's own names for its items: "gem.large" → "Gem Pack L". */
export function fetchShopItemNames(): Promise<Record<string, string>> {
  return cached('shopitems', 60 * 60_000, async () => {
    const rows = await getAllRows<{ item: string; title?: string; offer_name?: string }>({
      code: 'shop.ale',
      scope: 'shop.ale',
      table: 'shopitems',
    })
    return Object.fromEntries(rows.map((r) => [r.item, r.title || r.offer_name || r.item]))
  })
}

/* ---------- players ---------- */

export interface PlayersSnapshot {
  players: PlayerRow[]
  /** Every player's lifetime counters, summed. */
  lifetime: Record<string, number>
}

interface RawPlayer {
  wallet: string
  playertag?: string
  signup_date: string
  last_action: string
  legend_access_expiry: string
  permstats?: { first: string; second: number | string }[]
}

const ts = (s: string) => Date.parse(s.endsWith('Z') ? s : s + 'Z')

/**
 * Every player, trimmed to what the overview needs the moment the rows land.
 * The rows are heavy (about 14 KB each), and only a handful of fields matter.
 */
export function fetchPlayers(): Promise<PlayersSnapshot> {
  return cached('players', 5 * 60_000, async () => {
    const rows = await getAllRows<RawPlayer>({
      code: 'players.ale',
      scope: 'players.ale',
      table: 'players',
      limit: 200,
    })
    const lifetime: Record<string, number> = {}
    const players: PlayerRow[] = rows.map((r) => {
      const stats: Record<string, number> = {}
      for (const s of r.permstats ?? []) {
        const v = Number(s.second) || 0
        stats[s.first] = v
        lifetime[s.first] = (lifetime[s.first] ?? 0) + v
      }
      return {
        wallet: String(r.wallet),
        signup: ts(r.signup_date),
        lastAction: ts(r.last_action),
        legendUntil: ts(r.legend_access_expiry),
        tag: r.playertag ? String(r.playertag) : undefined,
        stats,
      }
    })
    return { players, lifetime }
  })
}

/* ---------- the collected days ---------- */

/** Each player's own daily stats. Larger than the totals, so read only when a player is chosen. */
export function fetchPlayersDaily(): Promise<PlayersDailyFile> {
  return cached('playersdaily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/players-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as PlayersDailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}

/** The daily summaries the collector keeps in the repo. Missing is not an error. */
export function fetchDailyFile(): Promise<DailyFile> {
  return cached('daily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as DailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}
