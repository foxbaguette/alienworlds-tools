import { awTransfersFor } from '@/chain/collections'
import { historyGet, historyTime } from '@/chain/history'
import { getAllRows } from '@/chain/rpc'
import type { CustodyDef } from './defs'

/**
 * Alien Worlds NFTs a project has been lent, and what they are doing there.
 *
 * Planetary Defense runs on its own NFTs — 8,778 `planetdefnft` assets have
 * passed through its custody against 61 from `alien.worlds` — so the question
 * a gHubs report asks is not how many NFTs it holds but how many of them are
 * Alien Worlds'. That is the figure here, and nothing else is counted.
 *
 * Two numbers, because for Alien Worlds NFTs they are nothing like each other.
 * An asset is first staked into the contract's custody, and only then put into
 * a division, which is where it actually fights. Of its own NFTs the project
 * has 7,141 of 7,629 in a division; of Alien Worlds' it has 6 of 58. Reporting
 * the one as the other would overstate what is in play ninefold.
 *
 * It is reconstructed rather than sampled, from two reads of different kinds:
 *
 *   Which assets, and when, comes from AtomicAssets — asked for one
 *   collection's transfers in and out of the holding account, which is twelve
 *   rows for the whole of history and one request. Chain history cannot be
 *   asked this: an atomicassets transfer names asset ids and nothing else, so
 *   finding the same twelve there means reading all eleven thousand transfers
 *   the account has ever made and then looking up the collection of nearly
 *   nine thousand distinct assets to discard nine in ten of them. That worked
 *   and agreed exactly with this, at two hundred seconds a run against five.
 *
 *   Whether an asset is in a division cannot come from a transfer at all —
 *   joining one moves nothing. It is a field on the contract's row for that
 *   asset, so it means that row's own history: one `get_deltas`, oldest
 *   first, is an asset's whole life. Sixty-one of them covers every Alien
 *   Worlds NFT ever staked here.
 *
 * Rebuilt in full on every run rather than accumulated. This is a derivation
 * from a handful of complete timelines, not a day sampled as it passed, so
 * there is nothing to lose by doing it again — and the check at the end
 * refuses the result unless the reconstruction's "now" is what the chain says
 * now, which is the one thing a short read could not fake.
 */
export interface CustodyDay {
  date: string
  /** Alien Worlds NFTs in the project's custody at the end of the UTC day. */
  staked: number
  /** How many of those were in a division, which is where they are of use. */
  divisions: number
}

interface StakeDelta {
  timestamp: string
  present?: number
  data?: { division_id?: number | string }
}

export interface Change {
  at: number
  id: string
  present: boolean
  division: number
}

/**
 * One asset's whole life in the contract's table, oldest change first.
 *
 * `present` is what says whether it is still there. A row being deleted is a
 * delta like any other and still carries the row's last contents, so an asset
 * taken back out goes on holding its division forever if it is not checked —
 * the same trap that had the alpha's wiped players holding gems for months.
 */
async function rowHistory(def: CustodyDef, owner: string, assetId: string): Promise<Omit<Change, 'id'>[]> {
  const page = await historyGet<{ deltas?: StakeDelta[] }>('/v2/history/get_deltas', {
    code: def.account,
    scope: owner,
    table: def.table,
    primary_key: assetId,
    limit: 200,
    sort: 'asc',
  })
  return (page.deltas ?? []).map((d) => ({
    at: historyTime(d.timestamp),
    present: d.present !== 0,
    division: Number(d.data?.division_id) || 0,
  }))
}

/** The state of a set of assets, as a walked timeline leaves it. */
function tally(state: Map<string, { present: boolean; division: number }>) {
  let staked = 0
  let divisions = 0
  for (const row of state.values()) {
    if (!row.present) continue
    staked++
    if (row.division > 0) divisions++
  }
  return { staked, divisions }
}

/**
 * A sorted timeline of row changes, as one figure per UTC day.
 *
 * Each day takes every change up to its own midnight and then reads the state
 * off — so a day shows what was held when it ended, which is what makes two
 * days comparable however the moves fell within them. Kept apart from the
 * reading above because this is where the mistakes would be: a boundary an
 * hour out, or a deleted row still counted.
 */
export function custodyDays(since: string, until: string, timeline: Change[]): CustodyDay[] {
  const from = Date.parse(since + 'T00:00:00Z')
  const end = Date.parse(until + 'T00:00:00Z') + 86_400_000
  const sorted = [...timeline].sort((a, b) => a.at - b.at)
  const state = new Map<string, { present: boolean; division: number }>()
  const days: CustodyDay[] = []
  let next = 0

  /* Anything from before the span still counts: an asset staked in June and
     left alone is held every day after it, with no change of its own to find
     inside the window. */
  for (let t = from; t < end; t += 86_400_000) {
    const dayEnd = t + 86_400_000
    while (next < sorted.length && sorted[next].at < dayEnd) {
      const c = sorted[next++]
      state.set(c.id, { present: c.present, division: c.division })
    }
    days.push({ date: new Date(t).toISOString().slice(0, 10), ...tally(state) })
  }
  return days
}

/** Where a timeline leaves things once every change in it has happened. */
export function custodyNow(timeline: Change[]): { staked: number; divisions: number } {
  const state = new Map<string, { present: boolean; division: number }>()
  for (const c of [...timeline].sort((a, b) => a.at - b.at)) {
    state.set(c.id, { present: c.present, division: c.division })
  }
  return tally(state)
}

/** What the contract's table says right now, for the assets that matter. */
async function liveCustody(def: CustodyDef, owners: Iterable<string>, wanted: Set<string>) {
  let staked = 0
  let divisions = 0
  const counted = new Set<string>()
  for (const owner of owners) {
    const rows = await getAllRows<{ asset_id: string; division_id: number | string }>({
      code: def.account,
      scope: owner,
      table: def.table,
      limit: 1000,
    })
    for (const r of rows) {
      const id = String(r.asset_id)
      /* An asset sits in one owner's scope at a time, but it has been in more
         than one over its life, so a second sighting would double-count it. */
      if (!wanted.has(id) || counted.has(id)) continue
      counted.add(id)
      staked++
      if (Number(r.division_id) > 0) divisions++
    }
  }
  return { staked, divisions }
}

export interface Custody {
  days: CustodyDay[]
  /** Alien Worlds NFTs ever staked here, so a caller can report the scale. */
  assets: number
}

/**
 * Every day from `since` to `until` inclusive, as Alien Worlds NFTs held.
 *
 * Throws rather than returning a series it cannot vouch for. A wrong level is
 * worse than a missing one here: it reads as a fact about the Alien Worlds
 * economy, and nobody looking at the chart could tell.
 */
export async function fetchCustody(def: CustodyDef, since: string, until: string): Promise<Custody> {
  /*
    Every one of them, over all time — not just the span reported on.

    The days end at the last one asked for, but the check at the bottom is
    against the contract's table as it stands now, so anything staked since has
    to be in the timeline too or the two could not agree. And an asset staked
    before the span is held on every day of it with no change inside the window
    to find. Twelve rows either way.
  */
  const moves = await awTransfersFor(def.account)

  /* Who staked each of them. An asset can be staked by one account, taken back
     and staked by another, so every owner it has had is read — the row lives
     in the staker's scope, and the wrong scope answers emptily. */
  const aw = new Set<string>()
  const owners = new Map<string, Set<string>>()
  for (const m of moves) {
    const party = m.to === def.account ? m.from : m.to
    if (!party) continue
    for (const id of m.assetIds) {
      aw.add(id)
      if (!owners.has(id)) owners.set(id, new Set())
      owners.get(id)!.add(party)
    }
  }

  /*
    Four at a time. One at a time is sixty-one round trips in a queue, which
    took six minutes on a pool where most servers were refusing us; all at once
    is a burst of sixty-one, which is how a pool starts refusing. Four is quick
    and is still a quieter neighbour than any other step here.
  */
  const jobs: { id: string; owner: string }[] = []
  for (const [id, had] of owners) for (const owner of had) jobs.push({ id, owner })

  const timeline: Change[] = []
  for (let i = 0; i < jobs.length; i += 4) {
    const batch = await Promise.all(
      jobs.slice(i, i + 4).map((j) => rowHistory(def, j.owner, j.id).then((rows) => ({ id: j.id, rows }))),
    )
    for (const got of batch) for (const change of got.rows) timeline.push({ ...change, id: got.id })
  }
  const days = custodyDays(since, until, timeline)

  /*
    The gate. Taking the timeline all the way to its end — today's changes
    included, past the last day reported — leaves the contract's table as it
    stands, and the table can simply be read. If the two disagree the
    reconstruction is wrong somewhere, and the only safe thing is to keep none
    of it: a history server that answered short would otherwise write a quiet,
    permanent understatement into every day, and days are kept for good.
  */
  const rebuilt = custodyNow(timeline)
  const everyOwner = new Set([...owners.values()].flatMap((s) => [...s]))
  const live = await liveCustody(def, everyOwner, aw)
  if (live.staked !== rebuilt.staked || live.divisions !== rebuilt.divisions) {
    throw new Error(
      `${def.account}: rebuilt ${rebuilt.staked} staked and ${rebuilt.divisions} in divisions, ` +
        `the chain holds ${live.staked} and ${live.divisions}`,
    )
  }

  return { days, assets: aw.size }
}
