import type { Session } from '@wharfkit/session'
import type { Dao } from './daos'
import type { ChainAction } from './act'

/**
 * Voting for custodians — `dao.worlds::votecust`.
 *
 * Refreshing a vote is RE-CASTING the same slate. It rewrites
 * `vote_time_stamp`, which feeds each candidate's `avg_vote_time_stamp` and so
 * their rank; the candidate list does not change, only its age.
 */
export interface VoteRow {
  voter: string
  candidates: string[]
  vote_time_stamp: string
}

export function voteAction(session: Session, dao: Dao, candidates: string[]): ChainAction {
  return {
    account: dao.custodianContract!,
    name: 'votecust',
    authorization: [
      {
        actor: String(session.actor),
        permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
      },
    ],
    data: { voter: String(session.actor), newvotes: candidates, dac_id: dao.id },
  }
}

/**
 * Why `votecust` would refuse this name, or null if it would take it.
 *
 * The contract checks three things about every name in `newvotes`: that it is a
 * registered member on the latest terms, that a candidate row exists, and that
 * the row is active. The last two are answered from `dao.standing`. The
 * membership check is about the CANDIDATE's own terms agreement rather than the
 * voter's, and pre-reading it for every candidate of every DAO would cost more
 * than it saves — that one surfaces as the chain's own error instead.
 *
 * Note the asymmetry that makes any of this survivable: only `newvotes` is
 * validated. The vote being replaced is walked with `find()` and missing rows
 * are skipped, so a slate holding a dead candidate can always be REPLACED — it
 * just cannot be re-cast unchanged.
 */
export function voteBlocker(dao: Dao, name: string): string | null {
  if (!dao.standing.size) return null // not read; do not invent a verdict
  if (!dao.standing.has(name)) return 'no longer a registered candidate'
  if (!dao.standing.get(name)) return 'has withdrawn and is no longer standing'
  return null
}

export interface Slate {
  slate: string[]
  keep: string[]
  drop: { name: string; why: string }[]
}

/**
 * The slate as it could be cast today, and what had to come off it.
 *
 * A candidate who has withdrawn takes the whole transaction down with them,
 * which is how one dead name once broke refreshing across every DAO at once.
 */
export function castableSlate(dao: Dao, votes: Map<string, VoteRow>): Slate {
  const slate = votes.get(dao.id)?.candidates ?? []
  const keep: string[] = []
  const drop: { name: string; why: string }[] = []
  for (const name of slate) {
    const why = voteBlocker(dao, name)
    if (why) drop.push({ name, why })
    else keep.push(name)
  }
  return { slate, keep, drop }
}

export interface GroupVotes {
  /** DAOs with something to re-cast. */
  eligible: { dao: Dao; keep: string[]; drop: { name: string; why: string }[] }[]
  /** Eligible, but losing a name on the way. */
  trimmed: { dao: Dao; keep: string[]; drop: { name: string; why: string }[] }[]
  /**
   * Every candidate gone. Kept OUT of the batch: re-casting an empty slate is
   * how votecust DELETES a vote, so this needs a decision, never a sweep.
   */
  emptied: { dao: Dao; slate: string[] }[]
  /** Could not be READ — a different thing entirely from holding no vote. */
  missing: Dao[]
  complete: boolean
}

export function groupVotes(daos: Dao[], votes: Map<string, VoteRow>, read: Set<string>): GroupVotes {
  const missing = daos.filter((d) => !read.has(d.id))

  const held = daos
    .filter((d) => (votes.get(d.id)?.candidates ?? []).length > 0)
    .map((dao) => ({ dao, ...castableSlate(dao, votes) }))

  const emptied = held.filter((h) => h.keep.length === 0).map((h) => ({ dao: h.dao, slate: h.slate }))
  const eligible = held.filter((h) => h.keep.length > 0)
  const trimmed = eligible.filter((h) => h.drop.length > 0)

  return { eligible, trimmed, emptied, missing, complete: daos.length > 0 && missing.length === 0 }
}
