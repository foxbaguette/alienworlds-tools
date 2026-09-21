import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatDecimals, formatNumber } from '@/format'
import { fetchPoolDescriptions, fetchShardPools, fetchTlmPools, liveShardPool, liveTlmState } from '@/pools/tables'
import { fetchPlayerTags } from '@/players'
import { fetchPoolActivity, fetchPoolDailyFile, fetchPoolHistory } from '@/poolstats/queries'
import { progressMeter } from '@/chain/history'
import { shortDate, longDate } from '@/components/DailyChart'
import {
  HIDDEN_POOLS,
  bucketOut,
  expandDays,
  type PoolDay,
  recipientsOf,
  type Recipient,
  KIND_LABEL,
  leftPool,
  playersOf,
  poolName,
  poolOf,
  poolTable,
  summarisePools,
  type BalancePoint,
  type Payout,
  type PayoutKind,
  type PoolSummary,
} from '@/poolstats/rules'
import { BarStrip, LineChart } from '@/components/LineChart'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * The window the whole page looks at. The last 24 hours is read live from
 * history; anything longer comes from the collected days, which stop at the
 * end of yesterday (UTC) — a day of pool history is about 20,000 rows, far
 * too many to crawl in a browser for a month.
 */
const WINDOWS = [
  { key: '1d', label: '24 hours', days: 1 },
  { key: '7', label: '7 days', days: 7 },
  { key: '14', label: '14 days', days: 14 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'Since launch', days: Infinity },
] as const
type WindowKey = (typeof WINDOWS)[number]['key']

/** What the page is showing: when from and to, and whether it is live. */
interface Frame {
  key: WindowKey
  label: string
  /** "in the last 7 days", "since launch". */
  phrase: string
  since: number
  until: number
  live: boolean
  /** The collected days behind a non-live window. */
  days: PoolDay[]
}

/** Balance at the end of each collected day, for one pool. */
function closesOf(days: PoolDay[], pool: string): BalancePoint[] {
  return days
    .filter((d) => d.close[pool] !== undefined)
    .map((d) => ({ t: Date.parse(d.date + 'T00:00:00Z') + DAY, v: d.close[pool] }))
}

/** Reserve at the end of each collected day, for a TLM pool. */
function reserveClosesOf(days: PoolDay[], pool: string): BalancePoint[] {
  return days
    .filter((d) => d.reserve?.[pool] !== undefined)
    .map((d) => ({ t: Date.parse(d.date + 'T00:00:00Z') + DAY, v: d.reserve![pool] }))
}

/* The reserve's line: dashed, and a colour none of the pool types use. */
const RESERVE_COLOR = 'var(--series-4)'

const ICON: Record<string, string> = {
  tlm: 'icons/tlm.svg',
  shards: 'icons/shards.svg',
  wax: 'icons/wax.png',
}
const SYMBOL: Record<string, string> = { tlm: 'TLM', shards: 'Shards', wax: 'WAX' }

/** The pool list shows one currency at a time. */
const CURRENCIES = [
  { key: 'tlm', label: 'TLM pools' },
  { key: 'shards', label: 'Shard pools' },
  { key: 'wax', label: 'WAX pools' },
] as const
type CurrencyKey = (typeof CURRENCIES)[number]['key']
/* One hue for every single-series chart; the title names the currency. */
const COLOR: Record<string, string> = { tlm: 'var(--series-1)', shards: 'var(--series-1)' }

/** The order kinds are stacked and listed in. */
/* What counts as paid out, stacked in this order. Escrow is shown beside it, not in it. */
const KINDS: PayoutKind[] = ['mine', 'landowner', 'claim']

/** The contract that paid, named for what it is where there is only one. */
const PAYER_LABEL: Record<string, string> = {
  'quests.ale': 'Quest rewards claimed',
  'recovery.ale': 'Candle payouts',
  'players.ale': 'Claimed from Rewards',
}

function kindLabel(kind: PayoutKind, payers?: string[]): string {
  if (kind === 'claim' && payers?.length === 1) return PAYER_LABEL[payers[0]] ?? `Paid by ${payers[0]}`
  return KIND_LABEL[kind]
}

/** Whole tokens, with the decimals that matter at that size. */
function amount(v: number, type: string): string {
  if (v === 0) return '0'
  if (type === 'shards') return formatDecimals(v, v >= 100 ? 0 : 1)
  if (type === 'wax') return formatDecimals(v, v >= 1000 ? 0 : 2)
  return formatDecimals(v, v >= 1000 ? 0 : v >= 10 ? 1 : 2)
}

function plural(n: number, one: string): string {
  return `${formatNumber(n)} ${one}${n === 1 ? '' : 's'}`
}

function ago(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h}h ${mins % 60}m ago` : `${Math.floor(h / 24)}d ago`
}

interface Balance {
  pool: string
  type: string
  balance: number
  /** Feeds the other pools rather than paying players — see PoolSummary. */
  parent?: boolean
  /** What it is holding back from them. */
  reserve?: number
}

/**
 * Pool payouts — what left every pool in the last day, how, and to whom.
 *
 * Read from history rather than tables (see `poolstats/queries`), so the
 * first open costs a crawl of a few seconds; everything after that is in
 * memory for a minute and a half.
 */
export default function PoolStats() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('pool')
  const view = params.get('view')
  const currency = (CURRENCIES.find((c) => c.key === params.get('cur'))?.key ?? 'tlm') as CurrencyKey
  const win = (WINDOWS.find((w) => w.key === params.get('win'))?.key ?? '1d') as WindowKey
  const spec = WINDOWS.find((w) => w.key === win)!

  const [frame, setFrame] = useState<Frame | null>(null)
  const [progress, setProgress] = useState(0)
  /* The live window's start, kept so coming back to it reuses the crawl. */
  const [liveSince, setLiveSince] = useState(() => Date.now() - DAY)
  const [payouts, setPayouts] = useState<Payout[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [balances, setBalances] = useState<Balance[]>([])
  const [descriptions, setDescriptions] = useState<Map<string, string>>(new Map())
  const [tags, setTags] = useState<Record<string, string>>({})
  const [loadedAt, setLoadedAt] = useState(0)

  /*
     A refresh of the live window is a fresh window: the last 24 hours from
     now, not from the first open. The collected windows are re-read from the
     file, which only changes when the collector runs.
  */
  const load = (refresh = false) => {
    let live = true
    setError(null)
    setPayouts(null)
    setProgress(0)
    const phrase = spec.key === 'all' ? 'since launch' : `in the last ${spec.label}`
    if (spec.key === '1d') {
      const from = refresh ? Date.now() - DAY : liveSince
      if (refresh) setLiveSince(from)
      fetchPoolActivity(from, { refresh, onProgress: progressMeter((f) => live && setProgress(f)) })
        .then((p) => {
          if (!live) return
          setFrame({ key: spec.key, label: spec.label, phrase, since: from, until: Date.now(), live: true, days: [] })
          setPayouts(p)
          setLoadedAt(Date.now())
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    } else {
      fetchPoolDailyFile()
        .then((file) => {
          if (!live) return
          const days = Number.isFinite(spec.days) ? file.days.slice(-spec.days) : file.days
          if (!days.length) {
            setError('No collected days yet. Run npm run collect to build them.')
            return
          }
          const since = Date.parse(days[0].date + 'T00:00:00Z')
          const until = Date.parse(days[days.length - 1].date + 'T00:00:00Z') + DAY
          setFrame({ key: spec.key, label: spec.label, phrase, since, until, live: false, days })
          setPayouts(expandDays(days))
          setLoadedAt(Date.now())
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    }
    return () => {
      live = false
    }
  }

  useEffect(() => load(), [win]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    Promise.all([fetchTlmPools(), fetchShardPools()])
      .then(([tlm, shards]) => {
        const now = Date.now()
        setBalances([
          /*
           * The parent pool is kept, flagged. It pays nobody directly — what
           * leaves it goes into the sub-pools — so it must stay out of the
           * totals or every payout would be counted twice. But its balance is
           * the first place a shortfall would show, which is worth watching.
           */
          ...tlm.map((p) => {
            /* Projected together: what the fill rate has moved into the
               balance since the row was written has left the reserve. */
            const live = liveTlmState(p, now)
            return {
              pool: p.pool,
              type: 'tlm',
              balance: live.current / 10_000,
              /* Every TLM pool holds some back and releases it at its fill
                 rate — the source into the sub-pools, each sub-pool into what
                 it can pay out. Shard pools have no reserve at all. */
              reserve: live.reserve / 10_000,
              ...((p.subpools ?? []).length ? { parent: true } : {}),
            }
          }),
          ...shards.map((p) => ({ pool: p.pool, type: 'shards', balance: liveShardPool(p, now) / 10 })),
        ])
      })
      .catch(() => {})
    fetchPoolDescriptions()
      .then((rows) => setDescriptions(new Map(rows.map((r) => [r.pool_name, r.pool_description]))))
      .catch(() => {})
    fetchPlayerTags()
      .then(setTags)
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const summaries = useMemo(
    () => (payouts ? summarisePools(payouts, balances) : []),
    [payouts, balances],
  )

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: key !== 'pool' })
  }

  const summary = selected ? summaries.find((s) => s.pool === selected) : undefined

  return (
    <div className="page pstats">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            {view === 'players' ? 'Players paid' : selected ? poolName(selected, descriptions) : 'Reward pools'}
          </h1>
          <p className="page__lead">
            {view === 'players' ? (
              <>
                <Link to={`?${new URLSearchParams([...params].filter(([k]) => k !== 'view'))}`}>← All pools</Link> ·
                Everyone who received TLM or Shards {frame?.phrase ?? ''}. Click a column heading to sort.
              </>
            ) : selected ? (
              <>
                <Link to={`?${new URLSearchParams([...params].filter(([k]) => k !== 'pool'))}`}>← All pools</Link>
                {' · '}
                <span className="mono">{selected}</span>
                {descriptions.get(selected) ? ` · ${descriptions.get(selected)}` : ''}
              </>
            ) : (
              <>
                What every reward pool paid out to players {frame?.phrase ?? (spec.key === 'all' ? 'since launch' : `in the last ${spec.label}`)}, traced from the chain's own records
                {frame && !frame.live && <> — whole UTC days, through {longDate(frame.days[frame.days.length - 1].date)}</>}.
              </>
            )}
          </p>
        </div>
        <div className="pstats__controls">
          <div className="seg" role="group" aria-label="Period">
            {WINDOWS.map((w) => (
              <button key={w.key} type="button" aria-pressed={win === w.key} onClick={() => setParam('win', w.key === '1d' ? null : w.key)}>
                {w.label}
              </button>
            ))}
          </div>
          {win === '1d' && (
            <button type="button" className="btn" onClick={() => load(true)} disabled={!payouts}>
              Refresh
            </button>
          )}
        </div>
      </header>

      {error && <p className="error">Could not read the payout history: {error}</p>}
      {!payouts && !error && (
        <div className="progress-wrap" role="status" aria-live="polite">
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${Math.max(3, Math.round((win === '1d' ? progress : 0.6) * 100))}%` }} />
          </div>
          <p className="loading">
            {win === '1d'
              ? `Reading the last 24 hours of payouts and tracing where each one came from… ${Math.round(progress * 100)}%`
              : 'Loading the collected days…'}
          </p>
        </div>
      )}

      {payouts && frame &&
        (view === 'players' ? (
          <PlayersPaid payouts={payouts} tags={tags} />
        ) : selected ? (
          <PoolDetail
            frame={frame}
            payouts={payouts}
            tags={tags}
            pool={selected}
            summary={summary}
            type={
              summary?.type ??
              balances.find((b) => b.pool === selected)?.type ??
              (selected.startsWith('shrd') ? 'shards' : 'tlm')
            }
            balance={balances.find((b) => b.pool === selected)?.balance}
            reserve={balances.find((b) => b.pool === selected)?.reserve}
          />
        ) : (
          <Overview
            frame={frame}
            payouts={payouts}
            summaries={summaries}
            descriptions={descriptions}
            hasBalance={new Set(balances.map((b) => b.pool))}
            loadedAt={loadedAt}
            onOpen={(pool) => setParam('pool', pool)}
            onPlayers={() => setParam('view', 'players')}
            currency={currency}
            onCurrency={(c) => setParam('cur', c === 'tlm' ? null : c)}
          />
        ))}
    </div>
  )
}

/* ---------- shared pieces ---------- */

/** A bar in the kinds' colours, scaled to `of`. */
function KindBar({ summary, of }: { summary: PoolSummary; of: number }) {
  return (
    <span className="kindbar" aria-hidden="true">
      {KINDS.map((k) =>
        summary.byKind[k] > 0 ? (
          <span
            key={k}
            className={`kindbar__seg kindbar__seg--${k}`}
            style={{ width: `${(summary.byKind[k] / Math.max(1, of)) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  )
}

function KindList({ summary, payers }: { summary: PoolSummary; payers?: string[] }) {
  const parts = KINDS.filter((k) => summary.byKind[k] > 0)
  if (!parts.length && !summary.intoEscrow) return null
  return (
    <ul className="kindlist">
      {parts.map((k) => (
        <li key={k}>
          <span className={`kinddot kinddot--${k}`} />
          {kindLabel(k, payers)}
          <strong>{amount(summary.byKind[k], summary.type)}</strong>
        </li>
      ))}
      {summary.intoEscrow > 0 && (
        <li className="kindlist__aside">
          <span className="kinddot kinddot--claimed" />
          Moved into escrow, not paid out yet
          <strong>{amount(summary.intoEscrow, summary.type)}</strong>
        </li>
      )}
    </ul>
  )
}

function Total({
  icon,
  label,
  value,
  sub,
  onClick,
}: {
  icon?: string
  label: string
  value: string
  sub?: string
  /** Makes the tile a way into the detail behind the number. */
  onClick?: () => void
}) {
  const body = (
    <>
      {icon && <img src={icon} alt="" />}
      <strong>{value}</strong>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </>
  )
  return onClick ? (
    <button type="button" className="ptotal ptotal--link" onClick={onClick}>
      {body}
      <small className="ptotal__more">See everyone →</small>
    </button>
  ) : (
    <div className="ptotal">{body}</div>
  )
}

/** The live balance as a final point, so the line reaches "now". */
function withNow(points: BalancePoint[], balance: number | undefined): BalancePoint[] {
  return balance === undefined ? points : [...points, { t: Date.now(), v: balance }]
}

/** The other contracts that paid out of each pool, for naming them. */
function payersByPool(payouts: Payout[]): Map<string, string[]> {
  const m = new Map<string, Set<string>>()
  for (const p of payouts) {
    if (p.kind !== 'claim') continue
    const k = poolOf(p)
    const s = m.get(k) ?? new Set<string>()
    s.add(p.payer)
    m.set(k, s)
  }
  return new Map([...m].map(([k, s]) => [k, [...s]]))
}

/* ---------- all pools ---------- */

function Overview({
  frame,
  payouts,
  summaries,
  descriptions,
  hasBalance,
  loadedAt,
  onOpen,
  onPlayers,
  currency,
  onCurrency,
}: {
  frame: Frame
  payouts: Payout[]
  summaries: PoolSummary[]
  descriptions: Map<string, string>
  hasBalance: Set<string>
  loadedAt: number
  onOpen: (pool: string) => void
  onPlayers: () => void
  currency: CurrencyKey
  onCurrency: (c: CurrencyKey) => void
}) {
  /* Everything on this list is for the chosen currency only. */
  const shownPools = summaries.filter((s) => s.type === currency)
  /* The source pool is on the page but never in a sum: what leaves it is
     counted again the moment the sub-pool it fed pays somebody. */
  const paying = shownPools.filter((s) => !s.parent)
  const out = paying.reduce((n, s) => n + s.out, 0)
  const landowner = paying.reduce((n, s) => n + s.byKind.landowner, 0)
  const payments = paying.reduce((n, s) => n + s.payouts, 0)
  const players = new Set(
    payouts
      .filter((p) => p.type === currency && p.kind !== 'escrow' && !HIDDEN_POOLS.has(poolOf(p)))
      .map((p) => p.player),
  ).size
  const sym = SYMBOL[currency]
  const payers = useMemo(() => payersByPool(payouts), [payouts])

  /*
     Each pool's balance over the window. Live, a day of every change, one
     pool at a time so the servers are not rushed; collected, the closing
     balance of each day, already in the file.
  */
  const [lines, setLines] = useState<Record<string, BalancePoint[]>>({})
  /* The same for what each TLM pool holds back. Read from the same writes as
     the balance, so it costs nothing a second time. */
  const [reserves, setReserves] = useState<Record<string, BalancePoint[]>>({})
  useEffect(() => {
    let live = true
    if (!frame.live) {
      setLines(Object.fromEntries(summaries.map((s) => [s.pool, closesOf(frame.days, s.pool)])))
      setReserves(Object.fromEntries(summaries.map((s) => [s.pool, reserveClosesOf(frame.days, s.pool)])))
      return
    }
    setLines({})
    setReserves({})
    void (async () => {
      for (const s of summaries) {
        if (!live) return
        if (!hasBalance.has(s.pool)) continue
        try {
          const pts = await fetchPoolHistory(poolTable(s.type), s.pool, frame.since)
          if (live) setLines((prev) => ({ ...prev, [s.pool]: withNow(pts, s.balance) }))
          const held = s.reserve
          if (s.type === 'tlm' && held !== undefined) {
            const r = await fetchPoolHistory('tlmpools', s.pool, frame.since, false, 'reserve')
            if (live) setReserves((prev) => ({ ...prev, [s.pool]: withNow(r, held) }))
          }
        } catch {
          /* The card just goes without its line. */
        }
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, summaries.length, hasBalance.size])

  const groups = [{ type: currency, title: CURRENCIES.find((c) => c.key === currency)!.label }]

  return (
    <>
      <div className="seg" role="group" aria-label="Currency">
        {CURRENCIES.map((c) => (
          <button key={c.key} type="button" aria-pressed={currency === c.key} onClick={() => onCurrency(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <section className="pstats__totals">
        <Total
          icon={ICON[currency]}
          label={`${sym} paid out to players`}
          value={amount(out, currency)}
          sub={landowner > 0 ? `${amount(landowner, currency)} of it as landowner cuts` : undefined}
        />
        <Total label={`Payments in ${sym}`} value={formatNumber(payments)} />
        <Total label={`Players paid in ${sym}`} value={formatNumber(players)} onClick={onPlayers} />
      </section>

      {shownPools.length === 0 && (
        <p className="notice">
          Nothing was paid out in {sym} in the last 24 hours. The only WAX pool is the Candle's, which pays when a
          recovery mission settles.
        </p>
      )}

      <ul className="kindlegend" aria-label="What the colours mean">
        {KINDS.map((k) => (
          <li key={k}>
            <span className={`kinddot kinddot--${k}`} />
            {KIND_LABEL[k]}
          </li>
        ))}
      </ul>

      {groups.map((g) => {
        const list = summaries.filter((s) => s.type === g.type)
        if (!list.length) return null
        const top = Math.max(1, ...list.filter((s) => !s.parent).map((s) => s.out))
        return (
          <section key={g.type} className="pstats__group">
            <h2 className="section__title">{g.title}</h2>
            <div className="pstats__grid">
              {list.map((s) => (
                <button type="button" key={s.pool} className={`pcard pcard--${s.type}`} onClick={() => onOpen(s.pool)}>
                  <div className="pcard__head">
                    <img src={(ICON[s.type] ?? ICON.tlm)} alt="" />
                    <div>
                      <strong className="pcard__name">{poolName(s.pool, descriptions)}</strong>
                      <span className="pcard__id mono">{s.pool}</span>
                    </div>
                  </div>
                  {s.parent ? (
                    <>
                      <div className="pcard__paid">
                        <span>Feeds every pool below it</span>
                      </div>
                      <div className="pcard__meta">
                        <span>Not counted in the totals</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="pcard__paid">
                        <span>
                          <strong>{amount(s.out, s.type)}</strong> {SYMBOL[s.type]} paid out
                        </span>
                        <KindBar summary={s} of={top} />
                      </div>
                      <KindList summary={s} payers={payers.get(s.pool)} />
                      <div className="pcard__meta">
                        <span>{plural(s.payouts, 'payment')}</span>
                        <span>{plural(s.players, 'player')}</span>
                      </div>
                    </>
                  )}
                  <div className="pcard__spark">
                    {hasBalance.has(s.pool) ? (
                      lines[s.pool]?.length ? (
                        <LineChart
                          spark
                          points={lines[s.pool]}
                          from={frame.since}
                          to={frame.live ? loadedAt || Date.now() : frame.until}
                          height={48}
                          color={COLOR[s.type]}
                          label={`${s.pool} balance, ${frame.phrase}`}
                          {...(reserves[s.pool]?.length
                            ? { extra: { points: reserves[s.pool], color: RESERVE_COLOR, name: 'Reserve' } }
                            : {})}
                        />
                      ) : (
                        <span className="pcard__sparkwait">Loading balance…</span>
                      )
                    ) : (
                      <span className="pcard__sparkwait">No balance row for this pool</span>
                    )}
                  </div>
                  {s.balance !== undefined && (
                    <div className="pcard__balance">
                      Holds now <strong>{amount(s.balance, s.type)}</strong> {SYMBOL[s.type]}
                      {/* Every TLM pool holds two piles: what is released and
                          can be paid out, and what is still held back. The
                          solid line is the first; the dashed one and this
                          figure are the second. */}
                      {s.reserve !== undefined ? (
                        <span className="pcard__reserve">
                          {' '}
                          · <strong>{amount(s.reserve, s.type)}</strong> in reserve
                        </span>
                      ) : null}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </section>
        )
      })}

      <p className="pstats__foot">
        Payments are the <span className="mono">rwrdlog.ale::addhistory</span> records every paying contract sends.
        Landowner cuts are credited to the pool their <span className="mono">claimbreward</span> drew on. Quest rewards
        and the Candle's TLM count when players are paid, not when they move into escrow. Window: {new Date(frame.since).toUTCString().slice(5, 22)} to{' '}
        {new Date(frame.live ? loadedAt : frame.until).toUTCString().slice(5, 22)} UTC.
      </p>
    </>
  )
}

/* ---------- one pool ---------- */

function PoolDetail({
  frame,
  payouts,
  tags,
  pool,
  summary,
  type,
  balance,
  reserve,
}: {
  frame: Frame
  payouts: Payout[]
  tags: Record<string, string>
  pool: string
  summary?: PoolSummary
  type: string
  balance?: number
  /** Present only for a parent pool: what it is holding back. */
  reserve?: number
}) {
  const players = useMemo(() => playersOf(payouts, pool), [payouts, pool])
  const mine = useMemo(() => payouts.filter((p) => poolOf(p) === pool).reverse(), [payouts, pool])
  const payers = useMemo(() => payersByPool(payouts).get(pool), [payouts, pool])
  /* An hour to a bar for a day; a day to a bar for anything longer. */
  const bucket = frame.live ? HOUR : DAY
  const bars = useMemo(
    () => bucketOut(payouts, pool, frame.since, frame.until, bucket),
    [payouts, pool, frame, bucket],
  )

  const from = frame.since
  const [line, setLine] = useState<BalancePoint[] | null>(null)
  const [lineError, setLineError] = useState(false)

  /*
     The balance line. For a day or a week, every recorded change; past that,
     each day's closing balance — a month of changes is tens of thousands of
     rows for a busy pool.
  */
  const detailed = frame.live || frame.key === '7'
  useEffect(() => {
    if (balance === undefined) return
    if (!detailed) {
      setLine(closesOf(frame.days, pool))
      return
    }
    let live = true
    setLine(null)
    setLineError(false)
    fetchPoolHistory(poolTable(type), pool, from)
      .then((pts) => {
        if (!live) return
        const inside = frame.live ? withNow(pts, balance) : pts.filter((p) => p.t <= frame.until)
        setLine(inside)
      })
      .catch(() => live && setLineError(true))
    return () => {
      live = false
    }
  }, [pool, type, from, balance, detailed, frame])

  /*
     The reserve, for a parent pool: the same row's other half, read the same
     way — every change for a day or a week, the recorded daily closes past
     that. Allowed to be missing on its own; the balance line stands without it.
  */
  const [reserveLine, setReserveLine] = useState<BalancePoint[] | null>(null)
  useEffect(() => {
    if (reserve === undefined) return setReserveLine(null)
    if (!detailed) {
      setReserveLine(reserveClosesOf(frame.days, pool))
      return
    }
    let live = true
    setReserveLine(null)
    fetchPoolHistory('tlmpools', pool, from, false, 'reserve')
      .then((pts) => {
        if (!live) return
        setReserveLine(frame.live ? withNow(pts, reserve) : pts.filter((p) => p.t <= frame.until))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [pool, from, reserve, detailed, frame])

  const sym = SYMBOL[type] ?? type
  const [showAll, setShowAll] = useState(false)
  const escrowOnly = summary ? summary.intoEscrow > 0 : false

  return (
    <>
      <section className="pstats__totals">
        <Total icon={ICON[type]} label={`${sym} paid out · ${frame.label}`} value={amount(summary?.out ?? 0, type)} />
        {summary?.intoEscrow ? (
          <Total label={`Moved into escrow (${sym})`} value={amount(summary.intoEscrow, type)} />
        ) : null}
        <Total label="Payments to players" value={formatNumber(summary?.payouts ?? 0)} />
        <Total label="Players paid" value={formatNumber(players.length)} />
        <Total label="Biggest payment" value={amount(summary?.biggest ?? 0, type)} />
        {balance !== undefined && <Total label={`Holds now (${sym})`} value={amount(balance, type)} />}
        {reserve !== undefined && <Total label={`In reserve now (${sym})`} value={amount(reserve, type)} />}
      </section>

      {summary && summary.out > 0 && (
        <section className="pstats__panel">
          <div className="pstats__panelhead">
            <h2 className="section__title">Where it went</h2>
          </div>
          <KindBar summary={summary} of={summary.out} />
          <KindList summary={summary} payers={payers} />
          {escrowOnly && (
            <p className="pstats__note">
              Only what reached players counts as paid out. Some TLM waits in a game contract first: quest rewards
              at <span className="mono">quests.ale</span> from when quests are handed out, landowners' cuts on their
              buildings at <span className="mono">lands.ale</span>, Candle winnings at{' '}
              <span className="mono">recovery.ale</span>, and Arena leaderboard rewards on the player's account
              until they claim them. That TLM is counted when the player receives it, not when it moves. The escrow
              figure is shown for reference.
            </p>
          )}
        </section>
      )}

      {balance !== undefined ? (
        <section className="pstats__panel">
          <div className="pstats__panelhead">
            <h2 className="section__title">What the pool held · {frame.label}</h2>
          </div>
          {line ? (
            <LineChart
              points={line}
              from={from}
              to={frame.live ? Date.now() : frame.until}
              height={260}
              color={COLOR[type]}
              unit={sym}
              format={(v) => amount(v, type)}
              label={`${pool} balance`}
              {...(reserveLine?.length
                ? { name: 'Holds', extra: { points: reserveLine, color: RESERVE_COLOR, name: 'Reserve' } }
                : {})}
            />
          ) : (
            <div className="pstats__chartwait">
              {lineError ? (
                'The balance history could not be read.'
              ) : (
                <>
                  <span className="spinner" /> Reading {frame.live ? 'a day' : 'a week'} of balance changes…
                </>
              )}
            </div>
          )}
          <p className="pstats__note">
            {detailed
              ? 'Every recorded change to the pool row, joined up. Rises are the fill rate topping it up; drops are money leaving it.'
              : 'The balance at the end of each UTC day.'}
            {reserve !== undefined
              ? ' The dashed line is the reserve: TLM this pool has been given but not yet released into what it holds.'
              : ''}
          </p>
        </section>
      ) : (
        <p className="pstats__note">This pool has no balance row, so there is no line to draw.</p>
      )}

      <section className="pstats__panel">
        <div className="pstats__panelhead">
          <h2 className="section__title">Paid out per {frame.live ? 'hour' : 'day'} · {frame.label}</h2>
        </div>
        <BarStrip values={bars} color={COLOR[type]} label={`${pool} outflow per ${frame.live ? 'hour' : 'day'}`} />
        <div className="pstats__axis">
          <span>
            {frame.live
              ? new Date(frame.since).toISOString().slice(11, 16) + ' UTC'
              : shortDate(frame.days[0].date)}
          </span>
          <span>{frame.live ? 'now' : shortDate(frame.days[frame.days.length - 1].date)}</span>
        </div>
      </section>

      <section className="pstats__panel">
        <div className="pstats__panelhead">
          <h2 className="section__title">Who received it</h2>
          <span className="faint">{plural(players.length, 'player')}</span>
        </div>
        {players.length === 0 ? (
          <p className="muted">Nobody received anything from this pool {frame.phrase}.</p>
        ) : (
          <div className="ptable" role="table" aria-label="Players paid from this pool">
            <div className="ptable__row ptable__row--head" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Player</span>
              <span role="columnheader" className="ptable__num">{sym}</span>
              <span role="columnheader">Share</span>
              <span role="columnheader" className="ptable__num">Payments</span>
              <span role="columnheader" className="ptable__num">Last</span>
            </div>
            {(showAll ? players : players.slice(0, 50)).map((p, i) => (
              <div className="ptable__row" role="row" key={p.player}>
                <span role="cell" className="ptable__rank">{i + 1}</span>
                <span role="cell" className="ptable__who">
                  <strong>
                    {tags[p.player] ?? p.player}
                    {p.kinds
                      .filter((k) => k !== 'mine')
                      .map((k) => (
                        <span key={k} className={`kindtag kindtag--${k}`}>
                          {k === 'landowner' ? 'Landowner' : k === 'claim' ? (payers?.[0] ?? 'Claim') : k}
                        </span>
                      ))}
                  </strong>
                  {tags[p.player] && tags[p.player] !== p.player && <span className="mono">{p.player}</span>}
                </span>
                <span role="cell" className="ptable__num mono">{amount(p.total, type)}</span>
                <span role="cell" className="ptable__share">
                  <span className="ptable__sharebar">
                    {/* Against the top earner, so the ranking reads at a glance. */}
                    <span style={{ width: `${(p.total / (players[0]?.total || 1)) * 100}%`, background: COLOR[type] }} />
                  </span>
                  {(p.share * 100).toFixed(p.share >= 0.1 ? 0 : 1)}%
                </span>
                <span role="cell" className="ptable__num">{formatNumber(p.payouts)}</span>
                <span role="cell" className="ptable__num faint">{ago(p.last)}</span>
              </div>
            ))}
            {players.length > 50 && (
              <button type="button" className="btn btn--block" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${formatNumber(players.length)}`}
              </button>
            )}
          </div>
        )}
      </section>

      {/* Single payments exist only in the live window; collected days are folded. */}
      {frame.live && (
        <section className="pstats__panel">
          <div className="pstats__panelhead">
            <h2 className="section__title">Latest</h2>
          </div>
          <ul className="plog">
            {mine.slice(0, 25).map((p) => (
              <li key={p.seq}>
                <span className="faint">{new Date(p.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                <span>
                  {tags[p.player] ?? p.player}
                  <span className={`kindtag kindtag--${p.kind}`}>
                    {p.kind === 'claim' ? p.payer : KIND_LABEL[p.kind ?? 'mine'].replace(/s$/, '').replace('Player mine', 'Mine')}
                  </span>
                </span>
                <span className={`mono${leftPool(p) ? '' : ' faint'}`}>
                  {amount(p.amount, type)} {sym}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/* ---------- everyone paid ---------- */

type SortKey = 'player' | 'tlm' | 'shards' | 'payments' | 'landowner' | 'pools' | 'last'

const COLUMNS: { key: SortKey; label: string; num: boolean; title?: string }[] = [
  { key: 'player', label: 'Player', num: false },
  { key: 'tlm', label: 'TLM', num: true },
  { key: 'shards', label: 'Shards', num: true },
  { key: 'landowner', label: 'As landowner (TLM)', num: true, title: 'TLM received as landowner cuts' },
  { key: 'payments', label: 'Payments', num: true },
  { key: 'pools', label: 'Pools', num: true, title: 'How many different pools paid them' },
  { key: 'last', label: 'Last paid', num: true },
]

/**
 * Everyone who received TLM or Shards, in one sortable table.
 *
 * Click a heading to sort by it; click again to reverse. Numbers sort biggest
 * first, names A to Z. The search narrows by in-game name or wallet.
 */
function PlayersPaid({ payouts, tags }: { payouts: Payout[]; tags: Record<string, string> }) {
  const rows = useMemo(() => recipientsOf(payouts), [payouts])
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'tlm', desc: true })
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    const name = (r: Recipient) => tags[r.player] ?? r.player
    const value = (r: Recipient, key: SortKey): number | string =>
      key === 'player' ? name(r).toLowerCase() : key === 'landowner' ? r.landownerTlm : r[key]
    const q = query.trim().toLowerCase()
    const list = q
      ? rows.filter((r) => r.player.includes(q) || (tags[r.player] ?? '').toLowerCase().includes(q))
      : rows
    return [...list].sort((a, b) => {
      const x = value(a, sort.key)
      const y = value(b, sort.key)
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)
      return (sort.desc ? -c : c) || a.player.localeCompare(b.player)
    })
  }, [rows, sort, query, tags])

  const totals = rows.reduce(
    (t, r) => ({ tlm: t.tlm + r.tlm, shards: t.shards + r.shards, payments: t.payments + r.payments }),
    { tlm: 0, shards: 0, payments: 0 },
  )

  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'player' }))

  return (
    <>
      <section className="pstats__totals">
        <Total label="Players paid" value={formatNumber(rows.length)} />
        <Total icon={ICON.tlm} label="TLM received" value={amount(totals.tlm, 'tlm')} />
        <Total icon={ICON.shards} label="Shards received" value={amount(totals.shards, 'shards')} />
        <Total label="Payments" value={formatNumber(totals.payments)} />
      </section>

      <div className="pstats__toolbar">
        <input
          className="input"
          type="search"
          placeholder="Search by name or wallet"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search players"
        />
        <span className="faint">
          {shown.length === rows.length
            ? `${formatNumber(rows.length)} players`
            : `${formatNumber(shown.length)} of ${formatNumber(rows.length)} players`}
        </span>
      </div>

      <div className="card table-wrap">
        <table className="table table--sortable">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.num ? 'r' : undefined}
                  aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                  title={c.title}
                >
                  <button type="button" onClick={() => sortBy(c.key)}>
                    {c.label}
                    <span className="sortmark" aria-hidden="true">
                      {sort.key === c.key ? (sort.desc ? '▼' : '▲') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.player}>
                <td>
                  <span className="pwho">
                    <strong>{tags[r.player] ?? r.player}</strong>
                    {tags[r.player] && tags[r.player] !== r.player && <span className="faint mono">{r.player}</span>}
                    {!tags[r.player] && <span className="faint">Not signed up</span>}
                  </span>
                </td>
                <td className="r">{amount(r.tlm, 'tlm')}</td>
                <td className="r">{amount(r.shards, 'shards')}</td>
                <td className="r">{r.landownerTlm ? amount(r.landownerTlm, 'tlm') : '—'}</td>
                <td className="r">{formatNumber(r.payments)}</td>
                <td className="r">{formatNumber(r.pools)}</td>
                <td className="r faint">{ago(r.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
