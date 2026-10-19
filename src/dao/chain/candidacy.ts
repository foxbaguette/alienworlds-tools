import type { ChainAction } from './act'
import type { Dao } from './daos'

type Level = ChainAction['authorization'][number]

/**
 * Standing for a council, and stepping back down.
 *
 * A candidate row lives on the DAO's custodian contract, scoped by dac_id, and
 * once written it is never removed — withdrawing only clears `is_active`. So
 * "registered" and "standing" are two different questions, and every council
 * carries far more of the former than the latter: eighty-five rows on Nerix
 * against nineteen people actually asking for a seat.
 *
 * The chain calls the withdrawal `withdrawcane`, and its own error message is
 * where most people meet it — `stakeobsv` refuses to let a registered
 * candidate unstake at all:
 *
 *   ERR::CANNOT_UNSTAKE_REGISTERED::Cannot unstake because you are
 *   registered as a candidate, use withdrawcane to unregister.
 *
 * Read off dao.worlds's deployed code, the withdrawal is refused two ways:
 *
 *   ERR::UNSTAKE_CAND_NOT_REGISTERED::Candidate is not already registered.
 *   ERR::REMOVECANDIDATE_CANDIDATE_NOT_ACTIVE::Candidate is not active.
 *
 * Both are checked here rather than discovered by a wallet popup, because a
 * failed transaction costs the signer their CPU and tells them nothing.
 */
export interface Candidacy {
  /** A row exists — true of anyone who has ever stood, withdrawn or not. */
  registered: boolean
  /** Still standing: what `newperiod` seats and what `votecust` accepts. */
  standing: boolean
  /** Holding a seat right now, which withdrawing does not give up. */
  seated: boolean
}

/**
 * How one account stands in one DAO, or null where it cannot be told.
 *
 * Null, not "not a candidate": the candidate list is read with the rest of the
 * DAO and a node under load answers an empty page rather than an error, so an
 * empty list is a question that went unanswered. Saying "you are not standing
 * here" on the strength of it would be inventing an answer — the same mistake
 * `voteBlocker` is careful not to make.
 */
export function candidacyOf(dao: Dao, actor: string | null): Candidacy | null {
  if (!actor || !dao.standing.size) return null
  return {
    registered: dao.standing.has(actor),
    standing: !!dao.standing.get(actor),
    seated: dao.custodians.includes(actor),
  }
}

/** Why withdrawing would be refused, as the contract would refuse it, or null. */
export function withdrawBlocker(of: Candidacy | null): string | null {
  if (!of) return null // not read; do not invent a verdict
  if (!of.registered) return 'This account has never stood for this council.'
  if (!of.standing) return 'This account has already withdrawn — there is nothing to unregister.'
  return null
}

/**
 * Stepping down as a candidate.
 *
 * `cand` rather than the authorising actor by name: the contract takes the
 * candidate to remove as a parameter and requires that account's own
 * signature, so the two are always the same account here.
 */
export const withdrawCandidacyAction = (level: Level, dao: Dao): ChainAction => ({
  account: dao.custodianContract!,
  name: 'withdrawcane',
  authorization: [level],
  data: { cand: level.actor, dac_id: dao.id },
})
