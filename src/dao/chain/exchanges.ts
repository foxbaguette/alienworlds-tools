import { historyGet, iso } from '../../chain/history'
import { STAKE_CONTRACT } from './stake'

/**
 * Governance tokens changing hands — `token.worlds::transfer`.
 *
 * Every planetary token lives on one contract, so a single stream carries all
 * twelve and the symbol is what separates them.
 *
 * The thing to get right is that most of the volume is NOT an exchange. Over a
 * two-day sample of a thousand transfers, 786 were mining rewards dripping out
 * of `theminergame` a couple of tokens at a time and another 22 were other
 * reward payouts — leaving about 190 that were somebody actually trading. A
 * feed that showed all of them would be a feed of mining rewards with the
 * interesting rows lost in it, so payouts are classified and hidden by default
 * rather than dropped: they are real, they are just not what this is for.
 *
 * The four kinds that ARE exchanges:
 *
 *   bought   stake.worlds -> player, "Voting tokens for stake" — TLM in
 *   sold     player -> stake.worlds, "Unstaking"               — TLM out
 *   swapped  to or from a DEX
 *   sent     one account to another, which is the rest
 */
export const TOKEN_CONTRACT = 'token.worlds'

/** Where the reward drip comes from. */
const PAYERS = new Set(['theminergame', 'rewards.mc', 'rewards.ale'])

/**
 * DEX accounts, by what they are rather than by a list that will go stale:
 * Alcor and Taco both name themselves in the account, and every swap they make
 * carries a `swap...` memo.
 */
const isDex = (account: string) => /alcor|taco|swap/i.test(account)

export type ExchangeKind = 'bought' | 'sold' | 'swapped' | 'sent' | 'payout'

export const KIND_LABEL: Record<ExchangeKind, string> = {
  bought: 'bought with TLM',
  sold: 'sold for TLM',
  swapped: 'swapped on a DEX',
  sent: 'sent',
  payout: 'reward payout',
}

/** Which way the row reads, for colour. */
export const KIND_TONE: Record<ExchangeKind, string> = {
  bought: 'go',
  sold: 'bad',
  swapped: 'work',
  sent: 'wait',
  payout: 'done',
}

export interface Exchange {
  /**
   * What makes this transfer distinct.
   *
   * NOT the action ordinal. A transfer notifies both parties, and an indexer
   * reports each notification as its own ordinal — so a DEX swap arrives two
   * or three times over, identically. The transaction plus who sent what to
   * whom collapses those; two genuinely different transfers in one
   * transaction, which is how a batch payout looks, still differ by `to`.
   */
  key: string
  at: number
  kind: ExchangeKind
  from: string
  to: string
  /** The token code — EYE, KAVUNN, NAR and so on. */
  symbol: string
  amount: number
  quantity: string
  memo: string
  /** The account whose exchange this is, which is not always `from`. */
  player: string
}

interface RawAction {
  trx_id: string
  action_ordinal: number
  timestamp: string
  act: {
    account: string
    name: string
    data: { from?: string; to?: string; quantity?: string; symbol?: string; amount?: number; memo?: string }
  }
}

function classify(from: string, to: string, memo: string): ExchangeKind {
  if (from === STAKE_CONTRACT) return 'bought'
  if (to === STAKE_CONTRACT) return 'sold'
  if (isDex(from) || isDex(to) || /^swapexact/i.test(memo)) return 'swapped'
  /* A payout is who sent it, not what the memo says: a reward memo on a peer
     transfer is somebody's joke, and a bare payout from one of these accounts
     is still a payout. */
  if (PAYERS.has(from)) return 'payout'
  return 'sent'
}

export async function fetchExchanges(since: number, limit = 500): Promise<Exchange[]> {
  const res = await historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
    'act.account': TOKEN_CONTRACT,
    'act.name': 'transfer',
    after: iso(since),
    limit,
    sort: 'desc',
  })

  const out: Exchange[] = []
  for (const a of res.actions ?? []) {
    const d = a.act.data
    const at = Date.parse(`${a.timestamp}Z`)
    const from = String(d.from ?? '')
    const to = String(d.to ?? '')
    const symbol = String(d.symbol ?? String(d.quantity ?? '').split(' ')[1] ?? '')
    if (!Number.isFinite(at) || !from || !to || !symbol) continue

    const memo = String(d.memo ?? '')
    const kind = classify(from, to, memo)
    out.push({
      key: `${a.trx_id}:${from}:${to}:${d.quantity ?? ''}`,
      at,
      kind,
      from,
      to,
      symbol,
      amount: Number(d.amount) || 0,
      quantity: String(d.quantity ?? ''),
      memo,
      /* On a buy the player is the receiver; on everything else the sender is
         the one who did something. */
      player: kind === 'bought' || kind === 'payout' ? to : from,
    })
  }
  return out
}

/** What counts as worth noticing. */
export const BIG_AMOUNT = 10_000
export const isBig = (e: Exchange) => e.amount >= BIG_AMOUNT
export const isExchange = (e: Exchange) => e.kind !== 'payout'

export const fmtAmount = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 4 })
