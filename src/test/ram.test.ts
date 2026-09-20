import { describe, expect, it } from 'vitest'
import { bytesForWax, costOfBytes, perMegabyte, type RamMarket } from '@/ale/chain/ram'

/*
 * The RAM price.
 *
 * Worth pinning because the arithmetic is the system contract's and not an
 * approximation of it: an estimate that disagrees with what the chain charges
 * is worse than no estimate, since the number is there to be decided on.
 *
 * These reserves are the live market as of 2026-09-20.
 */
const market: RamMarket = {
  ramReserve: 125_343_632_908,
  quoteReserve: 5_506_100_284_067_058,
}

describe('what RAM costs', () => {
  it('prices a megabyte at the market rate plus the buy fee', () => {
    /* base rate, before the fee: quote/base per byte, over a megabyte */
    const naive = ((market.quoteReserve / market.ramReserve) * (1 << 20)) / 1e8
    expect(naive).toBeCloseTo(460.6, 0)
    /* the 0.5% fee is taken off what is paid, so the cost is the naive one
       divided by 0.995 rather than multiplied by 1.005 */
    expect(perMegabyte(market)).toBeCloseTo(naive / 0.995, 1)
  })

  it('bends the right way: buying more costs more per byte', () => {
    const one = costOfBytes(market, 1 << 20)
    const hundred = costOfBytes(market, 100 * (1 << 20))
    expect(hundred / 100).toBeGreaterThan(one)
  })

  it('round-trips a WAX amount back to roughly the same bytes', () => {
    const bytes = 4 * (1 << 20)
    const wax = costOfBytes(market, bytes)
    /* Not exact — the fee is applied to opposite sides of the trade — but
       within a hair, which is all a "what will this buy me" answer needs. */
    expect(bytesForWax(market, wax) / bytes).toBeCloseTo(1, 2)
  })

  it('refuses a size the market cannot fill', () => {
    expect(costOfBytes(market, 0)).toBeNaN()
    expect(costOfBytes(market, -1)).toBeNaN()
    expect(costOfBytes(market, market.ramReserve)).toBeNaN()
    expect(bytesForWax(market, 0)).toBeNaN()
  })
})
