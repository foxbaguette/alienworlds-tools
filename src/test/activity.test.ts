import { describe, expect, it } from 'vitest'
import {
  dateRange,
  legendCount,
  mergeDays,
  signupsByDay,
  statValue,
  summariseDay,
  summariseRange,
  type StatChange,
} from '@/activity/rules'
import { niceScale, compact, shortDate } from '@/components/DailyChart'
import { changeOf } from '@/components/StatTile'

let n = 0
const change = (player: string, stat: string, value = 1): StatChange => ({ key: String(++n), time: 0, player, stat, value })

describe('daily activity', () => {
  it('sums stats and counts players who did something themselves', () => {
    const day = summariseDay('2026-09-18', [
      change('a.wam', 'dungeons_played'),
      change('a.wam', 'dungeons_won'),
      change('b.wam', 'dungeons_played'),
      /* A landowner credited while someone else played is not active. */
      change('lord.wam', 'tlm_earned', 250_000),
      /* Money passing through a game contract is not a payment to anyone. */
      change('arena.ale', 'tlm_earned', 9_990_000),
    ])
    expect(day.stats).toMatchObject({ dungeons_played: 2, dungeons_won: 1, tlm_earned: 250_000 })
    expect(day.players).toEqual(['a.wam', 'b.wam'])
    expect(day.active).toBe(2)
    expect(statValue(day.stats, 'tlm_earned')).toBe(25)
  })

  it('counts a week without counting a player twice', () => {
    const r = summariseRange([
      { date: 'd1', active: 2, players: ['a', 'b'], stats: { recruits: 3 } },
      { date: 'd2', active: 3, players: ['b', 'c', 'd'], stats: { recruits: 1 } },
    ])
    expect(r).toMatchObject({ uniqueActive: 4, avgDaily: 2.5, peak: { date: 'd2', active: 3 } })
    expect(r.totals.recruits).toBe(4)
  })

  it('replaces a day already in the file and keeps dates in order', () => {
    const d = (date: string, active: number) => ({ date, active, players: [], stats: {} })
    expect(mergeDays([d('2026-09-02', 1), d('2026-09-01', 1)], [d('2026-09-02', 9)]).map((x) => [x.date, x.active])).toEqual([
      ['2026-09-01', 1],
      ['2026-09-02', 9],
    ])
  })

  it('counts signups per UTC day and running Legend accounts', () => {
    const t = (s: string) => Date.parse(s)
    const players = [
      { wallet: 'a', signup: t('2026-09-01T23:59:00Z'), lastAction: 0, legendUntil: t('2026-10-01T00:00:00Z') },
      { wallet: 'b', signup: t('2026-09-02T00:01:00Z'), lastAction: 0, legendUntil: 0 },
    ]
    expect(signupsByDay(players, ['2026-09-01', '2026-09-02', '2026-09-03'])).toEqual({
      '2026-09-01': 1,
      '2026-09-02': 1,
      '2026-09-03': 0,
    })
    expect(legendCount(players, t('2026-09-19T00:00:00Z'))).toBe(1)
  })

  it('lists every date in a range', () => {
    expect(dateRange('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'])
  })
})

describe('chart helpers', () => {
  it('steps an axis in 1, 2 or 5 times a power of ten', () => {
    expect(niceScale(2492)).toEqual({ max: 3000, ticks: [0, 1000, 2000, 3000] })
    expect(niceScale(149)).toEqual({ max: 150, ticks: [0, 50, 100, 150] })
    expect(niceScale(25_877).ticks).toEqual([0, 10_000, 20_000, 30_000])
    expect(niceScale(0).max).toBe(1)
  })
  it('writes big figures briefly and dates as UTC days', () => {
    expect([compact(950), compact(2_500), compact(25_000), compact(1_353_320)]).toEqual(['950', '2.5k', '25k', '1.4M'])
    expect(shortDate('2026-09-03')).toBe('3 Sep')
  })
  it('compares only against something', () => {
    expect(changeOf(110, 100)).toBeCloseTo(0.1)
    expect(changeOf(5, 0)).toBeNull()
    expect(changeOf(5, undefined)).toBeNull()
  })
})

describe('per player', () => {
  it('keeps each player apart, and no game contracts', async () => {
    const { summarisePlayers, playerDays } = await import('@/activity/rules')
    const day = summarisePlayers([
      change('a.wam', 'recruits', 2),
      change('a.wam', 'recruits', 1),
      change('b.wam', 'tlm_earned', 50_000),
      change('arena.ale', 'tlm_earned', 9_000_000),
    ])
    expect(day).toEqual({ 'a.wam': { recruits: 3 }, 'b.wam': { tlm_earned: 50_000 } })
    const file = { generatedAt: '', days: [{ date: 'd1', players: day }] }
    expect(playerDays(file, 'a.wam', ['d1', 'd2']).map((d) => [d.date, d.active, d.stats.recruits ?? 0])).toEqual([
      ['d1', 1, 3],
      ['d2', 0, 0],
    ])
  })
})

describe('only Alien Legends', () => {
  it('never counts another game as a player or a sender', async () => {
    const { isGameContract, sentByAlienLegends, summariseDay } = await import('@/activity/rules')
    expect(['arena.ale', 'game.mc', 'emporium.mc', 'm.federation', 'federation.worlds'].map(isGameContract)).toEqual([
      true,
      true,
      true,
      false,
      true,
    ])
    expect([sentByAlienLegends('pools.ale'), sentByAlienLegends('emporium.mc')]).toEqual([true, false])
    const day = summariseDay('d', [change('game.mc', 'shards_earned', 999), change('a.wam', 'shards_earned', 10)])
    expect(day.stats.shards_earned).toBe(10)
  })
})

describe('niceScale on small counts', () => {
  it('steps by whole numbers', () => {
    expect(niceScale(2).ticks).toEqual([0, 1, 2])
    expect(niceScale(3).ticks).toEqual([0, 1, 2, 3])
  })
})
