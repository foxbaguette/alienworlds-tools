import { getRows } from './nodes'
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

/* ---------- standing in the first place ---------- */

/**
 * Whether an account may stand here at all.
 *
 * Every union sets `requires_whitelist` and keeps a list of about forty-seven
 * accounts; no syndicate does. So on a syndicate anyone who meets the stake can
 * put themselves forward, and on a union it is by invitation — which is why
 * `nominatecane` carries ERR::NOT_IN_WHITELIST, and why that is the first thing
 * worth telling somebody rather than the last.
 *
 * Null where it could not be read, for the same reason `candacyOf` returns
 * null: a node under load answers with an empty page, and an empty page is
 * indistinguishable from an account that is not on the list.
 */
export async function fetchWhitelisted(dao: Dao, actor: string | null): Promise<boolean | null> {
  if (!dao.needsWhitelist) return true
  if (!actor || !dao.custodianContract) return null
  try {
    const rows = await getRows<{ cand: string }>({
      code: dao.custodianContract,
      scope: dao.id,
      table: 'whitelist',
      lower_bound: actor,
      upper_bound: actor,
      limit: 1,
    })
    return rows.length > 0
  } catch (err) {
    console.error(`whitelist in ${dao.id}:`, err)
    return null
  }
}

/**
 * Putting an account forward as a candidate.
 *
 * `requestedpay` is what the candidate asks the DAO to pay them, and the
 * contract refuses anything over `requested_pay_max` — which is 0.0000 TLM on
 * every DAO today. So it is sent as zero of whatever the ceiling is denominated
 * in rather than offered as a field: a box that may only contain nought is not
 * a question worth asking.
 */
export const nominateAction = (level: Level, dao: Dao, pay: string): ChainAction => ({
  account: dao.custodianContract!,
  name: 'nominatecane',
  authorization: [level],
  data: { cand: level.actor, requestedpay: pay, dac_id: dao.id },
})

/** Zero, in whatever asset this DAO caps requested pay in. */
export function noPay(dao: Dao): string {
  const code = String(dao.maxPay ?? '').split(' ')[1]
  return code ? `0.0000 ${code}` : '0.0000 TLM'
}

/**
 * Why standing here would be refused, as the contract would refuse it.
 *
 * Checked in the order somebody would want to hear them: whether they may
 * stand at all, then whether they already do, then what they would have to
 * move to qualify. Each maps to an assert that would otherwise fire after
 * signing, costing the signer their CPU and telling them very little.
 */
export function nominateBlocker(
  dao: Dao,
  of: Candidacy | null,
  listed: boolean | null,
  staked: number,
  delay: number | null,
): string | null {
  if (listed === false) {
    return `${dao.title} only takes candidates from its whitelist, and this account is not on it.`
  }
  if (of?.standing) return 'This account is already standing here.'
  const need = Number(String(dao.minStake ?? '0').split(' ')[0]) || 0
  if (need && staked < need) {
    return `Standing takes ${dao.minStake} staked, and this account has ${staked.toLocaleString('en-GB')}.`
  }
  if (dao.minStakeDelay && delay != null && delay < dao.minStakeDelay) {
    return `The unstake delay must be at least ${dao.minStakeDelay} seconds to stand here.`
  }
  return null
}
