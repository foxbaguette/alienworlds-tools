import { useEffect, useMemo, useState } from 'react'
import { fetchPlayers } from '@/activity/queries'
import { projectByKey, type ProjectDef } from '@/projects/defs'
import { fetchMcMembers, fetchPdSnapshot, fetchProjectFile, type McMember, type PdSnapshot } from '@/projects/queries'
import { firstSeenByDay, metricOf, summariseProjectRange, type ProjectDay } from '@/projects/rules'
import { DailyChart, longDate } from '@/components/DailyChart'
import { ChartCard, EconomySection, PlayersSection, type Tile } from '@/components/Sections'
import { changeOf, StatTile } from '@/components/StatTile'
import { Recipients, type RecipientRow } from '@/components/Recipients'
import { usePeriod, type PeriodKey } from '@/components/usePeriod'
import { formatDecimals, formatNumber } from '@/format'

const RANGES = [
  { key: '7', label: '7 days', days: 7 },
  { key: '14', label: '14 days', days: 14 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'All collected', days: Infinity },
] satisfies readonly { key: PeriodKey; label: string; days: number }[]

/* TLM and Shards lead every overview; these follow, then anything else by name. */
const SYMBOL_ORDER = ['NAR', 'DEF', 'WAX']
const bySymbol = (a: string, b: string) => {
  const i = (s: string) => SYMBOL_ORDER.indexOf(s) + 1 || 99
  return i(a) - i(b) || a.localeCompare(b)
}

/* A wallet seen for the first time only means something once the history has run a while. */
const WARM_UP_DAYS = 28

const whole = (v: number) => formatNumber(Math.round(v))
const tokens = (v: number) => (v >= 100 || v === 0 ? whole(v) : formatDecimals(v, v >= 10 ? 1 : 2))
const addDays = (date: string, n: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
const pct = (a: number, b: number) => `${Math.round((a / Math.max(1, b)) * 100)}%`

/**
 * A project's overview — Mission Control, Planetary Defense, Naron Rewards.
 *
 * It opens exactly like the Alien Legends overview, so the games compare at a
 * glance: players, then TLM and Shards paid out. After that, what is the
 * project's own: its other rewards, what its players did, and its live state.
 */
export default function ProjectOverview({ projectKey }: { projectKey: string }) {
  const def = projectByKey(projectKey)!
  const [range, setRange] = usePeriod()
  const [days, setDays] = useState<ProjectDay[] | null>(null)
  const [members, setMembers] = useState<McMember[] | null>(null)
  const [pd, setPd] = useState<PdSnapshot | null>(null)

  useEffect(() => {
    setDays(null)
    fetchProjectFile(def.key).then((f) => setDays(f.days))
    if (def.key === 'mc')
      fetchMcMembers()
        .then(setMembers)
        .catch(() => setMembers([]))
    if (def.key === 'pd')
      fetchPdSnapshot()
        .then(setPd)
        .catch(() => {})
  }, [def.key])

  const spec = RANGES.find((r) => r.key === range)!
  const all = days ?? []
  const shown = Number.isFinite(spec.days) ? all.slice(-spec.days) : all
  const before = Number.isFinite(spec.days) ? all.slice(-2 * spec.days, -spec.days) : []
  const comparable = before.length === shown.length && shown.length > 0
  const dates = shown.map((d) => d.date)
  const now = useMemo(() => summariseProjectRange(shown), [shown])
  const prev = useMemo(() => (comparable ? summariseProjectRange(before) : null), [before, comparable])
  const vs = `previous ${spec.label}`
  const cmp = (a: number, b: number | undefined) => {
    const r = comparable ? changeOf(a, b) : null
    return r === null ? null : { ratio: r, against: vs }
  }
  const rangeLabel = spec.label.toLowerCase()
  const through = all.length ? all[all.length - 1].date : null

  const players = usePlayers(def, all, shown, before, dates, rangeLabel, members, pd)

  /* Actions the project no longer uses would only ever show 0. */
  const metrics = def.metrics.filter((m) => all.some((d) => metricOf(d, m.actions) > 0))
  const metric = (actions: string[], list = shown) => list.reduce((n, d) => n + metricOf(d, actions), 0)
  /* What players gained: rewards, less any entry fees of theirs the rewards were paid from. */
  const onDay = (d: ProjectDay, s: string) => (d.paid[s] ?? 0) - (d.stakes?.[s] ?? 0)
  const paid = (s: string, list = shown) => list.reduce((n, d) => n + onDay(d, s), 0)
  const gross = (s: string) => shown.reduce((n, d) => n + (d.paid[s] ?? 0), 0)
  const staked = (s: string) => shown.reduce((n, d) => n + (d.stakes?.[s] ?? 0), 0)
  /* Where players pay in, one bar of the difference would hide the days they paid in more: both are drawn. */
  const flows = (s: string) =>
    staked(s) > 0
      ? {
          title: `${s} rewards and entry fees per day`,
          series: [
            {
              key: 'rewards',
              label: 'Rewards paid',
              color: 'var(--series-1)',
              values: shown.map((d) => d.paid[s] ?? 0),
            },
            {
              key: 'fees',
              label: 'Entry fees paid in',
              color: 'var(--series-2)',
              values: shown.map((d) => d.stakes?.[s] ?? 0),
            },
          ],
        }
      : undefined
  const net = (s: string) =>
    staked(s) > 0 ? `${tokens(gross(s))} in rewards, less ${tokens(staked(s))} players paid in entry fees` : undefined
  const others = [...new Set(all.flatMap((d) => Object.keys(d.paid)))]
    .filter((s) => s !== 'TLM' && s !== 'Shards')
    .sort(bySymbol)
  const nfts = (list: ProjectDay[]) => list.reduce((n, d) => n + d.nfts, 0)
  const showNfts = def.nftRewards && nfts(all) > 0

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{def.name}</h1>
          <p className="page__lead">
            {def.lead}
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

      {!days && (
        <p className="loading">
          <span className="spinner" /> Loading…
        </p>
      )}
      {days && days.length === 0 && (
        <p className="error">
          No daily figures yet for {def.name}. Run <code>npm run collect -- --only projects</code> to build them.
        </p>
      )}
      {days && Number.isFinite(spec.days) && days.length > 0 && days.length < spec.days && (
        <p className="notice">
          History for {def.name} is collected from {longDate(all[0].date)}, so there are {days.length} days so far. This
          view shows all of them.
        </p>
      )}

      {days && days.length > 0 && (
        <>
          <PlayersSection
            note={
              def.activeFrom === 'signers'
                ? `Active means the wallet signed one of ${def.name}'s actions that day${def.actorFields ? ', or mined through it' : ''}.`
                : `Active means ${def.name} rewarded the wallet that day — its players never sign anything there.`
            }
            allTime={players.allTime}
            second={players.second}
            rangeLabel={rangeLabel}
            uniqueActive={now.uniqueActive}
            avgDaily={now.avgDaily}
            peak={now.peak}
            cmpActive={cmp(now.uniqueActive, prev?.uniqueActive)}
            cmpAvg={cmp(now.avgDaily, prev?.avgDaily)}
            dates={dates}
            active={shown.map((d) => d.active)}
            signups={players.signups}
            signupsTitle={players.signupsTitle}
            signupsFoot={players.signupsFoot}
          />

          <EconomySection
            recipients={(symbol, close) => (
              <ProjectRecipients symbol={symbol} shown={shown} rangeLabel={rangeLabel} onClose={close} />
            )}
            note={def.paidNote}
            days={shown.length}
            dates={dates}
            format={tokens}
            tlm={{
              total: paid('TLM'),
              change: cmp(paid('TLM'), paid('TLM', before)),
              perDay: shown.map((d) => onDay(d, 'TLM')),
              sub: net('TLM'),
              chart: flows('TLM'),
            }}
            shards={{
              total: paid('Shards'),
              change: cmp(paid('Shards'), paid('Shards', before)),
              perDay: shown.map((d) => onDay(d, 'Shards')),
              sub: net('Shards'),
              chart: flows('Shards'),
            }}
            extraTiles={[
              ...others.map((s) => ({
                label: `${s} paid out`,
                value: tokens(paid(s)),
                change: cmp(paid(s), paid(s, before)),
                sub: net(s) ?? `${tokens(paid(s) / Math.max(1, shown.length))} a day on average`,
              })),
              ...(showNfts
                ? [{ label: 'NFTs sent', value: whole(nfts(shown)), change: cmp(nfts(shown), nfts(before)) }]
                : []),
            ]}
            extraCharts={others.slice(0, 1).map((s) => {
              const f = flows(s)
              return {
                title: f?.title ?? `${s} paid out per day`,
                node: f ? (
                  <DailyChart dates={dates} series={f.series} kind="line" format={tokens} label={f.title} />
                ) : (
                  <DailyChart
                    dates={dates}
                    series={[{ key: s, label: s, color: 'var(--series-1)', values: shown.map((d) => onDay(d, s)) }]}
                    format={tokens}
                    label={`${s} paid out per day`}
                  />
                ),
              }
            })}
          >
            <RewardKinds def={def} shown={shown} />
          </EconomySection>

          {metrics.length > 0 && (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Activity</h2>
                <span className="section__note">Totals for the last {rangeLabel}</span>
              </div>
              <div className="tiles">
                {metrics.map((m) => (
                  <StatTile
                    key={m.key}
                    label={m.label}
                    value={whole(metric(m.actions))}
                    change={cmp(metric(m.actions), metric(m.actions, before))}
                    sub={`${whole(metric(m.actions) / Math.max(1, shown.length))} a day`}
                  />
                ))}
              </div>
              <div className="charts">
                {metrics.slice(0, 2).map((m) => (
                  <ChartCard key={m.key} title={`${m.label} per day`}>
                    <DailyChart
                      dates={dates}
                      series={[
                        {
                          key: m.key,
                          label: m.label,
                          color: 'var(--series-1)',
                          values: shown.map((d) => metricOf(d, m.actions)),
                        },
                      ]}
                      label={`${m.label} per day`}
                    />
                  </ChartCard>
                ))}
              </div>
            </section>
          )}

          {def.key === 'pd' && <PdMissions snap={pd} />}

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
                    {['TLM', 'Shards', ...others].map((s) => (
                      <th key={s} className="r">
                        {s} paid
                      </th>
                    ))}
                    {showNfts && <th className="r">NFTs</th>}
                    {metrics.map((m) => (
                      <th key={m.key} className="r">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...shown].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{longDate(d.date)}</td>
                      <td className="r">{whole(d.active)}</td>
                      {['TLM', 'Shards', ...others].map((s) => (
                        <td key={s} className="r">
                          {tokens(onDay(d, s))}
                        </td>
                      ))}
                      {showNfts && <td className="r">{whole(d.nfts)}</td>}
                      {metrics.map((m) => (
                        <td key={m.key} className="r">
                          {whole(metricOf(d, m.actions))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/* ---------- players, per project ---------- */

interface Players {
  allTime: Tile | null
  second: Tile | null
  signups: number[] | null
  signupsTitle: string
  signupsFoot?: string
}

/**
 * The Players section's project-specific parts. Mission Control keeps a
 * member list with join dates; the others have no sign-up record, so a new
 * player is a wallet seen for the first time in the collected history.
 */
function usePlayers(
  def: ProjectDef,
  all: ProjectDay[],
  shown: ProjectDay[],
  before: ProjectDay[],
  dates: string[],
  rangeLabel: string,
  members: McMember[] | null,
  pd: PdSnapshot | null,
): Players {
  const firstSeen = useMemo(() => firstSeenByDay(all), [all])
  const since = all[0]?.date ?? def.since
  const countFrom = addDays(since, WARM_UP_DAYS)
  const newIn = (list: ProjectDay[]) =>
    list.reduce((n, d) => n + (d.date >= countFrom ? (firstSeen[d.date] ?? 0) : 0), 0)
  const seen = {
    signups: dates.map((d) => (d >= countFrom ? (firstSeen[d] ?? 0) : 0)),
    signupsTitle: 'New players per day',
    signupsFoot: `A new player is a wallet seen for the first time since ${longDate(since)}, counted from ${longDate(countFrom)}.`,
  }
  const sub = `${whole(newIn(shown))} new in the last ${rangeLabel}`

  if (def.key === 'mc') {
    if (!members) return { allTime: null, second: null, signups: null, signupsTitle: 'New members per day' }
    const joined: Record<string, number> = {}
    for (const m of members) {
      const d = new Date(m.joined).toISOString().slice(0, 10)
      joined[d] = (joined[d] ?? 0) + 1
    }
    const full = members.filter((m) => !m.trial).length
    return {
      allTime: {
        label: 'Players, all time',
        value: whole(members.length),
        sub: `${whole(shown.reduce((n, d) => n + (joined[d.date] ?? 0), 0))} joined in the last ${rangeLabel}`,
      },
      second: {
        label: 'Full members',
        value: whole(full),
        sub: `${pct(full, members.length)} of all players · the rest on trial`,
      },
      signups: dates.map((d) => joined[d] ?? 0),
      signupsTitle: 'New members per day',
    }
  }

  if (def.key === 'pd') {
    return {
      allTime: pd ? { label: 'Players, all time', value: whole(pd.players), sub } : null,
      second: pd ? { label: 'Warlords', value: whole(pd.warlords), sub: 'Landowners defending Magor' } : null,
      ...seen,
    }
  }

  /* Naron keeps no player list: its players are the wallets it has rewarded. */
  const everyone = new Set(all.flatMap((d) => d.wallets))
  const inRange = new Set(shown.flatMap((d) => d.wallets))
  const earlier = new Set(before.flatMap((d) => d.wallets))
  const returning = [...inRange].filter((w) => earlier.has(w)).length
  return {
    allTime: { label: `Players since ${longDate(since)}`, value: whole(everyone.size), sub },
    second: before.length
      ? {
          label: 'Returning players',
          value: whole(returning),
          sub: `${pct(returning, inRange.size)} were also active the ${rangeLabel} before`,
        }
      : { label: 'Returning players', value: '—', sub: 'Nothing earlier to compare with' },
    ...seen,
  }
}

/* ---------- who was paid ---------- */

function ProjectRecipients({
  symbol,
  shown,
  rangeLabel,
  onClose,
}: {
  symbol: string
  shown: ProjectDay[]
  rangeLabel: string
  onClose: () => void
}) {
  /* Names: a Mission Control gamertag where the player has one, else their Alien Legends name. */
  const [tags, setTags] = useState<Record<string, string>>({})
  useEffect(() => {
    Promise.all([fetchMcMembers().catch(() => []), fetchPlayers().catch(() => null)]).then(([mc, ale]) =>
      setTags({
        ...Object.fromEntries((ale?.players ?? []).filter((p) => p.tag).map((p) => [p.wallet, p.tag!])),
        ...Object.fromEntries(mc.filter((m) => m.tag).map((m) => [m.wallet, m.tag!])),
      }),
    )
  }, [])
  const rows = useMemo(() => {
    const by = new Map<string, RecipientRow>()
    const row = (w: string) => by.get(w) ?? by.set(w, { wallet: w, received: 0, days: 0 }).get(w)!
    for (const d of shown) {
      for (const [w, v] of Object.entries(d.received?.[symbol] ?? {})) {
        const r = row(w)
        r.received += v
        r.days += 1
      }
      for (const [w, v] of Object.entries(d.feesBy?.[symbol] ?? {})) {
        const r = row(w)
        r.fees = (r.fees ?? 0) + v
      }
    }
    return [...by.values()]
  }, [shown, symbol])
  return (
    <Recipients symbol={symbol} rows={rows} tags={tags} rangeLabel={rangeLabel} format={tokens} onClose={onClose} />
  )
}

/* ---------- kinds of reward ---------- */

function RewardKinds({ def, shown }: { def: ProjectDef; shown: ProjectDay[] }) {
  const symbols = [...new Set(shown.flatMap((d) => Object.keys(d.categories).map((k) => k.split('|')[1])))].sort(
    (a, b) => (a === 'TLM' ? -1 : b === 'TLM' ? 1 : bySymbol(a, b)),
  )
  const rows = symbols
    .flatMap((symbol) =>
      (def.categories ?? []).map((c) => {
        const key = `${c.key}|${symbol}`
        return {
          key,
          label: c.label,
          symbol,
          count: shown.reduce((n, d) => n + (d.categories[key]?.count ?? 0), 0),
          amount: shown.reduce((n, d) => n + (d.categories[key]?.amount ?? 0), 0),
        }
      }),
    )
    .filter((r) => r.count > 0)
  if (!rows.length) return null
  /* Entry fees players paid in, taken off the rewards they funded. */
  const fees = symbols
    .map((symbol) => ({ symbol, amount: shown.reduce((n, d) => n + (d.stakes?.[symbol] ?? 0), 0) }))
    .filter((f) => f.amount > 0)
  const totalOf = (symbol: string) => rows.filter((r) => r.symbol === symbol).reduce((n, r) => n + r.amount, 0)
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Reward</th>
            <th className="r">Payments</th>
            <th className="r">Amount</th>
            <th className="r">Share of the token</th>
          </tr>
        </thead>
        <tbody>
          {symbols
            .flatMap((symbol) => [
              ...rows.filter((r) => r.symbol === symbol),
              ...fees.filter((f) => f.symbol === symbol).map((f) => ({ key: `fees|${symbol}`, fee: f.amount, symbol })),
            ])
            .map((r) =>
              'fee' in r ? (
                <tr key={r.key}>
                  <td>Less entry fees players paid in</td>
                  <td className="r" />
                  <td className="r">
                    −{tokens(r.fee)} {r.symbol}
                  </td>
                  <td className="r" />
                </tr>
              ) : (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="r">{whole(r.count)}</td>
                  <td className="r">
                    {tokens(r.amount)} {r.symbol}
                  </td>
                  <td className="r">{pct(r.amount, totalOf(r.symbol))}</td>
                </tr>
              ),
            )}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- Planetary Defense missions ---------- */

function PdMissions({ snap }: { snap: PdSnapshot | null }) {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const at = Date.now()
  const running = (snap?.missions ?? [])
    .filter((m) => m.start <= at && m.end > at)
    .sort((a, b) => b.divisions - a.divisions)
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Missions running now</h2>
        <span className="section__note">
          {snap
            ? `${whole(running.length)} running, ${whole(running.reduce((n, m) => n + m.divisions, 0))} divisions joined · live from miss.pdef`
            : 'Live from miss.pdef'}
        </span>
      </div>
      {!snap ? (
        <p className="loading">
          <span className="spinner" /> Reading missions…
        </p>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mission</th>
                <th>Planet</th>
                <th className="r">Divisions joined</th>
                <th className="r">Total attack</th>
                <th className="r">Ends (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {running.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td>{cap(m.planet)}</td>
                  <td className="r">{whole(m.divisions)}</td>
                  <td className="r">{whole(m.attack)}</td>
                  <td className="r">{longDate(new Date(m.end).toISOString().slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
