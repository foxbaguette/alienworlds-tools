import { describe, expect, it } from 'vitest'
import {
  WP_APPROVED,
  WP_FINAPPR,
  WP_PENDING,
  WP_WORKING,
  workerAction,
  workerButtons,
  type WorkerData,
  type WorkerProposal,
} from '@/dao/chain/worker'
import type { Dao } from '@/dao/chain/daos'

/*
 * What a row offers, and to whom.
 *
 * Worth testing rather than clicking, because the gating is the whole feature:
 * a button that is hidden when it should be live is indistinguishable from the
 * page being broken, and no signed-in path can be exercised here.
 */

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 19)
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 19)

const dao = {
  id: 'eyekeunn',
  title: 'Eyeke Union',
  owner: 'eye.unn.dac',
  group: 'union',
  custodians: ['seat1.wam', 'seat2.wam', 'seat3.wam'],
} as unknown as Dao

const proposal = (over: Partial<WorkerProposal> = {}): WorkerProposal => ({
  proposal_id: 'abc123',
  proposer: 'worker.wam',
  arbiter: 'arb.wam',
  title: 'A job',
  summary: 'Doing a job',
  content_hash: '',
  proposal_pay: { quantity: '100.0000 TLM', contract: 'alien.worlds' },
  arbiter_pay: { quantity: '10.0000 TLM', contract: 'alien.worlds' },
  arbiter_agreed: 1,
  state: WP_PENDING,
  expiry: ahead(10),
  created_at: ago(30),
  job_duration: 7 * 86_400,
  category: 0,
  ...over,
})

const data = (over: Partial<WorkerData> = {}): WorkerData => ({
  props: [],
  votes: [],
  config: {
    proposal_threshold: 3,
    finalize_threshold: 2,
    approval_duration: 2_592_000,
    min_proposal_duration: 604_800,
    proposal_fee: null,
  },
  arbiters: ['arb.wam'],
  receivers: new Set(['worker.wam']),
  actor: 'seat1.wam',
  member: true,
  agreedTerms: 3,
  latestTerms: 3,
  deposit: null,
  ...over,
})

const labels = (bs: { label: string }[]) => bs.map((b) => b.label)
const find = (bs: ReturnType<typeof workerButtons>, act: string) => bs.find((b) => b.act === act)

describe('what a worker proposal offers', () => {
  it('offers nothing to nobody', () => {
    expect(workerButtons(dao, proposal(), data(), null)).toEqual([])
  })

  it('offers a custodian the approval vote while the vote is open', () => {
    const bs = workerButtons(dao, proposal(), data(), 'seat1.wam')
    expect(labels(bs)).toEqual(['Approve', 'Deny'])
    expect(find(bs, 'approve')!.blocked).toBeNull()
  })

  it('offers nothing to someone with no part in it', () => {
    expect(workerButtons(dao, proposal(), data(), 'nobody.wam')).toEqual([])
  })

  it('marks a vote already cast as spent rather than hiding it', () => {
    const wp = data({ votes: [{ voter: 'seat1.wam', proposal_id: 'abc123', vote: 'propapprove', category_id: null, delegatee: null }] })
    const approve = find(workerButtons(dao, proposal(), wp, 'seat1.wam'), 'approve')!
    expect(approve.done).toBe(true)
    expect(approve.blocked).toMatch(/already approved/)
  })

  it('blocks everything when the member terms are out of date', () => {
    const wp = data({ member: false, agreedTerms: 2, latestTerms: 3 })
    for (const b of workerButtons(dao, proposal(), wp, 'seat1.wam')) {
      expect(b.blocked).toMatch(/member terms/)
    }
  })

  it('lets the worker start only once the votes and the arbiter are in', () => {
    const short = find(workerButtons(dao, proposal(), data(), 'worker.wam'), 'startwork')!
    expect(short.blocked).toMatch(/Needs 3 approvals and has 0/)

    const votes = ['seat1.wam', 'seat2.wam', 'seat3.wam'].map((voter) => ({
      voter,
      proposal_id: 'abc123',
      vote: 'propapprove',
      category_id: null,
      delegatee: null,
    }))
    const ready = find(workerButtons(dao, proposal({ state: WP_APPROVED }), data({ votes }), 'worker.wam'), 'startwork')!
    expect(ready.blocked).toBeNull()

    const noArbiter = find(
      workerButtons(dao, proposal({ state: WP_APPROVED, arbiter_agreed: 0 }), data({ votes }), 'worker.wam'),
      'startwork',
    )!
    expect(noArbiter.blocked).toMatch(/has not agreed to arbitrate/)
  })

  it('offers the arbiter their agreement, once', () => {
    expect(labels(workerButtons(dao, proposal({ arbiter_agreed: 0 }), data(), 'arb.wam'))).toEqual([
      'Agree to arbitrate',
    ])
    expect(workerButtons(dao, proposal({ arbiter_agreed: 1 }), data(), 'arb.wam')).toEqual([])
  })

  it('offers completework to the worker alone, while the job runs', () => {
    expect(labels(workerButtons(dao, proposal({ state: WP_WORKING }), data(), 'worker.wam'))).toEqual([
      'Mark complete',
    ])
    expect(workerButtons(dao, proposal({ state: WP_WORKING }), data(), 'seat1.wam')).toEqual([])
  })

  /* finalize carries no require_auth, so it is offered to everyone signed in. */
  it('offers finalize to anyone once it has its votes and has cleared the hold', () => {
    const votes = ['seat1.wam', 'seat2.wam'].map((voter) => ({
      voter,
      proposal_id: 'abc123',
      vote: 'finalapprove',
      category_id: null,
      delegatee: null,
    }))
    const p = proposal({ state: WP_FINAPPR, created_at: ago(30) })
    expect(find(workerButtons(dao, p, data({ votes }), 'nobody.wam'), 'finalize')!.blocked).toBeNull()

    const young = proposal({ state: WP_FINAPPR, created_at: ago(1) })
    expect(find(workerButtons(dao, young, data({ votes }), 'nobody.wam'), 'finalize')!.blocked).toMatch(/holds every/)

    const unvoted = find(workerButtons(dao, p, data(), 'nobody.wam'), 'finalize')!
    expect(unvoted.blocked).toMatch(/Needs 2 approvals to finalize and has 0/)
  })

  it('treats a passed expiry as expired, however the row reads', () => {
    const stale = proposal({ expiry: ago(1) })
    expect(workerButtons(dao, stale, data(), 'seat1.wam')).toEqual([])
  })
})

describe('the actions behind the buttons', () => {
  const level = { actor: 'seat1.wam', permission: 'active' }

  /*
   * The two vote actions carry a SECOND authorization — the DAO at its `one`
   * permission — which nothing in the published contract source explains but
   * every voteprop on chain has. Getting this wrong is the bug that made
   * approving fail with "missing the permission of ner.unn".
   */
  it('signs a vote as the custodian AND the DAO at one', () => {
    const a = workerAction(level, dao, proposal(), 'approve')
    expect(a.name).toBe('voteprop')
    expect(a.authorization).toEqual([level, { actor: 'eye.unn.dac', permission: 'one' }])
    expect(a.data).toMatchObject({ custodian: 'seat1.wam', vote: 'approve', dac_id: 'eyekeunn' })
  })

  it('signs the finalize-round vote the same way, on the other action', () => {
    const a = workerAction(level, dao, proposal(), 'findeny')
    expect(a.name).toBe('votepropfin')
    expect(a.data).toMatchObject({ vote: 'deny' })
    expect(a.authorization).toHaveLength(2)
  })

  it('signs everything else as the actor alone', () => {
    for (const act of ['arbagree', 'startwork', 'completework', 'finalize'] as const) {
      expect(workerAction(level, dao, proposal(), act).authorization).toEqual([level])
    }
  })
})
