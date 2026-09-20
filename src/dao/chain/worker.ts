/**
 * Worker proposals — `prop.worlds` (dacproposals), scoped by dac_id.
 *
 * A different system from the council multisigs. A msig proposal is a
 * transaction the council signs; a worker proposal is a JOB — someone offers to
 * do work for a fee, the council votes on whether it is worth doing, the worker
 * does it, and the council votes again on whether it was done. Money moves
 * through an escrow, not through the proposal.
 *
 * The directory registers prop.worlds as PROPOSALS (6) for every DAO, but only
 * the six unions use it; every syndicate scope holds zero rows.
 *
 * The state machine, from dacproposals.hpp:
 *
 *   pendingappr ──votes──▶ apprvtes ──startwork──▶ inprogress
 *        │                                              │
 *        └── expiry ──▶ expired                    completework
 *                                                       ▼
 *   completed ◀── finalize ── apprfinvtes ◀──votes── pendingfin
 *                                  │                    │
 *                                  └─── dispute ──▶ indispute
 */
import { getPage, getRows } from './nodes'
import type { Dao } from './daos'

export const WP_CONTRACT = 'prop.worlds'

export const WP_PENDING = 'pendingappr'
export const WP_APPROVED = 'apprvtes'
export const WP_WORKING = 'inprogress'
export const WP_FINALIZING = 'pendingfin'
export const WP_FINAPPR = 'apprfinvtes'
export const WP_EXPIRED = 'expired'
export const WP_DISPUTED = 'indispute'
export const WP_COMPLETED = 'completed'
export const WP_BLOCKED = 'blocked'

/** Internal vote names. The actions take approve/deny; the table stores these. */
export const WP_VOTE_YES = 'propapprove'
export const WP_VOTE_NO = 'propdeny'
export const WP_VOTE_FIN_YES = 'finalapprove'
export const WP_VOTE_FIN_NO = 'finaldeny'

export const WP_LABEL: Record<string, string> = {
  [WP_PENDING]: 'voting',
  [WP_APPROVED]: 'approved',
  [WP_WORKING]: 'in progress',
  [WP_FINALIZING]: 'finalizing',
  [WP_FINAPPR]: 'ready to pay',
  [WP_EXPIRED]: 'expired',
  [WP_DISPUTED]: 'in dispute',
  [WP_COMPLETED]: 'completed',
  [WP_BLOCKED]: 'blocked',
}

/** By what the state asks of a reader, not by which state it is. */
export const WP_TONE: Record<string, string> = {
  [WP_PENDING]: 'wait',
  [WP_APPROVED]: 'go',
  [WP_WORKING]: 'work',
  [WP_FINALIZING]: 'wait',
  [WP_FINAPPR]: 'go',
  [WP_EXPIRED]: 'dead',
  [WP_DISPUTED]: 'bad',
  [WP_COMPLETED]: 'done',
  [WP_BLOCKED]: 'bad',
}

export interface WorkerProposal {
  proposal_id: string
  proposer: string
  arbiter: string
  title: string
  summary: string
  content_hash: string
  proposal_pay: { quantity: string; contract: string }
  arbiter_pay: { quantity: string; contract: string }
  arbiter_agreed: number
  state: string
  expiry: string
  created_at: string
  job_duration: number
  category: number
}

export interface WorkerVote {
  voter: string
  proposal_id: string | null
  category_id: number | null
  vote: string | null
  delegatee: string | null
}

export interface WorkerConfig {
  proposal_threshold: number
  finalize_threshold: number
  approval_duration: number
  min_proposal_duration: number
  proposal_fee: { quantity: string; contract: string } | null
}

export interface WorkerData {
  props: WorkerProposal[]
  votes: WorkerVote[]
  config: WorkerConfig
  /** Arbiters with a rating above zero — createprop refuses the others. */
  arbiters: string[]
  receivers: Set<string>
}

/** Contract defaults, used only if the singleton cannot be read. */
const FALLBACK: WorkerConfig = {
  proposal_threshold: 3,
  finalize_threshold: 2,
  approval_duration: 2_592_000,
  min_proposal_duration: 604_800,
  proposal_fee: null,
}

export const hasWorkerProposals = (dao: Dao) => dao.group === 'union'

export const wpTime = (s: string) => Date.parse(`${s}Z`)

/**
 * The stored state is not the whole truth in the approval round: `expiry`
 * passes silently and the row only flips to `expired` when someone next votes.
 *
 * The finalize round has no expiry at all — `_voteprop` checks `has_not_expired`
 * only in the approval branch and `finalize` never checks it — so a proposal
 * waiting to be paid is NOT stale however old its `expiry` looks.
 */
export function wpEffectiveState(p: WorkerProposal): string {
  const inApprovalRound = p.state === WP_PENDING || p.state === WP_APPROVED
  if (inApprovalRound && wpTime(p.expiry) <= Date.now()) return WP_EXPIRED
  return p.state
}

const LIVE = new Set([WP_PENDING, WP_APPROVED, WP_WORKING, WP_FINALIZING, WP_FINAPPR, WP_DISPUTED])
export const wpIsLive = (p: WorkerProposal) => LIVE.has(wpEffectiveState(p))

/** Which round the row is in, or has just come through. */
export const wpRound = (p: WorkerProposal): 'approval' | 'finalize' =>
  p.state === WP_FINALIZING || p.state === WP_FINAPPR || p.state === WP_COMPLETED || p.state === WP_DISPUTED
    ? 'finalize'
    : 'approval'

export function wpVotingOpen(p: WorkerProposal) {
  const s = wpEffectiveState(p)
  return s === WP_PENDING || s === WP_APPROVED || s === WP_FINALIZING || s === WP_FINAPPR
}

/**
 * A faithful port of dacproposals::count_votes. Three things add up to one
 * approval: a custodian who voted this way directly, plus every custodian who
 * delegated THIS proposal to them, plus every custodian who has not voted here
 * at all and has delegated this proposal's CATEGORY to them.
 *
 * Votes from accounts no longer seated are skipped — the contract goes further
 * and erases those rows as it counts.
 *
 * No union has ever used delegation: every vote row on chain is direct and not
 * one carries a category_id. The weighting is implemented anyway, because a
 * tally that quietly ignored it would be wrong the first time someone used it.
 */
export function wpCountVotes(dao: Dao, prop: WorkerProposal, wanted: string, all: WorkerVote[]): number {
  const seated = new Set(dao.custodians)
  const delegatedHere = new Map<string, number>()
  const approvers = new Set<string>()
  const voted = new Set<string>()

  for (const v of all) {
    if (v.proposal_id !== prop.proposal_id || !seated.has(v.voter)) continue
    voted.add(v.voter)
    if (v.delegatee) delegatedHere.set(v.delegatee, (delegatedHere.get(v.delegatee) ?? 0) + 1)
    else if (v.vote === wanted) approvers.add(v.voter)
  }

  const delegatedCategory = new Map<string, number>()
  for (const name of seated) {
    if (voted.has(name)) continue
    const row = all.find(
      (v) => v.voter === name && v.delegatee && v.category_id != null && Number(v.category_id) === Number(prop.category),
    )
    if (row?.delegatee) delegatedCategory.set(row.delegatee, (delegatedCategory.get(row.delegatee) ?? 0) + 1)
  }

  let count = 0
  for (const name of approvers) {
    count += 1 + (delegatedHere.get(name) ?? 0) + (delegatedCategory.get(name) ?? 0)
  }
  return count
}

export interface Tally {
  round: 'approval' | 'finalize'
  yes: number
  no: number
  need: number
}

export function wpTally(dao: Dao, p: WorkerProposal, wp: WorkerData): Tally {
  const round = wpRound(p)
  const yes = round === 'finalize' ? WP_VOTE_FIN_YES : WP_VOTE_YES
  const no = round === 'finalize' ? WP_VOTE_FIN_NO : WP_VOTE_NO
  return {
    round,
    yes: wpCountVotes(dao, p, yes, wp.votes),
    no: wpCountVotes(dao, p, no, wp.votes),
    need: round === 'finalize' ? wp.config.finalize_threshold : wp.config.proposal_threshold,
  }
}

/**
 * `finalize` refuses until min_proposal_duration has passed — a week on every
 * union. It runs from CREATION, not from completework.
 */
export const wpPayableAt = (p: WorkerProposal, wp: WorkerData) =>
  wpTime(p.created_at) + wp.config.min_proposal_duration * 1000

/**
 * Where the proposal document lives. Workers put either an IPFS CID or a plain
 * URL in `content_hash`; both appear on chain, so both are made openable. The
 * gateway is Alien Worlds' own, which is where the WPS site links every one.
 */
export const IPFS_GATEWAY = 'https://ipfs.alienworlds.io/ipfs/'

export function wpDocUrl(hash: string | null | undefined): string | null {
  const s = String(hash ?? '').trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/.test(s)) return `${IPFS_GATEWAY}${s}`
  return null
}

export async function fetchWorker(dacId: string): Promise<WorkerData> {
  const [props, votes, cfg, arbiters, receivers] = await Promise.all([
    getRows<WorkerProposal>({ code: WP_CONTRACT, scope: dacId, table: 'proposals', limit: 500 }),
    getRows<WorkerVote>({ code: WP_CONTRACT, scope: dacId, table: 'propvotes', limit: 1000 }),
    getPage<{ data: { key: string; value: [string, unknown] }[] }>(
      { code: WP_CONTRACT, scope: dacId, table: 'configs', limit: 1 },
    ).catch(() => []),
    getRows<{ arbiter: string; rating: number }>({
      code: WP_CONTRACT,
      scope: dacId,
      table: 'arbwhitelist',
      limit: 500,
    }).catch(() => []),
    getRows<{ receiver: string }>({ code: WP_CONTRACT, scope: dacId, table: 'recwl', limit: 500 }).catch(() => []),
  ])

  /* The singleton stores its fields as a key/value list of variants, exactly
     like dacglobals — each value is [type, value]. */
  const c: Record<string, unknown> = {}
  for (const kv of cfg[0]?.data ?? []) c[kv.key] = kv.value?.[1]

  return {
    props: props.sort((a, b) => wpTime(b.created_at) - wpTime(a.created_at)),
    votes,
    config: {
      proposal_threshold: Number(c.proposal_threshold) || FALLBACK.proposal_threshold,
      finalize_threshold: Number(c.finalize_threshold) || FALLBACK.finalize_threshold,
      approval_duration: Number(c.approval_duration) || FALLBACK.approval_duration,
      min_proposal_duration: Number(c.min_proposal_duration) || 0,
      proposal_fee: (c.proposal_fee as WorkerConfig['proposal_fee']) ?? null,
    },
    arbiters: arbiters.filter((a) => Number(a.rating) > 0).map((a) => a.arbiter).sort(),
    receivers: new Set(receivers.map((r) => r.receiver)),
  }
}
