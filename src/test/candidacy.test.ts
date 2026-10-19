import { describe, expect, it } from 'vitest'
import { candidacyOf, withdrawBlocker, withdrawCandidacyAction } from '@/dao/chain/candidacy'
import type { Dao } from '@/dao/chain/daos'

/*
 * Stepping down as a candidate.
 *
 * The two states the contract tells apart look the same from outside — a
 * withdrawn candidate keeps their row forever, so "registered" is not
 * "standing" — and getting them the wrong way round means a transaction that
 * is refused after it has been signed and paid for.
 */
const daoWith = (standing: [string, boolean][], seated: string[] = []) =>
  ({
    id: 'kavian',
    title: 'Kavian',
    custodianContract: 'dao.worlds',
    standing: new Map(standing),
    custodians: seated,
  }) as unknown as Dao

const level = { actor: 'hopeful.wam', permission: 'active' }

describe('candidacy', () => {
  it('builds withdrawcane on the DAO’s own custodian contract', () => {
    const a = withdrawCandidacyAction(level, daoWith([['hopeful.wam', true]]))
    expect(a).toEqual({
      account: 'dao.worlds',
      name: 'withdrawcane',
      authorization: [level],
      data: { cand: 'hopeful.wam', dac_id: 'kavian' },
    })
  })

  it('reads a standing candidate', () => {
    expect(candidacyOf(daoWith([['hopeful.wam', true]]), 'hopeful.wam')).toEqual({
      registered: true,
      standing: true,
      seated: false,
    })
  })

  it('tells a withdrawn candidate from one who never stood', () => {
    const dao = daoWith([
      ['hopeful.wam', false],
      ['other.wam', true],
    ])
    expect(candidacyOf(dao, 'hopeful.wam')).toMatchObject({ registered: true, standing: false })
    expect(candidacyOf(dao, 'nobody.wam')).toMatchObject({ registered: false, standing: false })
  })

  it('notices a seat, which withdrawing does not give up', () => {
    const dao = daoWith([['hopeful.wam', true]], ['hopeful.wam'])
    expect(candidacyOf(dao, 'hopeful.wam')?.seated).toBe(true)
  })

  /* An unread list is a question that went unanswered, not a no. */
  it('answers nothing when the candidate list was not read', () => {
    expect(candidacyOf(daoWith([]), 'hopeful.wam')).toBeNull()
    expect(candidacyOf(daoWith([['hopeful.wam', true]]), null)).toBeNull()
  })

  it('refuses a withdrawal the contract would refuse', () => {
    expect(withdrawBlocker(candidacyOf(daoWith([['hopeful.wam', true]]), 'hopeful.wam'))).toBeNull()
    expect(withdrawBlocker(candidacyOf(daoWith([['hopeful.wam', false]]), 'hopeful.wam'))).toMatch(
      /already withdrawn/,
    )
    expect(withdrawBlocker(candidacyOf(daoWith([['other.wam', true]]), 'hopeful.wam'))).toMatch(
      /never stood/,
    )
  })

  /* And does not invent a verdict where there was no answer to read. */
  it('passes no judgement on an unread list', () => {
    expect(withdrawBlocker(null)).toBeNull()
  })
})
