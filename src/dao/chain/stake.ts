import { getRows, pinned } from './nodes'
import type { ChainAction } from './act'
import type { Dao } from './daos'

/**
 * Holding, staking and converting a DAO's token.
 *
 * Four things per DAO for whoever is signed in. All of them live on the DAO's
 * own token contract, and all but the balance are scoped by dac_id rather than
 * by the token symbol:
 *
 *   accounts   scope = the holder    what they hold, in total
 *   stakes     scope = dac_id        what they have staked, keyed by account
 *   staketime  scope = dac_id        their chosen unstake delay, keyed by account
 *   unstakes   scope = dac_id        releases in flight, via the `byaccount` index
 *
 * `staketime` has no row until someone sets one; the contract then falls back
 * to `stakeconfig.min_stake_time`, so a missing row means the minimum, not zero.
 *
 * The actions were read off the contracts and confirmed against live traces:
 *
 *   stake        token.worlds::stake(account, quantity)
 *   unstake      token.worlds::unstake(account, quantity)
 *   claim        token.worlds::claimunstkes(account, token_symbol)
 *   cancel       token.worlds::cancel(unstake_id, token_symbol)
 *   TLM → token  alien.worlds::transfer(→ stake.worlds, memo "staking")
 *                + stake.worlds::stake(account, planet_name, quantity)  [one trx]
 *   token → TLM  token.worlds::transfer(→ stake.worlds, memo "Unstaking")
 */
export const STAKE_CONTRACT = 'stake.worlds'
export const PLANETS_CONTRACT = 'plnts.worlds'
export const TLM_CONTRACT = 'alien.worlds'
export const TLM_SYMBOL = 'TLM'

/*
 * Assets are fixed point, so the arithmetic here is done in minor units and
 * never in floats — 600292.4900 minus 600000.0000 has to come out as exactly
 * 292.4900, and binary floating point does not promise that.
 */
export function assetUnits(a: string | null | undefined): number {
  if (!a) return 0
  const [whole, frac = ''] = String(a).split(' ')[0].split('.')
  return Number(whole) * 10 ** frac.length + Number(frac || 0)
}

export function unitsToAsset(units: number, precision: number, code: string): string {
  const s = String(Math.max(0, Math.round(units))).padStart(precision + 1, '0')
  const whole = s.slice(0, s.length - precision)
  const frac = precision ? `.${s.slice(s.length - precision)}` : ''
  return `${whole}${frac} ${code}`
}

export const assetAmount = (a: string | null | undefined) => Number(String(a ?? '0').split(' ')[0]) || 0
const codeOf = (a: string | null | undefined) => String(a ?? '').split(' ')[1] ?? ''

/**
 * A number typed by a person, as the fixed-point string the chain requires.
 * Truncates rather than rounds: rounding up could ask to move more than is held.
 */
export function toAsset(input: string | number, precision: number, code: string): string | null {
  const n = Number(String(input).trim().replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  const units = Math.floor(n * 10 ** precision + 1e-6)
  if (units <= 0) return null
  return unitsToAsset(units, precision, code)
}

export interface Unstaking {
  key: string
  stake: string
  release: number
}

export interface Position {
  /** Everything held, staked included — this is what `accounts` reports. */
  total: string | null
  /** What is actually spendable. Always a real asset, zero included. */
  notStaked: string
  hasFree: boolean
  staked: string | null
  /** The unstake delay in seconds, or null if it could not be established. */
  delay: number | null
  /** True when the delay came from the config floor rather than a chosen one. */
  delayIsMinimum: boolean
  unstakes: Unstaking[]
}

export interface StakeConfig {
  min: number
  max: number
  enabled: boolean
}

/**
 * One DAO's three staking tables, pinned to a single node so they agree.
 *
 * `unstake` moves tokens out of `stakes` and into `unstakes` in one
 * transaction, so reading the two from nodes at different heights can show the
 * same tokens twice — once as staked and once as unstaking.
 */
export async function readPosition(dao: Dao, actor: string, balance: string | null): Promise<Position | null> {
  if (!dao.tokenContract) return null
  const bounded = { lower_bound: actor, upper_bound: actor, limit: 1 }

  const contract = dao.tokenContract
  const [stakeRows, timeRows, unstakeRows] = await pinned(3, (url) => [
    getRows<{ stake: string }>({ code: contract, scope: dao.id, table: 'stakes', ...bounded }, url),
    getRows<{ delay: number }>({ code: contract, scope: dao.id, table: 'staketime', ...bounded }, url),
    getRows<{ key: string; stake: string; release_time: string }>(
      {
        code: contract,
        scope: dao.id,
        table: 'unstakes',
        /* `unstakes` is keyed by an auto-incrementing id, so finding one
           account's releases means the byaccount secondary index. */
        index_position: 2,
        key_type: 'name',
        lower_bound: actor,
        upper_bound: actor,
        limit: 100,
      },
      url,
    ),
  ] as const)

  const staked = stakeRows[0]?.stake ?? null
  const unstakes = unstakeRows
    .filter((u) => assetAmount(u.stake) > 0)
    .map((u) => ({ key: String(u.key), stake: u.stake, release: Date.parse(`${u.release_time}Z`) }))
    .sort((a, b) => a.release - b.release)

  /*
   * `accounts.balance` is the TOTAL held, not the free part. What is spendable
   * is the contract's own get_liquid:
   *
   *     liquid = balance - stake - unstakes not yet released
   *
   * A released unstake is deliberately not subtracted — the contract erases
   * those rows on sight, so they are back in hand.
   */
  const now = Date.now()
  const locked = unstakes.filter((u) => u.release > now).reduce((n, u) => n + assetUnits(u.stake), 0)
  const free = assetUnits(balance) - assetUnits(staked) - locked

  return {
    total: assetAmount(balance) > 0 ? balance : null,
    notStaked: unitsToAsset(free, dao.precision, dao.symbol),
    hasFree: free > 0,
    staked: assetAmount(staked) > 0 ? staked : null,
    delay: timeRows[0] ? Number(timeRows[0].delay) : null,
    delayIsMinimum: false,
    unstakes,
  }
}

/** Every balance one holder has on a token contract, in one read. */
export async function readBalances(contract: string, actor: string): Promise<Map<string, string>> {
  const rows = await getRows<{ balance: string }>({ code: contract, scope: actor, table: 'accounts', limit: 200 })
  return new Map(rows.map((r) => [codeOf(r.balance), r.balance]))
}

export async function readStakeConfig(dao: Dao): Promise<StakeConfig | null> {
  if (!dao.tokenContract) return null
  const rows = await getRows<{ min_stake_time: number; max_stake_time: number; enabled: number }>({
    code: dao.tokenContract,
    scope: dao.id,
    table: 'stakeconfig',
    limit: 1,
  })
  const row = rows[0]
  return row ? { min: Number(row.min_stake_time), max: Number(row.max_stake_time), enabled: !!row.enabled } : null
}

/**
 * What `stake.worlds` calls each DAO, for the TLM swap.
 *
 * Not uniform: syndicates are addressed by their planet account
 * (`eyeke.world`, from plnts.worlds) and unions by their dac_id (`kavianunn`,
 * from stake.worlds/stakedaos). Both branches were confirmed on chain.
 */
export async function readSwapTargets(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const [planets, stakedaos] = await Promise.all([
    getRows<{ dac_symbol: string; planet_name: string; active: number }>({
      code: PLANETS_CONTRACT,
      scope: PLANETS_CONTRACT,
      table: 'planets',
      limit: 100,
    }).catch(() => []),
    getRows<{ dac_symbol: string; dac_id: string }>({
      code: STAKE_CONTRACT,
      scope: STAKE_CONTRACT,
      table: 'stakedaos',
      limit: 100,
    }).catch(() => []),
  ])

  for (const p of planets) {
    const code = String(p.dac_symbol ?? '').split(',')[1]
    if (code && p.active) out.set(code, p.planet_name)
  }
  /* Unions second: where a symbol appears in both, stake.worlds' own list wins. */
  for (const d of stakedaos) {
    const code = String(d.dac_symbol ?? '').split(',')[1]
    if (code) out.set(code, d.dac_id)
  }
  return out
}

/* ---------- the actions ---------- */

type Level = ChainAction['authorization'][number]

const symbolOf = (dao: Dao) => `${dao.precision},${dao.symbol}`

export const stakeAction = (level: Level, dao: Dao, quantity: string): ChainAction => ({
  account: dao.tokenContract!,
  name: 'stake',
  authorization: [level],
  data: { account: level.actor, quantity },
})

export const unstakeAction = (level: Level, dao: Dao, quantity: string): ChainAction => ({
  account: dao.tokenContract!,
  name: 'unstake',
  authorization: [level],
  data: { account: level.actor, quantity },
})

export const claimAction = (level: Level, dao: Dao): ChainAction => ({
  account: dao.tokenContract!,
  name: 'claimunstkes',
  authorization: [level],
  data: { account: level.actor, token_symbol: symbolOf(dao) },
})

export const cancelAction = (level: Level, dao: Dao, key: string): ChainAction => ({
  account: dao.tokenContract!,
  name: 'cancel',
  authorization: [level],
  data: { unstake_id: String(key), token_symbol: symbolOf(dao) },
})

export const stakeTimeAction = (level: Level, dao: Dao, seconds: number): ChainAction => ({
  account: dao.tokenContract!,
  name: 'staketime',
  authorization: [level],
  data: { account: level.actor, unstake_time: seconds, token_symbol: symbolOf(dao) },
})

/**
 * TLM in. Both actions ride in one transaction — the transfer alone would just
 * park TLM on stake.worlds with nothing to claim it.
 */
export const buyActions = (level: Level, target: string, quantity: string): ChainAction[] => [
  {
    account: TLM_CONTRACT,
    name: 'transfer',
    authorization: [level],
    data: { from: level.actor, to: STAKE_CONTRACT, quantity, memo: 'staking' },
  },
  {
    account: STAKE_CONTRACT,
    name: 'stake',
    authorization: [level],
    data: { account: level.actor, planet_name: target, quantity },
  },
]

/** Token out. stake.worlds burns what it receives and refunds TLM 1:1. */
export const sellAction = (level: Level, dao: Dao, quantity: string): ChainAction => ({
  account: dao.tokenContract!,
  name: 'transfer',
  authorization: [level],
  data: { from: level.actor, to: STAKE_CONTRACT, quantity, memo: 'Unstaking' },
})
