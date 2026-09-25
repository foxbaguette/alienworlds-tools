import { call, getPage } from './nodes'
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
 * The ceiling, and why it is read rather than written down.
 *
 * `pltdtapset` checks the rate against a limit that exists nowhere but inside
 * the contract — no table row carries it, no action reports it. The one honest
 * source is the deployed code itself, which holds the assert's message:
 *
 *   ERR::INVALID_CLAIM_RATE::Claim rate must be between 0 and 45%
 *
 * It read 35% until m.federation was redeployed, which is the whole argument
 * against a constant: a stale one does not fail loudly, it quietly refuses
 * proposals the chain would have taken.
 *
 * The code is a quarter of a megabyte, so it is downloaded only when its hash
 * is one that has not been decoded before. Normally this costs one small call.
 */
const LIMIT_RE = /Claim rate must be between 0 and ([\d.]+)\s*%/
const LIMIT_KEY = 'aw.dao.tapMax.'

/** Used only when the chain cannot be reached — the last value seen there. */
export const TAP_MAX_FALLBACK_X100 = 4500

const remembered = (hash: string): number | null => {
  try {
    const v = Number(localStorage.getItem(LIMIT_KEY + hash))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

async function readTapMax(): Promise<number> {
  const hash = (await call({ account_name: FEDERATION }, 'get_code_hash'))?.code_hash as string | undefined
  const known = hash ? remembered(hash) : null
  if (known) return known

  /* atob yields one character per byte, which is all a string search needs. */
  const wasm = (await call({ account_name: FEDERATION }, 'get_raw_code_and_abi'))?.wasm as string | undefined
  const m = wasm ? LIMIT_RE.exec(atob(wasm)) : null
  if (!m) throw new Error('no claim-rate assert in m.federation')

  const x100 = Math.round(Number(m[1]) * 100)
  if (!Number.isFinite(x100) || x100 <= 0) throw new Error(`unreadable ceiling "${m[1]}"`)
  if (hash) {
    try {
      localStorage.setItem(LIMIT_KEY + hash, String(x100))
    } catch {
      /* Private browsing: costs a download next time, nothing worse. */
    }
  }
  return x100
}

let ceiling: Promise<number> | null = null

/** The most the contract will accept, times a hundred. Read once per session. */
export function fetchTapMax(): Promise<number> {
  ceiling ??= readTapMax().catch((err) => {
    console.error('tap ceiling:', err)
    return TAP_MAX_FALLBACK_X100
  })
  return ceiling
}

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
