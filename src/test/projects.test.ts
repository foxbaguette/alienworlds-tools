import { describe, expect, it } from 'vitest'
import { projectByKey } from '@/projects/defs'
import { firstSeenByDay, isPlayerWallet, metricOf, summariseProjectDay, summariseProjectRange } from '@/projects/rules'

const mc = projectByKey('mc')!
const naron = projectByKey('naron')!
const pd = projectByKey('pd')!

describe('isPlayerWallet', () => {
  it('leaves out the project, game contracts and system accounts', () => {
    expect(isPlayerWallet('abcde.wam', mc)).toBe(true)
    expect(isPlayerWallet('tools.mc', mc)).toBe(false)
    expect(isPlayerWallet('players.ale', mc)).toBe(false)
    expect(isPlayerWallet('m.federation', mc)).toBe(false)
    expect(isPlayerWallet('magordefense', pd)).toBe(false)
    expect(isPlayerWallet('', mc)).toBe(false)
  })
})

describe('summariseProjectDay', () => {
  it('counts signers as active, and the miner a mine names', () => {
    const d = summariseProjectDay(
      mc,
      '2026-09-01',
      [
        { name: 'notify.mc::logmine', signers: ['m.federation', 'miner1.wam'] },
        { name: 'notify.mc::logmine', signers: ['m.federation', 'miner1.wam'] },
        { name: 'tools.mc::renttools', signers: ['renter.wam'] },
        { name: 'cpu.mc::paycpu', signers: ['cpu.mc'] },
      ],
      [],
    )
    expect(d.active).toBe(2)
    expect(d.wallets).toEqual(['miner1.wam', 'renter.wam'])
    expect(metricOf(d, ['notify.mc::logmine'])).toBe(2)
    expect(metricOf(d, ['tools.mc::renttools', 'nope::x'])).toBe(1)
  })

  it('counts only reward memos for Mission Control, but always Shards', () => {
    const d = summariseProjectDay(mc, '2026-09-01', [], [
      { to: 'a.wam', symbol: 'TLM', amount: 10, memo: 'Week 12 claimed' },
      { to: 'b.wam', symbol: 'TLM', amount: 5, memo: 'Tool Loaning Earnings' },
      { to: 'c.wam', symbol: 'TLM', amount: 99, memo: 'Tool returned' },
      { to: 'd.wam', symbol: 'WAX', amount: 1, memo: 'powerup fee' },
      { to: 'a.wam', symbol: 'Shards', amount: 30, memo: '' },
      { to: 'e.wam', symbol: 'NFT', amount: 0, memo: 'loan', nfts: 3 },
      { to: 'game.mc', symbol: 'TLM', amount: 1000, memo: 'Week 12 claimed' },
    ])
    expect(d.paid).toEqual({ TLM: 15, Shards: 30 })
    expect(d.paidTo).toEqual({ TLM: 2, Shards: 1 })
    expect(d.nfts).toBe(0)
    expect(d.categories).toEqual({ 'weekly|TLM': { count: 1, amount: 10 }, 'loaning|TLM': { count: 1, amount: 5 } })
  })

  it('counts recipients as active for Naron, with its NFTs', () => {
    const d = summariseProjectDay(naron, '2026-09-01', [], [
      { to: 'a.wam', symbol: 'NAR', amount: 3, memo: 'Mining Reward for mining at 10:00 UTC on Planet Naron' },
      { to: 'b.wam', symbol: 'NAR', amount: 2, memo: 'Accumulator Game 12 Round 3 reward' },
      { to: 'c.wam', symbol: 'NFT', amount: 0, memo: 'NFT Reward for mining', nfts: 2 },
      { to: 'd.wam', symbol: 'TLM', amount: 20_000, memo: '' },
    ])
    expect(d.active).toBe(3)
    expect(d.paid).toEqual({ NAR: 5 })
    expect(d.nfts).toBe(2)
    expect(d.categories['mining|NAR']).toEqual({ count: 1, amount: 3 })
    expect(d.categories['accumulator|NAR']).toEqual({ count: 1, amount: 2 })
  })
})

describe('summariseProjectRange', () => {
  it('counts each wallet once over the range', () => {
    const day = (date: string, wallets: string[], tlm: number) => ({
      date,
      active: wallets.length,
      wallets,
      actions: {},
      paid: { TLM: tlm },
      paidTo: {},
      nfts: 1,
      categories: {},
    })
    const r = summariseProjectRange([day('2026-09-01', ['a', 'b'], 1), day('2026-09-02', ['b', 'c', 'd'], 2)])
    expect(r.uniqueActive).toBe(4)
    expect(r.avgDaily).toBe(2.5)
    expect(r.peak).toEqual({ date: '2026-09-02', active: 3 })
    expect(r.paid).toEqual({ TLM: 3 })
    expect(r.nfts).toBe(2)
  })
})

describe('firstSeenByDay', () => {
  it('counts each wallet on the first day it appears', () => {
    const day = (date: string, wallets: string[]) => ({
      date,
      active: wallets.length,
      wallets,
      actions: {},
      paid: {},
      paidTo: {},
      nfts: 0,
      categories: {},
    })
    expect(firstSeenByDay([day('2026-09-02', ['b', 'c']), day('2026-09-01', ['a', 'b'])])).toEqual({
      '2026-09-01': 2,
      '2026-09-02': 1,
    })
  })
})

describe('entry fees', () => {
  it('records what players paid in, for a project that takes them', () => {
    const d = summariseProjectDay(
      pd,
      '2026-09-16',
      [],
      [{ to: 'a.wam', symbol: 'TLM', amount: 80, memo: 'Mission division reward' }],
      [
        { from: 'a.wam', symbol: 'TLM', amount: 50, memo: 'entry:24' },
        { from: 'magordefense', symbol: 'TLM', amount: 1000, memo: 'reward' },
        { from: 'b.wam', symbol: 'TLM', amount: 5, memo: 'thanks' },
      ],
    )
    expect(d.paid).toEqual({ TLM: 80 })
    expect(d.stakes).toEqual({ TLM: 50 })
  })

  it('leaves them out for a project that takes none', () => {
    expect(summariseProjectDay(naron, '2026-09-16', [], []).stakes).toBeUndefined()
  })
})
