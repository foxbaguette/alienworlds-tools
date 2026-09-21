import { historyGet, iso } from '@/chain/history'
import { cached, getAllRows, nameToUint64 } from '@/chain/rpc'

/**
 * `farm.ale` — NFTs staked for a share of the farm's rewards.
 *
 * Its `pools` table keeps one row per NFT schema with a running `total_nfts`,
 * rewritten on every stake, unstake and claim. So what was staked at any
 * moment is simply that row as it last stood — the same read the reward
 * pools' daily balances use, and far cheaper than replaying transfers.
 */
export const FARM = 'farm.ale'

export interface FarmPool {
  schema: string
  current_size: number
  last_claim: string
  total_nfts: number
  total_weight: number
}

/** The schemas, in the order the page lists them, and what to call them. */
export const FARM_SCHEMAS: { schema: string; label: string; color: string }[] = [
  { schema: 'tool.worlds', label: 'Tools', color: 'var(--series-1)' },
  { schema: 'crew.worlds', label: 'Crew', color: 'var(--series-2)' },
  { schema: 'arms.worlds', label: 'Arms', color: 'var(--series-4)' },
]

export function fetchFarmPools(): Promise<FarmPool[]> {
  return cached('farmpools', 60_000, () => getAllRows<FarmPool>({ code: FARM, scope: FARM, table: 'pools' }))
}

interface FarmDeltaPage {
  deltas?: { data: { total_nfts?: number | string } }[]
}

/** How many NFTs of one schema were staked at `at`. */
export async function fetchFarmStakedAt(schema: string, at: number): Promise<number | undefined> {
  const page = await historyGet<FarmDeltaPage>('/v2/history/get_deltas', {
    code: FARM,
    scope: FARM,
    table: 'pools',
    primary_key: nameToUint64(schema).toString(),
    before: iso(at),
    limit: 1,
  })
  const d = page.deltas?.[0]
  return d ? Number(d.data.total_nfts ?? 0) : undefined
}

export interface FarmDay {
  date: string
  /** NFTs staked at the end of the UTC day, by schema. */
  nfts: Record<string, number>
}

export interface FarmDailyFile {
  generatedAt: string
  days: FarmDay[]
}

/** The farm's collected days. Missing is not an error — the chart just waits. */
export function fetchFarmDaily(): Promise<FarmDailyFile> {
  return cached('farmdaily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/farm-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as FarmDailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}
