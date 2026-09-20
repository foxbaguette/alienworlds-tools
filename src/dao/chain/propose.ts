import { ABI, Action } from '@wharfkit/session'
import { MSIG_CONTRACT, getAbi } from './proposals'
import type { ChainAction } from './act'
import type { Dao } from './daos'

/**
 * Raising a council proposal — `msig.worlds::propose`.
 *
 * A proposal is a whole transaction the council is being asked to sign. The
 * ONE fiddly part is that the inner action's `data` is bytes on the wire, so it
 * has to be serialised against the target contract's own ABI before it can be
 * wrapped; everything around it is plain fields the wallet serialises itself.
 *
 * `ref_block_num` and `ref_block_prefix` are left at zero, which is what every
 * proposal on chain does. TaPoS is checked when a transaction is pushed, and
 * this one never is — `exec` replays its actions inline. The expiration IS
 * checked, though, and a council that misses it can only start again.
 */

/** How long a council gets to sign, matching what the DAO tooling already uses. */
export const PROPOSAL_DAYS = 7

/**
 * A fresh proposal name.
 *
 * `proposal_name` is an eosio name the proposer invents and the contract
 * refuses a duplicate, so it is random rather than derived from the title —
 * two attempts at the same change must not collide.
 */
export function newProposalName(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz12345'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

/** `2026-09-27T18:54:59` — seconds, no zone, which is what the struct wants. */
const expiresAt = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19)

export interface ProposalDraft {
  title: string
  description: string
  /** Days the council has to sign. */
  days?: number
}

/**
 * Wrap one action in a proposal for this council to sign.
 *
 * The inner action is authorised by the DAO's OWNER account, not by the
 * proposer: the council's signatures are what satisfy that permission, and an
 * action signed by anyone else would execute as that person instead.
 */
export async function proposeAction(
  session: { actor: unknown; permissionLevel: { permission?: unknown } },
  dao: Dao,
  inner: Omit<ChainAction, 'authorization'>,
  draft: ProposalDraft,
): Promise<ChainAction> {
  if (!dao.owner) throw new Error(`${dao.title} has no owner account to propose against.`)

  const actor = String(session.actor)
  const permission = session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active'
  const council = { actor: dao.owner, permission: 'active' }

  /* Serialised through the contract's own ABI rather than by hand: the field
     order and the name encoding are the ABI's business, and getting either
     subtly wrong produces a proposal that looks right and does something else. */
  const abi = ABI.from(await getAbi(inner.account))
  const encoded = Action.from({ ...inner, authorization: [council] }, abi)

  return {
    account: MSIG_CONTRACT,
    name: 'propose',
    authorization: [{ actor, permission }],
    data: {
      proposer: actor,
      proposal_name: newProposalName(),
      requested: [council],
      dac_id: dao.id,
      metadata: [
        { key: 'title', value: draft.title },
        { key: 'description', value: draft.description },
      ],
      trx: {
        expiration: expiresAt(draft.days ?? PROPOSAL_DAYS),
        ref_block_num: 0,
        ref_block_prefix: 0,
        max_net_usage_words: 0,
        max_cpu_usage_ms: 0,
        delay_sec: 0,
        context_free_actions: [],
        actions: [
          {
            account: inner.account,
            name: inner.name,
            authorization: [council],
            data: String(encoded.data),
          },
        ],
        transaction_extensions: [],
      },
    },
  }
}
