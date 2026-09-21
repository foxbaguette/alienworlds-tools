import { historyCrawl, historyGet, historySliced, historyTime, iso, type Progress } from '@/chain/history'
import { nameToUint64 } from '@/chain/rpc'
import { getAllRows } from '@/chain/rpc'
import {
  attribute,
  BUILDING_POOL,
  CLAIMED_PAYOUTS,
  type BalancePoint,
  type BuildingClaim,
  type BuildingReward,
  type Payout,
  type PoolDailyFile,
  type PoolTable,
} from './rules'

/**
 * What the pools paid, and what they held — both read from history.
 *
 * Three crawls over the same window, run side by side:
 *
 *   * **Payout records** — `rwrdlog.ale::addhistory`, which every paying
 *     contract sends with each payment: player, currency, pool, amount.
 *   * **The trace** — the `pools.ale` actions that say where a payment came
 *     from: `claimbreward` (a landowner cut, and the pools it draws on),
 *     `lands.ale::addbldrwrd` (which land it was credited to), and the
 *     `qpremine` / `quests.ale::setquests` pair that moves quest rewards into
 *     escrow when quests are handed out.
 *   * **Balances**, separately and per pool, from the table deltas.
 *
 * `rules.attribute` joins the first two. The window is fixed at both ends and
 * read oldest-first, so a payout landing while the crawl runs cannot shift a
 * page and drop or repeat a row.
 */

interface Action<D> {
  global_sequence: number
  trx_id: string
  '@timestamp': string
  act: { account: string; name: string; data: D }
}

interface AddHistory {
  wallet: string
  player: string
  type: string
  pool: string
  reward: string
}

interface QuestRow {
  reward_type: string
  reward_amount: string | number
  mine_completed: boolean | number
}

interface DeltaPage {
  deltas?: {
    timestamp: string
    block_num: number
    data: { tlm_current?: string; tlm_reserve?: string; shard_current?: string | number }
  }[]
}

/** "98.6401 TLM" → 98.6401; "63.1 SHRDS" → 63.1. */
function amountOf(asset: string): number {
  const n = Number(String(asset ?? '').split(' ')[0])
  return Number.isFinite(n) ? n : 0
}

/* A short-lived memo: opening a pool and coming back should not re-crawl. */
const memo = new Map<string, { at: number; value: Promise<unknown> }>()
const MEMO_MS = 90_000

function remember<T>(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
  const hit = memo.get(key)
  if (!refresh && hit && Date.now() - hit.at < MEMO_MS) return hit.value as Promise<T>
  const value = load()
  memo.set(key, { at: Date.now(), value })
  value.catch(() => memo.delete(key))
  return value
}

function crawl<D>(params: Record<string, string>, from: number, until: number, onProgress?: Progress) {
  return historySliced<Action<D>>(
    '/v2/history/get_actions',
    params,
    from,
    until,
    (page) => ((page as { actions?: Action<D>[] }).actions ?? []),
    (a) => historyTime(a['@timestamp']),
    (a) => a.global_sequence,
    6,
    onProgress,
  )
}

/** The payment records, as payouts with no kind yet. */
async function fetchRecords(from: number, until: number, onProgress?: Progress): Promise<Payout[]> {
  const rows = await crawl<AddHistory>(
    { account: 'rwrdlog.ale', filter: 'rwrdlog.ale:addhistory' },
    from,
    until,
    onProgress,
  )
  /*
     Only payments Alien Legends itself made — see sentByAlienLegends. The
     Candle's TLM records are left out: they are written when a mission
     settles, before anyone is paid, and its payments are read from the
     claims themselves (fetchClaimedPayouts).
  */
  return rows
    .filter((a) => String(a.act.data.wallet).endsWith('.ale'))
    .filter((a) => !(a.act.data.wallet === 'recovery.ale' && a.act.data.type === 'tlm'))
    .map((a) => {
    const d = a.act.data
    return {
      seq: a.global_sequence,
      trx: a.trx_id,
      time: historyTime(a['@timestamp']),
      payer: d.wallet,
      player: d.player,
      type: d.type === 'tlm' ? 'tlm' : d.type === 'shrds' ? 'shards' : d.type,
      pool: d.pool,
      amount: amountOf(d.reward),
    }
  })
}

interface Transfer {
  from: string
  to: string
  amount?: number
  quantity?: string
  memo?: string
}

interface LandRow {
  asset_id: string | number
  buildings?: { building_name?: string }[]
}

const PLANETS = ['magor', 'naron', 'neri', 'eyeke', 'veles', 'kavian']

/**
 * Every land's primary building, by the land's asset id.
 *
 * A land claim's memo names the land by asset id; its building says which
 * pool the TLM it held came from. Read as the lands are now — a land that
 * swapped its building since the claim would be credited to the new one.
 */
export function fetchLandBuildings(): Promise<Map<string, string>> {
  return remember('landbuildings', async () => {
    const grids = await Promise.all(
      PLANETS.map((scope) => getAllRows<LandRow>({ code: 'lands.ale', scope, table: 'lands' })),
    )
    const out = new Map<string, string>()
    for (const land of grids.flat()) {
      const name = String(land.buildings?.[0]?.building_name ?? '').toLowerCase()
      if (name) out.set(String(land.asset_id), name)
    }
    return out
  })
}

/**
 * TLM reaching players from the contracts that hold it for them until they
 * claim it — landowners' building cuts (`lands.ale`), Candle winnings
 * (`recovery.ale`) and account rewards such as the Arena leaderboards
 * (`players.ale`). The transfer is the payment; see CLAIMED_PAYOUTS.
 */
export async function fetchClaimedPayouts(from: number, until: number, onProgress?: Progress): Promise<Payout[]> {
  const [buildings, ...crawls] = await Promise.all([
    fetchLandBuildings(),
    ...CLAIMED_PAYOUTS.map((c) =>
      crawl<Transfer>({ account: c.contract, filter: 'alien.worlds:transfer' }, from, until, onProgress),
    ),
  ])
  const out: Payout[] = []
  CLAIMED_PAYOUTS.forEach((c, i) => {
    for (const a of crawls[i]) {
      const d = a.act.data
      const memo = String(d.memo ?? '')
      if (d.from !== c.contract || !memo.startsWith(c.memo)) continue
      let pool = c.pool
      if (c.contract === 'lands.ale') {
        const building = buildings.get(memo.split(':')[1]?.trim() ?? '')
        pool = (building && BUILDING_POOL[building]?.tlm) || 'tlmlndowner'
      }
      out.push({
        seq: a.global_sequence,
        trx: a.trx_id,
        time: historyTime(a['@timestamp']),
        payer: c.contract,
        player: String(d.to),
        type: 'tlm',
        pool,
        amount: Number(d.amount ?? String(d.quantity ?? '0').split(' ')[0]) || 0,
      })
    }
  })
  return out
}

/** Where payments came from: building claims, land credits, quest escrow. */
async function fetchTrace(from: number, until: number, onProgress?: Progress) {
  const rows = await crawl<Record<string, unknown>>(
    {
      account: 'pools.ale',
      filter: 'pools.ale:claimbreward,lands.ale:addbldrwrd,pools.ale:qpremine,quests.ale:setquests',
    },
    from,
    until,
    onProgress,
  )

  const claims: BuildingClaim[] = []
  const rewards: BuildingReward[] = []
  const premines = new Map<string, Action<Record<string, unknown>>>()
  const sets = new Map<string, Action<Record<string, unknown>>[]>()

  for (const a of rows) {
    const d = a.act.data
    const name = `${a.act.account}::${a.act.name}`
    if (name === 'pools.ale::claimbreward') {
      const power = (d.reward_power as { pool: string; type: string }[]) ?? []
      claims.push({
        seq: a.global_sequence,
        trx: a.trx_id,
        planet: String(d.planet),
        land: String(d.land_id),
        tlmPool: power.find((p) => p.type === 'tlm')?.pool,
        shardPool: power.find((p) => p.type === 'shards')?.pool,
      })
    } else if (name === 'lands.ale::addbldrwrd') {
      rewards.push({
        seq: a.global_sequence,
        trx: a.trx_id,
        planet: String(d.planet),
        land: String(d.land_id),
        tlm: Number(d.tlm ?? 0),
        shards: Number(d.shards ?? 0),
      })
    } else if (name === 'pools.ale::qpremine') {
      premines.set(`${a.trx_id}:${d.player}`, a)
    } else if (name === 'quests.ale::setquests') {
      const key = `${a.trx_id}:${d.player}`
      sets.set(key, [...(sets.get(key) ?? []), a])
    }
  }

  /*
     Quest escrow. `qpremine` receives the player's quests with the new ones
     not yet mined, works out their rewards and hands the finished list to
     `setquests` in the same transaction — so a quest that went in unmined and
     came out with an amount is one whose reward just left the pool.
  */
  const escrow: Payout[] = []
  for (const [key, pre] of premines) {
    const set = sets.get(key)?.[0]
    if (!set) continue
    const before = (pre.act.data.quests as QuestRow[]) ?? []
    const after = (set.act.data.quests as QuestRow[]) ?? []
    const pd = pre.act.data as { player: string; tlmpool?: string; shardpool?: string }
    before.forEach((q, i) => {
      if (q.mine_completed === true || q.mine_completed === 1) return
      const done = after[i]
      if (!done) return
      const shards = done.reward_type === 'shards'
      const raw = Number(done.reward_amount ?? 0)
      if (!(raw > 0)) return
      escrow.push({
        seq: pre.global_sequence * 100 + i,
        trx: pre.trx_id,
        time: historyTime(pre['@timestamp']),
        payer: 'pools.ale',
        player: pd.player,
        type: shards ? 'shards' : 'tlm',
        pool: (shards ? pd.shardpool : pd.tlmpool) || (shards ? 'shrdquests' : 'tlmquests'),
        amount: raw / (shards ? 10 : 10_000),
        kind: 'escrow',
      })
    })
  }

  return { claims, rewards, escrow }
}

/**
 * Every payment out of the pools since `sinceMs`, with its kind and source.
 */
export function fetchPoolActivity(
  sinceMs: number,
  opts: { until?: number; refresh?: boolean; onProgress?: Progress } = {},
): Promise<Payout[]> {
  const until = opts.until ?? Date.now()
  return remember(
    `activity:${Math.floor(sinceMs / 60_000)}:${opts.until ? Math.floor(until / 60_000) : 'now'}`,
    async () => {
      const [records, trace, claimed] = await Promise.all([
        fetchRecords(sinceMs, until, opts.onProgress),
        fetchTrace(sinceMs, until, opts.onProgress),
        fetchClaimedPayouts(sinceMs, until, opts.onProgress),
      ])
      return attribute([...records, ...trace.escrow, ...claimed], trace.claims, trace.rewards)
        .filter((p) => p.time >= sinceMs && p.time < until)
        .sort((a, b) => a.time - b.time || a.seq - b.seq)
    },
    opts.refresh,
  )
}

/** The collected days of pool activity. Missing is not an error. */
export function fetchPoolDailyFile(): Promise<PoolDailyFile> {
  return remember('pooldaily', async () => {
    try {
      const res = await fetch('data/pools-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as PoolDailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}

/** A pool's balance as it stood at `at`: the last write before it. */
/** A TLM pool's reserve as it stood at `at`, in whole TLM. */
export async function fetchReserveAt(pool: string, at: number): Promise<number | undefined> {
  const page = await historyGet<DeltaPage>('/v2/history/get_deltas', {
    code: 'pools.ale',
    scope: 'pools.ale',
    table: 'tlmpools',
    primary_key: nameToUint64(pool).toString(),
    before: iso(at),
    limit: 1,
  })
  const d = page.deltas?.[0]
  return d ? amountOf(String(d.data.tlm_reserve ?? '0')) : undefined
}

export async function fetchBalanceAt(table: PoolTable, pool: string, at: number): Promise<number | undefined> {
  const page = await historyGet<DeltaPage>('/v2/history/get_deltas', {
    code: 'pools.ale',
    scope: 'pools.ale',
    table,
    primary_key: nameToUint64(pool).toString(),
    before: iso(at),
    limit: 1,
  })
  const d = page.deltas?.[0]
  if (!d) return undefined
  return table === 'tlmpools' ? amountOf(String(d.data.tlm_current ?? '0')) : Number(d.data.shard_current ?? 0) / 10
}

type Delta = NonNullable<DeltaPage['deltas']>[number]

/**
 * Every write to one pool row since `sinceMs`, plus the last one before it.
 *
 * Shared by both halves of a TLM pool: the balance and the reserve are two
 * fields of the same row, so a chart drawing both reads the row's history
 * once rather than crawling the same ten thousand writes twice.
 */
function poolWrites(
  table: PoolTable,
  pool: string,
  sinceMs: number,
  refresh: boolean,
): Promise<{ before: Delta | undefined; rows: Delta[] }> {
  const until = Date.now()
  return remember(
    `writes:${table}:${pool}:${Math.floor(sinceMs / 60_000)}`,
    async () => {
      const key = nameToUint64(pool).toString()
      const base = { code: 'pools.ale', scope: 'pools.ale', table, primary_key: key }
      const [before, rows] = await Promise.all([
        historyGet<DeltaPage>('/v2/history/get_deltas', { ...base, before: iso(sinceMs), limit: 1 }),
        historyCrawl<Delta>(
          '/v2/history/get_deltas',
          base,
          sinceMs,
          until,
          (page) => (page as DeltaPage).deltas ?? [],
          (d) => historyTime(d.timestamp),
          (d) => `${d.block_num}:${d.timestamp}:${JSON.stringify(d.data)}`,
          12,
        ),
      ])
      return { before: before.deltas?.[0], rows }
    },
    refresh,
  )
}

/**
 * A pool's balance over time: every write since `sinceMs`, plus the last one
 * before it so the line starts at the left edge rather than at the first mine.
 */
export async function fetchPoolHistory(
  table: PoolTable,
  pool: string,
  sinceMs: number,
  refresh = false,
  /** Which half of a TLM pool: what it can pay, or what it holds back. */
  field: 'current' | 'reserve' = 'current',
): Promise<BalancePoint[]> {
  const { before, rows } = await poolWrites(table, pool, sinceMs, refresh)
  const valueOf = (d: Delta['data']) =>
    table !== 'tlmpools'
      ? Number(d.shard_current ?? 0) / 10
      : amountOf(String((field === 'reserve' ? d.tlm_reserve : d.tlm_current) ?? '0'))

  const points: BalancePoint[] = []
  if (before) points.push({ t: sinceMs, v: valueOf(before.data) })
  for (const d of rows) points.push({ t: historyTime(d.timestamp), v: valueOf(d.data) })
  return points.sort((a, b) => a.t - b.t)
}
