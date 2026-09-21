import { describe, expect, it } from 'vitest'
import { claimedThisPeriod, pendingClaim } from '@/dao/chain/period'
import { MSIG_EXECUTED, MSIG_OPEN, type MsigProposal } from '@/dao/chain/proposals'
import type { Dao } from '@/dao/chain/daos'

/*
 * A real Veles claim, msig.worlds / veles / zwzhvjo3xyvp: one action,
 * dao.worlds::claimbudget { dac_id: veles }, authorised by veles.dac@active.
 *
 * Its first four bytes are the expiry, long past. The live-looking copy swaps
 * them for 2100-01-01 so "open" can be tested without waiting for one.
 */
const PACKED =
  '906db366000000000000000000000100004ef1520ea84900b262491fe94c44010000402601aca2da00000000a8ed3232080000000000aca2da00'
const FAR_FUTURE = (4_102_444_800).toString(16).padStart(8, '0').match(/../g)!.reverse().join('')
const LIVE = FAR_FUTURE + PACKED.slice(8)

const veles = { id: 'veles', custodianContract: 'dao.worlds' } as Dao
const naron = { id: 'naron', custodianContract: 'dao.worlds' } as Dao

const proposal = (over: Partial<MsigProposal>): MsigProposal => ({
  id: 1,
  proposal_name: 'zwzhvjo3xyvp',
  proposer: '42lra.wam',
  packed_transaction: LIVE,
  earliest_exec_time: null,
  modified_date: '2026-09-20T17:00:00',
  state: MSIG_OPEN,
  metadata: [{ key: 'title', value: 'Claim the Veles budget' }],
  ...over,
})

describe('pendingClaim', () => {
  it('finds an open claim for this DAO', () => {
    expect(pendingClaim(veles, [proposal({})])?.proposal_name).toBe('zwzhvjo3xyvp')
  })

  it('ignores one that has already run — that is the "already drawn" case', () => {
    expect(pendingClaim(veles, [proposal({ state: MSIG_EXECUTED })])).toBeNull()
  })

  it('ignores one past its expiry, which can never run', () => {
    expect(pendingClaim(veles, [proposal({ packed_transaction: PACKED })])).toBeNull()
  })

  it('ignores a claim for a different DAO', () => {
    expect(pendingClaim(naron, [proposal({})])).toBeNull()
  })

  it('survives a list that has not been read yet', () => {
    expect(pendingClaim(veles, undefined)).toBeNull()
    expect(pendingClaim(veles, null)).toBeNull()
  })
})

describe('claimedThisPeriod', () => {
  const at = (claim: number | null, period: number | null) =>
    claimedThisPeriod({ lastClaimBudget: claim, lastPeriod: period } as Dao)

  it('is drawn when the last claim came after this term began', () => {
    expect(at(Date.parse('2026-09-20T17:29:54Z'), Date.parse('2026-09-17T12:56:52Z'))).toBe(true)
  })

  it('is not drawn when the last claim was last term', () => {
    expect(at(Date.parse('2026-09-10T13:30:53Z'), Date.parse('2026-09-17T12:56:52Z'))).toBe(false)
  })

  it('is not drawn when it never has been', () => {
    expect(at(null, Date.parse('2026-09-17T12:56:52Z'))).toBe(false)
  })
})
