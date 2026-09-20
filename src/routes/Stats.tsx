import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchDailyFile, fetchPlayers, fetchPlayersDaily, type PlayersSnapshot } from '@/activity/queries'
import { playerDays, statValue, type DaySummary, type PlayersDailyFile } from '@/activity/rules'
import { statInfo, STAT_GROUPS } from '@/activity/statinfo'
import { DailyChart, longDate, shortDate } from '@/components/DailyChart'
import { changeOf, StatTile } from '@/components/StatTile'
import { PlayerPicker } from '@/components/PlayerPicker'
import { formatDecimals, formatNumber } from '@/format'

const RANGES = [
  { key: '7', label: '7 days', days: 7 },
  { key: '14', label: '14 days', days: 14 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'Since launch', days: Infinity },
] as const
type RangeKey = (typeof RANGES)[number]['key']

/** Big figures whole; small ones with the decimals that matter. */
function fmt(v: number): string {
  const a = Math.abs(v)
  return a >= 100 || Number.isInteger(v) ? formatNumber(Math.round(v)) : formatDecimals(v, a >= 10 ? 1 : 2)
}

/**
 * Stats — every lifetime counter the game keeps, and how it grows.
 *
 * The list holds every stat the chain has recorded, grouped; choosing one
 * shows how much it rose each day and its running total. Lifetime figures are
 * read live from the player rows; the daily figures come from the collected
 * stat-change log.
 */
export default function Stats() {
  const [params, setParams] = useSearchParams()
  const [days, setDays] = useState<DaySummary[] | null>(null)
  const [snap, setSnap] = useState<PlayersSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [perPlayer, setPerPlayer] = useState<PlayersDailyFile | null>(null)

  const range = (RANGES.find((r) => r.key === params.get('range'))?.key ?? '30') as RangeKey
  const selected = params.get('stat') ?? 'dungeons_played'
  /* A wallet, when one player is chosen; everything below is then theirs. */
  const wallet = params.get('player')

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  useEffect(() => {
    if (wallet && !perPlayer) fetchPlayersDaily().then(setPerPlayer)
  }, [wallet, perPlayer])

  useEffect(() => {
    fetchDailyFile().then((f) => setDays(f.days))
    fetchPlayers()
      .then(setSnap)
      .catch(() => {})
  }, [])

  const spec = RANGES.find((r) => r.key === range)!
  const player = wallet ? snap?.players.find((p) => p.wallet === wallet) : undefined
  const who = wallet ? (player?.tag ?? wallet) : null
  /*
     One player's days line up with the totals' dates — but only the dates
     their history has been collected for. A day that hasn't been collected
     yet is unknown, not a day they did nothing, and showing it as zero would
     say something false.
  */
  const all = useMemo(() => {
    const totals = days ?? []
    if (!wallet) return totals
    if (!perPlayer) return []
    const have = new Set(perPlayer.days.map((d) => d.date))
    return playerDays(perPlayer, wallet, totals.map((d) => d.date).filter((d) => have.has(d)))
  }, [days, wallet, perPlayer])
  const lagging = wallet && perPlayer && days && all.length < days.length ? all[all.length - 1]?.date : null
  const shown = Number.isFinite(spec.days) ? all.slice(-spec.days) : all
  const before = Number.isFinite(spec.days) ? all.slice(-2 * spec.days, -spec.days) : []
  const comparable = before.length === shown.length && shown.length > 0
  const firstShown = all.length - shown.length

  /* Every stat the log or the player rows have ever mentioned. */
  const keys = useMemo(() => {
    const set = new Set<string>()
    for (const d of all) for (const k of Object.keys(d.stats)) set.add(k)
    for (const k of Object.keys(snap?.lifetime ?? {})) set.add(k)
    return [...set]
  }, [all, snap])

  const sum = (key: string, list: DaySummary[]) => list.reduce((n, d) => n + statValue(d.stats, key), 0)
  const lifetime = (key: string) =>
    !snap ? undefined : wallet ? (player ? statValue(player.stats ?? {}, key) : undefined) : statValue(snap.lifetime, key)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return keys
      .map((key) => {
        const info = statInfo(key)
        const inRange = sum(key, shown)
        const prev = comparable ? sum(key, before) : undefined
        return {
          key,
          info,
          inRange,
          perDay: shown.length ? inRange / shown.length : 0,
          change: prev === undefined ? null : changeOf(inRange, prev),
          lifetime: lifetime(key),
        }
      })
      .filter((r) => !q || r.info.label.toLowerCase().includes(q) || r.key.includes(q))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, shown, before, comparable, snap, query])

  const info = statInfo(selected)
  const perDay = shown.map((d) => statValue(d.stats, selected))
  /* The running total starts from everything logged before the range. */
  const base = sum(selected, all.slice(0, firstShown))
  const running = perDay.reduce<number[]>((acc, v) => [...acc, (acc[acc.length - 1] ?? base) + v], [])
  const inRange = perDay.reduce((n, v) => n + v, 0)
  const best = perDay.reduce((b, v, i) => (v > b.v ? { v, i } : b), { v: -1, i: -1 })
  const logged = sum(selected, all)
  const life = lifetime(selected)
  const unit = info.unit ? ` ${info.unit}` : ''
  const prevSel = comparable ? sum(selected, before) : undefined
  const dates = shown.map((d) => d.date)

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{who ? `Stats · ${who}` : 'Stats'}</h1>
          <p className="page__lead">
            {who
              ? <>Every lifetime counter for {who} (<span className="mono">{wallet}</span>).</>
              : 'Every lifetime counter the game keeps, across all players.'}{' '}
            Choose one to see how it grows day by day.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => set('range', r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div className="playerpick">
        <PlayerPicker
          players={(snap?.players ?? []).map((p) => ({
            wallet: p.wallet,
            tag: p.tag,
            activity: p.stats?.dungeons_played ?? 0,
            activityLabel: 'dungeons',
          }))}
          value={wallet}
          onChange={(w) => set('player', w)}
        />
      </div>

      {wallet && snap && !player && <p className="error">No player with the wallet {wallet}.</p>}

      {(!days || (wallet && !perPlayer)) && (
        <p className="loading">
          <span className="spinner" /> Loading…
        </p>
      )}
      {lagging && (
        <p className="notice">
          Player histories are collected through {longDate(lagging)} so far; the days after it are still being
          collected and are left out rather than shown as zero.
        </p>
      )}
      {days && Number.isFinite(spec.days) && days.length < spec.days && (
        <p className="notice">
          The game launched on {longDate(days[0]?.date ?? '2026-08-31')}, so there are only {days.length} days so
          far. This view shows all of them.
        </p>
      )}

      {all.length > 0 && (
        <>
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">{info.label}</h2>
              <span className="section__note">
                {info.group} · <span className="mono">{selected}</span>
              </span>
            </div>
            <div className="tiles">
              <StatTile
                label={who ? 'Lifetime' : 'Lifetime, all players'}
                value={life === undefined ? '…' : fmt(life) + unit}
                /*
                   Lifetime is live; the daily figures stop at the end of
                   yesterday. Checked against every player's row, the two agree
                   once today is added, so the difference is today so far.
                */
                sub={
                  life !== undefined && !lagging && life - logged > 0
                    ? `${fmt(life - logged)}${unit} of it today, since 00:00 UTC`
                    : undefined
                }
              />
              <StatTile
                label={`Last ${spec.label.toLowerCase()}`}
                value={fmt(inRange) + unit}
                change={
                  prevSel !== undefined && changeOf(inRange, prevSel) !== null
                    ? { ratio: changeOf(inRange, prevSel)!, against: `previous ${spec.label}` }
                    : null
                }
              />
              <StatTile label="Per day, on average" value={fmt(shown.length ? inRange / shown.length : 0) + unit} />
              <StatTile
                label="Best day"
                value={best.i >= 0 ? fmt(best.v) + unit : '—'}
                sub={best.i >= 0 ? longDate(dates[best.i]) : undefined}
              />
            </div>
            <div className="charts">
              <div className="card card--pad">
                <div className="card__head">
                  <h3 className="card__title">Increase per day</h3>
                </div>
                <DailyChart
                  dates={dates}
                  series={[{ key: 'day', label: info.label, color: 'var(--series-1)', values: perDay }]}
                  format={(v) => fmt(v) + unit}
                  label={`${info.label}, increase per day`}
                />
              </div>
              <div className="card card--pad">
                <div className="card__head">
                  <h3 className="card__title">Running total since launch</h3>
                </div>
                <DailyChart
                  kind="line"
                  dates={dates}
                  series={[{ key: 'total', label: info.label, color: 'var(--series-1)', values: running }]}
                  format={(v) => fmt(v) + unit}
                  label={`${info.label}, running total`}
                />
              </div>
            </div>
          </section>

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">All stats</h2>
              <input
                className="input"
                type="search"
                placeholder="Find a stat"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Find a stat"
              />
            </div>
            <div className="card table-wrap">
              <table className="table stattable">
                <thead>
                  <tr>
                    <th>Stat</th>
                    <th className="r">{who ? 'Lifetime' : 'Lifetime, all players'}</th>
                    <th className="r">Last {spec.label.toLowerCase()}</th>
                    <th className="r">Per day</th>
                    {comparable && <th className="r">vs previous {spec.label}</th>}
                  </tr>
                </thead>
                {STAT_GROUPS.map((group) => {
                  const list = rows
                    .filter((r) => r.info.group === group)
                    .sort((a, b) => a.info.label.localeCompare(b.info.label))
                  if (!list.length) return null
                  return (
                    <tbody key={group}>
                      <tr className="stattable__group">
                        <th colSpan={comparable ? 5 : 4} scope="colgroup">
                          {group}
                        </th>
                      </tr>
                      {list.map((r) => (
                        <tr key={r.key} className={r.key === selected ? 'is-selected' : undefined}>
                          <td>
                            <button type="button" className="linkish" onClick={() => set('stat', r.key)}>
                              {r.info.label}
                            </button>
                          </td>
                          <td className="r">{r.lifetime === undefined ? '…' : fmt(r.lifetime)}</td>
                          <td className="r">{fmt(r.inRange)}</td>
                          <td className="r">{fmt(r.perDay)}</td>
                          {comparable && (
                          <td className="r">
                            {r.change === null ? (
                              <span className="faint">—</span>
                            ) : (
                              <span className={r.change > 0.0005 ? 'up' : r.change < -0.0005 ? 'down' : ''}>
                                {r.change > 0.0005 ? '▲ +' : r.change < -0.0005 ? '▼ ' : ''}
                                {(r.change * 100).toFixed(Math.abs(r.change) < 0.1 ? 1 : 0)}%
                              </span>
                            )}
                          </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  )
                })}
              </table>
            </div>
            <p className="section__note">
              Lifetime figures are read live from {who ? `${who}'s` : "every player's"} row and include today. The
              daily figures are the chain's log of stat changes since launch ({shortDate(all[0].date)}), whole UTC days
              through {longDate(all[all.length - 1].date)}; today is added once it is over. Checked against every
              player's row, the two agree once today is counted.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
