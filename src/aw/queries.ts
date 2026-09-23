import { historyGet, historySliced, historyTime, largestCount } from '@/chain/history'
import { cached, getAllRows } from '@/chain/rpc'

/**
 * Alien Worlds itself, day by day, for its monthly report.
 *
 * The scale decides what can be measured. `m.federation::mine` runs about
 * 3.4 million times a day, so the mines cannot be read one by one — but the
 * history servers count them exactly and instantly (`track=true`), and a
 * count is what the report needs.
 *
 * Who is playing cannot come from the mines for the same reason. It comes
 * from the claims instead: mined TLM reaches a wallet as a transfer from
 * m.federation ("ALIEN WORLDS - Mined Trilium", about 2,400 a day), few
 * enough to read in full, and a wallet that claims is a wallet that mines.
 * That is the honest measure of active miners the chain allows.
 *
 * New players are the accounts accepting the terms of use
 * (`federation::agreeterms`), which every new account does once.
 *
 * SHARDS MINED. Every Shard reaches a player through
 * `uspts.worlds::addpoints` — about 70,000 credits a day, including each
 * mine's luck. But uspts.worlds also passes on everything projects issue
 * through `ptpxy.worlds` (Mission Control, Naron, Planetary Defense…), so
 * what mining produced is the first less the second. Both count in tenths of
 * a Shard.
 *
 * SHARDS SPENT. The Outpost sells NFTs for Shards through
 * `uspts.worlds::redeempntnft {user, offer_id}`, which mints the offer's
 * template to the player. The price is not in the action — it is the
 * offer's `required`, in the `pointoffers` table. Offers are removed once
 * they end, so the prices of past ones come from their `setptsreward`, the
 * action that created them. (`redeemlvlnft` is the level-up reward: it
 * costs nothing, it only needs the points to have been earned.)
 */

/**
 * An exact count — the largest any server gives. A server that has dropped a
 * day counts what it still holds, often nothing, so the first answer can be a
 * confident 0 for a day of four million mines. See largestCount.
 */
const countOf = (params: Record<string, string>, from: number, until: number) =>
  largestCount('/v2/history/get_actions', params, from, until)

interface Claim {
  global_sequence: number
  timestamp: string
  act: { data: { from?: string; to?: string; amount?: number; quantity?: string; memo?: string } }
}

interface PointsAction {
  global_sequence: number
  timestamp: string
  act: { data: { points?: number | string } }
}

/** Points credited by one contract's addpoints between two moments. */
async function pointsAdded(account: string, from: number, until: number): Promise<number> {
  const rows = await historySliced<PointsAction>(
    '/v2/history/get_actions',
    { 'act.account': account, 'act.name': 'addpoints' },
    from,
    until,
    (page) => (page as { actions?: PointsAction[] }).actions ?? [],
    (a) => historyTime(a.timestamp),
    (a) => a.global_sequence,
    8,
    undefined,
    true,
  )
  return rows.reduce((n, r) => n + (Number(r.act.data.points) || 0), 0)
}

/** Shards produced by mining: everything credited, less what projects issued. */
export async function fetchShardsMined(from: number, until: number): Promise<number> {
  const all = await pointsAdded('uspts.worlds', from, until)
  const projects = await pointsAdded('ptpxy.worlds', from, until)
  return (all - projects) / 10
}

interface OfferRow {
  id: number | string
  required: number | string
}

interface SetOffer {
  global_sequence: number
  timestamp: string
  act: { data: OfferRow }
}

interface Redeem {
  global_sequence: number
  timestamp: string
  act: { data: { user?: string; offer_id?: number | string } }
}

/* Offers were created up to a month before they could be redeemed. */
const OFFERS_FROM = '2026-05-01'

let offerPrices: Promise<Map<string, number>> | null = null

/** Offer id → points it costs: every offer set since OFFERS_FROM, then the live table on top. */
function prices(): Promise<Map<string, number>> {
  offerPrices ??= (async () => {
    const out = new Map<string, number>()
    const set = await historySliced<SetOffer>(
      '/v2/history/get_actions',
      { 'act.account': 'uspts.worlds', 'act.name': 'setptsreward' },
      Date.parse(`${OFFERS_FROM}T00:00:00Z`),
      Date.now(),
      (page) => (page as { actions?: SetOffer[] }).actions ?? [],
      (a) => historyTime(a.timestamp),
      (a) => a.global_sequence,
      4,
      undefined,
      true,
    )
    for (const a of [...set].sort((x, y) => x.global_sequence - y.global_sequence)) {
      out.set(String(a.act.data.id), Number(a.act.data.required) || 0)
    }
    const live = await getAllRows<OfferRow>({ code: 'uspts.worlds', scope: 'uspts.worlds', table: 'pointoffers' })
    for (const o of live) out.set(String(o.id), Number(o.required) || 0)
    return out
  })()
  offerPrices.catch(() => (offerPrices = null))
  return offerPrices
}

interface OfferDelta {
  deltas?: { data?: { required?: number | string } }[]
}

/**
 * What one offer cost, for offers older than the actions we can still read.
 *
 * The Outpost's offers are deleted from the table when they end, and the
 * `setptsreward` that created them falls out of the history servers' reach
 * after a few months — the oldest kept is from March, while the Outpost has
 * been selling since long before. But the table's own history goes back
 * further: asking for the row as it last stood gives the price of an offer
 * whose creation is long gone.
 */
async function priceFromTable(id: string): Promise<number | undefined> {
  const page = await historyGet<OfferDelta>('/v2/history/get_deltas', {
    code: 'uspts.worlds',
    scope: 'uspts.worlds',
    table: 'pointoffers',
    primary_key: id,
    limit: 1,
    sort: 'desc',
  }).catch(() => null)
  const required = page?.deltas?.[0]?.data?.required
  return required === undefined ? undefined : Number(required) || 0
}

/** NFTs bought in the Outpost between two moments, and the Shards paid for them. */
export async function fetchShardsSpent(from: number, until: number): Promise<{ shards: number; nfts: number }> {
  const [price, rows] = await Promise.all([
    prices(),
    historySliced<Redeem>(
      '/v2/history/get_actions',
      { 'act.account': 'uspts.worlds', 'act.name': 'redeempntnft' },
      from,
      until,
      (page) => (page as { actions?: Redeem[] }).actions ?? [],
      (a) => historyTime(a.timestamp),
      (a) => a.global_sequence,
      4,
      undefined,
      true,
    ),
  ])
  let points = 0
  const unknown = new Set<string>()
  for (const r of rows) {
    const id = String(r.act.data.offer_id)
    let p = price.get(id)
    if (p === undefined) {
      /* Older than the actions we can read: ask the table's own history. */
      p = await priceFromTable(id)
      if (p !== undefined) price.set(id, p)
    }
    if (p === undefined) unknown.add(id)
    else points += p
  }
  /* A missing price would silently undercount, so it stops the day instead. */
  if (unknown.size) throw new Error(`no price for Outpost offer(s) ${[...unknown].join(', ')}`)
  return { shards: points / 10, nfts: rows.length }
}

export interface AwDayRaw {
  mines: number
  newPlayers: number
  /** Claims of mined TLM, and what they came to. */
  claims: number
  tlm: number
  /** The wallets that claimed. */
  claimers: string[]
}

export async function fetchAwDay(from: number, until: number): Promise<AwDayRaw> {
  const [mines, newPlayers, transfers] = await Promise.all([
    countOf({ 'act.account': 'm.federation', 'act.name': 'mine' }, from, until),
    countOf({ 'act.account': 'federation', 'act.name': 'agreeterms' }, from, until),
    historySliced<Claim>(
      '/v2/history/get_actions',
      { 'act.account': 'alien.worlds', 'act.name': 'transfer', 'transfer.from': 'm.federation' },
      from,
      until,
      (page) => (page as { actions?: Claim[] }).actions ?? [],
      (a) => historyTime(a.timestamp),
      (a) => a.global_sequence,
      4,
      undefined,
      true,
    ),
  ])
  const who = new Set<string>()
  let tlm = 0
  let claims = 0
  for (const t of transfers) {
    const d = t.act.data
    if (d.from !== 'm.federation' || !/Mined Trilium/i.test(String(d.memo ?? ''))) continue
    claims++
    tlm += Number(d.amount ?? String(d.quantity ?? '0').split(' ')[0]) || 0
    if (d.to) who.add(d.to)
  }
  return { mines, newPlayers, claims, tlm, claimers: [...who].sort() }
}

export interface AwDay {
  date: string
  mines: number
  /** Shards credited through mining — see fetchShardsMined. */
  shards?: number
  /** Shards spent in the Outpost, and the NFTs bought with them — see fetchShardsSpent. */
  shardsSpent?: number
  outpostNfts?: number
  newPlayers: number
  claims: number
  tlm: number
  /** Distinct wallets that claimed mined TLM that day. */
  miners: number
  /** Of those, the ones not seen claiming on any earlier collected day. */
  firstSeen: number
}

export interface AwDailyFile {
  generatedAt: string
  days: AwDay[]
  /** Month (YYYY-MM) → distinct wallets that claimed within it. */
  months: Record<string, number>
}

export function fetchAwDaily(): Promise<AwDailyFile> {
  return cached('awdaily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/aw-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as AwDailyFile
    } catch {
      return { generatedAt: '', days: [], months: {} }
    }
  })
}
