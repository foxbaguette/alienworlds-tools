import { getRows } from './nodes'
import { decayedPower, rawPower } from '../format'
import { assetUnits } from './stake'
import { STAKEVOTE_CONTRACT, TOKEN_CONTRACT } from './activity'
import type { Dao } from './daos'

/**
 * Who would take the seats if a period ran right now.
 *
 * The chain seats candidates on the DECAYED figure — the raw vote power halved
 * for every thirty days of vote age — so that is what the order here is. The
 * raw figure is carried alongside because the two come apart badly: a
 * candidate can hold twice the support of the one above them and still sit
 * below, on nothing but the age of the votes.
 *
 * Each candidate's own position is three separate things and they are worth
 * keeping separate:
 *
 *   held         what they have, which buys nothing on its own
 *   staked       what actually votes
 *   multiplier   what the unstake delay does to it, 1 up to 9
 *
 * A candidate holding a million tokens with none of them staked has no vote of
 * their own at all, and that is invisible from the vote power alone.
 */
export interface Standing {
  name: string
  /** What the chain seats on: raw power, aged. */
  power: number
  /** The sum of the balances behind them, undecayed. */
  raw: number
  voters: number
  /** Their own balance of this DAC's token, staked included. */
  held: number
  /** How much of that is staked, which is the part that votes. */
  staked: number
  /** Their unstake delay, in seconds. */
  delay: number
  /** What that delay multiplies their stake by, 1 to 1 + time_multiplier. */
  multiplier: number
  /** Already holds a seat. */
  seated: boolean
}

export interface Standings {
  /** The seats, in the order they would be filled. */
  elected: Standing[]
  /** The next one down — who takes a seat if anything moves. */
  next: Standing | null
  /** How many seats there are. */
  seats: number
  /** The gap between the last seat and the first miss, in vote power. */
  margin: number
}

/**
 * The delay multiplier, from the same three numbers the contract uses.
 *
 * Confirmed against `stkvt.worlds/weights`: an account with 300,000 staked at
 * the maximum delay carries 2,700,000 of weight, and one at the minimum delay
 * carries 1.0111 times its stake — which is 1 + 8 * 172800 / 15552000.
 */
export const multiplierFor = (delay: number, maxDelay: number, timeMultiplier: number) =>
  maxDelay > 0 ? 1 + (timeMultiplier * delay) / maxDelay : 1

/** One council at a glance, for the view that shows all of them. */
export interface Glance {
  dao: Dao
  seats: number
  /** In the order they would be filled. */
  elected: string[]
  /** The first candidate who would miss out. */
  next: string | null
  /** Vote power between the last seat and that first miss. */
  margin: number
  /** Would take a seat today without holding one. */
  incoming: string[]
  /** Holds a seat today and would lose it. */
  leaving: string[]
}

/**
 * Every council, without a single read.
 *
 * The candidates and their ranks arrive with the directory, and the seating
 * order is a sort of what is already in hand — so the overview costs nothing,
 * and only looking INTO one council pays for the balances and delays.
 */
export function glanceAll(daos: Dao[], now = Date.now()): Glance[] {
  return daos.map((dao) => {
    const seats = dao.council.length || 5
    const ranked = dao.candidates
      .filter((c) => c.is_active)
      .map((c) => ({ name: c.candidate_name, power: decayedPower(c.rank, dao.precision, now) }))
      .sort((a, b) => b.power - a.power)

    const elected = ranked.slice(0, seats)
    const next = ranked[seats] ?? null
    const names = elected.map((c) => c.name)
    return {
      dao,
      seats,
      elected: names,
      next: next?.name ?? null,
      margin: next && elected.length ? elected[elected.length - 1].power - next.power : 0,
      incoming: names.filter((n) => !dao.custodians.includes(n)),
      leaving: dao.custodians.filter((n) => !names.includes(n)),
    }
  })
}

export async function fetchStandings(dao: Dao): Promise<Standings> {
  const seats = dao.council.length || 5
  const token = dao.tokenContract ?? TOKEN_CONTRACT

  const [stakes, times, config, voteConfig] = await Promise.all([
    getRows<{ account: string; stake: string }>({
      code: token,
      scope: dao.id,
      table: 'stakes',
      limit: 1000,
    }).catch(() => []),
    getRows<{ account: string; delay: number }>({
      code: token,
      scope: dao.id,
      table: 'staketime',
      limit: 1000,
    }).catch(() => []),
    getRows<{ min_stake_time: number; max_stake_time: number }>({
      code: token,
      scope: dao.id,
      table: 'stakeconfig',
      limit: 1,
    }).catch(() => []),
    getRows<{ time_multiplier: number }>({
      code: STAKEVOTE_CONTRACT,
      scope: dao.id,
      table: 'config',
      limit: 1,
    }).catch(() => []),
  ])

  const minDelay = Number(config[0]?.min_stake_time) || 0
  const maxDelay = Number(config[0]?.max_stake_time) || 0
  const timeMultiplier = Number(voteConfig[0]?.time_multiplier) || 0

  const staked = new Map(stakes.map((s) => [s.account, assetUnits(s.stake)]))
  /* No staketime row means the contract's own floor, not zero. */
  const delays = new Map(times.map((t) => [t.account, Number(t.delay)]))

  /* Every standing candidate's balance, in one read each — `accounts` is
     scoped by the holder, so this is six reads rather than six per token. */
  const standing = dao.candidates.filter((c) => c.is_active)
  const balances = await Promise.all(
    standing.map((c) =>
      getRows<{ balance: string }>({ code: token, scope: c.candidate_name, table: 'accounts', limit: 100 })
        .then((rows) => rows.find((r) => String(r.balance).split(' ')[1] === dao.symbol)?.balance ?? null)
        .catch(() => null),
    ),
  )

  const now = Date.now()
  const rows: Standing[] = standing.map((c, i) => {
    const delay = delays.get(c.candidate_name) ?? minDelay
    return {
      name: c.candidate_name,
      power: decayedPower(c.rank, dao.precision, now),
      raw: rawPower(c.total_vote_power, dao.precision),
      voters: Number(c.number_voters) || 0,
      held: assetUnits(balances[i]) / 10 ** dao.precision,
      staked: (staked.get(c.candidate_name) ?? 0) / 10 ** dao.precision,
      delay,
      multiplier: multiplierFor(delay, maxDelay, timeMultiplier),
      seated: dao.custodians.includes(c.candidate_name),
    }
  })

  rows.sort((a, b) => b.power - a.power)
  const elected = rows.slice(0, seats)
  const next = rows[seats] ?? null
  return {
    elected,
    next,
    seats,
    margin: next && elected.length ? elected[elected.length - 1].power - next.power : 0,
  }
}
