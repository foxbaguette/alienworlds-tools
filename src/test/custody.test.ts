import { describe, expect, it } from 'vitest'
import { custodyDays, custodyNow, type Change } from '@/projects/custody'

/*
 * Alien Worlds NFTs in a project's custody, day by day.
 *
 * The figure is a level, not a flow, and a level read wrong is the kind of
 * mistake nobody can see: it looks like a fact about the Alien Worlds economy
 * whichever number it says. So the two places it could go wrong are pinned
 * here — where a day ends, and what a deleted row means.
 */
const at = (iso: string) => Date.parse(iso + 'Z')

const change = (t: string, id: string, present: boolean, division = 0): Change => ({
  at: at(t),
  id,
  present,
  division,
})

describe('custody days', () => {
  it('counts an asset from the day it was staked', () => {
    const days = custodyDays('2026-09-29', '2026-10-01', [
      change('2026-09-30T12:00:00', 'a', true),
    ])
    expect(days.map((d) => d.staked)).toEqual([0, 1, 1])
    expect(days.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'])
  })

  /* A change at 23:59 belongs to its own day; one at 00:00 to the next. */
  it('ends a day at midnight UTC', () => {
    expect(
      custodyDays('2026-09-30', '2026-10-01', [change('2026-09-30T23:59:59', 'a', true)]).map((d) => d.staked),
    ).toEqual([1, 1])
    expect(
      custodyDays('2026-09-30', '2026-10-01', [change('2026-10-01T00:00:00', 'a', true)]).map((d) => d.staked),
    ).toEqual([0, 1])
  })

  /*
     The trap. A row being deleted is a delta like any other and it carries the
     row's last contents, division and all — so an asset taken back out goes on
     being counted, in a division, for as long as the series runs.
  */
  it('stops counting an asset once its row is gone', () => {
    const days = custodyDays('2026-09-30', '2026-10-02', [
      change('2026-09-30T10:00:00', 'a', true, 7),
      change('2026-10-01T10:00:00', 'a', false, 7),
    ])
    expect(days.map((d) => d.staked)).toEqual([1, 0, 0])
    expect(days.map((d) => d.divisions)).toEqual([1, 0, 0])
  })

  it('tells staked from in a division', () => {
    const days = custodyDays('2026-09-30', '2026-10-02', [
      change('2026-09-30T10:00:00', 'a', true, 0),
      change('2026-09-30T10:00:00', 'b', true, 0),
      change('2026-10-01T10:00:00', 'a', true, 4),
    ])
    expect(days.map((d) => `${d.staked}/${d.divisions}`)).toEqual(['2/0', '2/1', '2/1'])
  })

  /* Leaving a division is not leaving custody. */
  it('keeps an asset staked when it is taken out of its division', () => {
    const days = custodyDays('2026-10-01', '2026-10-02', [
      change('2026-10-01T10:00:00', 'a', true, 9),
      change('2026-10-02T10:00:00', 'a', true, 0),
    ])
    expect(days).toEqual([
      { date: '2026-10-01', staked: 1, divisions: 1 },
      { date: '2026-10-02', staked: 1, divisions: 0 },
    ])
  })

  /* An asset staked before the window has no change inside it to find. */
  it('carries in what was already held', () => {
    const days = custodyDays('2026-10-01', '2026-10-02', [change('2026-06-30T10:00:00', 'a', true, 2)])
    expect(days.map((d) => `${d.staked}/${d.divisions}`)).toEqual(['1/1', '1/1'])
  })

  it('takes a timeline in any order', () => {
    const shuffled = [
      change('2026-10-02T10:00:00', 'a', false),
      change('2026-10-01T10:00:00', 'a', true, 3),
    ]
    expect(custodyDays('2026-10-01', '2026-10-02', shuffled).map((d) => d.staked)).toEqual([1, 0])
  })

  /* Two sightings of one asset: staked, taken back, staked again by somebody
     else. Its row is read in each owner's scope, so both show up. */
  it('follows an asset through a change of owner', () => {
    const days = custodyDays('2026-10-01', '2026-10-04', [
      change('2026-10-01T10:00:00', 'a', true, 1),
      change('2026-10-02T10:00:00', 'a', false, 1),
      change('2026-10-03T10:00:00', 'a', true, 0),
    ])
    expect(days.map((d) => `${d.staked}/${d.divisions}`)).toEqual(['1/1', '0/0', '1/0', '1/0'])
  })
})

describe('custody now', () => {
  /* What the gate compares against the contract's own table. */
  it('is the state after every change, whenever they happened', () => {
    expect(
      custodyNow([
        change('2026-10-01T10:00:00', 'a', true, 1),
        change('2026-10-18T10:00:00', 'b', true, 0),
        change('2026-10-19T06:00:00', 'a', false, 1),
      ]),
    ).toEqual({ staked: 1, divisions: 0 })
  })

  it('holds nothing when nothing has happened', () => {
    expect(custodyNow([])).toEqual({ staked: 0, divisions: 0 })
  })
})
