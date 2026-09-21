import { historySliced, historyTime, largestCount } from '@/chain/history'
import { cached } from '@/chain/rpc'

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
