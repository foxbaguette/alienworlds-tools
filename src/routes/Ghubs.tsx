import { useEffect, useMemo, useState } from 'react'
import { fetchDailyFile, fetchPlayers, type PlayersSnapshot } from '@/activity/queries'
import { LAUNCH, dayStart, statValue, summariseRange, type DaySummary } from '@/activity/rules'
import { DailyChart, longDate } from '@/components/DailyChart'
import { formatNumber } from '@/format'

/**
 * The gHubs report — Alien Legends by the month, laid out to be printed.
 *
 * Every figure comes in a pair: all time, as it stood at the END of the chosen
 * month, and within that month. Pinning "all time" to the month's end is what
 * makes a report a report — September's reads the same whenever it is
 * printed, instead of drifting with every day added since.
 *
 * Three graphs each, one point a day and filled beneath the line: every day
 * from launch to the month's end, the chosen month on its own scale, and the
 * running total — the "all time" figure, drawn as it grew.
 *
 * Built only from finished days (`data/daily.json`) and the player table's
 * signup dates, so the current month is marked "so far" and says which day it
 * runs to.
 */

interface Metric {
  key: string
  title: string
  /** Where the value comes from: a stat, or the day's active-player count. */
  stat?: string
  unit?: string
  color: string
}

const METRICS: Metric[] = [
  { key: 'tlm', title: 'TLM paid out to players', stat: 'tlm_earned', unit: 'TLM', color: 'var(--series-1)' },
  { key: 'shards', title: 'Shards paid out to players', stat: 'shards_earned', unit: 'Shards', color: 'var(--series-3)' },
  { key: 'dungeons', title: 'Dungeons played', stat: 'dungeons_played', color: 'var(--series-2)' },
  { key: 'arenas', title: 'Arenas played', stat: 'arenas_played', color: 'var(--series-4)' },
  { key: 'quests', title: 'Quests completed', stat: 'quests_completed', color: 'var(--series-1)' },
  { key: 'recruits', title: 'Fighters recruited', stat: 'recruits', color: 'var(--series-2)' },
]

const whole = (v: number) => formatNumber(Math.round(v))
const monthOf = (date: string) => date.slice(0, 7)
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export default function Ghubs() {
  const [days, setDays] = useState<DaySummary[] | null>(null)
  const [snap, setSnap] = useState<PlayersSnapshot | null>(null)
  const [month, setMonth] = useState<string>('')

  useEffect(() => {
    fetchDailyFile().then((f) => setDays(f.days))
    fetchPlayers()
      .then(setSnap)
      .catch(() => {})
  }, [])

  /* Newest first: the month anyone opening this most likely wants. */
  const months = useMemo(() => [...new Set((days ?? []).map((d) => monthOf(d.date)))].sort().reverse(), [days])
  const picked = month || months[0] || ''

  const all = days ?? []
  const upTo = all.filter((d) => monthOf(d.date) <= picked)
  const inMonth = upTo.filter((d) => monthOf(d.date) === picked)
  const lastDay = inMonth.length ? inMonth[inMonth.length - 1].date : null
  const monthEnd = picked ? new Date(Date.UTC(Number(picked.slice(0, 4)), Number(picked.slice(5, 7)), 0)) : null
  const complete = !!lastDay && !!monthEnd && lastDay === monthEnd.toISOString().slice(0, 10)
  const name = picked ? monthName(picked) : ''
  const within = complete ? `In ${name}` : `In ${name}, so far`

  const dates = upTo.map((d) => d.date)
  const sum = (list: DaySummary[], stat: string) => list.reduce((n, d) => n + statValue(d.stats, stat), 0)

  /* Players as of the report's last day: everybody signed up before it ended. */
  const cutoff = lastDay ? dayStart(lastDay) + 86_400_000 : 0
  const playersAllTime = snap ? snap.players.filter((p) => p.signup < cutoff).length : null
  const signedUp = snap ? snap.players.filter((p) => p.signup < cutoff && p.signup >= dayStart(`${picked}-01`)).length : null
  const activeInMonth = summariseRange(inMonth).uniqueActive
  const monthDates = inMonth.map((d) => d.date)
  /* Accounts that existed by the end of each day. Not a running sum of the
     daily actives — that would count the same players again every day. */
  const accounts = useMemo(
    () =>
      snap ? dates.map((d) => snap.players.filter((p) => p.signup < dayStart(d) + 86_400_000).length) : dates.map(() => 0),
    [snap, dates.join()],
  )

  /* Print light whatever the screen shows: a dark page is a page of ink, and
     most printers drop the backgrounds anyway, leaving white text on white. */
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
          <h1 className="page__title">gHubs report · {name || '…'}</h1>
          <p className="page__lead">
            Alien Legends, from launch on {longDate(LAUNCH)}
            {lastDay ? <> to {longDate(lastDay)} UTC</> : null}.{' '}
            {complete ? '' : lastDay ? 'The month is not over; figures run to the last finished day.' : ''}
          </p>
        </div>
        <div className="page__actions rpt__actions">
          <label className="rpt__month">
            <span className="sr-only">Month</span>
            <select value={picked} onChange={(e) => setMonth(e.target.value)} disabled={!months.length}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn rpt__print" type="button" onClick={() => window.print()} disabled={!days}>
            Print or save as PDF
          </button>
        </div>
      </header>

      {!days ? (
        <p className="section__note">Reading the collected days…</p>
      ) : !all.length ? (
        <p className="section__note">No days have been collected yet.</p>
      ) : (
        <>
          <Block
            title="Players"
            figures={[
              { label: 'All time', value: playersAllTime === null ? '…' : whole(playersAllTime), sub: 'accounts signed up' },
              {
                label: within,
                value: whole(activeInMonth),
                sub: `active players${signedUp !== null ? ` · ${whole(signedUp)} signed up` : ''}`,
              },
            ]}
            color="var(--series-1)"
            charts={[
              { title: 'Active players per day, since launch', dates, values: upTo.map((d) => d.active) },
              { title: `Active players per day, ${name}`, dates: monthDates, values: inMonth.map((d) => d.active) },
              { title: 'Accounts signed up, running total', dates, values: accounts },
            ]}
          />

          {METRICS.map((m) => (
            <Block
              key={m.key}
              title={m.title}
              figures={[
                { label: 'All time', value: whole(sum(upTo, m.stat!)), sub: m.unit },
                { label: within, value: whole(sum(inMonth, m.stat!)), sub: m.unit },
              ]}
              color={m.color}
              charts={[
                { title: 'Per day, since launch', dates, values: upTo.map((d) => statValue(d.stats, m.stat!)) },
                { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map((d) => statValue(d.stats, m.stat!)) },
                { title: 'Running total, since launch', dates, values: running(upTo.map((d) => statValue(d.stats, m.stat!))) },
              ]}
            />
          ))}

          <p className="section__note rpt__foot">
            Read from the WAX chain: daily totals from the game&rsquo;s stat-change log, players from its player
            table. &ldquo;Active&rdquo; counts a player who did something themselves that day — being credited a
            landowner&rsquo;s cut does not count. Each player counts once however many days they played. Paid out
            is what players were credited: mines, landowner cuts, quests and the Candle. Generated{' '}
            {new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.
          </p>
        </>
      )}
    </div>
  )
}

/** Each day's value added to everything before it. */
function running(values: number[]): number[] {
  let n = 0
  return values.map((v) => (n += v))
}

function Block({
  title,
  figures,
  charts,
  color,
}: {
  title: string
  figures: { label: string; value: string; sub?: string }[]
  charts: { title: string; dates: string[]; values: number[] }[]
  color: string
}) {
  return (
    <section className="section rpt__block">
      <h2 className="section__title">{title}</h2>
      <div className="rpt__body card card--pad">
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
            <div key={c.title} className="rpt__chart">
              <span className="rpt__charttitle">{c.title}</span>
              <DailyChart
                kind="line"
                fill
                height={160}
                dates={c.dates}
                series={[{ key: 'v', label: title, color, values: c.values }]}
                label={`${title}: ${c.title}`}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
