import { describe, expect, it } from 'vitest'
import { candidacyOf, nominateAction, nominateBlocker, noPay } from '@/dao/chain/candidacy'
import type { Dao } from '@/dao/chain/daos'

/*
 * Standing for a council.
 *
 * Four separate things the contract checks, and each one fires after signing
 * if it is not checked here — costing the signer their CPU to be told
 * something the chain would have said for free beforehand.
 */
const syndicate = {
  id: 'kavian',
  title: 'Kavian',
  custodianContract: 'dao.worlds',
  standing: new Map<string, boolean>([['other.wam', true]]),
  custodians: [],
  minStake: '5000.0000 KAV',
  minStakeDelay: 1,
  maxPay: '0.0000 TLM',
  needsWhitelist: false,
} as unknown as Dao

const union = { ...syndicate, id: 'kavianunn', title: 'Kavian Union', needsWhitelist: true } as Dao

const level = { actor: 'hopeful.wam', permission: 'active' }
const mine = (dao: Dao) => candidacyOf(dao, 'hopeful.wam')

describe('standing as a candidate', () => {
  it('builds nominatecane on the custodian contract', () => {
    expect(nominateAction(level, syndicate, noPay(syndicate))).toEqual({
      account: 'dao.worlds',
      name: 'nominatecane',
      authorization: [level],
      data: { cand: 'hopeful.wam', requestedpay: '0.0000 TLM', dac_id: 'kavian' },
    })
  })

  /* requested_pay_max is zero everywhere, and it is denominated in the asset
     the DAO caps it in rather than in the DAO's own token. */
  it('asks for nothing, in the asset the cap is set in', () => {
    expect(noPay(syndicate)).toBe('0.0000 TLM')
    expect(noPay({ ...syndicate, maxPay: '0.0000 WAX' } as Dao)).toBe('0.0000 WAX')
    expect(noPay({ ...syndicate, maxPay: null } as Dao)).toBe('0.0000 TLM')
  })

  it('lets a staked account stand on a syndicate', () => {
    expect(nominateBlocker(syndicate, mine(syndicate), true, 5000, 172_800)).toBeNull()
  })

  it('refuses an account short of the lockup', () => {
    expect(nominateBlocker(syndicate, mine(syndicate), true, 4999, 172_800)).toMatch(/5000.0000 KAV/)
  })

  it('refuses an unstake delay under the floor', () => {
    expect(nominateBlocker({ ...syndicate, minStakeDelay: 86_400 } as Dao, mine(syndicate), true, 5000, 60)).toMatch(
      /unstake delay/i,
    )
  })

  it('refuses an account already standing', () => {
    const dao = { ...syndicate, standing: new Map([['hopeful.wam', true]]) } as Dao
    expect(nominateBlocker(dao, candidacyOf(dao, 'hopeful.wam'), true, 5000, 172_800)).toMatch(/already standing/)
  })

  /* A withdrawn candidate keeps their row, and may stand again. */
  it('lets a withdrawn candidate stand again', () => {
    const dao = { ...syndicate, standing: new Map([['hopeful.wam', false]]) } as Dao
    expect(nominateBlocker(dao, candidacyOf(dao, 'hopeful.wam'), true, 5000, 172_800)).toBeNull()
  })

  /* Every union carries a whitelist; no syndicate does. */
  it('refuses a union to an account that is not whitelisted', () => {
    expect(nominateBlocker(union, mine(union), false, 5000, 172_800)).toMatch(/whitelist/)
  })

  it('allows a whitelisted account into a union', () => {
    expect(nominateBlocker(union, mine(union), true, 5000, 172_800)).toBeNull()
  })

  /* An unread whitelist is not a refusal — the same rule as everywhere else
     here: a node answering emptily must not read as a verdict. */
  it('passes no judgement while the whitelist is unread', () => {
    expect(nominateBlocker(union, mine(union), null, 5000, 172_800)).toBeNull()
  })

  /* A DAO that names no lockup cannot be held to one. */
  it('asks for no stake where the DAO sets none', () => {
    const dao = { ...syndicate, minStake: null } as Dao
    expect(nominateBlocker(dao, mine(dao), true, 0, 172_800)).toBeNull()
  })
})
