import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { copyBlock, copyChart } from './copyChart'
import { DailyChart, longDate } from '@/components/DailyChart'
import { formatNumber } from '@/format'

/**
 * The pieces every monthly report is built from — Alien Legends, Mission
 * Control, Planetary Defense and the rest — so they read and print the same.
 *
 * Every figure comes in a pair: all time (or since records began) as it stood
 * at the END of the chosen month, and within that month. Pinning the first to
 * the month's end is what makes a report a report: September's reads the same
 * whenever it is printed.
 */

/* ---------------- groups and their colours ---------------- */

/**
 * A colour per GROUP of sections, never per section: a report reads as parts —
 * who plays, what they are paid, what they do, what the NFTs are doing — and
 * the colour is how a reader flicking through the pages knows which part they
 * are in. Within a group every graph is the same colour.
 */
export type Group = 'players' | 'rewards' | 'incoming' | 'game' | 'nfts'

export const GROUP_COLOR: Record<Group, string> = {
  players: 'var(--series-1)',
  rewards: 'var(--series-4)',
  incoming: 'var(--series-3)',
  game: 'var(--rpt-game)',
  nfts: 'var(--rpt-nfts)',
}

export const GROUP_NAME: Record<Group, string> = {
  players: 'Players',
  rewards: 'Rewards paid out',
  incoming: 'Incoming tokens',
  game: 'Game activity',
  nfts: 'NFTs',
}

/**
 * Second and third lines within one graph, for a section that splits into
 * parts (mines by mode). The group's colour leads; these follow it and stay
 * distinct from each other in both themes.
 */
export const EXTRA_LINES = ['var(--text-2)', 'var(--rpt-alt)']

/* ---------------- numbers ---------------- */

export const whole = (v: number) => formatNumber(Math.round(v))

/** Each day's value added to everything before it. */
export function running(values: number[]): number[] {
  let n = 0
  return values.map((v) => (n += v))
}

/**
 * A quantity that stands at a level — NFTs staked, rows in a table — rather
 * than one that adds up. The day's figure where there is one, the day before's
 * where the collector missed it; and the month measured from the close of the
 * day before it began, or from its own first day for the first month.
 */
export interface Stock {
  values: number[]
  inMonth: number[]
  start: number
  end: number
}

export function stockOf(byDate: Map<string, number>, dates: string[], monthDays: number): Stock {
  let last = 0
  const values = dates.map((d) => (last = byDate.get(d) ?? last))
  const inMonth = values.slice(values.length - monthDays)
  const before = values.length - monthDays - 1
  return {
    values,
    inMonth,
    start: before >= 0 ? values[before] : (inMonth[0] ?? 0),
    end: values[values.length - 1] ?? 0,
  }
}

/** Where it stood at the end, and how far it moved over the month. */
export function stockFigures(s: Stock, endLabel: string, endSub: string, within: string): Figure[] {
  const change = s.end - s.start
  return [
    { label: endLabel, value: whole(s.end), sub: endSub },
    {
      label: `Change ${within.charAt(0).toLowerCase()}${within.slice(1)}`,
      value: `${change > 0 ? '+' : change < 0 ? '−' : ''}${whole(Math.abs(change))}`,
      sub: `from ${whole(s.start)}`,
    },
  ]
}

/* ---------------- the month ---------------- */

const monthOf = (date: string) => date.slice(0, 7)
/** "20 Aug". */
export const shortDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
export const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export interface MonthView<D extends { date: string }> {
  months: string[]
  picked: string
  setMonth: (m: string) => void
  /** Every collected day up to the end of the chosen month. */
  upTo: D[]
  /** The chosen month's days. */
  inMonth: D[]
  dates: string[]
  monthDates: string[]
  lastDay: string | null
  name: string
  /** "In September 2026", or "…, so far" while the month is not over. */
  within: string
}

/** The month picker's state and everything derived from it. */
export function useMonthView<D extends { date: string }>(days: D[] | null): MonthView<D> {
  const [month, setMonth] = useState('')
  /* Newest first: the month anyone opening a report most likely wants. */
  const months = useMemo(() => [...new Set((days ?? []).map((d) => monthOf(d.date)))].sort().reverse(), [days])
  const picked = month || months[0] || ''
  const all = days ?? []
  const upTo = all.filter((d) => monthOf(d.date) <= picked)
  const inMonth = upTo.filter((d) => monthOf(d.date) === picked)
  const lastDay = inMonth.length ? inMonth[inMonth.length - 1].date : null
  const monthEnd = picked ? new Date(Date.UTC(Number(picked.slice(0, 4)), Number(picked.slice(5, 7)), 0)) : null
  const complete = !!lastDay && !!monthEnd && lastDay === monthEnd.toISOString().slice(0, 10)
  const name = picked ? monthName(picked) : ''
  /* The records' first month usually starts partway through it — launch day,
     or the day collecting began — and "In August" over twelve days would
     read as the whole month. */
  const first = inMonth[0]?.date
  const from = first && !first.endsWith('-01') ? `, from ${shortDay(first)}` : ''
  return {
    months,
    picked,
    setMonth,
    upTo,
    inMonth,
    dates: upTo.map((d) => d.date),
    monthDates: inMonth.map((d) => d.date),
    lastDay,
    name,
    within: complete ? `In ${name}${from}` : `In ${name}${from}, so far`,
  }
}

/* ---------------- the page ---------------- */

/**
 * The report's frame: its title with the month, the month picker, the print
 * button, and the time it was generated. Printing turns the page light
 * whatever the screen shows — a dark page is a page of ink, and most printers
 * drop the backgrounds anyway, leaving white text on white.
 */
export function ReportPage({
  title,
  view,
  loading,
  empty,
  children,
}: {
  title: string
  view: MonthView<{ date: string }>
  loading: boolean
  empty: boolean
  children: ReactNode
}) {
  useEffect(() => {
    const root = document.documentElement
    let was: string | null = null
    const before = () => {
      was = root.getAttribute('data-theme')
      root.setAttribute('data-theme', 'light')
    }
    const after = () => {
      if (was === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', was)
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  return (
    <div className="page rpt">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            {title} · {view.name || '…'}
          </h1>
        </div>
        <div className="page__actions rpt__actions">
          <label className="rpt__month">
            <span className="sr-only">Month</span>
            <select value={view.picked} onChange={(e) => view.setMonth(e.target.value)} disabled={!view.months.length}>
              {view.months.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn rpt__print" type="button" onClick={() => window.print()} disabled={loading}>
            Print or save as PDF
          </button>
        </div>
      </header>

      {loading ? (
        <p className="section__note">Reading the collected days…</p>
      ) : empty ? (
        <p className="section__note">No days have been collected yet.</p>
      ) : (
        <>
          {children}
          <p className="section__note rpt__foot">
            Generated {new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.
          </p>
        </>
      )}
    </div>
  )
}

/* ---------------- one section ---------------- */

export interface Figure {
  label: string
  value: string
  sub?: string
}

export interface ChartLine {
  label: string
  values: number[]
}

export interface Chart {
  title: string
  dates: string[]
  /** One line, or several — a section that splits into parts. */
  values?: number[]
  lines?: ChartLine[]
}

/**
 * The heading over a group of sections, in the group's colour — the one place
 * the colour appears as a name rather than as a line, which is what lets it
 * carry meaning in the graphs below.
 */
function GroupHead({ group }: { group: Group }) {
  return (
    <h2 className="rpt__group" style={{ '--grp': GROUP_COLOR[group] } as CSSProperties}>
      {GROUP_NAME[group]}
    </h2>
  )
}

/**
 * One graph, with the button that copies it as a picture — the report is
 * written to be quoted from, and a screenshot of a chart in a dark page
 * pasted into a light chat is not the same chart. See copyChart.
 */
/** A copy button's own short-lived answer: Copied, Saved or Failed. */
function useCopy(run: () => Promise<'copied' | 'saved'>) {
  const [said, setSaid] = useState('')
  const go = async () => {
    try {
      setSaid((await run()) === 'copied' ? 'Copied' : 'Saved')
    } catch (err) {
      console.error('copy:', err)
      setSaid('Failed')
    }
    setTimeout(() => setSaid(''), 2000)
  }
  return { said, go: () => void go() }
}

function ChartPanel({ title, heading, children }: { title: string; heading: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const { said, go } = useCopy(() => copyChart(panel.current!, title))
  return (
    <div className="rpt__chart" ref={panel}>
      <span className="rpt__charttitle">{heading}</span>
      <button className="rpt__copy" type="button" title="Copy this graph as a picture" onClick={go}>
        {said || 'Copy'}
      </button>
      {children}
    </div>
  )
}

/**
 * One subject: two figures across the top, up to three graphs beneath. Fewer
 * graphs leave their slots empty rather than stretching the rest.
 */
export function Block({
  head,
  group,
  title,
  figures,
  charts,
  how,
}: {
  /**
   * Whether this section opens its group. The group's name is drawn INSIDE the
   * section so a printed page can never leave it at the foot of one page and
   * the section at the top of the next.
   */
  head?: boolean
  group: Group
  title: string
  figures: Figure[]
  charts: Chart[]
  /** One line under the charts: where the numbers come from. */
  how?: string
}) {
  const color = GROUP_COLOR[group]
  const body = useRef<HTMLDivElement>(null)
  const { said, go } = useCopy(() => copyBlock(body.current!, title))
  return (
    <section className="section rpt__block">
      {head ? <GroupHead group={group} /> : null}
      <h3 className="section__title">
        {title}
        <button className="rpt__copy rpt__copy--block" type="button" title="Copy this whole section as a picture" onClick={go}>
          {said || 'Copy section'}
        </button>
      </h3>
      <div className="rpt__body card card--pad" ref={body}>
        <div className="rpt__figures">
          {figures.map((f) => (
            <div key={f.label} className="rpt__figure">
              <span className="tile__label">{f.label}</span>
              <strong className="tile__value num">{f.value}</strong>
              {f.sub ? <span className="tile__sub">{f.sub}</span> : null}
            </div>
          ))}
        </div>
        <div className="rpt__charts">
          {charts.map((c) => (
            <ChartPanel key={c.title} title={`${title} — ${c.title}`} heading={c.title}>
              <DailyChart
                kind="line"
                fill={!c.lines || c.lines.length === 1}
                height={160}
                dates={c.dates}
                series={
                  c.lines
                    ? c.lines.map((l, i) => ({
                        key: l.label,
                        label: l.label,
                        color: i === 0 ? color : EXTRA_LINES[(i - 1) % EXTRA_LINES.length],
                        values: l.values,
                      }))
                    : [{ key: 'v', label: title, color, values: c.values ?? [] }]
                }
                label={`${title}: ${c.title}`}
              />
            </ChartPanel>
          ))}
        </div>
        {how ? <p className="rpt__how">{how}</p> : null}
      </div>
    </section>
  )
}

/** "Staked on Sun 20 Sep", or the plain label before any day is known. */
export const onDay = (prefix: string, day: string | null, fallback: string) =>
  day ? `${prefix} ${longDate(day)}` : fallback
