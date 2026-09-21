import { useEffect, useMemo, useState } from 'react'
import {
  fetchDailyFile,
  fetchPlayers,
  fetchPlayersDaily,
  fetchShopItemNames,
  fetchShopPurchases,
  type PlayersSnapshot,
  type ShopPurchase,
} from '@/activity/queries'
import {
  dayOf,
  dayStart,
  LAUNCH,
  legendCount,
  signupsByDay,
  statValue,
  summariseRange,
  type DaySummary,
  type PlayersDailyFile,
} from '@/activity/rules'
import { DailyChart, longDate } from '@/components/DailyChart'
import { changeOf, StatTile } from '@/components/StatTile'
import { usePeriod, type PeriodKey } from '@/components/usePeriod'
import { EconomySection, PlayersSection } from '@/components/Sections'
import { Recipients, type RecipientRow } from '@/components/Recipients'
import { formatNumber } from '@/format'
import { FARM, FARM_SCHEMAS, fetchFarmDaily, fetchFarmPools, type FarmDay, type FarmPool } from '@/farm/queries'

const RANGES = [
  { key: '7', label: '7 days', days: 7 },
  { key: '14', label: '14 days', days: 14 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'Since launch', days: Infinity },
] satisfies readonly { key: PeriodKey; label: string; days: number }[]

/** The first player signed up this day. */

const whole = (v: number) => formatNumber(Math.round(v))

/**
 * Overview — how many play, how much, and what it pays.
 *
 * Finished days come from `data/daily.json`, which the collector builds from
 * the chain's stat-change log; players, Legend accounts and signups are read
 * live from the player table; shop WAX live from its transfers.
 */
export default function Overview() {
  const [range, setRange] = usePeriod()
  const [days, setDays] = useState<DaySummary[] | null>(null)
  const [generatedAt, setGeneratedAt] = useState('')
  const [snap, setSnap] = useState<PlayersSnapshot | null>(null)
  const [shop, setShop] = useState<ShopPurchase[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchDailyFile().then((f) => {
      setDays(f.days)
      setGeneratedAt(f.generatedAt)
    })
    fetchPlayers()
      .then(setSnap)
      .catch((e) => setError(`Players could not be read: ${e instanceof Error ? e.message : e}`))
    fetchShopPurchases(dayStart(LAUNCH))
      .then(setShop)
      .catch(() => setShop([]))
  }, [])

  const spec = RANGES.find((r) => r.key === range)!
  const all = days ?? []
  const shown = Number.isFinite(spec.days) ? all.slice(-spec.days) : all
  const before = Number.isFinite(spec.days) ? all.slice(-2 * spec.days, -spec.days) : []
  const comparable = before.length === shown.length && shown.length > 0
  const dates = shown.map((d) => d.date)

  const now = useMemo(() => summariseRange(shown), [shown])
  const prev = useMemo(() => (comparable ? summariseRange(before) : null), [before, comparable])
  const vs = `previous ${spec.label}`

  const signups = useMemo(
    () =>
      snap
        ? signupsByDay(
            snap.players,
            all.map((d) => d.date),
          )
        : {},
    [snap, all],
  )
  const signupsIn = (list: DaySummary[]) => list.reduce((n, d) => n + (signups[d.date] ?? 0), 0)

  const shopByDay = useMemo(() => {
    const out: Record<string, number> = {}
    for (const p of shop ?? []) out[dayOf(p.time)] = (out[dayOf(p.time)] ?? 0) + p.wax
    return out
  }, [shop])
  const shopIn = (list: DaySummary[]) => list.reduce((n, d) => n + (shopByDay[d.date] ?? 0), 0)

  const stat = (key: string, list = shown) => list.reduce((n, d) => n + statValue(d.stats, key), 0)
  const series = (key: string) => shown.map((d) => statValue(d.stats, key))
  const cmp = (a: number, b: number | undefined) => {
    const r = comparable ? changeOf(a, b) : null
    return r === null ? null : { ratio: r, against: vs }
  }

  const legend = snap ? legendCount(snap.players) : null
  const through = all.length ? all[all.length - 1].date : null

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Overview</h1>
          <p className="page__lead">
            Players and activity in Alien Legends, read from the WAX chain.
            {through && <> Daily figures run midnight to midnight UTC, through {longDate(through)}.</>}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {days && Number.isFinite(spec.days) && days.length < spec.days && (
        <p className="notice">
          The game launched on {longDate(LAUNCH)}, so there are only {days.length} days so far. This view shows all of
          them, and fills out to {spec.days} days as they come. There's nothing earlier to compare with yet.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!days && (
        <p className="loading">
          <span className="spinner" /> Loading…
        </p>
      )}
      {days && days.length === 0 && (
        <p className="error">
          No daily figures yet. Run <code>npm run collect</code> to build them.
        </p>
      )}

      {days && days.length > 0 && (
        <>
          {/* ---------- players ---------- */}
          <PlayersSection
            note="Active means the player did something themselves that day — earnings as a landowner don't count."
            allTime={
              snap
                ? {
                    label: 'Players, all time',
                    value: whole(snap.players.length),
                    sub: `${whole(signupsIn(shown))} signed up in the last ${spec.label.toLowerCase()}`,
                  }
                : null
            }
            second={{
              label: 'Legend accounts running',
              value: legend === null ? '…' : whole(legend),
              sub:
                snap && legend !== null
                  ? `${Math.round((legend / Math.max(1, snap.players.length)) * 100)}% of all players`
                  : undefined,
            }}
            rangeLabel={spec.label.toLowerCase()}
            uniqueActive={now.uniqueActive}
            avgDaily={now.avgDaily}
            peak={now.peak}
            cmpActive={cmp(now.uniqueActive, prev?.uniqueActive)}
            cmpAvg={cmp(now.avgDaily, prev?.avgDaily)}
            dates={dates}
            active={shown.map((d) => d.active)}
            signups={snap ? dates.map((d) => signups[d] ?? 0) : null}
          />

          {/* ---------- economy ---------- */}
          <EconomySection
            recipients={(symbol, close) => (
              <AleRecipients
                symbol={symbol}
                dates={dates}
                tags={snap ? Object.fromEntries(snap.players.filter((p) => p.tag).map((p) => [p.wallet, p.tag!])) : {}}
                rangeLabel={spec.label.toLowerCase()}
                onClose={close}
              />
            )}
            note="Paid out is what players were credited: mines, landowner cuts, quests and the Candle."
            days={shown.length}
            dates={dates}
            tlm={{
              total: stat('tlm_earned'),
              change: cmp(stat('tlm_earned'), stat('tlm_earned', before)),
              perDay: series('tlm_earned'),
            }}
            shards={{
              total: stat('shards_earned'),
              change: cmp(stat('shards_earned'), stat('shards_earned', before)),
              perDay: series('shards_earned'),
            }}
            extraTiles={[
              {
                label: 'WAX spent in the shop',
                value: shop ? whole(shopIn(shown)) : '…',
                change: shop ? cmp(shopIn(shown), shopIn(before)) : null,
                sub: shop ? `${whole(shopIn(shown) / Math.max(1, shown.length))} a day on average` : undefined,
              },
            ]}
            extraCharts={[
              {
                title: 'WAX spent in the shop per day',
                node: shop ? (
                  <DailyChart
                    dates={dates}
                    series={[
                      {
                        key: 'wax',
                        label: 'WAX',
                        color: 'var(--series-1)',
                        values: dates.map((d) => shopByDay[d] ?? 0),
                      },
                    ]}
                    label="WAX spent in the shop per day"
                  />
                ) : (
                  <p className="loading">
                    <span className="spinner" /> Reading shop transfers…
                  </p>
                ),
              },
            ]}
          >
            {shop && <ShopItems purchases={shop.filter((p) => dates.includes(dayOf(p.time)))} />}
          </EconomySection>

          {/* ---------- activity ---------- */}
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">Activity</h2>
              <span className="section__note">Totals for the last {spec.label.toLowerCase()}</span>
            </div>
            <div className="tiles">
              <StatTile
                label="Dungeons played"
                value={whole(stat('dungeons_played'))}
                change={cmp(stat('dungeons_played'), stat('dungeons_played', before))}
                sub={`${Math.round((stat('dungeons_won') / Math.max(1, stat('dungeons_played'))) * 100)}% won · ${whole(stat('dungeons_won'))} wins`}
              />
              <StatTile
                label="Arena fights"
                value={whole(stat('arenas_played'))}
                change={cmp(stat('arenas_played'), stat('arenas_played', before))}
                sub={`${whole(stat('arenas_won'))} won`}
              />
              <StatTile
                label="Fighters recruited"
                value={whole(stat('recruits'))}
                change={cmp(stat('recruits'), stat('recruits', before))}
              />
              <StatTile
                label="Quests completed"
                value={whole(stat('quests_completed'))}
                change={cmp(stat('quests_completed'), stat('quests_completed', before))}
              />
            </div>
            <div className="charts">
              <div className="card card--pad">
                <div className="card__head">
                  <h3 className="card__title">Dungeons per day</h3>
                </div>
                <DailyChart
                  kind="line"
                  dates={dates}
                  series={[
                    {
                      key: 'played',
                      label: 'Played',
                      color: 'var(--series-1)',
                      values: series('dungeons_played'),
                    },
                    {
                      key: 'won',
                      label: 'Won',
                      color: 'var(--series-2)',
                      values: series('dungeons_won'),
                    },
                  ]}
                  label="Dungeons played and won per day"
                />
              </div>
              <div className="card card--pad">
                <div className="card__head">
                  <h3 className="card__title">Fighters recruited per day</h3>
                </div>
                <DailyChart
                  dates={dates}
                  series={[
                    {
                      key: 'recruits',
                      label: 'Recruits',
                      color: 'var(--series-1)',
                      values: series('recruits'),
                    },
                  ]}
                  label="Fighters recruited per day"
                />
              </div>
            </div>
          </section>

          {/* ---------- by day ---------- */}
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">By day</h2>
              <span className="section__note">Newest first</span>
            </div>
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date (UTC)</th>
                    <th className="r">Active</th>
                    <th className="r">Signups</th>
                    <th className="r">Dungeons</th>
                    <th className="r">Won</th>
                    <th className="r">Arena fights</th>
                    <th className="r">Recruits</th>
                    <th className="r">Quests</th>
                    <th className="r">TLM paid</th>
                    <th className="r">Shards paid</th>
                    <th className="r">Shop WAX</th>
                  </tr>
                </thead>
                <tbody>
                  {[...shown].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{longDate(d.date)}</td>
                      <td className="r">{whole(d.active)}</td>
                      <td className="r">{snap ? whole(signups[d.date] ?? 0) : '…'}</td>
                      <td className="r">{whole(statValue(d.stats, 'dungeons_played'))}</td>
                      <td className="r">{whole(statValue(d.stats, 'dungeons_won'))}</td>
                      <td className="r">{whole(statValue(d.stats, 'arenas_played'))}</td>
                      <td className="r">{whole(statValue(d.stats, 'recruits'))}</td>
                      <td className="r">{whole(statValue(d.stats, 'quests_completed'))}</td>
                      <td className="r">{whole(statValue(d.stats, 'tlm_earned'))}</td>
                      <td className="r">{whole(statValue(d.stats, 'shards_earned'))}</td>
                      <td className="r">{shop ? whole(shopByDay[d.date] ?? 0) : '…'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <FarmSection dates={dates} before={before.map((d) => d.date)} label={spec.label} />

          <p className="section__note">
            Figures through {through ? longDate(through) : '—'} UTC
            {generatedAt ? `, collected ${new Date(generatedAt).toLocaleString()}` : ''}. Today is added once the day is
            over. Players, Legend accounts and shop WAX are live.
          </p>
        </>
      )}
    </div>
  )
}

/**
 * NFTs staked on farm.ale, day by day.
 *
 * Follows the page's period like every other chart here. The line is each
 * day's close; the tiles are live, straight from the farm's own table, and
 * compare against the close of the day before the period began — so "+3%"
 * means the same span the chart shows.
 */
function FarmSection({ dates, before, label }: { dates: string[]; before: string[]; label: string }) {
  const [days, setDays] = useState<FarmDay[] | null>(null)
  const [now, setNow] = useState<FarmPool[] | null>(null)

  useEffect(() => {
    fetchFarmDaily().then((f) => setDays(f.days))
    fetchFarmPools()
      .then(setNow)
      .catch(() => setNow([]))
  }, [])

  const byDate = useMemo(() => new Map((days ?? []).map((d) => [d.date, d.nfts])), [days])
  /* A day the collector could not read carries the one before it, rather than
     dropping to zero and drawing a crash that never happened. */
  const valuesOf = (schema: string) => {
    let last = 0
    return dates.map((d) => {
      const day = byDate.get(d)
      if (day) last = day[schema] ?? 0
      return last
    })
  }

  const liveOf = (schema: string) => Number(now?.find((p) => p.schema === schema)?.total_nfts ?? 0)
  const liveTotal = FARM_SCHEMAS.reduce((n, s) => n + liveOf(s.schema), 0)
  /* The close the period starts from: the last day before it, if collected. */
  const start = before.length ? byDate.get(before[before.length - 1]) : undefined
  const startOf = (schema: string | null) =>
    start ? (schema ? (start[schema] ?? 0) : Object.values(start).reduce((n, v) => n + v, 0)) : undefined
  const change = (live: number, from: number | undefined) => {
    const r = from ? changeOf(live, from) : null
    return r === null ? null : { ratio: r, against: `the start of the last ${label.toLowerCase()}` }
  }

  if (days && !days.length) return null

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Staked on the farm</h2>
        <span className="section__note">
          NFTs staked on <span className="mono">{FARM}</span>
        </span>
      </div>
      <div className="tiles">
        <StatTile
          label="Staked now"
          value={now ? whole(liveTotal) : '…'}
          change={now ? change(liveTotal, startOf(null)) : null}
        />
        {FARM_SCHEMAS.map((s) => (
          <StatTile
            key={s.schema}
            label={s.label}
            value={now ? whole(liveOf(s.schema)) : '…'}
            change={now ? change(liveOf(s.schema), startOf(s.schema)) : null}
            sub={s.schema}
          />
        ))}
      </div>
      <div className="card card--pad">
        <div className="card__head">
          <h3 className="card__title">NFTs staked, end of each day</h3>
        </div>
        {days ? (
          <DailyChart
            kind="line"
            dates={dates}
            series={FARM_SCHEMAS.map((s) => ({ key: s.schema, label: s.label, color: s.color, values: valuesOf(s.schema) }))}
            label="NFTs staked on farm.ale at the end of each day, by schema"
          />
        ) : (
          <p className="section__note">Reading…</p>
        )}
      </div>
    </section>
  )
}

/** What the shop's WAX bought, largest first. */
/**
 * Where a shop item sits in the size order, or last if it has no size.
 *
 * Matched on a trailing word so "Gem Pack XL" is XL and something merely
 * containing an "s" is not. XL is checked before L for the same reason.
 */
const SIZES = ['S', 'M', 'L', 'XL']

function sizeRank(label: string): number {
  const m = /\b(XL|L|M|S)\s*$/i.exec(label.trim())
  if (!m) return SIZES.length
  return SIZES.indexOf(m[1].toUpperCase())
}

function ShopItems({ purchases }: { purchases: ShopPurchase[] }) {
  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => {
    fetchShopItemNames()
      .then(setNames)
      .catch(() => {})
  }, [])
  const rows = useMemo(() => {
    const by = new Map<string, { item: string; count: number; wax: number; buyers: Set<string> }>()
    for (const p of purchases) {
      const r = by.get(p.item) ?? {
        item: p.item,
        count: 0,
        wax: 0,
        buyers: new Set<string>(),
      }
      r.count += 1
      r.wax += p.wax
      r.buyers.add(p.wallet)
      by.set(p.item, r)
    }
    /* By pack size, not by revenue.
       These are one product in four sizes, so the order people expect is the
       order they come in - and sorting by WAX put XL between M and S, which
       reads as a mistake even though the numbers were right. Anything whose
       name does not end in a known size keeps the revenue ordering, after the
       sized ones. */
    return [...by.values()].sort((x, y) => {
      const rx = sizeRank(names[x.item] ?? x.item)
      const ry = sizeRank(names[y.item] ?? y.item)
      if (rx !== ry) return rx - ry
      return y.wax - x.wax
    })
  }, [purchases, names])
  const total = rows.reduce((n, r) => n + r.wax, 0)
  if (!rows.length) return null
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Shop item</th>
            <th className="r">Purchases</th>
            <th className="r">Buyers</th>
            <th className="r">WAX</th>
            <th className="r">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.item}>
              <td>{names[r.item] ?? r.item}</td>
              <td className="r">{whole(r.count)}</td>
              <td className="r">{whole(r.buyers.size)}</td>
              <td className="r">{whole(r.wax)}</td>
              <td className="r">{total ? `${Math.round((r.wax / total) * 100)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- who was paid ---------- */

/** Each player's TLM or Shards earned over the shown days, from the per-player daily file. */
function AleRecipients({
  symbol,
  dates,
  tags,
  rangeLabel,
  onClose,
}: {
  symbol: 'TLM' | 'Shards'
  dates: string[]
  tags: Record<string, string>
  rangeLabel: string
  onClose: () => void
}) {
  const [file, setFile] = useState<PlayersDailyFile | null>(null)
  useEffect(() => {
    fetchPlayersDaily().then(setFile)
  }, [])
  const rows = useMemo(() => {
    if (!file) return null
    const stat = symbol === 'TLM' ? 'tlm_earned' : 'shards_earned'
    const want = new Set(dates)
    const by = new Map<string, RecipientRow>()
    for (const day of file.days) {
      if (!want.has(day.date)) continue
      for (const [wallet, stats] of Object.entries(day.players)) {
        const v = statValue(stats, stat)
        if (!v) continue
        const r = by.get(wallet) ?? by.set(wallet, { wallet, received: 0, days: 0 }).get(wallet)!
        r.received += v
        r.days += 1
      }
    }
    return [...by.values()]
  }, [file, dates, symbol])
  return <Recipients symbol={symbol} rows={rows} tags={tags} rangeLabel={rangeLabel} format={whole} onClose={onClose} />
}
