import { describe, expect, it } from 'vitest'
import { canApprove, canCancel, canUnapprove, hasAction } from '@/dao/chain/act'
import { MSIG_CANCELLED, MSIG_OPEN, type MsigProposal } from '@/dao/chain/proposals'
import type { Dao } from '@/dao/chain/daos'

/* The expiry is the first four bytes of the packed transaction, little-endian
   seconds — so a fixture sets its deadline by writing them. */
const packedExpiring = (atMs: number) => {
  const hex = Math.floor(atMs / 1000)
    .toString(16)
    .padStart(8, '0')
  return (hex.match(/../g) as string[]).reverse().join('') + 'ffff'
}

const HOUR = 3600_000
const proposal = (over: Partial<MsigProposal> = {}): MsigProposal => ({
  id: 1,
  proposal_name: 'aaa',
  proposer: 'maker.wam',
  packed_transaction: packedExpiring(Date.now() + HOUR),
  earliest_exec_time: null,
  modified_date: '',
  state: MSIG_OPEN,
  metadata: [],
  approvals: { provided_approvals: [] },
  ...over,
})

const signedBy = (...actors: string[]) => ({
  provided_approvals: actors.map((actor) => ({ level: { actor, permission: 'active' } })),
})

const dao = { id: 'nerix', custodians: ['seat.wam', 'maker.wam'], approvalThreshold: 3 } as unknown as Dao

describe('taking a signature back', () => {
  it('is offered to a custodian who has signed', () => {
    const p = proposal({ approvals: signedBy('seat.wam') })
    expect(canUnapprove(p, dao, 'seat.wam')).toBe(true)
    /* and is the exact mirror of approving */
    expect(canApprove(p, dao, 'seat.wam')).toBe(false)
  })

  it('is not offered to a custodian who has not signed', () => {
    expect(canUnapprove(proposal(), dao, 'seat.wam')).toBe(false)
  })

  it('is not offered to somebody without a seat', () => {
    const p = proposal({ approvals: signedBy('outsider.wam') })
    expect(canUnapprove(p, dao, 'outsider.wam')).toBe(false)
  })

  it('is not offered once it has expired or closed', () => {
    const gone = proposal({ approvals: signedBy('seat.wam'), packed_transaction: packedExpiring(Date.now() - HOUR) })
    expect(canUnapprove(gone, dao, 'seat.wam')).toBe(false)
    const shut = proposal({ approvals: signedBy('seat.wam'), state: MSIG_CANCELLED })
    expect(canUnapprove(shut, dao, 'seat.wam')).toBe(false)
  })
})

describe('calling a proposal off', () => {
  it('is offered to whoever raised it, while it is still open', () => {
    expect(canCancel(proposal(), 'maker.wam')).toBe(true)
  })

  it('is refused to anyone else until it expires', () => {
    /* The contract's own rule: "cannot cancel until expiration". */
    expect(canCancel(proposal(), 'seat.wam')).toBe(false)
  })

  it('is open to anyone once it has expired', () => {
    const gone = proposal({ packed_transaction: packedExpiring(Date.now() - HOUR) })
    expect(canCancel(gone, 'seat.wam')).toBe(true)
  })

  it('is not offered on one already settled', () => {
    expect(canCancel(proposal({ state: MSIG_CANCELLED }), 'maker.wam')).toBe(false)
  })

  it('needs somebody signed in', () => {
    expect(canCancel(proposal(), null)).toBe(false)
    expect(canUnapprove(proposal(), dao, null)).toBe(false)
  })
})

describe('a proposal waiting on me', () => {
  /*
    What "select what needs me" selects, and the overview's batch performs:
    a signature not yet given, or an execution anyone may push.
  */
  it('is not one I have already signed', () => {
    const mine = proposal({ approvals: signedBy('seat.wam') })
    /* There is still something seat.wam could do here — take the signature
       back — but the proposal is not waiting on them, and selecting every
       proposal they had already approved is what that confusion did. */
    expect(canUnapprove(mine, dao, 'seat.wam')).toBe(true)
    expect(hasAction(mine, dao, 'seat.wam', 1)).toBe(false)
  })

  it('is one I hold a seat on and have not signed', () => {
    expect(hasAction(proposal(), dao, 'seat.wam', 0)).toBe(true)
  })

  it('is one that has its signatures, whoever I am', () => {
    const ready = proposal({ approvals: signedBy('seat.wam', 'maker.wam', 'third.wam') })
    /* exec takes no seat, so an outsider can still push it over the line. */
    expect(hasAction(ready, dao, 'outsider.wam', 3)).toBe(true)
  })

  it('is not one I cannot vote on at all', () => {
    expect(hasAction(proposal(), dao, 'outsider.wam', 0)).toBe(false)
  })

  it('is nothing at all when signed out', () => {
    expect(hasAction(proposal(), dao, null, 0)).toBe(false)
  })
})
