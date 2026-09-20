/**
 * The DAO directory, and the council seated on each one.
 *
 * Two reads:
 *
 *   index.worlds / dacs                 the directory of DAOs
 *   <CUSTODIAN> / custodians1 @ dac_id  the council seated on one of them
 *
 * The custodian contract is not hardcoded. Each directory row carries an
 * `accounts` map keyed by role, and role 2 is CUSTODIAN — today every DAO
 * points at dao.worlds, but the directory is what decides that.
 */
import { getPage, getRows, pinned, start } from './nodes'

export const DIRECTORY = 'index.worlds'
export const TLM_CONTRACT = 'alien.worlds'
export const TLM_SYMBOL = 'TLM'

/*
 * dacdir::account_type. The two that matter here:
 *
 *   TREASURY  (1)  present on syndicates, absent on unions — see `classify`
 *   CUSTODIAN (2)  the contract each DAO's council lives in
 *
 * And the two a DAO can actually spend from, which differ by group for a reason
 * dacdirectory_shared.hpp states itself:
 *
 *   SPENDINGS         (11)  "the spending allowance for the current period"
 *   PROP_FUNDS_SOURCE (13)  "...to ensure that the union daos have spending
 *                            access but the syndicates only have deposit access"
 *
 * So 13 is registered on the unions and nothing else, and 11 is the syndicate's
 * own. Preferring 13 and falling back to 11 asks the directory which account
 * this DAO may spend from, instead of assembling names out of the DAO id.
 */
const TREASURY = 1
const CUSTODIAN = 2
const SPENDINGS = 11
const PROP_FUNDS_SOURCE = 13

/** Scratch DAOs, registered exactly like the real ones. A curation choice. */
const HIDDEN = new Set(['testa', 'testb'])

/**
 * Accounts to watch, and how many seats on one council it takes before that
 * council is marked. Nothing on chain says these are related — it is a
 * hand-supplied list, and the marker means "these accounts hold this many
 * seats", nothing more.
 */
export const WATCHED = new Set(['5thba.wam', '42lra.wam', 't1dbe.wam', 'fgaqa.c.wam', 'im24u.c.wam'])
export const CONTROL_THRESHOLD = 3

/**
 * Whether an account is Mission Control's.
 *
 * Known two different ways, and the difference matters.
 *
 * The `.mc` suffix is CONCLUSIVE. An Antelope name with a suffix can only be
 * created by the account owning that suffix, so `vote1.mc`, `rewards.mc` and
 * `shards.mc` are Mission Control's by construction rather than by assumption
 * — no list to maintain, and a new one is recognised the day it appears.
 *
 * The wallets in WATCHED are not. Nothing on chain relates them; that half is
 * hand-supplied and no more reliable than whoever supplied it.
 */
export const isMissionControl = (name: string) => WATCHED.has(name) || /\.mc$/.test(name)

export type DaoGroup = 'syndicate' | 'union'

export interface CouncilSeat {
  cust_name: string
  rank: string
  total_vote_power: string
  number_voters: number
  avg_vote_time_stamp: string
}

export interface CandidateRow {
  candidate_name: string
  rank: string
  total_vote_power: string
  number_voters: number
  is_active: number
  avg_vote_time_stamp: string
}

export interface Dao {
  id: string
  title: string
  owner: string | null
  group: DaoGroup
  symbol: string
  precision: number
  tokenContract: string | null
  custodianContract: string | null
  /** Where this DAO's own money sits — see PROP_FUNDS_SOURCE above. */
  treasury: string | null
  tlm: string | null
  council: CouncilSeat[]
  custodians: string[]
  candidates: CandidateRow[]
  /** Candidate name to whether it is still standing, which is what votecust checks. */
  standing: Map<string, boolean>
  nextElection: number | null
  periodLength: number | null
  approvalThreshold: number
  /** Seated now, but below the cut on today's ranking. */
  atRisk: Set<string>
  wouldSeat: string[]
  rankOf: Map<string, number>
  error: string | null
}

interface DirectoryRow {
  dac_id: string
  title: string
  owner?: string
  symbol?: { sym?: string; contract?: string }
  accounts: { key: number; value: string }[]
}

/**
 * Syndicates hold a treasury; unions do not. A real functional difference the
 * directory encodes rather than a naming convention — and it agrees exactly
 * with the titles, which end in "Union" on the same six rows.
 */
const classify = (keys: number[]): DaoGroup => (keys.includes(TREASURY) ? 'syndicate' : 'union')

const assetCode = (a: string | null | undefined) => String(a ?? '').split(' ')[1] ?? ''

async function loadOne(row: DirectoryRow): Promise<Dao> {
  const accounts: Record<number, string> = {}
  for (const a of row.accounts) accounts[a.key] = a.value
  const [precision, code] = String(row.symbol?.sym ?? '').split(',')

  const dao: Dao = {
    id: row.dac_id,
    title: row.title || row.dac_id,
    owner: row.owner ?? null,
    group: classify(row.accounts.map((a) => a.key)),
    symbol: code ?? '',
    precision: Number(precision) || 0,
    tokenContract: row.symbol?.contract ?? null,
    custodianContract: accounts[CUSTODIAN] ?? null,
    treasury: accounts[PROP_FUNDS_SOURCE] ?? accounts[SPENDINGS] ?? null,
    tlm: null,
    council: [],
    custodians: [],
    candidates: [],
    standing: new Map(),
    nextElection: null,
    periodLength: null,
    approvalThreshold: 3,
    atRisk: new Set(),
    wouldSeat: [],
    rankOf: new Map(),
    error: null,
  }

  if (!dao.custodianContract) {
    dao.error = 'no custodian contract registered'
    return dao
  }

  try {
    /*
     * Who sits now, who would sit if a period ran this second, and when that is
     * due. The first two are compared against each other, so they come from one
     * node: split across a block boundary they can disagree and invent an
     * at-risk seat that is not at risk.
     *
     * The treasury balance rides along on the same node. It has nothing to
     * agree with, but it is a fourth read that would otherwise cost a second
     * round trip per DAO.
     */
    const [seated, allCands, globals, tlmRows] = await pinned(4, (url) => [
      getRows<CouncilSeat>({ code: dao.custodianContract!, scope: dao.id, table: 'custodians1', limit: 100 }, url),
      /* The whole table, not a page of the `bydecayed` index: 85 rows at its
         largest, one call either way, and the inactive rows are what make a
         vote that can no longer be cast recognisable. `bydecayed` is literally
         `UINT64_MAX - rank`, so sorting by rank below is the same order. */
      getRows<CandidateRow>({ code: dao.custodianContract!, scope: dao.id, table: 'candidates', limit: 500 }, url),
      getPage<{ data: { key: string; value: [string, unknown] }[] }>(
        { code: dao.custodianContract!, scope: dao.id, table: 'dacglobals', limit: 1 },
        url,
      ),
      dao.treasury
        ? getRows<{ balance: string }>(
            { code: TLM_CONTRACT, scope: dao.treasury, table: 'accounts', limit: 20 },
            url,
          ).catch(() => [])
        : Promise.resolve([]),
    ] as const)

    /*
     * A node under pressure answers with an empty `rows` array instead of an
     * error, and that renders as fact — "no custodians seated" — rather than as
     * a problem. It cannot be caught in general, since plenty of tables are
     * legitimately empty, but a DAO with no council AND no candidates AND no
     * globals does not exist. Throwing sends the whole group to another node.
     */
    if (!seated.length && !allCands.length && !globals.length) {
      throw new Error(`${dao.id}: empty council, candidates and globals in one read`)
    }

    dao.tlm = tlmRows.map((r) => r.balance).find((b) => assetCode(b) === TLM_SYMBOL) ?? null

    const g: Record<string, unknown> = {}
    for (const kv of globals[0]?.data ?? []) g[kv.key] = kv.value?.[1]

    const last = Date.parse(`${g.lastperiodtime}Z`)
    const length = Number(g.periodlength)
    dao.nextElection = Number.isFinite(last) && Number.isFinite(length) && length > 0 ? last + length * 1000 : null
    dao.periodLength = Number.isFinite(length) ? length : null
    /* The owner's "active" permission just delegates to "high" with a threshold
       of 1, so "high" is the real bar a msig proposal has to clear. */
    dao.approvalThreshold = Number(g.auth_threshold_high) || 3

    dao.council = [...seated].sort((a, b) => Number(b.rank) - Number(a.rank))
    dao.custodians = dao.council.map((c) => c.cust_name)
    dao.candidates = allCands
    dao.standing = new Map(allCands.map((c) => [c.candidate_name, !!Number(c.is_active)]))

    /* newperiod walks the ranked index, skips inactive candidates, requires
       vote power above zero, and stops at the seat count. */
    const ranked = [...allCands].sort((a, b) => Number(b.rank) - Number(a.rank))
    const contenders = ranked.filter((c) => c.is_active && Number(c.total_vote_power) > 0)
    dao.wouldSeat = contenders.slice(0, dao.council.length).map((c) => c.candidate_name)
    dao.rankOf = new Map(contenders.map((c, i) => [c.candidate_name, i + 1]))
    dao.atRisk = contenders.length
      ? new Set(dao.custodians.filter((n) => !dao.wouldSeat.includes(n)))
      : new Set()
  } catch (err) {
    dao.error = err instanceof Error ? err.message : String(err)
  }

  return dao
}

/** Runs `fn` over `items` a few at a time; workers pull from a shared cursor. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Every DAO, reported as it lands rather than all at once at the end. The last
 * one does not arrive any sooner, but the first does — by seconds — and a page
 * that fills in is a page that is working.
 */
export async function loadDaos(onProgress?: (daos: Dao[]) => void): Promise<Dao[]> {
  if (!(await start())) throw new Error('No WAX node answered.')

  const directory = await getRows<DirectoryRow>({
    code: DIRECTORY,
    scope: DIRECTORY,
    table: 'dacs',
    limit: 200,
  })

  const wanted = directory.filter((row) => !HIDDEN.has(row.dac_id))
  const done: Dao[] = []

  await mapLimit(wanted, 16, async (row) => {
    const dao = await loadOne(row)
    done.push(dao)
    done.sort((a, b) => a.title.localeCompare(b.title))
    onProgress?.([...done])
    return dao
  })

  return done
}

export const heldByWatched = (dao: Dao) => dao.custodians.filter((n) => WATCHED.has(n)).length
export const isMcControlled = (dao: Dao) => heldByWatched(dao) >= CONTROL_THRESHOLD
