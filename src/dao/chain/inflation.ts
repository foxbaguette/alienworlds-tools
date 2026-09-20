import { historyGet } from '../../chain/history'
import type { Dao } from './daos'

/**
 * Where a union's money comes from.
 *
 * `inflt.worlds::claim(planet_name)` runs once a day per planet and splits that
 * day's inflation three ways — verified identical on two planets:
 *
 *     80%  m.federation      "Mining allocation"
 *     13%  <planet>.world    "Planet claim"
 *      7%  <planet>.wp.dac   "DAC claim"
 *
 * That last leg is the union's entire income: its proposal funds are filled by
 * a redirected share of its planet's inflation, and nothing else pays into
 * them. The share is READ from a real claim rather than hardcoded at 7%, so if
 * the contract is ever retuned the page follows it instead of lying.
 *
 * This needs history, not table state: the split exists only as transfers, and
 * nodes do not keep those.
 */
export interface Redirect {
  /** The account the share lands in — the union's proposal funds. */
  to: string
  /** The planet whose inflation is being split. */
  planet: string | null
  /** That share as a percentage of the day's whole inflation. */
  percent: number | null
  /** TLM a day, averaged over the claims seen. */
  perDay: number
  /** How many daily claims that average is over. */
  days: number
}

interface HistoryAction {
  trx_id: string
  timestamp: string
  act: { name: string; data: { from?: string; to?: string; amount?: number; memo?: string } }
}

const CLAIM_MEMO = 'DAC claim'

/**
 * The redirect feeding one union, or null if it cannot be established.
 *
 * Two reads: the recent claims into the treasury, which give the daily amount,
 * and the transaction behind the newest of them, which gives the share. The
 * second one is what turns "2,162 TLM landed" into "7% of the day's inflation".
 */
export async function fetchRedirect(dao: Dao): Promise<Redirect | null> {
  const to = dao.treasury
  if (!to) return null

  const recent = await historyGet<{ actions?: HistoryAction[] }>('/v2/history/get_actions', {
    account: to,
    filter: '*:transfer',
    limit: 40,
    sort: 'desc',
  }).catch(() => null)

  const claims = (recent?.actions ?? []).filter(
    (a) => a.act.data.to === to && a.act.data.memo === CLAIM_MEMO && Number(a.act.data.amount) > 0,
  )
  if (!claims.length) return null

  /* One claim a day, so the mean of what we have is the daily rate. Averaged
     rather than taken from the newest: the amount drifts a little day to day
     with the planet's stake, and one day is a noisier answer than seven. */
  const window = claims.slice(0, 7)
  const perDay = window.reduce((n, a) => n + Number(a.act.data.amount ?? 0), 0) / window.length

  /* The share, from the transaction the newest claim was part of. */
  let percent: number | null = null
  let planet: string | null = null
  const trx = await historyGet<{ actions?: HistoryAction[] }>('/v2/history/get_transaction', {
    id: claims[0].trx_id,
  }).catch(() => null)

  if (trx?.actions) {
    let total = 0
    let share = 0
    for (const a of trx.actions) {
      if (a.act.name === 'claim') {
        const p = (a.act.data as { planet_name?: string }).planet_name
        if (p) planet = p
        continue
      }
      if (a.act.name !== 'transfer' || a.act.data.from !== 'inflt.worlds') continue
      const amt = Number(a.act.data.amount ?? 0)
      total += amt
      if (a.act.data.to === to) share = amt
    }
    if (total > 0 && share > 0) percent = (share / total) * 100
  }

  return { to, planet, percent, perDay, days: window.length }
}
