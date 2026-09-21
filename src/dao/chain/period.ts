/**
 * Two council settings that only the DAO's OWNER account may change, and so
 * only ever reach the chain as a proposal the council signs:
 *
 *   dao.worlds::setperiodlen(periodlength, dac_id)   how long a term runs
 *   dao.worlds::claimbudget(dac_id)                  draw this period's budget
 *
 * Both are signed on chain by the owner's `active` permission — every one of
 * the thousand-odd `claimbudget`s in the history is `<planet>.dac@active`,
 * executed through msig.worlds — which is what `proposeAction` requests.
 */
import type { Dao } from './daos'

/*
 * setperiodlen's own bounds, from the contract's config checks:
 *   periodlength >= 1 day
 *   periodlength <= 6 months, a month being 30 days
 *   periodlength >= the DAO's pending period delay
 */
export const PERIOD_MIN_DAYS = 1
export const PERIOD_MAX_DAYS = 180

/** The shortest period this DAO will accept, in whole days. */
export const periodFloorDays = (dao: Dao) =>
  Math.max(PERIOD_MIN_DAYS, Math.ceil((dao.pendingPeriodDelay || 0) / 86_400))

export const setPeriodAction = (dao: Dao, days: number) => ({
  account: dao.custodianContract ?? 'dao.worlds',
  name: 'setperiodlen',
  data: { periodlength: Math.round(days) * 86_400, dac_id: dao.id },
})

/**
 * Only syndicates draw a budget. Every claim on chain is from one — the unions
 * are funded by the inflation redirect instead, and their globals carry no
 * budget percentage at all.
 */
export const hasBudget = (dao: Dao) => dao.group === 'syndicate' && dao.budgetPercent != null

export const claimBudgetAction = (dao: Dao) => ({
  account: dao.custodianContract ?? 'dao.worlds',
  name: 'claimbudget',
  data: { dac_id: dao.id },
})

/**
 * Whether this period's budget has been drawn already.
 *
 * Read from the claim history rather than from the contract source: every
 * syndicate claims once a term, after its election, and never twice between
 * two — which is what the contract refusing a second claim would look like.
 * A proposal can sit for days, so this is a warning on the form, not a lock.
 */
export const claimedThisPeriod = (dao: Dao) =>
  dao.lastClaimBudget != null && dao.lastPeriod != null && dao.lastClaimBudget >= dao.lastPeriod
