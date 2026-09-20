import { getRows } from '../../dao/chain/nodes'

/**
 * `collect.ale` — where the game's WAX income is banked and split.
 *
 * The planets' mining claims land here (`claimplanets`), and the contract sorts
 * what arrives into named reserves. Each reserve holds its balance until it
 * crosses a threshold, and then pays out to the wallets listed under its
 * `payout_name`, split by percentage.
 *
 * The developer payout is one of those reserves: `waxdev`, paying `waxdevs`.
 * "How close are we" is its reserve against its threshold, and nothing else —
 * the contract does not pay early and does not pay part.
 */
export const COLLECT = 'collect.ale'

export interface Distribution {
  distribution_name: string
  currency_symbol: string
  current_reserve_amount: string
  required_in_reserve_amount: string
  payout_threshold_active: number
  payout_threshold_amount: string
  payout_name: string
  /** Share of what comes in that this reserve takes, as a whole percent. */
  percentage: number
}

export interface Payout {
  payout_target_wallet: string
  only_payout_below_limit: number
  limit: string
  payout_percent: number
  payout_memo: string
}

export interface Tracking {
  index: number
  wax_required_in_reserve_amount: string
  tlm_required_in_reserve_amount: string
  wax_overflow: string
  tlm_overflow: string
  last_planet_claim: string
}

export interface ClaimScope {
  scope: string
  active: number
}

export interface CollectState {
  distributions: Distribution[]
  /** Keyed by payout_name — the scope the payout rows live in. */
  payouts: Map<string, Payout[]>
  tracking: Tracking | null
  scopes: ClaimScope[]
}

export const amountOf = (asset: string) => Number(String(asset ?? '').split(' ')[0]) || 0
export const symbolOf = (asset: string) => String(asset ?? '').split(' ')[1] ?? ''

/** Where a reserve stands against the threshold that releases it. */
export interface Progress {
  have: number
  need: number
  /** 0 to 100, clamped — a reserve over its threshold is simply ready. */
  percent: number
  ready: boolean
  /** No threshold set means it pays out on every claim. */
  always: boolean
}

export function progressOf(d: Distribution): Progress {
  const have = amountOf(d.current_reserve_amount)
  const need = amountOf(d.payout_threshold_amount)
  if (!d.payout_threshold_active || need <= 0) {
    return { have, need: 0, percent: 100, ready: have > 0, always: true }
  }
  return { have, need, percent: Math.min(100, (have / need) * 100), ready: have >= need, always: false }
}

export async function fetchCollect(): Promise<CollectState> {
  const [distributions, tracking, scopes] = await Promise.all([
    getRows<Distribution>({ code: COLLECT, scope: COLLECT, table: 'distribution', limit: 100 }),
    getRows<Tracking>({ code: COLLECT, scope: COLLECT, table: 'tracking', limit: 1 }),
    getRows<ClaimScope>({ code: COLLECT, scope: COLLECT, table: 'claimscopes', limit: 100 }),
  ])

  /* One read per payout name rather than a scope listing: get_table_by_scope is
     the least reliable call on these nodes, and the names are already in hand
     from the distributions. */
  const names = [...new Set(distributions.map((d) => d.payout_name).filter(Boolean))]
  const lists = await Promise.all(
    names.map((n) =>
      getRows<Payout>({ code: COLLECT, scope: n, table: 'payout', limit: 100 }).catch(() => [] as Payout[]),
    ),
  )

  return {
    distributions,
    payouts: new Map(names.map((n, i) => [n, lists[i]])),
    tracking: tracking[0] ?? null,
    scopes,
  }
}
