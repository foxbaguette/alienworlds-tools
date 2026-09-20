/**
 * Council multisig proposals — `msig.worlds`, scoped by dac_id.
 *
 * Not to be confused with worker proposals on `prop.worlds`, which are a
 * different contract and a different thing entirely (see worker.ts). The
 * directory registers `prop.worlds` for every DAO, which is what makes it easy
 * to reach for the wrong one.
 */
import { call, getPage, getRows } from './nodes'

export const MSIG_CONTRACT = 'msig.worlds'

export const MSIG_OPEN = 0
export const MSIG_EXECUTED = 1
export const MSIG_CANCELLED = 2

export interface Approval {
  level?: { actor: string; permission: string }
}

export interface MsigProposal {
  id: number
  proposal_name: string
  proposer: string
  packed_transaction: string
  earliest_exec_time: string | null
  modified_date: string
  state: number
  metadata: { key: string; value: string }[]
  /** Joined in from the approvals table, which is keyed by proposal_name. */
  approvals?: { provided_approvals?: Approval[] }
}

export const msigTitle = (p: MsigProposal) =>
  p.metadata?.find((m) => m.key === 'title')?.value ||
  p.metadata?.find((m) => m.key === 'description')?.value ||
  p.proposal_name

export const msigDescription = (p: MsigProposal) =>
  p.metadata?.find((m) => m.key === 'description')?.value ?? ''

/**
 * When the proposed transaction expires, read off the packed bytes.
 *
 * The first four bytes of a serialized transaction header are its expiration,
 * little-endian seconds. Cheaper than deserializing the whole thing for one
 * field, and it is the only place the deadline exists — the table row does not
 * carry it.
 */
export function msigExpiry(packed: string): number {
  const hex = String(packed ?? '').slice(0, 8)
  if (hex.length < 8) return NaN
  const le = hex.match(/../g)!.reverse().join('')
  return parseInt(le, 16) * 1000
}

export const isExpired = (p: MsigProposal) => msigExpiry(p.packed_transaction) < Date.now()
export const approvalsOf = (p: MsigProposal) => p.approvals?.provided_approvals ?? []
export const approvalCount = (p: MsigProposal) => approvalsOf(p).length

/**
 * The most recent proposals for one DAO, newest first.
 *
 * `index_position: 3` is the `id` index, which is chronological. The PRIMARY
 * key is `proposal_name` — an eosio name — so reading the table in its natural
 * order and reversing gives the names nearest "zzzz", not the newest rows.
 */
export async function fetchProposals(dacId: string): Promise<MsigProposal[]> {
  const [rows, approvals] = await Promise.all([
    getPage<MsigProposal>({
      code: MSIG_CONTRACT,
      scope: dacId,
      table: 'proposals',
      index_position: 3,
      key_type: 'i64',
      limit: 300,
      reverse: true,
    }),
    getRows<{ proposal_name: string; provided_approvals?: Approval[] }>({
      code: MSIG_CONTRACT,
      scope: dacId,
      table: 'approvals',
      limit: 500,
    }).catch(() => []),
  ])

  const byName = new Map(approvals.map((a) => [a.proposal_name, a]))
  return rows
    .map((p) => ({ ...p, approvals: byName.get(p.proposal_name) }))
    .sort((a, b) => Number(b.id) - Number(a.id))
}

/** Whether a named account is already among a proposal's signatures. */
export const approvedBy = (p: MsigProposal, actor: string) =>
  approvalsOf(p).some((a) => a.level?.actor === actor)

/** The ABI of a contract, cached — deserializing an inner action needs it. */
const abiCache = new Map<string, unknown>()
export async function getAbi(account: string) {
  if (abiCache.has(account)) return abiCache.get(account)
  const data = await call({ account_name: account }, 'get_abi')
  abiCache.set(account, data.abi)
  return data.abi
}
