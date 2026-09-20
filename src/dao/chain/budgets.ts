import { POINTS_CONTRACT } from './allocators'
import { MSIG_CONTRACT } from './proposals'
import { encodeInner, expiresAt, newProposalName, tapos, wrapTrx, PROPOSAL_DAYS } from './propose'
import type { ChainAction } from './act'
import type { Dao } from './daos'
import type { Signers } from '../useAllocators'

/**
 * Moving an allocator's budget — `ptpxy.worlds`, through a multisig.
 *
 * Three actions, all requiring the ALLOCATOR's own authority, which is a
 * multisig account. So none of them can be signed directly; each goes out as a
 * proposal on `eosio.msig` for the allocator's signers to approve.
 *
 *   setbudget    creates a NEW allocation. Refused if a pointsconfig already
 *                exists for that account, so it cannot be used to change one.
 *   addbudget    increases an existing one, reusing the recipient's own n_days.
 *   withdrawbudg decreases; omitting the amount withdraws the whole period.
 *
 * `budget` throughout is the PERIOD total, which the contract divides by n_days
 * to get the per-day allowance it stores. And every figure in this contract is
 * held at ten times face value — see allocators.ts — so what a person types is
 * multiplied by ten on the way out.
 */
export type AllocOp = 'add' | 'sub' | 'new'

export const ALLOC_OPS: Record<AllocOp, { action: string; verb: string; blurb: string }> = {
  add: {
    action: 'addbudget',
    verb: 'Increase',
    blurb: 'Adds to an existing allocation, keeping the recipient’s own period length.',
  },
  sub: {
    action: 'withdrawbudg',
    verb: 'Decrease',
    blurb: 'Takes back part of the period’s budget.',
  },
  new: {
    action: 'setbudget',
    verb: 'New allocation',
    blurb: 'Only creates allocations — refused if this account already has one.',
  },
}

/** The contract's own bounds on a new allocation's period. */
export const PERIOD_MIN_DAYS = 1
export const PERIOD_MAX_DAYS = 60

/**
 * Which of an allocator's signers are DAOs rather than people.
 *
 * `synthar.dac` is signed for by the six planet DACs themselves, and a DAO acts
 * only through its own council — it cannot simply press approve. So each of
 * those needs a `msig.worlds` proposal of its own carrying the approval, and
 * `msig.worlds` only accepts one from a seated custodian.
 *
 * Worked out from the directory rather than by naming synthar: a signer is a
 * DAO if it owns one. The other allocators have none, so they produce nothing
 * extra.
 */
export function councilSigners(signers: Signers | null, daos: Dao[], actor: string | null) {
  if (!signers) return { mine: [] as Dao[], others: [] as Dao[] }
  const byOwner = new Map(daos.filter((d) => d.owner).map((d) => [d.owner as string, d]))
  const all = signers.members.map((m) => byOwner.get(m.actor)).filter((d): d is Dao => !!d)
  return {
    mine: all.filter((d) => actor && d.custodians.includes(actor)),
    others: all.filter((d) => !actor || !d.custodians.includes(actor)),
  }
}

export interface BudgetDraft {
  op: AllocOp
  /** The recipient account. */
  to: string
  /** As typed, at face value — this is scaled by ten on the way to the chain. */
  amount: number
  /** Period length in days. Only `setbudget` takes one. */
  days: number
}

/**
 * The whole transaction: the allocator proposal, plus one council proposal for
 * every DAO signer this account can raise one on.
 *
 * They go out together on purpose. A council proposal that approves an
 * `eosio.msig` proposal which does not exist yet is useless, and raising them
 * in two transactions leaves a window where exactly that is true.
 */
export async function budgetProposal(
  level: ChainAction['authorization'][number],
  allocator: string,
  signers: Signers,
  draft: BudgetDraft,
  councils: Dao[],
): Promise<ChainAction[]> {
  const op = ALLOC_OPS[draft.op]
  const budget = Math.round(draft.amount * 10)
  const data =
    draft.op === 'new'
      ? {
          allocator,
          points_manager: draft.to,
          budget,
          n_days: draft.days,
          batch_process: true,
        }
      : { allocator, points_manager: draft.to, budget }

  const inner = await encodeInner({
    account: POINTS_CONTRACT,
    name: op.action,
    authorization: [{ actor: allocator, permission: 'active' }],
    data,
  })

  const expiry = expiresAt(PROPOSAL_DAYS)
  const outerName = newProposalName()

  /* eosio.msig, not msig.worlds: an allocator is a plain account multisig with
     no dac_id, and every one of these on chain has gone through the system
     contract. */
  const actions: ChainAction[] = [
    {
      account: 'eosio.msig',
      name: 'propose',
      authorization: [level],
      data: {
        proposer: level.actor,
        proposal_name: outerName,
        requested: signers.members.map((m) => ({ actor: m.actor, permission: m.permission })),
        trx: wrapTrx([inner], expiry, await tapos()),
      },
    },
  ]

  if (!councils.length) return actions

  const title = `${op.verb}: ${draft.to} — ${draft.amount.toLocaleString('en-US')}`
  for (const dao of councils) {
    const approve = await encodeInner({
      account: 'eosio.msig',
      name: 'approve',
      authorization: [{ actor: dao.owner as string, permission: 'active' }],
      data: {
        proposer: level.actor,
        proposal_name: outerName,
        level: { actor: dao.owner, permission: 'active' },
      },
    })

    actions.push({
      account: MSIG_CONTRACT,
      name: 'propose',
      authorization: [level],
      data: {
        proposer: level.actor,
        proposal_name: newProposalName(),
        requested: [{ actor: dao.owner, permission: 'active' }],
        dac_id: dao.id,
        metadata: [
          { key: 'title', value: `Approve ${allocator} allocation · ${title}` },
          {
            key: 'description',
            value:
              `Approves ${level.actor}/${outerName} on eosio.msig, which asks ${allocator} to ` +
              `${op.action} ${budget} for ${draft.to}. ${allocator} needs ${signers.threshold} of its ` +
              `${signers.members.length} signers, and ${dao.owner} is one of them.`,
          },
        ],
        trx: wrapTrx([approve], expiry),
      },
    })
  }

  return actions
}
