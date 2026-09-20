import { describe, expect, it } from 'vitest'
import {
  attribute,
  hourlyOut,
  playersOf,
  poolName,
  summarisePools,
  totalsOf,
  type BuildingClaim,
  type BuildingReward,
  type Payout,
} from '@/poolstats/rules'

let seq = 0
const pay = (over: Partial<Payout>): Payout => ({
  seq: ++seq,
  trx: 't' + seq,
  time: 1_000_000,
  payer: 'pools.ale',
  player: 'a.wam',
  type: 'tlm',
  pool: 'tlmdung',
  amount: 10,
  ...over,
})

const claim = (over: Partial<BuildingClaim>): BuildingClaim => ({
  seq: ++seq,
  trx: 'x',
  planet: 'eyeke',
  land: 'hxbe',
  tlmPool: 'tlmtavern',
  shardPool: 'shrdtavern',
  ...over,
})

const credit = (over: Partial<BuildingReward>): BuildingReward => ({
  seq: ++seq,
  trx: 'x',
  planet: 'eyeke',
  land: 'hxbe',
  tlm: 0,
  shards: 0,
  ...over,
})

describe('pool statistics', () => {
  it('traces a landowner cut to the pool its building drew on', () => {
    const [p] = attribute([pay({ trx: 'x', pool: 'tlmlndowner', amount: 24.124 })], [claim({})], [])
    /* Traced to the tavern pool — and, being TLM, held on the building until claimed. */
    expect(p).toMatchObject({ kind: 'escrow', source: 'tlmtavern' })
  })

  it('keeps two lands in one transaction apart by the amount credited', () => {
    const out = attribute(
      [
        pay({ trx: 'x', pool: 'tlmlndowner', amount: 13.91 }),
        pay({ trx: 'x', pool: 'shrdlndowner', type: 'shards', amount: 15.6 }),
      ],
      [claim({}), claim({ planet: 'kavian', land: 'baxf', tlmPool: 'tlmdung', shardPool: 'shrddung' })],
      [credit({ tlm: 241240 }), credit({ planet: 'kavian', land: 'baxf', tlm: 139100 }), credit({ planet: 'kavian', land: 'baxf', shards: 156 })],
    )
    expect(out.map((p) => p.source)).toEqual(['tlmdung', 'shrddung'])
  })

  it('marks mines, other payers, and leaves escrow alone', () => {
    const out = attribute(
      [
        pay({}),
        pay({ payer: 'quests.ale', pool: 'tlmquests' }),
        pay({ pool: 'tlmquests', kind: 'escrow' }),
      ],
      [],
      [],
    )
    expect(out.map((p) => p.kind)).toEqual(['mine', 'claim', 'escrow'])
  })

  it('counts quest rewards when players claim them, with escrow beside it', () => {
    const s = summarisePools([
      pay({ pool: 'tlmquests', kind: 'escrow', amount: 50 }),
      pay({ pool: 'tlmquests', payer: 'quests.ale', kind: 'claim', amount: 20 }),
    ])
    expect(s[0]).toMatchObject({ pool: 'tlmquests', out: 20, intoEscrow: 50, payouts: 1, players: 1 })
    expect(s[0].byKind.claim).toBe(20)
    expect(s[0].byKind.escrow).toBe(0)
  })

  it('splits a pool by kind, with the landowner cut on the building pool', () => {
    const payouts = attribute(
      [pay({ amount: 100 }), pay({ trx: 'x', pool: 'tlmlndowner', amount: 30, player: 'lord.wam' })],
      [claim({ tlmPool: 'tlmdung' })],
      [],
    )
    const [dung] = summarisePools(payouts)
    /* The TLM cut waits on the building, so only the mine is paid out yet. */
    expect(dung).toMatchObject({ pool: 'tlmdung', out: 100, intoEscrow: 30, players: 1 })
    expect(dung.byKind).toMatchObject({ mine: 100, landowner: 0 })
    expect(totalsOf([dung]).landowner.tlm).toBe(0)
    expect(playersOf(payouts, 'tlmdung').map((r) => [r.player, r.kinds])).toEqual([['a.wam', ['mine']]])
  })

  it('leaves Arena Domination shards off entirely', () => {
    const s = summarisePools(
      [pay({ pool: 'shrdarenadom', type: 'shards', amount: 5 })],
      [{ pool: 'shrdarenadom', type: 'shards', balance: 133 }],
    )
    expect(s).toEqual([])
  })

  it('keeps pools that paid nothing but hold a balance', () => {
    const s = summarisePools([], [{ pool: 'tlmtourna', type: 'tlm', balance: 5 }])
    expect(s[0]).toMatchObject({ pool: 'tlmtourna', out: 0, balance: 5 })
  })

  it('buckets what was paid out by hour, leaving escrow out', () => {
    const h = hourlyOut(
      [
        pay({ time: 10 }),
        pay({ time: 3_600_001, amount: 5 }),
        pay({ time: 20, kind: 'escrow', pool: 'tlmdung' }),
      ],
      'tlmdung',
      0,
      2 * 3_600_000,
    )
    expect(h).toEqual([10, 5])
  })

  it('names pools briefly, falling back to the game description', () => {
    expect(poolName('tlmdung')).toBe('Dungeon Wins')
    expect(poolName('newpool', new Map([['newpool', 'Something new']]))).toBe('Something new')
    expect(poolName('mystery')).toBe('mystery')
  })
})

describe('players paid', () => {
  it('sums what reached each wallet, per currency, and leaves escrow out', async () => {
    const { recipientsOf } = await import('@/poolstats/rules')
    const rows = recipientsOf([
      pay({ player: 'a.wam', amount: 10, kind: 'mine' }),
      pay({ player: 'a.wam', type: 'shards', pool: 'shrddung', amount: 40, kind: 'mine' }),
      pay({ player: 'a.wam', pool: 'tlmlndowner', source: 'tlmtavern', amount: 5, kind: 'landowner' }),
      pay({ player: 'b.wam', pool: 'tlmquests', amount: 99, kind: 'escrow' }),
      pay({ player: 'b.wam', pool: 'tlmquests', payer: 'quests.ale', amount: 3, kind: 'claim' }),
    ])
    expect(rows.map((r) => r.player)).toEqual(['a.wam', 'b.wam'])
    expect(rows[0]).toMatchObject({ tlm: 15, shards: 40, payments: 3, landownerTlm: 5, pools: 3 })
    expect(rows[1]).toMatchObject({ tlm: 3, payments: 1 })
  })
})

describe('escrow through game contracts', () => {
  it('counts the Candle once, when it pays players', async () => {
    const { attribute, summarisePools, recipientsOf } = await import('@/poolstats/rules')
    const rows = attribute(
      [
        pay({ pool: 'tlmrec', player: 'recovery.ale', amount: 100 }),
        pay({ pool: 'tlmrec', payer: 'recovery.ale', player: 'a.wam', amount: 80 }),
        /* Candle shards have no transfer from a pool, so they count when paid. */
        pay({ pool: 'shrdrec', type: 'shards', payer: 'recovery.ale', player: 'a.wam', amount: 30 }),
      ],
      [],
      [],
    )
    const s = summarisePools(rows)
    const rec = s.find((x) => x.pool === 'tlmrec')!
    expect(rec).toMatchObject({ out: 80, intoEscrow: 100, players: 1 })
    expect(rec.byKind.claim).toBe(80)
    expect(s.find((x) => x.pool === 'shrdrec')!.out).toBe(30)
    expect(recipientsOf(rows).map((r) => r.player)).toEqual(['a.wam'])
  })
})

describe('paid out means received', () => {
  it('holds a landowner TLM cut in escrow until the land is claimed; shards are paid at once', async () => {
    const { classify, leftPool } = await import('@/poolstats/rules')
    const tlmCut = classify(pay({ pool: 'tlmlndowner', source: 'tlmtavern', kind: 'landowner', amount: 10 }))
    const shardCut = classify(pay({ pool: 'shrdlndowner', type: 'shards', kind: 'landowner', amount: 5 }))
    const landClaim = classify(pay({ pool: 'tlmtavern', payer: 'lands.ale', amount: 10 }))
    expect([tlmCut.kind, shardCut.kind, landClaim.kind]).toEqual(['escrow', 'landowner', 'landowner'])
    expect([leftPool(tlmCut), leftPool(shardCut), leftPool(landClaim)]).toEqual([false, true, true])
  })

  it('counts leaderboard rewards and Candle winnings when claimed', async () => {
    const { classify, summarisePools } = await import('@/poolstats/rules')
    const rows = [
      pay({ pool: 'tlmarenalbd', player: 'arena.ale', amount: 100 }),
      pay({ pool: 'tlmarenalb', payer: 'players.ale', amount: 40 }),
      pay({ pool: 'tlmrec', payer: 'recovery.ale', amount: 25 }),
    ].map(classify)
    const s = summarisePools(rows)
    expect(s.find((x) => x.pool === 'tlmarenalbd')).toMatchObject({ out: 0, intoEscrow: 100 })
    expect(s.find((x) => x.pool === 'tlmarenalb')).toMatchObject({ out: 40 })
    expect(s.find((x) => x.pool === 'tlmrec')).toMatchObject({ out: 25 })
  })
})
