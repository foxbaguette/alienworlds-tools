import { getRows } from '../../dao/chain/nodes'
import type { ChainAction } from '../../dao/chain/act'

/**
 * Buying RAM, on `eosio`.
 *
 * RAM is bought, not rented, and it is the resource that actually stops a
 * contract: fill the quota and writes start failing. `buyrambytes` is the
 * action to want — you know how many bytes you are short, not how much WAX
 * that is — and it pays from the SIGNER's balance to whichever account
 * receives the bytes, which is how one wallet tops up seventeen contracts.
 *
 * The price comes from the Bancor market in `eosio/rammarket`, and the
 * arithmetic here is the system contract's own so the estimate matches what
 * the chain will charge rather than approximating it:
 *
 *     cost          = quote_reserve * bytes / (ram_reserve - bytes)
 *     cost_plus_fee = cost / 0.995          // the 0.5% buy fee
 */
export const SYSTEM = 'eosio'
export const CORE_SYMBOL = 'WAX'
export const CORE_PRECISION = 8

export interface RamMarket {
  /** Bytes the market holds. */
  ramReserve: number
  /** WAX the market holds, in minor units. */
  quoteReserve: number
}

interface MarketRow {
  base: { balance: string }
  quote: { balance: string }
}

const minorUnits = (asset: string) => {
  const [whole, frac = ''] = String(asset).split(' ')[0].split('.')
  return Number(whole) * 10 ** frac.length + Number(frac || 0)
}

export async function fetchRamMarket(): Promise<RamMarket | null> {
  const rows = await getRows<MarketRow>({ code: SYSTEM, scope: SYSTEM, table: 'rammarket', limit: 1 })
  const row = rows[0]
  if (!row) return null
  return {
    ramReserve: Number(String(row.base.balance).split(' ')[0]),
    quoteReserve: minorUnits(row.quote.balance),
  }
}

/** What `bytes` will cost, in WAX, fee included. */
export function costOfBytes(market: RamMarket, bytes: number): number {
  if (!(bytes > 0) || bytes >= market.ramReserve) return NaN
  const cost = (market.quoteReserve * bytes) / (market.ramReserve - bytes)
  return cost / 0.995 / 10 ** CORE_PRECISION
}

/** The other direction: roughly what `wax` buys, fee taken off first. */
export function bytesForWax(market: RamMarket, wax: number): number {
  if (!(wax > 0)) return NaN
  const paid = wax * 0.995 * 10 ** CORE_PRECISION
  return Math.floor((market.ramReserve * paid) / (market.quoteReserve + paid))
}

/** WAX per MB, which is the figure anyone actually compares against. */
export const perMegabyte = (market: RamMarket) => costOfBytes(market, 1 << 20)

/**
 * `buyrambytes` rather than `buyram`: the contract works out the WAX itself, at
 * the price in the block that lands, so a market that moves between the
 * estimate and the signature costs bytes rather than silently buying fewer.
 */
export const buyRamAction = (
  level: ChainAction['authorization'][number],
  receiver: string,
  bytes: number,
): ChainAction => ({
  account: SYSTEM,
  name: 'buyrambytes',
  authorization: [level],
  data: { payer: level.actor, receiver, bytes: Math.max(1, Math.round(bytes)) },
})
