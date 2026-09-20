/**
 * Competitions — `comp.worlds`.
 *
 * A game runs a competition, players register against it, scores accrue, and at
 * the end a prize pool is split by the percentages the admin declares. Nothing
 * here belongs to a DAO: the admin is whatever account runs the game, which is
 * why it is its own section rather than a DAO tab.
 *
 * All competitions live in ONE scope (`comp.worlds`); the players and sponsors
 * of each live in a scope named after its numeric id.
 */
import { call, getRows } from '../../dao/chain/nodes'

export const COMP_CONTRACT = 'comp.worlds'

/**
 * The states, in the order the contract runs them:
 *
 *   preparing -> playing -> processing -> auditing -> rewarding -> complete
 *
 * All but `preparing` carry a numeric prefix, which is the contract sorting
 * them by name. `preparing` has none, so it sorts first by accident rather than
 * by design — the order below is explicit so nothing inherits that.
 *
 * `rejected`, `expired` and `deleting` are ends rather than steps: a
 * competition leaves the line rather than moving along it.
 */
export const COMP_STATES = [
  'preparing',
  '1.playing',
  '2.processing',
  '3.auditing',
  '4.rewarding',
  '5.complete',
] as const
export type CompState = (typeof COMP_STATES)[number] | string

export const AUDITING = '3.auditing'

export const COMP_LABEL: Record<string, string> = {
  preparing: 'preparing',
  '1.playing': 'playing',
  '2.processing': 'processing',
  '3.auditing': 'auditing',
  '4.rewarding': 'rewarding',
  '5.complete': 'complete',
  rejected: 'rejected',
  expired: 'expired',
  deleting: 'deleting',
}

/** By what the state asks of a reader, matching the DAO chips. */
export const COMP_TONE: Record<string, string> = {
  preparing: 'wait',
  '1.playing': 'work',
  '2.processing': 'wait',
  /* The one state that asks something of a person rather than of the clock. */
  '3.auditing': 'go',
  '4.rewarding': 'go',
  '5.complete': 'done',
  rejected: 'bad',
  expired: 'dead',
  deleting: 'bad',
}

export interface CompRow {
  id: number
  admin: string
  title: string
  description: string
  winnings_budget: string
  winnings_claimed: string
  winnings_allocated_perc_x_100: number
  admin_pay_perc_x_100: number
  shards_budget: number
  shards_claimed: number
  shards_allocated_perc_x_100: number
  start_time: string
  end_time: string
  min_players: number
  max_players: number
  num_players: number
  state: CompState
  notice: string
  extra_configs: { key: string; value: [string, unknown] }[]
}

export interface CompPlayer {
  player: string
  reward_perc_x_100: number
  shards_perc_x_100: number
  live_score: string
  claimed: number
}

export interface CompSponsor {
  sponsor: string
  reward: string
}

/** Percentages are stored times a hundred, so 2500 means 25%. */
export const pct = (v: number) => (Number(v) || 0) / 100

export const compTime = (s: string) => Date.parse(`${s}Z`)

/** An `extra_configs` value, which is a key to a [type, value] pair. */
export function extra(comp: CompRow, key: string): unknown {
  return comp.extra_configs?.find((e) => e.key === key)?.value?.[1]
}

export const compImage = (c: CompRow) => {
  const v = extra(c, 'image')
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null
}
export const compUrl = (c: CompRow) => {
  const v = extra(c, 'url')
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null
}

export const isLive = (c: CompRow) => c.state === '1.playing'
export const needsAudit = (c: CompRow) => c.state === AUDITING

/** Still going somewhere, as against finished one way or the other. */
const ENDED = new Set(['5.complete', 'rejected', 'expired', 'deleting'])
export const isOpen = (c: CompRow) => !ENDED.has(String(c.state))

/**
 * Whether a `preparing` competition is worth showing yet.
 *
 * They are created well ahead and then sit there for weeks, which buries
 * everything actually happening. One becomes interesting three days before its
 * planned start and stays so until an hour after it — past that without having
 * moved to playing, something is wrong with it and it is worth seeing again.
 */
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000
const ONE_HOUR = 60 * 60 * 1000

export function preparingIsNear(c: CompRow, now = Date.now()): boolean {
  const start = compTime(c.start_time)
  if (!Number.isFinite(start)) return true
  return start - now <= THREE_DAYS && now - start <= ONE_HOUR
}

/**
 * Whether the connected account can audit.
 *
 * `approve` and `reject` are authorised as `comp.worlds@auditor`, and that
 * permission is satisfied by three PUBLIC KEYS rather than by any account — so
 * being an auditor is not something an account name can be checked against. The
 * only honest test is whether a key on the connected account is one of them.
 *
 * Both sides are read from chain rather than hardcoded: the auditor set can
 * change without this app knowing, and a stale copy would either hide the
 * buttons from a real auditor or offer them to someone who cannot sign.
 */
export async function isAuditor(actor: string): Promise<boolean> {
  try {
    const [contract, user] = await Promise.all([
      call({ account_name: COMP_CONTRACT }, 'get_account'),
      call({ account_name: actor }, 'get_account'),
    ])

    const auditorKeys = new Set<string>(
      (contract.permissions ?? [])
        .filter((p: { perm_name: string }) => p.perm_name === 'auditor')
        .flatMap((p: { required_auth: { keys: { key: string }[] } }) => p.required_auth.keys.map((k) => k.key)),
    )
    if (!auditorKeys.size) return false

    for (const p of user.permissions ?? []) {
      for (const k of p.required_auth?.keys ?? []) {
        if (auditorKeys.has(k.key)) return true
      }
    }
    return false
  } catch (err) {
    console.error('Could not check the auditor keys:', err)
    return false
  }
}

/**
 * Auditing a competition.
 *
 * Authorised as `comp.worlds@auditor`, not as the signer's own account: the
 * permission belongs to the contract and is satisfied by the auditor's key. A
 * wallet without one of those keys is refused by the chain.
 */
export const auditAction = (id: number, verdict: 'approve' | 'reject', notice = '') => ({
  account: COMP_CONTRACT,
  name: verdict,
  authorization: [{ actor: COMP_CONTRACT, permission: 'auditor' }],
  data: verdict === 'approve' ? { id } : { id, notice },
})

export async function fetchComps(): Promise<CompRow[]> {
  const rows = await getRows<CompRow>({
    code: COMP_CONTRACT,
    scope: COMP_CONTRACT,
    table: 'comps',
    limit: 500,
  })
  /* Newest first: the id is a running number, so it is also the order they
     were created in. */
  return rows.sort((a, b) => Number(b.id) - Number(a.id))
}

export async function fetchPlayers(id: number): Promise<CompPlayer[]> {
  const rows = await getRows<CompPlayer>({
    code: COMP_CONTRACT,
    scope: String(id),
    table: 'players',
    limit: 1000,
  })
  return rows.sort((a, b) => Number(b.live_score) - Number(a.live_score))
}

export async function fetchSponsors(id: number): Promise<CompSponsor[]> {
  return getRows<CompSponsor>({ code: COMP_CONTRACT, scope: String(id), table: 'sponsors', limit: 200 })
}
