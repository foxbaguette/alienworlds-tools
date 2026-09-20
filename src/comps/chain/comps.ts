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
import { getRows } from '../../dao/chain/nodes'

export const COMP_CONTRACT = 'comp.worlds'

/**
 * The states, in the order the contract runs them.
 *
 * Four of the five carry a numeric prefix — `1.playing`, `2.processing` — which
 * is the contract sorting them by name. `preparing` has none, so it sorts
 * first by accident rather than by design; the rank below is explicit so the UI
 * does not inherit that.
 */
export const COMP_STATES = ['preparing', '1.playing', '2.processing', '4.rewarding', '5.complete'] as const
export type CompState = (typeof COMP_STATES)[number] | string

export const COMP_LABEL: Record<string, string> = {
  preparing: 'preparing',
  '1.playing': 'playing',
  '2.processing': 'processing',
  '4.rewarding': 'rewarding',
  '5.complete': 'complete',
}

/** By what the state asks of a reader, matching the DAO chips. */
export const COMP_TONE: Record<string, string> = {
  preparing: 'wait',
  '1.playing': 'work',
  '2.processing': 'wait',
  '4.rewarding': 'go',
  '5.complete': 'done',
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
/** Still going somewhere, as against finished. */
export const isOpen = (c: CompRow) => c.state !== '5.complete'

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
