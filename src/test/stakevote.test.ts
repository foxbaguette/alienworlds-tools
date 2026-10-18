import { describe, expect, it } from 'vitest'
import { stakeAndVoteActions, STAKE_CONTRACT, TLM_CONTRACT } from '@/dao/chain/stake'
import type { Dao } from '@/dao/chain/daos'

/*
 * Stake and vote, as one transaction.
 *
 * This one moves somebody's Trilium and casts their vote, so the sequence is
 * pinned here rather than trusted: the wrong order, the wrong contract or the
 * wrong asset would each fail in a way that is only visible after signing.
 */
const dao = {
  id: 'kavian',
  symbol: 'KAV',
  precision: 4,
  tokenContract: 'token.worlds',
  custodianContract: 'dao.worlds',
} as unknown as Dao

const level = { actor: 'voter.wam', permission: 'active' }

const built = stakeAndVoteActions(level, dao, {
  planet: 'kavian',
  tlm: '25.0000 TLM',
  token: '25.0000 KAV',
  seconds: 864_000,
  slate: ['first.wam', 'second.wam'],
})

describe('stake and vote', () => {
  it('is five actions in the order the chain needs', () => {
    expect(built.map((a) => `${a.account}::${a.name}`)).toEqual([
      `${TLM_CONTRACT}::transfer`,
      `${STAKE_CONTRACT}::stake`,
      'token.worlds::stake',
      'token.worlds::staketime',
      'dao.worlds::votecust',
    ])
  })

  it('sends the Trilium to stake.worlds with the memo that converts it', () => {
    expect(built[0].data).toEqual({
      from: 'voter.wam',
      to: STAKE_CONTRACT,
      quantity: '25.0000 TLM',
      memo: 'staking',
    })
  })

  it('converts on the planet, and stakes the DAO token — not the Trilium', () => {
    expect(built[1].data).toEqual({ account: 'voter.wam', planet_name: 'kavian', quantity: '25.0000 TLM' })
    /* The staked leg is the DAO's own token, same number, different symbol.
       Staking "TLM" on token.worlds would be refused. */
    expect(built[2].data).toEqual({ account: 'voter.wam', quantity: '25.0000 KAV' })
  })

  it('sets the delay against the symbol the contract keys it by', () => {
    expect(built[3].data).toEqual({
      account: 'voter.wam',
      unstake_time: 864_000,
      token_symbol: '4,KAV',
    })
  })

  it('casts the slate whole, because votecust replaces rather than adds', () => {
    expect(built[4].data).toEqual({
      voter: 'voter.wam',
      newvotes: ['first.wam', 'second.wam'],
      dac_id: 'kavian',
    })
  })

  it('signs every action as the one account', () => {
    for (const a of built) expect(a.authorization).toEqual([level])
  })
})
