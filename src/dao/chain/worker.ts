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
import { TLM_CONTRACT, TLM_SYMBOL, assetUnits, toAsset, unitsToAsset } from './stake'
import type { ChainAction } from './act'
import type { Dao } from './daos'

export const WP_CONTRACT = 'prop.worlds'
/** Where the pay sits between startwork and finalize. */
export const ESCROW_CONTRACT = 'escrw.worlds'

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
  /**
   * Whose reads these were. Half of what is here is about one account, so
   * signing in or out has to invalidate it — stamping the data with the reader
   * makes that automatic rather than something a sign-in path can forget.
   */
  actor: string | null
  /** Whether that account has agreed to the LATEST member terms. */
  member: boolean | null
  agreedTerms: number
  latestTerms: number
  /** Their balance with prop.worlds, which the proposal fee is drawn from. */
  deposit: { quantity: string; contract: string } | null
  /**
   * Proposal ids that still have an escrow holding their money.
   *
   * `startwork` moves the pay into `escrw.worlds` and `finalize` releases it,
   * so a proposal in the finalize round with no escrow can never be paid —
   * `finalize` asserts ERR::ESCROW_ACCOUNT_NOT_FOUND. An escrow can vanish
   * before that: it carries its own expiry, and once past it the sender may
   * refund itself, which leaves the proposal stranded looking ready.
   */
  escrows: Set<string>
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
 * Whether the money is still there to pay.
 *
 * Only asked of the finalize round: before startwork there is no escrow yet and
 * none is expected. After it, a missing one means the pay has already gone back
 * where it came from and nothing can move the proposal on.
 */
export const wpStranded = (p: WorkerProposal, wp: WorkerData): boolean => {
  const state = wpEffectiveState(p)
  if (state !== WP_FINALIZING && state !== WP_FINAPPR) return false
  return !wp.escrows.has(p.proposal_id)
}

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

/**
 * The arbiters a proposal may name right now, read straight from the chain.
 *
 * The custodians add and remove them (addarbwl, rmvarbwl) and change their
 * rating (updarbwl), so a list read when the page opened can be out of date
 * by the time a proposal is written. Only those rated above zero are offered
 * — createprop refuses the others.
 */
export async function fetchArbiters(dacId: string): Promise<string[]> {
  const rows = await getRows<{ arbiter: string; rating: number }>({
    code: WP_CONTRACT,
    scope: dacId,
    table: 'arbwhitelist',
    limit: 500,
  })
  return rows.filter((a) => Number(a.rating) > 0).map((a) => a.arbiter).sort()
}

export async function fetchWorker(dacId: string, dao?: Dao, actor?: string | null): Promise<WorkerData> {
  /* Bounded to one account, for the three reads that are about the signer. */
  const one = actor ? { lower_bound: actor, upper_bound: actor, limit: 1 } : null
  const tokenContract = dao?.tokenContract ?? null

  const [props, votes, cfg, arbiters, receivers, member, terms, deposit, escrows] = await Promise.all([
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
    /* Every action in this contract calls assertValidMember, which wants the
       account registered against the LATEST terms, not merely registered.
       Reading it turns an unreadable wallet error into a sentence. */
    one && tokenContract
      ? getRows<{ agreedtermsversion: number }>({
          code: tokenContract,
          scope: dacId,
          table: 'members',
          ...one,
        }).catch(() => [])
      : Promise.resolve([]),
    one && tokenContract
      ? getRows<{ version: number }>({
          code: tokenContract,
          scope: dacId,
          table: 'memberterms',
          limit: 100,
        }).catch(() => [])
      : Promise.resolve([]),
    /* The fee comes out of a deposit the contract holds, not the wallet, so
       raising a proposal may need a transfer first. */
    one
      ? getRows<{ deposit: { quantity: string; contract: string } }>({
          code: WP_CONTRACT,
          scope: WP_CONTRACT,
          table: 'deposits',
          ...one,
        }).catch(() => [])
      : Promise.resolve([]),
    getRows<{ key: string }>({ code: ESCROW_CONTRACT, scope: dacId, table: 'escrows', limit: 500 }).catch(() => []),
  ])

  /* The singleton stores its fields as a key/value list of variants, exactly
     like dacglobals — each value is [type, value]. */
  const c: Record<string, unknown> = {}
  for (const kv of cfg[0]?.data ?? []) c[kv.key] = kv.value?.[1]

  const latest = terms.reduce((n, t) => Math.max(n, Number(t.version) || 0), 0)
  const agreed = Number(member[0]?.agreedtermsversion ?? 0)

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
    actor: actor ?? null,
    member: !actor ? null : latest > 0 && agreed === latest,
    agreedTerms: agreed,
    latestTerms: latest,
    deposit: deposit[0]?.deposit ?? null,
    escrows: new Set(escrows.map((e) => String(e.key))),
  }
}

/**
 * Raising one — `createprop`.
 *
 * The fee is NOT paid with this transaction. prop.worlds keeps a deposit
 * balance per account, topped up by an ordinary transfer — `receive` credits
 * any transfer to the contract regardless of memo — so a proposal from an
 * account with no deposit is two actions rather than one.
 */
export function wpFeeShortfall(wp: WorkerData): { contract: string; quantity: string } | null {
  const fee = wp.config.proposal_fee
  if (!fee || assetUnits(fee.quantity) <= 0) return null
  const have = wp.deposit && wp.deposit.contract === fee.contract ? assetUnits(wp.deposit.quantity) : 0
  const short = assetUnits(fee.quantity) - have
  if (short <= 0) return null
  return {
    contract: fee.contract,
    quantity: unitsToAsset(short, assetPrecision(fee.quantity), assetCode(fee.quantity)),
  }
}

const assetPrecision = (a: string) => (String(a ?? '').split(' ')[0].split('.')[1] ?? '').length
const assetCode = (a: string) => String(a ?? '').split(' ')[1] ?? ''

export interface WorkerDraft {
  title: string
  summary: string
  /** An IPFS CID or a plain URL — both appear on chain, so both are accepted. */
  url: string
  arbiter: string
  pay: string
  arbiterPay: string
  days: number
  category: number
}

/** A fresh proposal id; `createprop` takes one the caller invents. */
export function newWorkerId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz12345'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

/**
 * The actions for a new worker proposal, or a sentence saying why not.
 *
 * Every check here is one the contract makes anyway. They are made first so a
 * refusal costs nothing — otherwise the only way to find out is a wallet
 * prompt and a failed transaction.
 */
export function createPropActions(
  level: ChainAction['authorization'][number],
  dao: Dao,
  wp: WorkerData,
  draft: WorkerDraft,
): ChainAction[] | string {
  const fee = wp.config.proposal_fee
  const sym = fee ? assetCode(fee.quantity) : TLM_SYMBOL
  const prec = fee ? assetPrecision(fee.quantity) : 4
  const contract = fee ? fee.contract : TLM_CONTRACT

  if (draft.title.trim().length < 4) return 'The title has to be more than three characters.'
  if (draft.summary.trim().length < 4) return 'The summary has to be more than three characters.'
  if (!draft.arbiter) return 'Pick an arbiter.'
  if (draft.arbiter === level.actor) return 'You cannot arbitrate your own proposal.'

  const pay = toAsset(draft.pay, prec, sym)
  if (!pay) return 'Enter a pay amount above zero.'
  /* Not a contract rule, but startwork sends the arbiter's pay to escrow as its
     own transfer, and a transfer of zero is rejected — so a proposal created
     with nothing for the arbiter can never start. */
  const arbiterPay = toAsset(draft.arbiterPay, prec, sym)
  if (!arbiterPay) {
    return (
      'The arbiter needs a pay amount above zero — startwork sends it as its own transfer, ' +
      'and a transfer of zero is rejected.'
    )
  }

  const actions: ChainAction[] = []
  const short = wpFeeShortfall(wp)
  if (short) {
    actions.push({
      account: short.contract,
      name: 'transfer',
      authorization: [level],
      data: { from: level.actor, to: WP_CONTRACT, quantity: short.quantity, memo: `Proposal fee for ${dao.id}` },
    })
  }

  actions.push({
    account: WP_CONTRACT,
    name: 'createprop',
    authorization: [level],
    data: {
      proposer: level.actor,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      arbiter: draft.arbiter,
      proposal_pay: { quantity: pay, contract },
      arbiter_pay: { quantity: arbiterPay, contract },
      content_hash: draft.url.trim(),
      id: newWorkerId(),
      category: Math.max(0, Math.min(65535, Math.round(draft.category))),
      job_duration: Math.max(1, Math.round(draft.days)) * 86400,
      dac_id: dao.id,
    },
  })

  return actions
}

/**
 * Pinning a document to IPFS.
 *
 * The same endpoint, field name and response shape the WPS site uses, so a
 * document uploaded here lands exactly where one uploaded there would.
 *
 * Content-Type is deliberately NOT set: the browser has to write it itself so
 * it can attach the multipart boundary, and naming it by hand produces a
 * header with no boundary the server can parse.
 */
export const IPFS_UPLOAD = 'https://api.alienworlds.io/workerproposal/upload'

export async function uploadToIpfs(file: File): Promise<{ cid: string; already: boolean }> {
  const body = new FormData()
  body.append('file', file)
  const res = await fetch(IPFS_UPLOAD, { method: 'POST', body })
  const text = await res.text()

  if (!res.ok) {
    /* 409 means the file is already pinned, which is a success wearing an
       error's clothes — the CID is in the message. Uploading the same file
       twice answers 200 with the same CID today, so this path is here for
       parity with the WPS client rather than because it has been seen. */
    const cid = res.status === 409 ? text.slice(text.indexOf('Qm'), text.indexOf(' is')) : ''
    if (!cid) throw new Error(text.slice(0, 200) || `upload failed (${res.status})`)
    return { cid, already: true }
  }

  const cid = (JSON.parse(text) as { result?: { cid?: string } })?.result?.cid
  if (!cid) throw new Error('the upload service returned no CID')
  return { cid, already: false }
}

/* ---------- acting on one ---------- */

/** How this account has voted on a proposal, in whichever round it is in. */
export const wpMyVote = (p: WorkerProposal, wp: WorkerData, actor: string | null): string | null =>
  actor ? (wp.votes.find((v) => v.proposal_id === p.proposal_id && v.voter === actor)?.vote ?? null) : null

export type WorkerAct =
  | 'approve'
  | 'deny'
  | 'finapprove'
  | 'findeny'
  | 'arbagree'
  | 'startwork'
  | 'completework'
  | 'finalize'

/**
 * The action behind each button.
 *
 * The two VOTE actions want a second authorization: the DAO's own account at
 * its `one` permission, alongside the custodian's active. Every voteprop and
 * votepropfin on chain carries both — `["1x1ci.wam@active","nar.unn.dac@one"]`
 * — and without it the contract refuses for missing that permission.
 *
 * No extra signature is involved. `one` is threshold 1 with every seated
 * custodian's @active at weight 1, so the custodian's own key satisfies it; it
 * is the DAO saying "a custodian asked for this", not a second signer.
 *
 * Nothing in the published dacproposals source explains it — master's
 * `_voteprop` does `require_auth(custodian)` and nothing more, so the deployed
 * build is not that source. This follows the chain rather than the source.
 *
 * The other six take the actor's active alone, which history confirms for each.
 */
export function workerAction(
  level: ChainAction['authorization'][number],
  dao: Dao,
  p: WorkerProposal,
  act: WorkerAct,
): ChainAction {
  const dac_id = dao.id
  const proposal_id = p.proposal_id
  const plain = (name: string, data: Record<string, unknown>): ChainAction => ({
    account: WP_CONTRACT,
    name,
    authorization: [level],
    data,
  })
  const voting = (name: string, data: Record<string, unknown>): ChainAction => ({
    account: WP_CONTRACT,
    name,
    authorization: dao.owner ? [level, { actor: dao.owner, permission: 'one' }] : [level],
    data,
  })

  switch (act) {
    case 'approve':
      return voting('voteprop', { custodian: level.actor, proposal_id, vote: 'approve', dac_id })
    case 'deny':
      return voting('voteprop', { custodian: level.actor, proposal_id, vote: 'deny', dac_id })
    case 'finapprove':
      return voting('votepropfin', { custodian: level.actor, proposal_id, vote: 'approve', dac_id })
    case 'findeny':
      return voting('votepropfin', { custodian: level.actor, proposal_id, vote: 'deny', dac_id })
    case 'arbagree':
      return plain('arbagree', { arbiter: level.actor, proposal_id, dac_id })
    case 'startwork':
      return plain('startwork', { proposal_id, dac_id })
    case 'completework':
      return plain('completework', { proposal_id, dac_id })
    default:
      return plain('finalize', { proposal_id, dac_id })
  }
}

export interface WorkerButton {
  act: WorkerAct
  label: string
  /** Why it cannot be pressed, or null if it can. */
  blocked: string | null
  /** True when this is what the account already did — shown, but spent. */
  done?: boolean
}

/**
 * Everything this account can do to one proposal, and why not where it cannot.
 *
 * A disabled button with a reason beats a hidden one: "you have already
 * approved this" and "this needs three approvals and has two" are both things
 * somebody came to the page to find out.
 */
export function workerButtons(
  dao: Dao,
  p: WorkerProposal,
  wp: WorkerData,
  actor: string | null,
): WorkerButton[] {
  if (!actor) return []

  const state = wpEffectiveState(p)
  const tally = wpTally(dao, p, wp)
  const mine = wpMyVote(p, wp, actor)
  const seated = dao.custodians.includes(actor)
  const isWorker = p.proposer === actor
  const isArbiter = p.arbiter === actor
  const out: WorkerButton[] = []

  /* Every action in the contract asserts membership first, so this blocks all
     of them rather than being repeated on each. */
  const terms =
    wp.member === false
      ? `${actor} has not agreed to this DAO’s latest member terms (agreed version ${
          wp.agreedTerms || 'none'
        }, current is ${wp.latestTerms}), which every action here requires.`
      : null

  const approving = state === WP_PENDING || state === WP_APPROVED
  const finalizing = state === WP_FINALIZING || state === WP_FINAPPR

  if (seated && approving) {
    out.push({
      act: 'approve',
      label: mine === WP_VOTE_YES ? 'Approved' : 'Approve',
      done: mine === WP_VOTE_YES,
      blocked: terms ?? (mine === WP_VOTE_YES ? 'You have already approved this one.' : null),
    })
    out.push({
      act: 'deny',
      label: mine === WP_VOTE_NO ? 'Denied' : 'Deny',
      done: mine === WP_VOTE_NO,
      blocked: terms ?? (mine === WP_VOTE_NO ? 'You have already voted against this one.' : null),
    })
  }

  if (seated && finalizing) {
    out.push({
      act: 'finapprove',
      label: mine === WP_VOTE_FIN_YES ? 'Work accepted' : 'Accept work',
      done: mine === WP_VOTE_FIN_YES,
      blocked: terms ?? (mine === WP_VOTE_FIN_YES ? 'You have already accepted this work.' : null),
    })
    out.push({
      act: 'findeny',
      label: mine === WP_VOTE_FIN_NO ? 'Work rejected' : 'Reject work',
      done: mine === WP_VOTE_FIN_NO,
      blocked: terms ?? (mine === WP_VOTE_FIN_NO ? 'You have already rejected this work.' : null),
    })
  }

  /* startwork is refused without it, so the arbiter's agreement is a stage of
     its own rather than a detail on the row. */
  if (isArbiter && !p.arbiter_agreed && approving) {
    out.push({ act: 'arbagree', label: 'Agree to arbitrate', blocked: terms })
  }

  if (isWorker && approving) {
    out.push({
      act: 'startwork',
      label: 'Start work',
      blocked:
        terms ??
        (tally.yes < tally.need ? `Needs ${tally.need} approvals and has ${tally.yes}.` : null) ??
        (!p.arbiter_agreed
          ? `${p.arbiter} has not agreed to arbitrate, which the contract requires before work starts.`
          : null),
    })
  }

  if (isWorker && state === WP_WORKING) {
    out.push({ act: 'completework', label: 'Mark complete', blocked: terms })
  }

  /* finalize carries no require_auth — anyone may push a proposal that has
     cleared both gates over the line, and the money goes to the worker either
     way. That is why it is offered to everyone signed in, not the worker alone. */
  if (finalizing) {
    const payable = wpPayableAt(p, wp)
    out.push({
      act: 'finalize',
      label: 'Finalize and pay',
      blocked: wpStranded(p, wp)
        ? `There is no escrow left for this proposal, so finalize would be refused — the pay was returned to ` +
          `the treasury when the escrow ran out. Nothing can move it on.`
        : tally.yes < tally.need
          ? `Needs ${tally.need} approvals to finalize and has ${tally.yes}.`
          : Date.now() < payable
            ? `The contract holds every proposal for ${Math.round(
                wp.config.min_proposal_duration / 86400,
              )} days from creation. This one can be finalized ${new Date(payable)
                .toISOString()
                .slice(0, 10)}.`
            : null,
    })
  }

  return out
}
