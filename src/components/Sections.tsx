import { useState, type ReactNode } from 'react'
import { DailyChart, shortDate, type Series } from './DailyChart'
import { StatTile } from './StatTile'
import { formatDecimals, formatNumber } from '@/format'

/**
 * The two sections every overview opens with — Alien Legends and each other
 * project alike — so the games read side by side: who plays, then what they
 * were paid in TLM and Shards.
 */

type Change = { ratio: number; against: string } | null

export interface Tile {
  label: string
  value: string
  sub?: string
  change?: Change
}

const whole = (v: number) => formatNumber(Math.round(v))

export function ChartCard({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="card card--pad">
      <div className="card__head">
        <h3 className="card__title">{title}</h3>
      </div>
      {children}
      {foot && <p className="card__foot">{foot}</p>}
    </div>
  )
}

function Loading({ what }: { what: string }) {
  return (
    <p className="loading">
      <span className="spinner" /> Reading {what}…
    </p>
  )
}

export function PlayersSection({
  note,
  allTime,
  second,
  rangeLabel,
  uniqueActive,
  avgDaily,
  peak,
  cmpActive,
  cmpAvg,
  dates,
  active,
  signups,
  signupsTitle = 'New signups per day',
  signupsFoot,
}: {
  note: string
  /** Players, all time — null while it loads. */
  allTime: Tile | null
  /** The one tile each game fills with its own figure. */
  second: Tile | null
  rangeLabel: string
  uniqueActive: number
  avgDaily: number
  peak: { date: string; active: number } | null
  cmpActive: Change
  cmpAvg: Change
  dates: string[]
  active: number[]
  /** New players per shown day — null while it loads. */
  signups: number[] | null
  signupsTitle?: string
  signupsFoot?: ReactNode
}) {
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Players</h2>
        <span className="section__note">{note}</span>
      </div>
      <div className="tiles">
        <StatTile {...(allTime ?? { label: 'Players, all time', value: '…' })} />
        {second ? <StatTile {...second} /> : null}
        <StatTile
          label={`Active players · ${rangeLabel}`}
          value={whole(uniqueActive)}
          change={cmpActive}
          sub="Active on at least one day"
        />
        <StatTile
          label="Average daily active"
          value={formatDecimals(avgDaily, 0)}
          change={cmpAvg}
          sub={peak ? `Peak ${whole(peak.active)} on ${shortDate(peak.date)}` : undefined}
        />
      </div>
      <div className="charts">
        <ChartCard title="Daily active players">
          <DailyChart
            dates={dates}
            series={[{ key: 'active', label: 'Active players', color: 'var(--series-1)', values: active }]}
            label="Daily active players"
          />
        </ChartCard>
        <ChartCard title={signupsTitle} foot={signups ? signupsFoot : undefined}>
          {signups ? (
            <DailyChart
              dates={dates}
              series={[{ key: 'signups', label: 'New players', color: 'var(--series-1)', values: signups }]}
              label={signupsTitle}
            />
          ) : (
            <Loading what="players" />
          )}
        </ChartCard>
      </div>
    </section>
  )
}

export interface PaidSeries {
  total: number
  change: Change
  perDay: number[]
  /** Replaces the daily average under the figure. */
  sub?: string
  /** Drawn instead of `perDay`, as lines — for what a single bar per day can't show. */
  chart?: { title: string; series: Series[] }
}

/**
 * TLM and Shards paid out, always both and always first, then whatever else
 * the game pays or spends.
 */
export function EconomySection({
  note,
  days,
  tlm,
  shards,
  dates,
  format = whole,
  extraTiles = [],
  extraCharts = [],
  children,
  recipients,
}: {
  note: string
  days: number
  tlm: PaidSeries
  shards: PaidSeries
  dates: string[]
  format?: (v: number) => string
  extraTiles?: Tile[]
  extraCharts?: { title: string; node: ReactNode }[]
  children?: ReactNode
  /** Who received TLM or Shards — when given, their tiles open it. */
  recipients?: (symbol: 'TLM' | 'Shards', close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState<'TLM' | 'Shards' | null>(null)
  const action = (symbol: 'TLM' | 'Shards') =>
    recipients
      ? {
          label: 'See who received it',
          open: open === symbol,
          onClick: () => setOpen((o) => (o === symbol ? null : symbol)),
        }
      : undefined
  const perDay = (v: number) => `${format(v / Math.max(1, days))} a day on average`
  const charts = [
    { title: 'TLM paid out per day', label: 'TLM', paid: tlm },
    { title: 'Shards paid out per day', label: 'Shards', paid: shards },
  ].map((c) => ({
    title: c.paid.chart?.title ?? c.title,
    kind: c.paid.chart ? ('line' as const) : ('bar' as const),
    series: c.paid.chart?.series ?? [{ key: c.label, label: c.label, color: 'var(--series-1)', values: c.paid.perDay }],
  }))
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Economy</h2>
        <span className="section__note">{note}</span>
      </div>
      <div className="tiles">
        <StatTile
          label="TLM paid out"
          value={format(tlm.total)}
          change={tlm.change}
          sub={tlm.sub ?? perDay(tlm.total)}
          action={action('TLM')}
        />
        <StatTile
          label="Shards paid out"
          value={format(shards.total)}
          change={shards.change}
          sub={shards.sub ?? perDay(shards.total)}
          action={action('Shards')}
        />
        {extraTiles.map((t) => (
          <StatTile key={t.label} {...t} />
        ))}
      </div>
      {open && recipients?.(open, () => setOpen(null))}
      <div className={`charts${charts.length + extraCharts.length >= 3 ? ' charts--3' : ''}`}>
        {charts.map((c) => (
          <ChartCard key={c.title} title={c.title}>
            <DailyChart dates={dates} series={c.series} kind={c.kind} format={format} label={c.title} />
          </ChartCard>
        ))}
        {extraCharts.map((c) => (
          <ChartCard key={c.title} title={c.title}>
            {c.node}
          </ChartCard>
        ))}
      </div>
      {children}
    </section>
  )
}
