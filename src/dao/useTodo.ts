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
  wpStranded,
  wpTally,
  type WorkerData,
} from './chain/worker'
import { msigTitle } from './chain/proposals'
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
 * A proposal counts ONCE however many of those it satisfies. One proposal is
 * one thing to go and look at, and a list saying "3" for two proposals is a
 * list nobody can reconcile with what they see.
 *
 * The council ones are narrowed to proposals raised by the watched accounts on
 * purpose. Every council carries hundreds of proposals and most are nothing to
 * do with this account; the watchlist is what makes the number a to-do list
 * rather than a census.
 *
 * Every count comes with the line that produced it. A bare number on a menu
 * entry is not answerable — "why is there a 3 next to Eyeke Union?" has to be
 * answerable without opening every tab, and a council whose own proposals are
 * all settled can still carry three WORKER proposals waiting on a vote.
 */
export interface Todo {
  n: number
  /** One line per thing counted, in the order they were counted. */
  why: string[]
  /**
   * The same count split by the tab it lives on. A council whose proposals
   * are all settled can still owe a worker vote, and "1 thing waiting" on a
   * Proposals tab showing nothing open reads as a mistake unless the page can
   * point at the tab that has it.
   */
  byTab: { proposals: number; worker: number }
}

export const NO_TODO: Todo = { n: 0, why: [], byTab: { proposals: 0, worker: 0 } }

export function todoFor(dao: Dao, actor: string | null): Todo {
  if (!actor) return NO_TODO
  const why: string[] = []

  const seated = dao.custodians.includes(actor)

  for (const p of proposalsOf(dao.id) ?? []) {
    if (p.state !== MSIG_OPEN || isExpired(p)) continue
    if (!WATCHED.has(p.proposer)) continue
    if (seated && !approvedBy(p, actor)) why.push(`Approve ${quote(msigTitle(p))} — raised by ${p.proposer}`)
    else if (approvalCount(p) >= dao.approvalThreshold)
      why.push(`Execute ${quote(msigTitle(p))} — it has its signatures`)
  }

  const proposals = why.length
  if (hasWorkerProposals(dao)) {
    const wp = workerOf(dao.id)
    if (wp) why.push(...workerTodo(dao, wp, actor, seated))
  }

  return { n: why.length, why, byTab: { proposals, worker: why.length - proposals } }
}

/** Titles go in the reasons, and an untitled proposal should not read oddly. */
const quote = (title: string) => `“${title}”`

function workerTodo(dao: Dao, wp: WorkerData, actor: string, seated: boolean): string[] {
  const why: string[] = []
  const now = Date.now()

  for (const p of wp.props) {
    const state = wpEffectiveState(p)
    const mine = p.proposer === actor
    const voted = wp.votes.find((v) => v.proposal_id === p.proposal_id && v.voter === actor)?.vote ?? null
    const tally = wpTally(dao, p, wp)

    const what = `worker proposal ${quote(p.title || p.proposal_id)}`

    /* Its pay has gone back to the treasury and finalize would be refused, so
       there is nothing here to do — voting on it would change nothing. */
    if (wpStranded(p, wp)) continue

    /* Whatever this proposal most needs, said once. The order is by how far it
       moves things: finishing beats starting, and starting beats voting. */
    const lines: string[] = []

    /* Ready to pay: enough finalize votes AND past the contract's hold, which
       runs from creation rather than from completion. Anyone may finalize, so
       this counts for everyone, not just the worker. */
    if ((state === WP_FINALIZING || state === WP_FINAPPR) && tally.yes >= tally.need && now >= wpPayableAt(p, wp))
      lines.push(`Finalize ${what} — it has its votes and has cleared its hold`)

    /* Your own proposal, cleared to move. startwork also wants the arbiter's
       agreement, so an approved proposal without it is not yours to push. */
    if (mine && state === WP_WORKING) lines.push(`Mark your ${what} complete`)
    if (mine && (state === WP_PENDING || state === WP_APPROVED) && tally.yes >= tally.need && p.arbiter_agreed)
      lines.push(`Start work on your ${what}`)

    /* A vote you can cast and have not. The two rounds take different vote
       names, so "already voted" has to be asked about the round in hand. */
    if (seated && (state === WP_PENDING || state === WP_APPROVED) && voted !== WP_VOTE_YES)
      lines.push(`Vote on ${what}`)
    if (seated && (state === WP_FINALIZING || state === WP_FINAPPR) && voted !== WP_VOTE_FIN_YES)
      lines.push(`Vote on finalizing ${what}`)

    if (lines.length) why.push(lines[0])
  }

  return why
}

/**
 * Loads what the counts need, once, when there is an account to count for.
 *
 * The sidebar itself stays passive — see useDaoNav — but something has to ask,
 * or the badges would only appear after a visit to All proposals. This is that
 * something: signed in, it warms the same caches every other view reads from,
 * so nothing is fetched twice.
 */
const asked = new Set<string>()

export function useTodoCounts(): Map<string, Todo> {
  const { actor } = useSession()
  const version = useProposalCaches()
  const [, bump] = useState(0)

  useEffect(() => subscribeDaos(() => bump((n) => n + 1)), [])

  /*
   * Runs on every render rather than on a dependency list, guarded by what it
   * has already asked for. The list it works from grows — the directory lands
   * after the first paint, and the session lands after that — and a dependency
   * list that misses one of those arrivals leaves the badges blank until
   * something else happens to re-read a council. Which looked exactly like
   * "the numbers only appear once I click the union".
   *
   * The Set makes re-running free: a DAO already asked about is skipped, and
   * ensureProposals is itself deduplicated.
   */
  useEffect(() => {
    if (!actor) return
    for (const dao of peekDaos()) {
      const key = `${actor}:${dao.id}`
      if (asked.has(key)) continue
      asked.add(key)
      void ensureProposals(dao.id)
      if (hasWorkerProposals(dao)) void ensureWorker(dao.id)
    }
  })

  const counts = new Map<string, Todo>()
  if (!actor) return counts
  /* `version` is read so this recomputes as caches fill. */
  void version
  for (const dao of peekDaos()) {
    const todo = todoFor(dao, actor)
    if (todo.n > 0) counts.set(dao.id, todo)
  }
  return counts
}

/** For callers outside React, which have no session in hand. */
export const todoNow = (dao: Dao) => todoFor(dao, currentSession() ? String(currentSession()!.actor) : null)
