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
import { fetchNftsUsed, type NftsDailyFile } from '../src/nfts/queries'
import { PROJECTS, HISTORY_FLOOR } from '../src/projects/defs'
import { historyReaches } from '../src/chain/history'
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

function load<T>(file: string, empty: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : empty
}

function save(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data) + '\n')
}

/** The days a file still needs, plus the last `redo` it already has. */
function todo(days: { date: string }[]): string[] {
  const yesterday = dayOf(Date.now() - DAY_MS)
  const have = new Set(days.map((d) => d.date))
  const again = new Set(redo > 0 ? days.slice(-redo).map((d) => d.date) : [])
  return dateRange(LAUNCH, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))
}

async function activity(): Promise<void> {
  const FILE = 'public/data/daily.json'
  const PLAYERS = 'public/data/players-daily.json'
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
    const FILE = `public/data/projects/${def.key}.json`
    const file = load<ProjectFile>(FILE, { generatedAt: '', days: [] })
    const yesterday = dayOf(Date.now() - DAY_MS)
    const have = new Set(file.days.map((d) => d.date))
    const again = new Set(redo > 0 ? file.days.slice(-redo).map((d) => d.date) : [])
    const dates = dateRange(def.since, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))

    /* Days collected before incoming tokens were measured get just those added. */
    if (def.incoming?.length) {
      const bare = file.days.filter((d) => d.incoming === undefined && !dates.includes(d.date))
      if (bare.length) console.log(`${def.name}: adding incoming tokens to ${bare.length} day(s)`)
      for (const d of bare) {
        d.incoming = (await fetchProjectIncoming(def, d.date)) ?? {}
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
  const FILE = 'public/data/shop-daily.json'
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
  const FILE = 'public/data/farm-daily.json'
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
 * Rows in nfts.ale's assets table at the end of each day — which, since the
 * table keeps a row per NFT used in the last 24 hours, is the distinct NFTs
 * named in that day's usenfts calls. About eight thousand calls a day.
 */
async function nftRows(): Promise<void> {
  const FILE = 'public/data/nfts-daily.json'
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
  const FILE = 'public/data/projects/mc-report.json'
  const since = PROJECTS.find((p) => p.key === 'mc')!.since
  const file = load<McReportFile>(FILE, { generatedAt: '', days: [] })
  const yesterday = dayOf(Date.now() - DAY_MS)
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
  const FILE = 'public/data/aw-daily.json'
  const STATE = 'public/data/aw-claimers.json'
  const file = load<AwDailyFile>(FILE, { generatedAt: '', days: [], months: {} })
  const saved = load<{ firstSeen: Record<string, string[]>; months: Record<string, string[]> }>(STATE, {
    firstSeen: {},
    months: {},
  })
  const firstDay: Record<string, string> = {}
  for (const [date, ws] of Object.entries(saved.firstSeen)) for (const w of ws) firstDay[w] = date
  const months = saved.months
  const counts = { ...file.months }
  const yesterday = dayOf(Date.now() - DAY_MS)
  const have = new Set(file.days.map((d) => d.date))
  const again = new Set(redo > 0 ? file.days.slice(-redo).map((d) => d.date) : [])
  const dates = dateRange(HISTORY_FLOOR, yesterday).filter((d) => !have.has(d) || again.has(d) || forced.has(d))

  /* Days collected before Shards were measured get just that figure added,
     rather than the whole day read again. */
  const shardless = file.days.filter((d) => d.shards === undefined && !dates.includes(d.date))
  if (shardless.length) console.log(`aw: adding Shards mined to ${shardless.length} day(s)`)
  for (const d of shardless) {
    const from = dayStart(d.date)
    d.shards = Math.round((await fetchShardsMined(from, from + DAY_MS)) * 10) / 10
    save(FILE, file)
    console.log(`  ${d.date}  ${Math.round(d.shards).toLocaleString('en-US').padStart(9)} shards`)
  }

  /* Likewise the Outpost's spending, measured later still. */
  const spentless = file.days.filter((d) => d.shardsSpent === undefined && !dates.includes(d.date))
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
    const day = await fetchAwDay(from, from + DAY_MS)
    const shards = await fetchShardsMined(from, from + DAY_MS)
    const spent = await fetchShardsSpent(from, from + DAY_MS)
    for (const w of day.claimers) if (!firstDay[w] || firstDay[w] > date) firstDay[w] = date
    const month = date.slice(0, 7)
    months[month] = [...new Set([...(months[month] ?? []), ...day.claimers])].sort()
    counts[month] = months[month].length

    const by = new Map(file.days.map((d) => [d.date, d]))
    by.set(date, {
      date,
      mines: day.mines,
      shards: Math.round(shards * 10) / 10,
      shardsSpent: Math.round(spent.shards * 10) / 10,
      outpostNfts: spent.nfts,
      newPlayers: day.newPlayers,
      claims: day.claims,
      tlm: Math.round(day.tlm * 10_000) / 10_000,
      miners: day.claimers.length,
      firstSeen: 0,
    })
    file.days = [...by.values()].sort((a, b) => a.date.localeCompare(b.date))
    /* First sightings are recounted over every day each time: a wallet's
       first day can only move earlier, never later. */
    const first: Record<string, number> = {}
    for (const d of Object.values(firstDay)) first[d] = (first[d] ?? 0) + 1
    for (const d of file.days) d.firstSeen = first[d.date] ?? 0
    file.months = counts
    file.generatedAt = new Date().toISOString()
    save(FILE, file)
    console.log(
      `  ${date}  ${String(day.mines).padStart(8)} mines  ${String(day.claims).padStart(5)} claims  ` +
        `${Math.round(day.tlm).toLocaleString('en-US').padStart(8)} TLM  ${String(day.claimers.length).padStart(5)} miners  ` +
        `${day.newPlayers} new  ${Math.round(shards).toLocaleString('en-US')} shards  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
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

void (async () => {
  if (!only || only === 'activity') await activity()
  if (!only || only === 'pools') await pools()
  if (!only || only === 'farm') await farm()
  if (!only || only === 'shop') await shop()
  if (!only || only === 'nfts') await nftRows()
  if (!only || only === 'mcreport') await mcReport()
  if (!only || only === 'aw') await aw()
  if (!only || only === 'projects') await projects()
  if (only === 'landclaims') await landClaims()
})()
