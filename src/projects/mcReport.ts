import { historySliced, historyTime } from '@/chain/history'
import { cached, getAllRows } from '@/chain/rpc'

/**
 * What Mission Control's monthly report needs beyond its collected days
 * (`projects/mc.json`, which counts every action by name).
 *
 * MINES BY MODE. Mission Control pays the CPU of every mine it sends through
 * `cpu.mc::paycpu`, and the call carries a type: 0 a mine on the land already
 * set, 1 a land change and a mine, 2 a mine with a loaned tool (3 and 4 are
 * daily rewards and votes). On 20 Sep the three mining types came to 780 +
 * 998 + 554 = 2,332, exactly the day's `notify.mc::logmine`, and the 554 were
 * exactly the day's `tools.mc::renttools`. The site's five buttons collapse
 * to these three: Mine Maximizer and both Favourite Lands modes all change
 * land, and nothing on chain says which picked it.
 *
 * NFTS STAKED. Both `game.mc` (buildings, memo `nftstake,…`) and
 * `adventure.mc` (memo `mcadventure,…`) take the NFTs into custody, and
 * nothing but transfers ever moves them — a week of every atomicassets action
 * touching either account was transfers and nothing else. So what is staked
 * is what they own, and any past day is today's count less every transfer
 * since. `adventure.mc`'s count matches the NFTs listed in its participants
 * table to within the six stray NFTs sent to it by mistake.
 *
 * ADVENTURES STARTED. A player joins one either by sending NFTs with the
 * `mcadventure` memo or with `joinadv`, which spends points and stakes
 * nothing. The first is counted here; the second is already in mc.json.
 */

export const MC_MODES = [
  { key: 'same', label: 'Same land', type: 0 },
  { key: 'land', label: 'Land change', type: 1 },
  { key: 'loan', label: 'Tool Loaning', type: 2 },
] as const

export type McMode = (typeof MC_MODES)[number]['key']

export const MC_STAKING = [
  { key: 'game', account: 'game.mc', memo: 'nftstake' },
  { key: 'adventure', account: 'adventure.mc', memo: 'mcadventure' },
] as const

export type McStakeKey = (typeof MC_STAKING)[number]['key']

interface PayCpu {
  global_sequence: number
  timestamp: string
  act: { data: { type?: number | string } }
}

/** Mines through Mission Control between two moments, by mode. */
export async function fetchMinesByMode(from: number, until: number): Promise<Record<McMode, number>> {
  const rows = await historySliced<PayCpu>(
    '/v2/history/get_actions',
    { 'act.account': 'cpu.mc', 'act.name': 'paycpu' },
    from,
    until,
    (page) => (page as { actions?: PayCpu[] }).actions ?? [],
    (a) => historyTime(a.timestamp),
    (a) => a.global_sequence,
    8,
  )
  const out = { same: 0, land: 0, loan: 0 } as Record<McMode, number>
  for (const r of rows) {
    const mode = MC_MODES.find((m) => m.type === Number(r.act.data.type))
    if (mode) out[mode.key]++
  }
  return out
}

interface NftTransfer {
  global_sequence: number
  timestamp: string
  act: { data: { from?: string; to?: string; asset_ids?: unknown[]; memo?: string } }
}

export interface NftFlow {
  /** NFTs sent in to stake. */
  in: number
  /** NFTs sent back out. */
  out: number
  /** Transfers in — one per building stake, or per adventure joined. */
  joins: number
}

/**
 * NFTs moved in and out of one contract between two moments.
 *
 * In counts only transfers carrying the contract's own staking memo, so an NFT
 * sent there by mistake does not read as staked; out counts everything,
 * because nothing leaves but what is returned.
 */
export async function fetchNftFlow(account: string, memo: string, from: number, until: number): Promise<NftFlow> {
  const rows = await historySliced<NftTransfer>(
    '/v2/history/get_actions',
    { account, 'act.account': 'atomicassets', 'act.name': 'transfer' },
    from,
    until,
    (page) => (page as { actions?: NftTransfer[] }).actions ?? [],
    (a) => historyTime(a.timestamp),
    (a) => a.global_sequence,
    4,
  )
  const flow: NftFlow = { in: 0, out: 0, joins: 0 }
  for (const r of rows) {
    const d = r.act.data
    const n = (d.asset_ids ?? []).length
    if (d.to === account && String(d.memo ?? '').startsWith(memo)) {
      flow.in += n
      flow.joins++
    } else if (d.from === account) flow.out += n
  }
  return flow
}

/** Alien Worlds NFTs an account owns right now. */
export async function fetchOwnedAw(account: string): Promise<number> {
  const rows = await getAllRows<{ collection_name: string }>({ code: 'atomicassets', scope: account, table: 'assets' })
  return rows.filter((r) => r.collection_name === 'alien.worlds').length
}

export interface McReportDay {
  date: string
  mines: Record<McMode, number>
  flows: Record<McStakeKey, NftFlow>
  /** NFTs staked at the end of the day, rebuilt from the flows. */
  staked: Record<McStakeKey, number>
}

export interface McReportFile {
  generatedAt: string
  days: McReportDay[]
}

export function fetchMcReportFile(): Promise<McReportFile> {
  return cached('mcreport', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/projects/mc-report.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as McReportFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}
