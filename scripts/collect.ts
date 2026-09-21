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
import { fetchStatChanges } from '../src/activity/queries'
import {
  dateRange,
  dayOf,
  dayStart,
  DAY_MS,
  mergeDays,
  summariseDay,
  summarisePlayers,
  type DailyFile,
  type PlayersDailyFile,
} from '../src/activity/rules'
import { fetchBalanceAt, fetchClaimedPayouts, fetchPoolActivity, fetchReserveAt } from '../src/poolstats/queries'
import { compressDay, HIDDEN_POOLS, poolTable, type PoolDailyFile, type PoolDay } from '../src/poolstats/rules'
import { fetchShardPools, fetchTlmPools } from '../src/pools/tables'
import { PROJECTS } from '../src/projects/defs'
import { fetchProjectDay } from '../src/projects/queries'
import type { ProjectFile } from '../src/projects/rules'

/** The first player signed up on this day; nothing before it is the game. */
const LAUNCH = '2026-08-31'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const redo = Number(flag('--redo')) || 0
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
  return dateRange(LAUNCH, yesterday).filter((d) => !have.has(d) || again.has(d))
}

async function activity(): Promise<void> {
  const FILE = 'public/data/daily.json'
  const PLAYERS = 'public/data/players-daily.json'
  const file = load<DailyFile>(FILE, { generatedAt: '', days: [] })
  const players = load<PlayersDailyFile>(PLAYERS, { generatedAt: '', days: [] })
  /* A day either file is missing is read again, and both are written. */
  const dates = [...new Set([...todo(file.days), ...todo(players.days)])].sort()
  if (!dates.length) return console.log('activity: up to date')
  console.log(`activity: ${dates.length} day(s), ${dates[0]} … ${dates[dates.length - 1]}`)
  for (const date of dates) {
    const t0 = Date.now()
    const from = dayStart(date)
    const changes = await fetchStatChanges(from, from + DAY_MS)
    const day = summariseDay(date, changes)
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
  /* The pools other pools are released from, whose reserve gets a line. */
  const parents = tlm.filter((p) => (p.subpools ?? []).length).map((p) => p.pool)

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
    for (const pool of parents) {
      const v = await fetchReserveAt(pool, until).catch(() => undefined)
      if (v !== undefined) reserve[pool] = v
    }
    const day: PoolDay = { date, rows: compressDay(payouts), close, ...(parents.length ? { reserve } : {}) }
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
    const dates = dateRange(def.since, yesterday).filter((d) => !have.has(d) || again.has(d))
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

void (async () => {
  if (!only || only === 'activity') await activity()
  if (!only || only === 'pools') await pools()
  if (!only || only === 'projects') await projects()
  if (only === 'landclaims') await landClaims()
})()
