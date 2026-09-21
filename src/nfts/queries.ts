import { historySliced, historyTime } from '@/chain/history'
import { cached } from '@/chain/rpc'

/**
 * `nfts.ale` — the game's register of NFTs in use.
 *
 * Its `assets` table holds a row per NFT used within the last day
 * (`config.timeframe_sec`, 86,400): every `usenfts` call writes the NFTs it
 * names and clears up to ten expired rows, far more than ever expire between
 * calls. So the table is a rolling window, and its size at any moment is the
 * number of distinct NFTs used in the 24 hours before.
 *
 * That was checked rather than assumed: the distinct NFTs named in the last
 * 24 hours of `usenfts` came to 1,084 against 1,086 rows read a minute later.
 * At the end of a UTC day it is therefore the distinct NFTs used that day —
 * which the history can answer exactly for any past day, where the table
 * itself only ever says what it holds now.
 */
export const NFTS = 'nfts.ale'

interface UseAction {
  global_sequence: number
  timestamp: string
  act: { data: { asset_ids?: (string | number)[] } }
}

/** Distinct NFTs named in `usenfts` between two moments. */
export async function fetchNftsUsed(from: number, until: number): Promise<number> {
  const actions = await historySliced<UseAction>(
    '/v2/history/get_actions',
    { 'act.account': NFTS, 'act.name': 'usenfts' },
    from,
    until,
    (page) => (page as { actions?: UseAction[] }).actions ?? [],
    (a) => historyTime(a.timestamp),
    (a) => a.global_sequence,
    8,
  )
  const ids = new Set<string>()
  for (const a of actions) for (const id of a.act.data.asset_ids ?? []) ids.add(String(id))
  return ids.size
}

export interface NftsDay {
  date: string
  /** Rows in the table at the end of the UTC day: distinct NFTs used that day. */
  rows: number
}

export interface NftsDailyFile {
  generatedAt: string
  days: NftsDay[]
}

export function fetchNftsDaily(): Promise<NftsDailyFile> {
  return cached('nftsdaily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/nfts-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as NftsDailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}
