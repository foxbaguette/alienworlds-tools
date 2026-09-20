import { useEffect, useState } from 'react'
import { WATCHED, type Dao } from './chain/daos'
import { MSIG_OPEN, approvalCount, approvedBy, isExpired } from './chain/proposals'
import {
  WP_APPROVED,
  WP_FINAPPR,
  WP_FINALIZING,
  WP_PENDING,
  WP_VOTE_FIN_YES,
  WP_VOTE_YES,
  WP_WORKING,
  hasWorkerProposals,
  wpEffectiveState,
  wpPayableAt,
  wpTally,
  type WorkerData,
} from './chain/worker'
import { ensureProposals, ensureWorker, proposalsOf, useProposalCaches, workerOf } from './useProposals'
import { peekDaos, subscribeDaos } from './useDaos'
import { currentSession } from '../wallet/session'
import { useSession } from '../wallet/session'

/**
 * What is waiting on this account, per DAO.
 *
 * Five different things count, and they are all "somebody cannot proceed until
 * you act" rather than "something is happening here":
 *
 *   1. A council proposal raised by a watched account that you hold a seat for
 *      and have not signed.
 *   2. A council proposal raised by a watched account that has its signatures
 *      and only needs running.
 *   3. A worker proposal in a round you can vote in and have not.
 *   4. A worker proposal of YOUR OWN that you can push to its next stage.
 *   5. A worker proposal that has cleared both its vote and its hold, and only
 *      needs finalizing.
 *
 * The council ones are narrowed to proposals raised by the watched accounts on
 * purpose. Every council carries hundreds of proposals and most are nothing to
 * do with this account; the watchlist is what makes the number a to-do list
 * rather than a census.
 */
export function todoFor(dao: Dao, actor: string | null): number {
  if (!actor) return 0
  let n = 0

  const seated = dao.custodians.includes(actor)

  for (const p of proposalsOf(dao.id) ?? []) {
    if (p.state !== MSIG_OPEN || isExpired(p)) continue
    if (!WATCHED.has(p.proposer)) continue
    if (seated && !approvedBy(p, actor)) n++
    else if (approvalCount(p) >= dao.approvalThreshold) n++
  }

  if (hasWorkerProposals(dao)) {
    const wp = workerOf(dao.id)
    if (wp) n += workerTodo(dao, wp, actor, seated)
  }

  return n
}

function workerTodo(dao: Dao, wp: WorkerData, actor: string, seated: boolean): number {
  let n = 0
  const now = Date.now()

  for (const p of wp.props) {
    const state = wpEffectiveState(p)
    const mine = p.proposer === actor
    const voted = wp.votes.find((v) => v.proposal_id === p.proposal_id && v.voter === actor)?.vote ?? null
    const tally = wpTally(dao, p, wp)

    /* A vote you can cast and have not. The two rounds take different vote
       names, so "already voted" has to be asked about the round in hand. */
    if (seated && (state === WP_PENDING || state === WP_APPROVED) && voted !== WP_VOTE_YES) n++
    if (seated && (state === WP_FINALIZING || state === WP_FINAPPR) && voted !== WP_VOTE_FIN_YES) n++

    /* Your own proposal, cleared to move. startwork also wants the arbiter's
       agreement, so an approved proposal without it is not yours to push. */
    if (mine && (state === WP_PENDING || state === WP_APPROVED) && tally.yes >= tally.need && p.arbiter_agreed) n++
    if (mine && state === WP_WORKING) n++

    /* Ready to pay: enough finalize votes AND past the contract's hold, which
       runs from creation rather than from completion. Anyone may finalize, so
       this counts for everyone, not just the worker. */
    if ((state === WP_FINALIZING || state === WP_FINAPPR) && tally.yes >= tally.need && now >= wpPayableAt(p, wp)) n++
  }

  return n
}

/**
 * Loads what the counts need, once, when there is an account to count for.
 *
 * The sidebar itself stays passive — see useDaoNav — but something has to ask,
 * or the badges would only appear after a visit to All proposals. This is that
 * something: signed in, it warms the same caches every other view reads from,
 * so nothing is fetched twice.
 */
let prefetchedFor: string | null = null

export function useTodoCounts(): Map<string, number> {
  const { actor } = useSession()
  const version = useProposalCaches()
  const [, bump] = useState(0)

  useEffect(() => subscribeDaos(() => bump((n) => n + 1)), [])

  useEffect(() => {
    if (!actor) {
      prefetchedFor = null
      return
    }
    const daos = peekDaos()
    if (!daos.length || prefetchedFor === actor) return
    prefetchedFor = actor
    for (const dao of daos) {
      void ensureProposals(dao.id)
      if (hasWorkerProposals(dao)) void ensureWorker(dao.id)
    }
  }, [actor, peekDaos().length])

  const counts = new Map<string, number>()
  if (!actor) return counts
  /* `version` is read so this recomputes as caches fill. */
  void version
  for (const dao of peekDaos()) {
    const n = todoFor(dao, actor)
    if (n > 0) counts.set(dao.id, n)
  }
  return counts
}

/** For callers outside React that just want the number. */
export const todoCount = (dao: Dao) => todoFor(dao, currentSession() ? String(currentSession()!.actor) : null)
