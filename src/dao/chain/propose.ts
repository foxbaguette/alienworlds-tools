import { ABI, Action, Serializer, Transaction } from '@wharfkit/session'
import { call } from './nodes'
import { MSIG_CONTRACT, getAbi, type MsigProposal } from './proposals'
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
export const expiresAt = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19)

/**
 * One action with its data serialised, ready to sit inside a proposal.
 *
 * Done through the contract's own ABI rather than by hand: the field order and
 * the name encoding are the ABI's business, and getting either subtly wrong
 * produces a proposal that looks right and does something else.
 */
export async function encodeInner(inner: Omit<ChainAction, 'authorization'> & {
  authorization: ChainAction['authorization']
}) {
  const abi = ABI.from(await getAbi(inner.account))
  const encoded = Action.from(inner, abi)
  return {
    account: inner.account,
    name: inner.name,
    authorization: inner.authorization,
    data: String(encoded.data),
  }
}

/**
 * A reference to a recent irreversible block.
 *
 * `eosio.msig` proposals on chain carry real TAPOS, unlike `msig.worlds` where
 * every live one has zeroes, so proposals bound for the system contract get the
 * real thing.
 */
export async function tapos(): Promise<{ ref_block_num: number; ref_block_prefix: number }> {
  const info = await call({}, 'get_info')
  const num = Number(info.last_irreversible_block_num)
  const block = await call({ block_num_or_id: num }, 'get_block')
  /* ref_block_prefix is the second 32-bit word of the block id, little endian. */
  const prefix = parseInt(String(block.id).slice(16, 24).match(/../g)!.reverse().join(''), 16)
  return { ref_block_num: num & 0xffff, ref_block_prefix: prefix }
}

/** The transaction body a proposal wraps, around actions already encoded. */
export const wrapTrx = (
  actions: Awaited<ReturnType<typeof encodeInner>>[],
  expiration: string,
  ref: { ref_block_num: number; ref_block_prefix: number } = { ref_block_num: 0, ref_block_prefix: 0 },
) => ({
  expiration,
  ...ref,
  max_net_usage_words: 0,
  max_cpu_usage_ms: 0,
  delay_sec: 0,
  context_free_actions: [],
  actions,
  transaction_extensions: [],
})

export interface ProposalDraft {
  title: string
  description: string
  /** Days the council has to sign. */
  days?: number
}

/** One action of a proposal being written, with its arguments still as JSON. */
export interface DraftAction {
  account: string
  name: string
  /** JSON, which is serialised against the contract's own ABI on the way out. */
  data: string
}

export const blankDraftAction = (): DraftAction => ({ account: '', name: '', data: '{}' })

/**
 * A proposal on chain, turned back into something a person can read and edit.
 *
 * A packed transaction carries its actions' arguments as opaque bytes, so each
 * one has to go BACK through its own contract's ABI before it can be shown —
 * which is several reads, but only on the copy path and only once.
 *
 * An action that cannot be decoded is handed over as raw bytes rather than
 * dropped: the reader can still see something was there and decide.
 */
export async function decodeProposal(p: MsigProposal): Promise<DraftAction[]> {
  const trx = Serializer.decode({ type: Transaction, data: p.packed_transaction })
  const out: DraftAction[] = []
  for (const a of trx.actions ?? []) {
    const account = String(a.account)
    const name = String(a.name)
    let data = '{}'
    try {
      const abi = ABI.from(await getAbi(account))
      data = JSON.stringify(Serializer.objectify(Serializer.decode({ abi, type: name, data: a.data })), null, 2)
    } catch (err) {
      console.error(`Could not decode ${account}::${name}:`, err)
      data = `/* could not decode — raw bytes: ${String(a.data)} */`
    }
    out.push({ account, name, data })
  }
  return out
}

/**
 * A proposal carrying any number of hand-written actions.
 *
 * Every action is serialised BEFORE any of it is sent: a half-built proposal is
 * not worth putting in front of a wallet, and a bad argument should be a
 * message in the form rather than a rejected transaction.
 */
export async function proposeActions(
  level: ChainAction['authorization'][number],
  dao: Dao,
  rows: DraftAction[],
  draft: ProposalDraft,
): Promise<ChainAction> {
  if (!dao.owner) throw new Error(`${dao.title} has no owner account to propose against.`)
  const council = { actor: dao.owner, permission: 'active' }

  const inner = []
  for (const a of rows) {
    let args: unknown
    try {
      args = JSON.parse(a.data)
    } catch (err) {
      throw new Error(`${a.account}::${a.name} — arguments are not valid JSON: ${(err as Error).message}`)
    }
    inner.push(await encodeInner({ account: a.account, name: a.name, authorization: [council], data: args as Record<string, unknown> }))
  }

  return {
    account: MSIG_CONTRACT,
    name: 'propose',
    authorization: [level],
    data: {
      proposer: level.actor,
      proposal_name: newProposalName(),
      requested: [council],
      dac_id: dao.id,
      metadata: [
        { key: 'title', value: draft.title },
        { key: 'description', value: draft.description || '- No description -' },
      ],
      trx: wrapTrx(inner, expiresAt(draft.days ?? PROPOSAL_DAYS)),
    },
  }
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
  const encoded = await encodeInner({ ...inner, authorization: [council] })

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
      /* msig.worlds dispatches its inner actions itself, so no TAPOS —
         matching every live proposal on that contract. */
      trx: wrapTrx([encoded], expiresAt(draft.days ?? PROPOSAL_DAYS)),
    },
  }
}
