import { getPage } from './nodes'
import type { ChainAction } from './act'
import type { Dao } from './daos'

/**
 * The planet tap — `m.federation::pltdtapset`, one row per planet.
 *
 * A union's INCOME is its share of inflation (see inflation.ts). This is the
 * other direction: a standing order that skims a percentage off its planet's
 * mining rewards and pipes it to somebody else. Every planet has one and all
 * six are pointed at a game — Neri, Kavian and Veles at `rewards.mc`, Naron at
 * `theminergame`, Magor at `magordefense`, Eyeke at `beekeeperone`.
 *
 * The money does not move when it is skimmed. It piles up in `claim_bucket`
 * until the destination calls `pltdtapclaim`, so a bucket says how long it has
 * been since anyone collected rather than how much is owed.
 *
 * Only the planet's union can change it: every `pltdtapset` on chain is signed
 * by `<planet>.unn.dac@active`, which means a council multisig — see propose.ts.
 */
export const FEDERATION = 'm.federation'

/**
 * The ceiling, quoted from the contract's own assert:
 *
 *   ERR::INVALID_CLAIM_RATE::Claim rate must be between 0 and 35%
 *
 * Stored times a hundred, so 3500 is 35%. Every planet is already at it.
 */
export const TAP_MAX_X100 = 3500

export interface Tap {
  /** The planet being skimmed, e.g. `eyeke.world`. */
  planet: string
  /** Where the skim goes, or null if the tap has never been pointed anywhere. */
  destination: string | null
  /** The share, times a hundred: 3500 is 35%. */
  rateX100: number
  /** TLM skimmed but not yet collected by the destination. */
  bucket: number
}

/**
 * The planet a union governs.
 *
 * From the dac_id rather than from a lookup: the directory names every union
 * `<planet>unn` and nothing else on it carries the planet. The treasury cannot
 * be used — Kavian's is `kavan.wp.dac`, which is not a planet name.
 */
export function planetOf(dao: Dao): string | null {
  if (dao.group !== 'union') return null
  const m = /^(.+)unn$/.exec(dao.id)
  return m ? `${m[1]}.world` : null
}

/** The tap on one planet, or null if there is no row for it. */
export async function fetchTap(planet: string): Promise<Tap | null> {
  const rows = await getPage<{ data: { key: string; value: [string, unknown] }[] }>({
    code: FEDERATION,
    scope: planet,
    table: 'pltdtapconf',
    limit: 1,
  })

  /* A singleton of key/value variants, the same shape as dacglobals: each
     value arrives as [type, value] and only the value is wanted. */
  const kv = rows[0]?.data
  if (!kv) return null
  const c: Record<string, unknown> = {}
  for (const p of kv) c[p.key] = p.value?.[1]

  return {
    planet,
    destination: (c.claim_destination as string) || null,
    rateX100: Number(c.claim_rate_perc_x100) || 0,
    bucket: Number(String(c.claim_bucket ?? '').split(' ')[0]) || 0,
  }
}

/**
 * Point the tap somewhere, or change its rate.
 *
 * One action sets both — there is no way to move the destination without
 * restating the rate — so a form for this has to carry the current rate even
 * when only the destination is being changed.
 */
export const tapSetAction = (
  authorization: ChainAction['authorization'],
  planet: string,
  rateX100: number,
  destination: string,
): ChainAction => ({
  account: FEDERATION,
  name: 'pltdtapset',
  authorization,
  data: { planet_name: planet, claim_rate_perc_x100: rateX100, destination },
})

/** 3500 reads as "35%", and 3250 as "32.5%". */
export const fmtRate = (x100: number): string => {
  const pct = x100 / 100
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2).replace(/0$/, '')}%`
}
