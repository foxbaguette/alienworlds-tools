import { cached, getAllRows } from '@/chain/rpc'

/**
 * `pools.ale` — the reward pools, and what they hold right now.
 *
 * Types and the balance projection are the game's own (web/src/pools), kept
 * in step by hand: the chain decides the arithmetic, so there is nothing to
 * adapt, only to copy.
 */

/** `pools.ale` / `tlmpools`. A parent pool has subpools and pays nobody. */
export interface TlmPool {
  pool: string
  subpools: string[]
  has_fillrate: boolean
  /** Per minute, as an asset string. */
  fillrate: string
  tlm_reserve: string
  tlm_current: string
  last_reserve_update: string
  last_current_update: string
  fillrate_expiry: string
  claim_per_hour_percent: number
  /** Hundred-thousandths: 350000 is 35% of the reserve a day. */
  fillrate_1d_percent: number
}

/** `pools.ale` / `shardpools` — one flat balance, one decimal place. */
export interface ShardPool {
  pool: string
  shard_current: number
  fillrate_per_hour: number
  last_current_update: string
}

/** `rwrdlog.ale` / `pooldesc` — the game's own wording for each pool. */
export interface PoolDescription {
  pool_name: string
  pool_description: string
}

const MINUTE = 60_000

export function fetchTlmPools(): Promise<TlmPool[]> {
  return cached('tlmpools', MINUTE, () =>
    getAllRows<TlmPool>({ code: 'pools.ale', scope: 'pools.ale', table: 'tlmpools' }),
  )
}

export function fetchShardPools(): Promise<ShardPool[]> {
  return cached('shardpools', MINUTE, () =>
    getAllRows<ShardPool>({ code: 'pools.ale', scope: 'pools.ale', table: 'shardpools' }),
  )
}

export function fetchPoolDescriptions(): Promise<PoolDescription[]> {
  return cached('pooldesc', 60 * MINUTE, () =>
    getAllRows<PoolDescription>({ code: 'rwrdlog.ale', scope: 'rwrdlog.ale', table: 'pooldesc' }),
  )
}

/* ---------- what a pool holds right now (verbatim from the game) ---------- */

export function assetAmount(asset: string, places: number): number {
  return Math.round(Number((asset ?? '0').split(' ')[0] ?? 0) * Math.pow(10, places))
}

function secondsSince(stamp: string, now: number): number {
  return Math.floor((now - Date.parse(stamp + 'Z')) / 1000)
}

/**
 * A shard pool's balance, projected forward.
 *
 * `updshardpool` runs before every payout, so the stored row is stale by
 * however long it has been since anyone last mined. Showing the stored figure
 * would quote a payout the chain will not honour.
 */
export function liveShardPool(pool: ShardPool, now = Date.now()): number {
  const secs = secondsSince(pool.last_current_update, now)
  if (secs <= 0) return Number(pool.shard_current ?? 0)
  return (
    Number(pool.shard_current ?? 0) +
    Math.floor((Number(pool.fillrate_per_hour ?? 0) * secs) / 3600)
  )
}

/**
 * A TLM pool's spendable balance, projected forward.
 *
 * `updtlmpool` moves reserve into current at `fillrate` per minute until
 * `fillrate_expiry`, then recomputes the rate day by day from what is left —
 * `reserve * fillrate_1d_percent / 1e6 / 1440` per minute for the next day —
 * until it catches up with now. Several live pools are days past expiry, so
 * skipping that loop would under-report them badly.
 *
 * The parent-pool claim is deliberately left out: it tops up `tlm_reserve`,
 * not `tlm_current`, so it cannot change this mine's payout.
 */
export function liveTlmPool(pool: TlmPool, now = Date.now()): number {
  let current = assetAmount(pool.tlm_current, 4)
  if (!pool.has_fillrate) return current

  let reserve = assetAmount(pool.tlm_reserve, 4)
  let rate = assetAmount(pool.fillrate, 4)
  let expiry = Date.parse(pool.fillrate_expiry + 'Z')
  let last = Date.parse(pool.last_current_update + 'Z')

  if (expiry > now) {
    const secs = Math.floor((now - last) / 1000)
    if (secs <= 0) return current
    const fill = Math.min(Math.floor((rate * secs) / 60), reserve)
    /* The contract ignores dust: anything at or under 100 (0.01 TLM) is not moved. */
    return fill > 100 ? current + fill : current
  }

  /* Expired: replay the day-by-day catch-up the contract would run. */
  let moved = 0
  let guard = 0
  while (expiry < now && reserve > 0 && guard++ < 400) {
    const secs = Math.floor((expiry - last) / 1000)
    if (secs <= 0) break

    const fill = Math.min(Math.floor((rate * secs) / 60), reserve)
    moved += fill
    reserve -= fill
    rate = Math.floor((reserve * Number(pool.fillrate_1d_percent ?? 0)) / 1e6 / 1440)

    last = expiry
    expiry += 86_400_000
  }

  current += moved
  return current
}
