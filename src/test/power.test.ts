import { describe, expect, it } from 'vitest'
import { decayedPower, powerTitle, rawPower } from '@/dao/format'

/*
 * Vote power, as the chain counts it.
 *
 * `total_vote_power` is a running sum that never ages. `rank` carries the same
 * support discounted by how old the votes are, encoded as
 *
 *     rank / 10000 = log2(power + 1) + avg_vote_time_stamp / 2592000
 *
 * and the council is seated on that, not on the sum. The two run far enough
 * apart that showing the wrong one is not a rounding question: the rows below
 * are live, read from dao.worlds on 21 October 2026.
 */
const SECONDS_TO_DOUBLE = 2_592_000

/** Builds the rank the chain would store for this support at this vote age. */
const rankFor = (power: number, votedAt: string) =>
  Math.round((Math.log2(power + 1) + Date.parse(votedAt + 'Z') / 1000 / SECONDS_TO_DOUBLE) * 10_000)

describe('vote power', () => {
  /*
     Veles Union, 21 October 2026. 1zcq4.c.wam holds 2.73M voted on and the
     chain counts 12.9K of it — two hundred times apart, and the smaller
     figure is the one that decides whether they take a seat.
  */
  it('recovers the support behind a fresh vote', () => {
    const now = Date.parse('2026-10-21T00:00:00Z')
    const rank = rankFor(4_056_000 * 10_000, '2026-10-21T00:00:00')
    expect(decayedPower(rank, 4, now)).toBeCloseTo(4_056_000, -2)
  })

  it('halves it for every thirty days of age', () => {
    const now = Date.parse('2026-10-21T00:00:00Z')
    const rank = rankFor(1_000_000 * 10_000, '2026-09-21T00:00:00')
    /* Thirty days is one halving: a million voted on counts as half of one. */
    expect(decayedPower(rank, 4, now)).toBeCloseTo(500_000, -3)
  })

  it('is far below the running total for an old vote', () => {
    const now = Date.parse('2026-10-21T00:00:00Z')
    const raw = 2_733_000
    const rank = rankFor(raw * 10_000, '2026-02-21T00:00:00')
    const counted = decayedPower(rank, 4, now)
    expect(counted).toBeLessThan(raw / 100)
    expect(rawPower(String(raw * 10_000), 4)).toBeCloseTo(raw, 0)
  })

  /*
     Computed in log space on purpose: 2 ^ (now / 2592000) alone is about
     2^690, which is Infinity in a double, and the subtraction has to happen
     before the exponent rather than after.
  */
  it('does not overflow on a present-day timestamp', () => {
    const rank = rankFor(5_000 * 10_000, '2026-10-21T00:00:00')
    const counted = decayedPower(rank, 4, Date.parse('2026-10-21T00:00:00Z'))
    expect(Number.isFinite(counted)).toBe(true)
    expect(counted).toBeGreaterThan(0)
  })

  it('reads zero rather than NaN for a rank it cannot parse', () => {
    expect(decayedPower('not a number', 4)).toBe(0)
  })

  /* The counted figure leads the sentence, because it is the one on show. */
  it('explains the counted figure first, and the total as context', () => {
    const said = powerTitle(12_900, 2_733_000, 'VELUNN', 3)
    expect(said.indexOf('12.9K')).toBeLessThan(said.indexOf('2.73M'))
    expect(said).toContain('VELUNN')
    expect(said).toContain(', from 3 accounts')
    expect(said).toContain('halve every 30 days')
  })

  it('names no token where there is no single one to name', () => {
    expect(powerTitle(1_000, 2_000)).not.toContain('undefined')
  })

  it('counts one voter as an account, not accounts', () => {
    expect(powerTitle(10, 20, 'KAV', 1)).toContain(', from 1 account —')
  })
})
