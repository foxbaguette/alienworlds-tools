/**
 * Collect finished UTC days into public/data/.
 *
 *   npm run collect                     every finished day not collected yet
 *   npm run collect -- --redo 2         and re-read the last two days
 *   npm run collect -- --only pools     just one of: activity, pools, landclaims, projects
 *   npm run collect -- --only projects --project mc   one project
 *
 * `landclaims` adds landowners' land claims to pool days collected before
 * the collector read them; new days include them already.
 *
 * Three files, each written after every day so a stopped run keeps what it got:
 *
 *   daily.json        player activity: the stat-change log
 *                     (`players.ale::updpermstat` + `updpstatmap`), summarised
 *   players-daily.json  the same log, per player, for the Stats report
 *   pools-daily.json  reward-pool payments, traced to their pools and folded
 *                     into one row per pool, player, kind and payer; plus each
 *                     pool's balance at the end of the day
 *
 * Only finished days are collected; the site reads the current day live.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchStatChanges, statFromCounters } from '../src/activity/queries'
import {
  dateRange,
  dayOf,
  dayStart,
  DAY_MS,
  LAUNCH,
  mergeDays,
  summariseDay,
  summarisePlayers,
  type DailyFile,
  type PlayersDailyFile,
} from '../src/activity/rules'
import { fetchBalanceAt, fetchClaimedPayouts, fetchPoolActivity, fetchReserveAt } from '../src/poolstats/queries'
import { compressDay, HIDDEN_POOLS, poolTable, type PoolDailyFile, type PoolDay } from '../src/poolstats/rules'
import { fetchShardPools, fetchTlmPools } from '../src/pools/tables'
import { fetchFarmPools, fetchFarmStakedAt, type FarmDailyFile } from '../src/farm/queries'
import { fetchGemsHeldAt, fetchPlayerWallets, type GemsDailyFile } from '../src/gems/queries'
import { fetchNftsUsed, type NftsDailyFile } from '../src/nfts/queries'
import { PROJECTS, HISTORY_FLOOR } from '../src/projects/defs'
import {
  historyProgress,
  resetHistoryProgress,
  historyReaches,
  useHistoryBackwards,
  useHistoryConcurrency,
  useHistoryGap,
  useHistoryPage,
  HISTORY_ENDPOINTS,
  useHistoryServers,
} from '../src/chain/history'
import { fetchAwDay, fetchShardsMined, fetchShardsSpent, type AwDailyFile } from '../src/aw/queries'
import {
  MC_STAKING,
  fetchMinesByMode,
  fetchNftFlow,
  fetchOwnedAw,
  type McReportFile,
  type McStakeKey,
} from '../src/projects/mcReport'
import { fetchProjectDay, fetchProjectIncoming } from '../src/projects/queries'
import { fetchShopDay, type ShopDailyFile } from '../src/shop/queries'
import type { ProjectFile } from '../src/projects/rules'


const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const redo = Number(flag('--redo')) || 0
/* Particular days to read again, e.g. --dates 2026-07-31,2026-08-27: the ones
   the history servers turned out to disagree about. */
const forced = new Set((flag('--dates') ?? '').split(',').filter(Boolean))
const only = flag('--only')
/* Collect further back than a project's own start, for a one-off backfill. */
const sinceFlag = flag('--since')
/* Only these history servers, for days most of the pool no longer holds. */
useHistoryServers((flag('--servers') ?? '').split(',').filter(Boolean))
/* Some indexers refuse a page above a hundred rows. */
useHistoryPage(Number(flag('--page') ?? 0))
/* Slower between pages, for servers that have started refusing us. */
useHistoryGap(Number(flag('--gap') ?? 0))
/* Walk each window backwards — what eosphere needs for anything older than 90 days. */
useHistoryBackwards(process.argv.includes('--backwards'))
/* At most this many requests in the air at once — see useHistoryConcurrency. */
useHistoryConcurrency(Number(flag('--inflight') ?? 0))

/**
 * Player rows read at once.
 *
 * Six drew 429s out of the history servers, and a refused read comes back
 * empty rather than angry, so the days it spoiled looked like real days on
 * which nobody held a gem. Four, and an answer that is missing is now treated
 * as missing.
 */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

const GEM_READS_AT_ONCE = 2

/**
 * The servers allowed to answer for a player's row at a past moment.
 *
 * Asked for one wallet on 26 April, these four all said 302 gems. Of the rest
 * of the pool, hivebp returned nothing at all, and eosusa — whose deltas only
 * begin in September — answered 6,501, which is that wallet months later. An
 * empty answer reads as a player holding nothing and a September answer reads
 * as April, so a pool picked at random turns a table read into a coin toss.
 */
const GEM_SERVERS = [
  'https://wax.cryptolions.io',
  'https://wax.eosdac.io',
  /*
    Two exclusions, both for answering wrongly rather than failing.

    detroitledger's deltas begin in April, and asked about February it returns
    nothing — indistinguishable from a player who held nothing.

    eosphere is worse. It never indexed the deltas that deleted every alpha
    player on 3 June 2026, so asked about one of them afterwards it hands back
    the row as it last stood alive: a wiped account still holding its gems.
    The two servers left both report that deletion, to the same second. Mixed
    together the holder count flickered between 10 and 47 on consecutive days
    in late June — not the game, just whose turn it was to answer.
  */
]

/*
  A running account of what this collector is doing, for the backfill report:
  which day it is on and how far through its rows it has got. Without it a
  heavy day — Alien Worlds reads a third of a million rows for one — looks
  exactly like a hung process.
*/
/*
  Which part of an Alien Worlds day to read.

  A day comes in three parts of wildly different cost: the mines, claims and
  new players are forty thousand rows; the Shards a million and a half; the
  Outpost a handful. Read together, the cheap parts wait months behind the
  dear one and progress is one long silence. Read as separate passes, the
  players and the Outpost are in hand within the hour, and the Shards fill in
  behind them — each with a figure of its own.
*/
const phase = flag('--phase') ?? 'all'
const wants = (which: string) => phase === 'all' || phase === which

const progressFile = flag('--progress')
let progressLabel = ''

function nowReading(label: string): void {
  progressLabel = label
  resetHistoryProgress()
}

if (progressFile) {
  const tell = () => {
    const { seen, wanted } = historyProgress()
    try {
      writeFileSync(progressFile, JSON.stringify({ at: Date.now(), label: progressLabel, seen, wanted }))
    } catch {
      /* the report can live without it */
    }
  }
  const timer = setInterval(tell, 2000)
  timer.unref()
}
/* The last day to collect, so two runs can share a backfill without meeting. */
const untilFlag = flag('--until')
/*
   A backfill run writes its own copy of a file — "mc.part-a.json" — which
   merge.mjs folds back in afterwards. Two collectors cannot share one file:
   each saves the whole of it after every day, so the second would undo the
   first. Splitting the work by server and date makes them independent.
*/
const part = flag('--part')
const partOf = (file: string) => (part ? file.replace(/.json$/, `.${part}.json`) : file)

function load<T>(file: string, empty: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : empty
}

function save(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data) + '\n')
}

/** The days a file still needs, plus the last `redo` it already has. */
function todo(days: { date: string }[]): string[] {
  const yesterday = untilFlag ?? dayOf(Date.now() - DAY_MS)
  const have = new Set(days.map((d) => d.date))
  const again = new Set(redo > 0 ? days.slice(-redo).map((d) => d.date) : [])
  /* Alien Legends had an alpha before its launch day, so a backfill can ask
     for days earlier than LAUNCH. */
  return dateRange(sinceFlag ?? LAUNCH, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))
}

async function activity(): Promise<void> {
  const FILE = partOf('public/data/daily.json')
  const PLAYERS = partOf('public/data/players-daily.json')
  const file = load<DailyFile>(FILE, { generatedAt: '', days: [] })
  const players = load<PlayersDailyFile>(PLAYERS, { generatedAt: '', days: [] })
  /* A day either file is missing is read again, and both are written. */
  const dates = [...new Set([...todo(file.days), ...todo(players.days)])].sort()

  /* Shards paid, corrected from the lifetime counters of everyone the stat
     log credited — for new days below, and here for days read before. */
  const shardsOf = (date: string, perPlayer: Record<string, Record<string, number>>) =>
    statFromCounters(
      Object.fromEntries(
        Object.entries(perPlayer)
          .filter(([, s]) => (s.shards_earned ?? 0) > 0)
          .map(([p, s]) => [p, s.shards_earned]),
      ),
      'shards_earned',
      dayStart(date),
      dayStart(date) + DAY_MS,
    )
  const playersOn = new Map(players.days.map((d) => [d.date, d.players]))
  const unchecked = file.days.filter((d) => !d.fromCounters?.includes('shards_earned') && !dates.includes(d.date))
  if (unchecked.length) console.log(`activity: correcting Shards from counters on ${unchecked.length} day(s)`)
  for (const d of unchecked) {
    const per = playersOn.get(d.date)
    if (!per) continue
    const before = d.stats.shards_earned ?? 0
    d.stats.shards_earned = await shardsOf(d.date, per)
    d.fromCounters = [...(d.fromCounters ?? []), 'shards_earned']
    save(FILE, file)
    console.log(`  ${d.date}  shards ${before} → ${d.stats.shards_earned} (tenths)`)
  }

  if (!dates.length) return console.log('activity: up to date')
  console.log(`activity: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)
  for (const date of dates) {
    const t0 = Date.now()
    const from = dayStart(date)
    const changes = await fetchStatChanges(from, from + DAY_MS)
    const day = summariseDay(date, changes)
    day.stats.shards_earned = await shardsOf(date, summarisePlayers(changes))
    day.fromCounters = ['shards_earned']
    file.days = mergeDays(file.days, [day])
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    const byDate = new Map(players.days.map((d) => [d.date, d]))
    byDate.set(date, { date, players: summarisePlayers(changes) })
    players.days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    players.generatedAt = file.generatedAt
    save(PLAYERS, players)
    console.log(
      `  ${date}  ${String(changes.length).padStart(6)} changes  ${String(day.active).padStart(4)} active  ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }
}

async function pools(): Promise<void> {
  const FILE = 'public/data/pools-daily.json'
  const file = load<PoolDailyFile>(FILE, { generatedAt: '', days: [] })
  const dates = todo(file.days)
  if (!dates.length) return console.log('pools: up to date')
  console.log(`pools: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)

  /* Every pool that has a balance, for the end-of-day closes. The parent is
     included: the page shows its balance and leaves it out of the totals, and
     a line it cannot draw over a month is not much of a line. */
  const [tlm, shards] = await Promise.all([fetchTlmPools(), fetchShardPools()])
  const balances = [
    ...tlm.map((p) => ({ pool: p.pool, type: 'tlm' })),
    ...shards.map((p) => ({ pool: p.pool, type: 'shards' })),
  ].filter((p) => !HIDDEN_POOLS.has(p.pool))
  /* Every TLM pool holds a reserve back; each gets a line beside its balance. */
  const reserved = tlm.map((p) => p.pool).filter((p) => !HIDDEN_POOLS.has(p))

  for (const date of dates) {
    const t0 = Date.now()
    const from = dayStart(date)
    const until = from + DAY_MS
    const payouts = await fetchPoolActivity(from, { until })
    const close: Record<string, number> = {}
    for (const b of balances) {
      const v = await fetchBalanceAt(poolTable(b.type), b.pool, until).catch(() => undefined)
      if (v !== undefined) close[b.pool] = v
    }
    const reserve: Record<string, number> = {}
    for (const pool of reserved) {
      const v = await fetchReserveAt(pool, until).catch(() => undefined)
      if (v !== undefined) reserve[pool] = v
    }
    const day: PoolDay = { date, rows: compressDay(payouts), close, ...(reserved.length ? { reserve } : {}) }
    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, day)
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    const untraced = payouts.filter((p) => p.kind === 'landowner' && !p.source).length
    console.log(
      `  ${date}  ${String(payouts.length).padStart(6)} payments → ${String(day.rows.length).padStart(5)} rows` +
        `${untraced ? `  (${untraced} landowner cuts untraced)` : ''}  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }
}

/**
 * Re-reads each collected pool day's claimed payouts (land claims, Candle
 * winnings, account rewards) and replaces what the day had for them — including
 * the Candle's TLM settlement records, which are not payments.
 */
async function landClaims(): Promise<void> {
  const FILE = 'public/data/pools-daily.json'
  const file = load<PoolDailyFile>(FILE, { generatedAt: '', days: [] })
  const claimedBy = new Set(['lands.ale', 'players.ale'])
  for (const day of file.days) {
    const from = dayStart(day.date)
    const claims = await fetchClaimedPayouts(from, from + DAY_MS)
    day.rows = [
      ...day.rows.filter((r) => !claimedBy.has(r[3]) && !(r[3] === 'recovery.ale' && r[4] === 'tlm')),
      ...compressDay(claims),
    ]
    save(FILE, file)
    const by: Record<string, number> = {}
    for (const c of claims) by[c.payer] = (by[c.payer] ?? 0) + c.amount
    const untraced = claims.filter((c) => c.pool === 'tlmlndowner').length
    console.log(
      `  ${day.date}  ${String(claims.length).padStart(4)} claims  ` +
        Object.entries(by).map(([k, v]) => `${k} ${Math.round(v).toLocaleString('en-US')}`).join('  ') +
        (untraced ? `  (${untraced} lands not found)` : ''),
    )
  }
}

/**
 * The other projects' overviews: one file each in public/data/projects/,
 * every finished UTC day since the project's `since` date.
 */
async function projects(): Promise<void> {
  const pick = flag('--project')
  for (const def of PROJECTS.filter((p) => !pick || p.key === pick)) {
    const FILE = partOf(`public/data/projects/${def.key}.json`)
    const file = load<ProjectFile>(FILE, { generatedAt: '', days: [] })
    const yesterday = untilFlag ?? dayOf(Date.now() - DAY_MS)
    const have = new Set(file.days.map((d) => d.date))
    const again = new Set(redo > 0 ? file.days.slice(-redo).map((d) => d.date) : [])
    const dates = dateRange(sinceFlag ?? def.since, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))

    /* Days collected before incoming tokens were measured get just those added. */
    if (def.incoming?.length) {
      const bare = part ? [] : file.days.filter((d) => d.incoming === undefined && !dates.includes(d.date))
      if (bare.length) console.log(`${def.name}: adding incoming tokens to ${bare.length} day(s)`)
      for (const d of bare) {
        const paidIn = await fetchProjectIncoming(def, d.date)
        d.incoming = paidIn?.incoming ?? {}
        d.incomingBy = paidIn?.incomingBy
        save(FILE, file)
        const sums: Record<string, number> = {}
        for (const [k, v] of Object.entries(d.incoming)) sums[k.split('|')[1]] = (sums[k.split('|')[1]] ?? 0) + v.amount
        console.log(`  ${d.date}  in: ${Object.entries(sums).map(([s, v]) => `${Math.round(v).toLocaleString('en-US')} ${s}`).join(', ') || 'nothing'}`)
      }
    }

    if (!dates.length) {
      console.log(`${def.name}: up to date`)
      continue
    }
    console.log(`${def.name}: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)
    for (const date of dates) {
      const t0 = Date.now()
      nowReading(`${def.name} ${date}`)
      const day = await fetchProjectDay(def, date)
      const by = new Map(file.days.map((d) => [d.date, d]))
      by.set(date, day)
      file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
      file.generatedAt = new Date().toISOString()
      save(FILE, file)
      const paid = Object.entries(day.paid).map(([k, v]) => `${Math.round(v).toLocaleString('en-US')} ${k}`).join(', ')
      console.log(`  ${date}  ${String(day.active).padStart(5)} active  ${paid || 'nothing paid'}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }
  }
}

/** What players spent in the Alien Legends shop, day by day since launch. */
async function shop(): Promise<void> {
  const FILE = partOf('public/data/shop-daily.json')
  const file = load<ShopDailyFile>(FILE, { generatedAt: '', days: [] })
  const dates = todo(file.days)
  if (!dates.length) return console.log('shop: up to date')
  console.log(`shop: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)
  for (const date of dates) {
    const day = await fetchShopDay(date)
    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, day)
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    console.log(`  ${date}  ${String(day.purchases).padStart(4)} purchases  ${Math.round(day.spent.WAX ?? 0).toLocaleString('en-US')} WAX`)
  }
}

/**
 * NFTs staked on farm.ale at the end of each day, by schema. Three reads a
 * day: the pool row for each schema as it last stood before midnight.
 */
async function farm(): Promise<void> {
  const FILE = partOf('public/data/farm-daily.json')
  const file = load<FarmDailyFile>(FILE, { generatedAt: '', days: [] })
  const dates = todo(file.days)
  if (!dates.length) return console.log('farm: up to date')
  console.log(`farm: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)

  const schemas = (await fetchFarmPools()).map((p) => p.schema)
  for (const date of dates) {
    const until = dayStart(date) + DAY_MS
    const nfts: Record<string, number> = {}
    for (const schema of schemas) {
      const v = await fetchFarmStakedAt(schema, until).catch(() => undefined)
      if (v !== undefined) nfts[schema] = v
    }
    /* A day with nothing read is left for the next run rather than saved as
       zeros, which would draw as everybody unstaking at once. */
    if (!Object.keys(nfts).length) {
      console.log(`  ${date}  nothing read — left for next time`)
      continue
    }
    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, { date, nfts })
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    const total = Object.values(nfts).reduce((n, v) => n + v, 0)
    console.log(`  ${date}  ${total.toLocaleString('en-US').padStart(7)} staked`)
  }
}

/**
 * Gems held by every player together at the end of each day.
 *
 * One read per player per day, because the balance lives in each player's own
 * row and no aggregate of it exists. A few hundred players makes that a
 * couple of minutes; it would be out of the question on a bigger game.
 *
 * A day is only written when every player answered. One wallet the server
 * would not return is one wallet counted as nought, and a sum that quietly
 * understates is worse than a day left for the next run — the chart would
 * show gems being spent that never moved.
 */
/**
 * Every wallet that has ever held a player row, and the first day it could
 * have.
 *
 * The live table is not enough. Alien Legends ran an open alpha from January
 * to June, and those players were wiped before the relaunch on 31 August —
 * 230 wallets that hold no row today but held gems all spring. They are
 * recoverable from the stat log, which is what players-daily.json is, so the
 * two sources together are the real population.
 */
/**
 * Run `fn` over `items`, `width` at a time, keeping the order of the answers.
 *
 * A player's balance is one round trip and nothing else — no paging, no work
 * to do on what comes back. Run one after another they are pure latency: a
 * third of a second each, which is hours across a year of days for a table
 * that could be read in one go if the history API let you ask for it that
 * way. Several at once asks no server for more than the history queue already
 * allows, and turns the same work into minutes.
 */
async function inParallel<T, R>(items: T[], width: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

async function gemWallets(): Promise<Map<string, string>> {
  const since = new Map<string, string>()
  const note = (wallet: string, day: string) => {
    const had = since.get(wallet)
    if (!had || day < had) since.set(wallet, day)
  }

  const log = load<PlayersDailyFile>('public/data/players-daily.json', { generatedAt: '', days: [] })
  for (const d of log.days) for (const w of Object.keys(d.players ?? {})) note(w, d.date)
  /* Somebody who signed up and bought gems without a stat ever moving would
     be missing from the log, so today's table is folded in as well — by its
     own signup day, because that is the first day the row can be read and a
     wallet asked for earlier would look like a server that went quiet. */
  for (const p of await fetchPlayerWallets()) note(p.wallet, p.signup || LAUNCH)

  return since
}

async function gems(): Promise<void> {
  const FILE = partOf('public/data/gems-daily.json')
  const file = load<GemsDailyFile>(FILE, { generatedAt: '', days: [] })
  /* A day costs a read per player — a minute and a half, where every other
     step here is seconds. Left uncapped, a file starting from nothing would
     take the better part of an hour and crowd out the steps behind it, which
     is how Alien Worlds came to be six days stale. Catch up a few days a
     night instead; the steady state is one day. */
  const dates = todo(file.days).slice(0, 8)
  if (!dates.length) return console.log('gems: up to date')
  console.log(`gems: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)

  const wallets = await gemWallets()

  /*
    Narrowed for this step alone — and put back afterwards.

    useHistoryServers REPLACES the shared list in place, so narrowing it here
    quietly narrowed it for everything that ran after. The nightly run went on
    to read NFTs, the Mission Control report, Alien Worlds and five project
    reports through the two servers these gems need, one of which answers 403:
    eight days lost on each of them before anyone noticed, while the steps in
    front of this one stayed up to date.
  */
  const chosen = (flag('--servers') ?? '').split(',').filter(Boolean)
  const poolBefore = [...HISTORY_ENDPOINTS]
  useHistoryServers(chosen.length ? chosen : GEM_SERVERS)
  try {
    await readGemDays(dates, wallets, file, FILE)
  } finally {
    useHistoryServers(poolBefore)
  }
}

async function readGemDays(
  dates: string[],
  wallets: Map<string, string>,
  file: GemsDailyFile,
  FILE: string,
): Promise<void> {
  for (const date of dates) {
    const t0 = Date.now()
    const until = dayStart(date) + DAY_MS
    /* Only wallets that could have had a row by then. The rest cost a read
       to be told nothing, and there are months of the alpha where that is
       almost all of them. */
    const asking = [...wallets].filter(([, since]) => since <= date).map(([w]) => w)
    const asked = asking.length
    /* null is a read that threw, undefined one that came back empty for a
       player who had a row. Neither is a balance. */
    const held = new Map<string, number>()
    let waiting = asking

    /*
      Three or four wallets in a hundred and eighty refuse on any given pass,
      and throwing the whole day away for them meant reading all hundred and
      eighty again only to lose another handful — the backfill sat on 4 May
      for an hour that way. The stragglers are asked again, after a pause, and
      only a wallet that will not answer three times over holds the day back.
    */
    for (let attempt = 0; attempt < 3 && waiting.length; attempt++) {
      if (attempt) await pause(5_000 * attempt)
      const got = await inParallel(waiting, GEM_READS_AT_ONCE, (w) =>
        fetchGemsHeldAt(w, until).catch(() => null),
      )
      const again: string[] = []
      waiting.forEach((w, i) => {
        const v = got[i]
        if (v === null || v === undefined) again.push(w)
        else held.set(w, v)
      })
      if (again.length && again.length < waiting.length) console.log(`    ${date}  asking ${again.length} again`)
      waiting = again
    }

    if (waiting.length) {
      console.log(`  ${date}  ${waiting.length} of ${asked} wallets unread — left for next time`)
      continue
    }
    const total = [...held.values()].reduce((n, v) => n + v, 0)
    /* A player with no row yet reads as nought and is not counted among the
       day's holders, which is what makes the base grow. */
    const had = [...held.values()].filter((v) => v > 0).length
    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, { date, gems: total, players: had })
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    console.log(
      `  ${date}  ${total.toLocaleString('en-US').padStart(11)} gems held by ${had} of ${asked}  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }
}

/**
 * Rows in nfts.ale's assets table at the end of each day — which, since the
 * table keeps a row per NFT used in the last 24 hours, is the distinct NFTs
 * named in that day's usenfts calls. About eight thousand calls a day.
 */
async function nftRows(): Promise<void> {
  const FILE = partOf('public/data/nfts-daily.json')
  const file = load<NftsDailyFile>(FILE, { generatedAt: '', days: [] })
  const dates = todo(file.days)
  if (!dates.length) return console.log('nfts: up to date')
  console.log(`nfts: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)
  for (const date of dates) {
    const t0 = Date.now()
    const from = dayStart(date)
    const rows = await fetchNftsUsed(from, from + DAY_MS)
    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, { date, rows })
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    console.log(`  ${date}  ${String(rows).padStart(6)} rows  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }
}

/**
 * What Mission Control's report needs beyond mc.json: mines by mode, and the
 * NFTs moving in and out of game.mc and adventure.mc. The staked levels are
 * then rebuilt for EVERY day from the owned counts right now, walking back
 * through the stored flows — exact, since nothing but transfers moves them,
 * and redone each run so a day is never left on yesterday's arithmetic.
 */
async function mcReport(): Promise<void> {
  const FILE = partOf('public/data/projects/mc-report.json')
  const since = sinceFlag ?? PROJECTS.find((p) => p.key === 'mc')!.since
  const file = load<McReportFile>(FILE, { generatedAt: '', days: [] })
  const yesterday = untilFlag ?? dayOf(Date.now() - DAY_MS)
  const have = new Set(file.days.map((d) => d.date))
  const again = new Set(redo > 0 ? file.days.slice(-redo).map((d) => d.date) : [])
  const dates = dateRange(since, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))
  if (dates.length) console.log(`mc report: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)

  for (const date of dates) {
    const t0 = Date.now()
    const from = dayStart(date)
    const until = from + DAY_MS
    const mines = await fetchMinesByMode(from, until)
    const flows = {} as McReportFile['days'][number]['flows']
    for (const s of MC_STAKING) flows[s.key] = await fetchNftFlow(s.account, s.memo, from, until)
    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, { date, mines, flows, staked: by.get(date)?.staked ?? { game: 0, adventure: 0 } })
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    save(FILE, file)
    console.log(
      `  ${date}  mines ${mines.same}/${mines.land}/${mines.loan}  ` +
        MC_STAKING.map((s) => `${s.key} +${flows[s.key].in} −${flows[s.key].out}`).join('  ') +
        `  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }
  if (!file.days.length) return
  /* A part of a backfill holds only its own stretch of days; the staked levels
     are counted back across the whole run, once the parts are merged. */
  if (part) return

  /* Today so far, then back one day at a time. */
  const now = Date.now()
  const todayStart = dayStart(dayOf(now))
  for (const s of MC_STAKING) {
    const owned = await fetchOwnedAw(s.account)
    /* What it owns this moment, less today's flows up to this same moment —
       once history has indexed that far, or the newest transfers are missed. */
    const readAt = Date.now()
    await historyReaches(readAt + 5_000)
    const today = await fetchNftFlow(s.account, s.memo, todayStart, readAt)
    let level = owned - (today.in - today.out)
    for (let i = file.days.length - 1; i >= 0; i--) {
      const d = file.days[i]
      d.staked = { ...d.staked, [s.key]: level } as Record<McStakeKey, number>
      level -= d.flows[s.key].in - d.flows[s.key].out
    }
    console.log(`  ${s.account}: owns ${owned} now; ${file.days[file.days.length - 1].staked[s.key]} at the end of yesterday`)
  }
  file.generatedAt = new Date().toISOString()
  save(FILE, file)
}

/**
 * Alien Worlds itself: mines, claims of mined TLM and who claimed, and new
 * players, from the earliest day the history servers still hold.
 *
 * Who claimed is kept in a state file beside the report's, so a month and
 * "new" can be counted without shipping every day's wallet list to the page.
 * It is committed every night, so it is kept lean: the wallets first seen
 * each day, grouped by that day (a hundred thousand of them, each written
 * once), and the wallet lists of the current and previous month only — all
 * the nightly re-read of yesterday can ever touch. Older months keep just
 * their count, in the report's own file.
 */
async function aw(): Promise<void> {
  const FILE = partOf('public/data/aw-daily.json')
  const STATE = partOf('public/data/aw-claimers.json')
  const file = load<AwDailyFile>(FILE, { generatedAt: '', days: [], months: {} })
  const saved = load<{ firstSeen: Record<string, string[]>; months: Record<string, string[]> }>(STATE, {
    firstSeen: {},
    months: {},
  })
  const firstDay: Record<string, string> = {}
  for (const [date, ws] of Object.entries(saved.firstSeen)) for (const w of ws) firstDay[w] = date
  const months = saved.months
  const counts = { ...file.months }
  const yesterday = untilFlag ?? dayOf(Date.now() - DAY_MS)
  /* A day is "had" when the part being read is in it, not when the row exists. */
  const held = (d: AwDailyFile['days'][number]) =>
    phase === 'shards' ? d.shards !== undefined : phase === 'outpost' ? d.shardsSpent !== undefined : true
  const have = new Set(file.days.filter(held).map((d) => d.date))
  const again = new Set(redo > 0 ? file.days.slice(-redo).map((d) => d.date) : [])
  const dates = dateRange(sinceFlag ?? HISTORY_FLOOR, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))

  /* Days collected before Shards were measured get just that figure added,
     rather than the whole day read again. */
  /* A run asked for one part of the day, or for named days, does that and
     nothing else — these two fill in what older runs never measured. */
  const shardless = part || phase !== 'all' || forced.size ? [] : file.days.filter((d) => d.shards === undefined && !dates.includes(d.date))
  if (shardless.length) console.log(`aw: adding Shards mined to ${shardless.length} day(s)`)
  for (const d of shardless) {
    const from = dayStart(d.date)
    d.shards = Math.round((await fetchShardsMined(from, from + DAY_MS)) * 10) / 10
    save(FILE, file)
    console.log(`  ${d.date}  ${Math.round(d.shards).toLocaleString('en-US').padStart(9)} shards`)
  }

  /* Likewise the Outpost's spending, measured later still. */
  const spentless = part || phase !== 'all' || forced.size ? [] : file.days.filter((d) => d.shardsSpent === undefined && !dates.includes(d.date))
  if (spentless.length) console.log(`aw: adding Outpost spending to ${spentless.length} day(s)`)
  for (const d of spentless) {
    const from = dayStart(d.date)
    const spent = await fetchShardsSpent(from, from + DAY_MS)
    d.shardsSpent = Math.round(spent.shards * 10) / 10
    d.outpostNfts = spent.nfts
    save(FILE, file)
    console.log(`  ${d.date}  ${Math.round(d.shardsSpent).toLocaleString('en-US').padStart(11)} shards spent  ${spent.nfts} NFTs`)
  }

  if (!dates.length) return console.log('aw: up to date')
  console.log(`aw: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)

  for (const date of dates) {
    const t0 = Date.now()
    const from = dayStart(date)
    const by = new Map(file.days.map((d) => [d.date, d]))
    const was = by.get(date)
    let told = ''

    let day: Awaited<ReturnType<typeof fetchAwDay>> | undefined
    if (wants('base')) {
      nowReading(`Alien Worlds ${date} · mines, claims and new players`)
      day = await fetchAwDay(from, from + DAY_MS)
      for (const w of day.claimers) if (!firstDay[w] || firstDay[w] > date) firstDay[w] = date
      const month = date.slice(0, 7)
      months[month] = [...new Set([...(months[month] ?? []), ...day.claimers])].sort()
      counts[month] = months[month].length
      told += `${String(day.mines).padStart(8)} mines  ${String(day.claims).padStart(5)} claims  ` +
        `${Math.round(day.tlm).toLocaleString('en-US').padStart(8)} TLM  ${String(day.claimers.length).padStart(5)} miners  ` +
        `${day.newPlayers} new  `
    }

    let shards: number | undefined
    if (wants('shards')) {
      nowReading(`Alien Worlds ${date} · Shards mined`)
      shards = await fetchShardsMined(from, from + DAY_MS)
      told += `${Math.round(shards).toLocaleString('en-US')} shards  `
    }

    let spent: Awaited<ReturnType<typeof fetchShardsSpent>> | undefined
    if (wants('outpost')) {
      nowReading(`Alien Worlds ${date} · Outpost spending`)
      spent = await fetchShardsSpent(from, from + DAY_MS)
      told += `${Math.round(spent.shards).toLocaleString('en-US')} spent  `
    }

    by.set(date, {
      /* A pass writes only what it read. Filling the rest with zeros would
         put "no mines, no claims" into a part file whose only job was Shards,
         and the merge would then overwrite the real figures with them. */
      ...((was ?? { date }) as AwDailyFile['days'][number]),
      date,
      ...(day
        ? {
            mines: day.mines,
            newPlayers: day.newPlayers,
            claims: day.claims,
            tlm: Math.round(day.tlm * 10_000) / 10_000,
            miners: day.claimers.length,
          }
        : {}),
      ...(shards !== undefined ? { shards: Math.round(shards * 10) / 10 } : {}),
      ...(spent ? { shardsSpent: Math.round(spent.shards * 10) / 10, outpostNfts: spent.nfts } : {}),
    })
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    /* First sightings are recounted over every day each time: a wallet's
       first day can only move earlier, never later. Only the pass that reads
       the claimers knows anything about them. */
    if (wants('base')) {
      const first: Record<string, number> = {}
      for (const d of Object.values(firstDay)) first[d] = (first[d] ?? 0) + 1
      for (const d of file.days) d.firstSeen = first[d.date] ?? 0
      file.months = counts
    }
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    console.log(`  ${date}  ${told}${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  const grouped: Record<string, string[]> = {}
  for (const [w, d] of Object.entries(firstDay)) (grouped[d] ??= []).push(w)
  for (const d of Object.keys(grouped)) grouped[d].sort()
  const keep = Object.keys(months).sort().slice(-2)
  save(STATE, {
    firstSeen: Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))),
    months: Object.fromEntries(keep.map((m) => [m, months[m]])),
  })
}

/*
  Every step, in the order they run.

  landclaims is not part of a nightly run and is only reached by asking for it
  by name; everything else runs unless --only names one of them.
*/
const STEPS: [name: string, run: () => Promise<void>, nightly: boolean][] = [
  ['activity', activity, true],
  ['pools', pools, true],
  ['farm', farm, true],
  ['shop', shop, true],
  ['gems', gems, true],
  ['nfts', nftRows, true],
  ['mcreport', mcReport, true],
  ['aw', aw, true],
  ['projects', projects, true],
  ['landclaims', landClaims, false],
]

void (async () => {
  /*
    Each step stands on its own.

    They were a single chain of awaits, so the first one to throw ended the
    run and every step behind it was skipped — never attempted, not merely
    unfinished. A 500 from one history server during the NFT read cost Alien
    Worlds, Mission Control and all five project reports eight days each,
    while the steps in front of it carried on being collected nightly.

    The run still reports failure at the end, so the workflow commits the days
    that did land and the log still says which step went wrong.
  */
  const failed: string[] = []
  for (const [name, run, nightly] of STEPS) {
    if (only ? only !== name : !nightly) continue
    try {
      await run()
    } catch (err) {
      failed.push(name)
      console.error(`\n${name} stopped early:`, err instanceof Error ? err.message : err)
    }
  }
  if (failed.length) {
    console.error(`\nSteps that did not finish: ${failed.join(', ')}. The rest were collected.`)
    process.exitCode = 1
  }
})()
