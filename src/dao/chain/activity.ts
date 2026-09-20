import { historyGet, iso } from '../../chain/history'
import { getRows } from './nodes'
import { decayedPower, rawPower } from '../format'
import { STAKE_CONTRACT } from './stake'
import type { Dao } from './daos'

/**
 * Everything happening around the governance tokens, in one stream.
 *
 * Three sources, because the three things a token holder does live on three
 * contracts:
 *
 *   token.worlds::transfer   the token changing hands
 *   dao.worlds::votecust     a slate being cast or re-cast
 *   token.worlds::staketime  the unstake delay, which is a vote MULTIPLIER
 *
 * That last one is why they belong together. Vote power is not the stake: it is
 * the stake times a multiplier that runs from 1 at the minimum delay to
 * 1 + `time_multiplier` at the maximum — nine times on every DAC today. So
 * somebody lengthening their delay can move a council without buying a single
 * token, and a feed of transfers alone would never show it.
 *
 * Most of the transfer volume is not an exchange at all. Over a two-day sample
 * of a thousand, 786 were mining rewards dripping out of `theminergame` and
 * another 22 were other payouts. They are classified and hidden by default
 * rather than dropped — they are real, they are just not what this is for.
 */
export const TOKEN_CONTRACT = 'token.worlds'
export const DAO_CONTRACT = 'dao.worlds'
export const STAKEVOTE_CONTRACT = 'stkvt.worlds'

/** Where the reward drip comes from. */
const PAYERS = new Set(['theminergame', 'rewards.mc', 'rewards.ale'])

/** Alcor and Taco both name themselves, and every swap carries a `swap…` memo. */
const isDex = (account: string) => /alcor|taco|swap/i.test(account)

export type ActivityKind = 'bought' | 'sold' | 'swapped' | 'sent' | 'payout' | 'vote' | 'staketime'

export const KIND_LABEL: Record<ActivityKind, string> = {
  bought: 'bought with TLM',
  sold: 'sold for TLM',
  swapped: 'swapped on a DEX',
  sent: 'sent',
  payout: 'reward payout',
  vote: 'voted',
  staketime: 'changed their unstake delay',
}

export const KIND_TONE: Record<ActivityKind, string> = {
  bought: 'go',
  sold: 'bad',
  swapped: 'work',
  sent: 'wait',
  payout: 'done',
  vote: 'go',
  staketime: 'work',
}

/** The three groups the filter offers, and which kinds are in each. */
export const GROUPS = {
  exchanges: ['bought', 'sold', 'swapped', 'sent'] as ActivityKind[],
  votes: ['vote'] as ActivityKind[],
  delays: ['staketime'] as ActivityKind[],
  payouts: ['payout'] as ActivityKind[],
}

export interface Activity {
  /**
   * What makes this event distinct.
   *
   * For a transfer this is NOT the action ordinal: a transfer notifies both
   * parties and an indexer reports each notification separately, so a DEX swap
   * arrives two or three times over, identically.
   */
  key: string
  at: number
  kind: ActivityKind
  /** Whose action it is. */
  actor: string
  /** The other side, where there is one. */
  other?: string
  /** The token code — EYE, KAVUNN, NAR. Known for every kind. */
  symbol: string
  /** The DAC this is about, where it is knowable. */
  dacId?: string
  /** Tokens moved, for a transfer. */
  amount?: number
  /** Seconds, for a staketime change. */
  delay?: number
  /** Who was voted for. */
  votes?: string[]
  memo?: string
}

interface RawAction {
  trx_id: string
  action_ordinal: number
  timestamp: string
  act: { account: string; name: string; data: Record<string, unknown> }
}

function classifyTransfer(from: string, to: string, memo: string): ActivityKind {
  if (from === STAKE_CONTRACT) return 'bought'
  if (to === STAKE_CONTRACT) return 'sold'
  if (isDex(from) || isDex(to) || /^swapexact/i.test(memo)) return 'swapped'
  /* A payout is who sent it, not what the memo says. */
  if (PAYERS.has(from)) return 'payout'
  return 'sent'
}

/** `4,NARUNN` — the symbol as `staketime` carries it. */
const codeOfSymbol = (s: unknown) => String(s ?? '').split(',')[1] ?? ''

/**
 * One sweep of all three sources.
 *
 * Fired together rather than in turn: they are independent, and the indexers
 * are the slow part.
 */
export async function fetchActivity(since: number, limit = 400): Promise<Activity[]> {
  const after = iso(since)
  const [transfers, votes, delays] = await Promise.all([
    historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
      'act.account': TOKEN_CONTRACT,
      'act.name': 'transfer',
      after,
      limit,
      sort: 'desc',
    }).catch(() => ({ actions: [] })),
    historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
      'act.account': DAO_CONTRACT,
      'act.name': 'votecust',
      after,
      limit: 200,
      sort: 'desc',
    }).catch(() => ({ actions: [] })),
    historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
      'act.account': TOKEN_CONTRACT,
      'act.name': 'staketime',
      after,
      limit: 200,
      sort: 'desc',
    }).catch(() => ({ actions: [] })),
  ])

  const out: Activity[] = []

  for (const a of transfers.actions ?? []) {
    const d = a.act.data as { from?: string; to?: string; quantity?: string; symbol?: string; amount?: number; memo?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    const from = String(d.from ?? '')
    const to = String(d.to ?? '')
    const symbol = String(d.symbol ?? String(d.quantity ?? '').split(' ')[1] ?? '')
    if (!Number.isFinite(at) || !from || !to || !symbol) continue
    const memo = String(d.memo ?? '')
    const kind = classifyTransfer(from, to, memo)
    out.push({
      key: `${a.trx_id}:${from}:${to}:${d.quantity ?? ''}`,
      at,
      kind,
      /* On a buy or a payout the receiver is the one it happened to. */
      actor: kind === 'bought' || kind === 'payout' ? to : from,
      other: kind === 'bought' || kind === 'payout' ? from : to,
      symbol,
      amount: Number(d.amount) || 0,
      memo,
    })
  }

  for (const a of votes.actions ?? []) {
    const d = a.act.data as { voter?: string; newvotes?: string[]; dac_id?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at) || !d.voter || !d.dac_id) continue
    out.push({
      key: `${a.trx_id}:vote:${d.dac_id}:${d.voter}`,
      at,
      kind: 'vote',
      actor: String(d.voter),
      symbol: '',
      dacId: String(d.dac_id),
      votes: (d.newvotes ?? []).map(String),
    })
  }

  for (const a of delays.actions ?? []) {
    const d = a.act.data as { account?: string; unstake_time?: number; token_symbol?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at) || !d.account) continue
    out.push({
      key: `${a.trx_id}:delay:${d.account}:${d.token_symbol ?? ''}`,
      at,
      kind: 'staketime',
      actor: String(d.account),
      symbol: codeOfSymbol(d.token_symbol),
      delay: Number(d.unstake_time) || 0,
    })
  }

  return out.sort((x, y) => y.at - x.at)
}

/* ---------- vote power ---------- */

/**
 * What each voter's vote is worth, per DAC — `stkvt.worlds/weights`.
 *
 * Read rather than derived. The weight IS stake times a delay multiplier, and
 * the formula is confirmed —
 *
 *     weight = stake * (1 + time_multiplier * delay / max_stake_time)
 *
 * with `time_multiplier` 8 on every DAC today, so nine times at the maximum
 * delay — but the contract keeps the answer, and a figure read from the table
 * cannot drift from what the chain will count.
 */
const weightCache = new Map<string, Map<string, number>>()
const weightLoading = new Map<string, Promise<void>>()

export function weightsReady(dacId: string) {
  return weightCache.has(dacId)
}

export function ensureWeights(dacId: string): Promise<void> {
  if (weightCache.has(dacId)) return Promise.resolve()
  const live = weightLoading.get(dacId)
  if (live) return live

  const job = getRows<{ voter: string; weight: string | number }>({
    code: STAKEVOTE_CONTRACT,
    scope: dacId,
    table: 'weights',
    limit: 1000,
  })
    .then((rows) => {
      weightCache.set(dacId, new Map(rows.map((r) => [r.voter, Number(r.weight) || 0])))
    })
    .catch((err: unknown) => {
      console.error(`vote weights for ${dacId}:`, err)
      weightCache.set(dacId, new Map())
    })
    .finally(() => weightLoading.delete(dacId))

  weightLoading.set(dacId, job)
  return job
}

/** One voter's power in a DAC, in whole tokens, or null if not read yet. */
export function weightOf(dacId: string, voter: string, precision: number): number | null {
  const held = weightCache.get(dacId)
  if (!held) return null
  return rawPower(held.get(voter) ?? 0, precision)
}

/* ---------- would this change the council? ---------- */

export interface Flip {
  /** Who would lose their place if this vote were not there. */
  out: string
  /** Who would take it. */
  in: string
}

/**
 * Whether one voter's weight is what is holding the council in its current
 * shape.
 *
 * The counterfactual is "take this voter's weight back off the candidates they
 * voted for, and see whether the seats change". The chain seats on the DECAYED
 * figure, so the decayed one is what is compared — scaled by the change in raw
 * power, since removing a vote also changes the average age it is weighted by
 * and no table records what that average was before.
 *
 * So this is an estimate, and the UI says so. It is the right estimate though:
 * a vote big enough to flip a seat under it is a vote worth looking at.
 */
export function wouldFlip(dao: Dao, votedFor: string[], weight: number): Flip | null {
  const seats = dao.council.length
  if (!seats || !weight || !votedFor.length) return null

  const standing = dao.candidates.filter((c) => c.is_active)
  if (standing.length <= seats) return null

  const now = Date.now()
  const voted = new Set(votedFor)
  const scored = standing.map((c) => {
    const raw = rawPower(c.total_vote_power, dao.precision)
    const decayed = decayedPower(c.rank, dao.precision, now)
    const without = voted.has(c.candidate_name) ? Math.max(0, raw - weight) : raw
    return {
      name: c.candidate_name,
      now: decayed,
      /* Scaled rather than recomputed: the rank encodes power AND vote age
         together, and the age this vote contributed is not recorded. */
      without: raw > 0 ? decayed * (without / raw) : 0,
    }
  })

  const top = (key: 'now' | 'without') =>
    [...scored].sort((a, b) => b[key] - a[key]).slice(0, seats).map((c) => c.name)

  const before = top('now')
  const after = top('without')
  const lost = before.find((n) => !after.includes(n))
  const gained = after.find((n) => !before.includes(n))
  return lost && gained ? { out: lost, in: gained } : null
}

/* ---------- thresholds and formatting ---------- */

/** A transfer worth noticing. */
export const BIG_AMOUNT = 10_000
/** A vote worth noticing. */
export const BIG_POWER = 100_000

export const fmtTokens = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 4 })

/** An unstake delay as people talk about it. */
export function fmtDelay(seconds: number): string {
  const days = seconds / 86_400
  const shown = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10
  return `${shown} day${shown === 1 ? '' : 's'}`
}
