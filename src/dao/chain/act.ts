import type { Session } from '@wharfkit/session'
import type { Dao } from './daos'
import { MSIG_CONTRACT, MSIG_OPEN, approvedBy, isExpired, type MsigProposal } from './proposals'

/**
 * Signing against the council multisigs.
 *
 * `msig.worlds` approves against a permission LEVEL, which is the signer's own —
 * the same one the transaction is authorised with — and every action is scoped
 * by dac_id, so one transaction can carry approvals across several councils.
 */

/** Whether this account can add a signature to this proposal. */
export function canApprove(p: MsigProposal, dao: Dao, actor: string | null): boolean {
  if (!actor) return false
  /* Approving needs a seat on THAT council; a signature from anyone else is
     not one the threshold counts. */
  if (!dao.custodians.includes(actor)) return false
  if (p.state !== MSIG_OPEN || isExpired(p)) return false
  /* An approval is recorded per account, so signing twice is wasted. */
  return !approvedBy(p, actor)
}

/**
 * Whether this proposal can be run now.
 *
 * `exec` takes no seat — anyone may push a proposal that has already collected
 * its signatures over the line — so this asks only about the proposal, not the
 * signer.
 */
export function canExecute(p: MsigProposal, dao: Dao, approvals: number): boolean {
  return p.state === MSIG_OPEN && !isExpired(p) && approvals >= dao.approvalThreshold
}

/** Anything this account could usefully do here, which is what a row is dimmed on. */
export function hasAction(p: MsigProposal, dao: Dao, actor: string | null, approvals: number): boolean {
  return canApprove(p, dao, actor) || canExecute(p, dao, approvals)
}

export interface ChainAction {
  account: string
  name: string
  authorization: { actor: string; permission: string }[]
  data: Record<string, unknown>
}

function level(session: Session) {
  return {
    actor: String(session.actor),
    permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
  }
}

export const approveAction = (session: Session, dao: Dao, p: MsigProposal): ChainAction => ({
  account: MSIG_CONTRACT,
  name: 'approve',
  authorization: [level(session)],
  data: { proposal_name: p.proposal_name, level: level(session), dac_id: dao.id },
})

export const execAction = (session: Session, dao: Dao, p: MsigProposal): ChainAction => ({
  account: MSIG_CONTRACT,
  name: 'exec',
  authorization: [level(session)],
  data: { proposal_name: p.proposal_name, executer: String(session.actor), dac_id: dao.id },
})

/** A wallet cancellation is a decision, not a failure. */
export const isCancel = (err: unknown) => {
  const m = err instanceof Error ? err.message : String(err)
  return /cancel|closed|abort|declin|reject/i.test(m)
}

/** The part of a chain error worth putting in front of a reader. */
export function readableError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  /* Antelope asserts read `assertion failure with message: ERR::SOME_CODE::the
     actual sentence`. The sentence is the only part anyone can act on. */
  const assertion = /ERR::[A-Z_0-9]+::(.+?)(?:\n|$)/.exec(m)
  if (assertion) return assertion[1].trim()
  const bare = /assertion failure with message: (.+?)(?:\n|$)/.exec(m)
  if (bare) return bare[1].trim()
  return m.length > 200 ? `${m.slice(0, 200)}…` : m
}
