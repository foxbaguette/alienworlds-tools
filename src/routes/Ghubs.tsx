import { useEffect, useMemo, useState } from 'react'
import { fetchDailyFile, fetchPlayers, type PlayersSnapshot } from '@/activity/queries'
import { dayStart, statValue, summariseRange, type DaySummary } from '@/activity/rules'
import { DailyChart, longDate } from '@/components/DailyChart'
import { formatNumber } from '@/format'
import { FARM, fetchFarmDaily, type FarmDay } from '@/farm/queries'
import { NFTS, fetchNftsDaily, type NftsDay } from '@/nfts/queries'

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
}

const METRICS: Metric[] = [
  { key: 'tlm', title: 'TLM paid out to players', stat: 'tlm_earned', unit: 'TLM' },
  { key: 'shards', title: 'Shards paid out to players', stat: 'shards_earned', unit: 'Shards' },
  { key: 'dungeons', title: 'Dungeons played', stat: 'dungeons_played' },
  { key: 'arenas', title: 'Arenas played', stat: 'arenas_played' },
  { key: 'quests', title: 'Quests completed', stat: 'quests_completed' },
  { key: 'recruits', title: 'Fighters recruited', stat: 'recruits' },
]

/**
 * One colour for every graph. Each graph shows one quantity under its own
 * heading, so a colour would have nothing to tell apart — and a different
 * one per section invites the reader to look for a meaning that is not there.
 */
const LINE = 'var(--series-1)'

const whole = (v: number) => formatNumber(Math.round(v))
const monthOf = (date: string) => date.slice(0, 7)
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export default function Ghubs() {
  const [days, setDays] = useState<DaySummary[] | null>(null)
  const [snap, setSnap] = useState<PlayersSnapshot | null>(null)
  const [month, setMonth] = useState<string>('')
  const [farm, setFarm] = useState<FarmDay[]>([])
  const [nftDays, setNftDays] = useState<NftsDay[]>([])

  useEffect(() => {
    fetchDailyFile().then((f) => setDays(f.days))
    fetchFarmDaily().then((f) => setFarm(f.days))
    fetchNftsDaily().then((f) => setNftDays(f.days))
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

  /*
     NFTs staked on the farm are a stock, not a flow: what matters is how many
     are staked, and how that moved, not a sum of daily figures. So the pair is
     "staked on the last day" and "change over the month", and there is no
     running total. A day the collector missed carries the one before it.
  */
  const farmBy = useMemo(() => new Map(farm.map((d) => [d.date, Object.values(d.nfts).reduce((n, v) => n + v, 0)])), [farm])
  const nftsBy = useMemo(() => new Map(nftDays.map((d) => [d.date, d.rows])), [nftDays])
  const staked = stockOf(farmBy, dates, monthDates.length)
  const nftRows = stockOf(nftsBy, dates, monthDates.length)

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
          <h1 className="page__title">Alien Legends - gHubs report · {name || '…'}</h1>
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
              charts={[
                { title: 'Per day, since launch', dates, values: upTo.map((d) => statValue(d.stats, m.stat!)) },
                { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map((d) => statValue(d.stats, m.stat!)) },
                { title: 'Running total, since launch', dates, values: running(upTo.map((d) => statValue(d.stats, m.stat!))) },
              ]}
            />
          ))}

          {farm.length ? (
            <Block
              title="NFTs staked on the farm"
              figures={stockFigures(staked, lastDay ? `Staked on ${longDate(lastDay)}` : 'Staked', FARM, within)}
              charts={[
                { title: 'End of each day, since launch', dates, values: staked.values },
                { title: `End of each day, ${name}`, dates: monthDates, values: staked.inMonth },
              ]}
            />
          ) : null}

          {nftDays.length ? (
            <Block
              title="Unique NFTs used for other purposes per day"
              figures={stockFigures(nftRows, lastDay ? `On ${longDate(lastDay)}` : 'Last day', `unique NFTs, ${NFTS}`, within)}
              charts={[
                { title: 'Per day, since launch', dates, values: nftRows.values },
                { title: `Per day, ${name}`, dates: monthDates, values: nftRows.inMonth },
              ]}
            />
          ) : null}

          <p className="section__note rpt__foot">
            Generated {new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.
          </p>
        </>
      )}
    </div>
  )
}

/**
 * A quantity that stands at a level — NFTs staked, rows in a table — rather
 * than one that adds up. The day's figure where there is one, the day before's
 * where the collector missed it; and the month measured from the close of the
 * day before it began, or from its own first day for the month of launch.
 */
interface Stock {
  values: number[]
  inMonth: number[]
  start: number
  end: number
}

function stockOf(byDate: Map<string, number>, dates: string[], monthDays: number): Stock {
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
function stockFigures(s: Stock, endLabel: string, endSub: string, within: string) {
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

/** Each day's value added to everything before it. */
function running(values: number[]): number[] {
  let n = 0
  return values.map((v) => (n += v))
}

function Block({
  title,
  figures,
  charts,
}: {
  title: string
  figures: { label: string; value: string; sub?: string }[]
  charts: { title: string; dates: string[]; values: number[] }[]
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
                series={[{ key: 'v', label: title, color: LINE, values: c.values }]}
                label={`${title}: ${c.title}`}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
