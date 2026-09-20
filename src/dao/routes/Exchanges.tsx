import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BIG_AMOUNT,
  KIND_LABEL,
  KIND_TONE,
  fetchExchanges,
  fmtAmount,
  isBig,
  isExchange,
  type Exchange,
} from '../chain/exchanges'
import { EXPLORER } from '../format'
import { useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'

/**
 * Governance tokens changing hands, as it happens.
 *
 * Built like the Alien Legends feed and for the same reasons — a poll fills a
 * queue and the queue drains one row at a time, so six transfers landing in one
 * block read as six things happening rather than as the page redrawing.
 *
 * The window is a day rather than an hour. Real exchanges run at a few an hour
 * against several hundred reward payouts, so an hour of them is usually an
 * empty page.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000
const POLL_MS = 8_000
const OVERLAP_MS = 60_000
const MIN_GAP_MS = 130
const MAX_GAP_MS = 700

export default function Exchanges() {
  const { daos } = useDaos()
  const [rows, setRows] = useState<Exchange[]>([])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [symbol, setSymbol] = useState('all')
  const [payouts, setPayouts] = useState(false)
  const [bigOnly, setBigOnly] = useState(false)

  const held = useRef(new Map<string, Exchange>())
  const queue = useRef<Exchange[]>([])
  const [queued, setQueued] = useState(0)
  const fresh = useRef(new Set<string>())
  const newest = useRef(0)

  const publish = () => {
    const cutoff = Date.now() - WINDOW_MS
    for (const [k, e] of held.current) if (e.at < cutoff) held.current.delete(k)
    setRows([...held.current.values()].sort((x, y) => y.at - x.at))
  }

  useEffect(() => {
    if (!live) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const since = newest.current ? newest.current - OVERLAP_MS : Date.now() - WINDOW_MS
        const got = await fetchExchanges(since, newest.current ? 100 : 500)
        if (!alive) return
        setError(null)
        setLastAt(Date.now())

        const first = !newest.current
        const waiting = new Set(queue.current.map((e) => e.key))
        for (const e of got) {
          newest.current = Math.max(newest.current, e.at)
          if (held.current.has(e.key) || waiting.has(e.key)) continue
          if (first) held.current.set(e.key, e)
          else queue.current.push(e)
        }

        if (first) publish()
        else {
          queue.current.sort((x, y) => x.at - y.at)
          setQueued(queue.current.length)
        }
      } catch (err) {
        if (!alive) return
        console.error('exchanges:', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) timer = setTimeout(tick, POLL_MS)
      }
    }

    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [live])

  /* One row at a time, pacing itself to clear inside one poll. */
  useEffect(() => {
    if (!queued) return
    const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, POLL_MS / queued))
    const timer = setTimeout(() => {
      const next = queue.current.shift()
      if (!next) return setQueued(0)
      held.current.set(next.key, next)
      fresh.current.add(next.key)
      setTimeout(() => fresh.current.delete(next.key), 2_000)
      publish()
      setQueued(queue.current.length)
    }, gap)
    return () => clearTimeout(timer)
  }, [queued])

  /* The tokens to filter by, from the directory rather than from what has
     traded — a token with no trades today should still be pickable, and the
     empty answer is the answer. */
  const symbols = useMemo(() => [...new Set(daos.map((d) => d.symbol).filter(Boolean))], [daos])

  const shown = rows.filter(
    (e) =>
      (payouts || isExchange(e)) &&
      (symbol === 'all' || e.symbol === symbol) &&
      (!bigOnly || isBig(e)),
  )

  const bigCount = shown.filter(isBig).length

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Token exchanges</h1>
          <p className="page__lead">
            Governance tokens changing hands on <code>token.worlds</code>, over the last day. Anything of{' '}
            {BIG_AMOUNT.toLocaleString('en-US')} tokens or more is marked.
          </p>
        </div>
        <div className="page__actions">
          <span className={`live-dot${live ? ' is-on' : ''}`} aria-hidden="true" />
          <button className="btn" type="button" onClick={() => setLive((v) => !v)}>
            {live ? 'Pause' : 'Resume'}
          </button>
          <RefreshButton />
        </div>
      </header>

      <section className="section">
        <div className="page__actions">
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={symbol === 'all'} onClick={() => setSymbol('all')}>
              Every token
            </button>
            {symbols.map((s) => (
              <button key={s} type="button" role="tab" aria-selected={symbol === s} onClick={() => setSymbol(s)}>
                {s}
              </button>
            ))}
          </div>
          <label className="pause-chip">
            <input type="checkbox" checked={bigOnly} onChange={() => setBigOnly(!bigOnly)} />
            <span>{BIG_AMOUNT.toLocaleString('en-US')}+ only</span>
          </label>
          {/* Reward payouts are most of the volume and none of the trading, so
              they are off unless somebody asks for them. */}
          <label className="pause-chip">
            <input type="checkbox" checked={payouts} onChange={() => setPayouts(!payouts)} />
            <span>Include reward payouts</span>
          </label>
        </div>

        <h2 className="dao-h2">
          {shown.length} exchange{shown.length === 1 ? '' : 's'}{' '}
          <span className="dao-dim">
            {bigCount ? `${bigCount} over ${BIG_AMOUNT.toLocaleString('en-US')} · ` : ''}
            {queued ? `${queued} arriving · ` : ''}
            {error ? error : lastAt ? `updated ${new Date(lastAt).toISOString().slice(11, 19)} UTC` : 'reading…'}
          </span>
        </h2>

        <ul className="feed">
          {shown.map((e) => (
            <li
              key={e.key}
              className={
                `feed__row is-${KIND_TONE[e.kind]}` +
                (fresh.current.has(e.key) ? ' is-new' : '') +
                (isBig(e) ? ' is-big' : '')
              }
            >
              <span className="feed__time">{new Date(e.at).toISOString().slice(11, 19)}</span>
              <span className="feed__who">
                <a href={`${EXPLORER}${encodeURIComponent(e.player)}`} target="_blank" rel="noopener">
                  {e.player}
                </a>
              </span>
              <span className="feed__what">
                <b className="xch-amount">
                  {fmtAmount(e.amount)} {e.symbol}
                </b>{' '}
                {KIND_LABEL[e.kind]}
                {e.kind === 'sent' || e.kind === 'swapped' ? (
                  <>
                    {' '}
                    to{' '}
                    <a href={`${EXPLORER}${encodeURIComponent(e.to)}`} target="_blank" rel="noopener">
                      {e.to}
                    </a>
                  </>
                ) : null}
                {e.memo ? <i className="xch-memo">{e.memo}</i> : null}
              </span>
            </li>
          ))}
          {!shown.length ? (
            <li className="feed__row">
              <span className="dao-dim">
                {error
                  ? 'The history indexers are not answering.'
                  : !rows.length
                    ? 'Reading…'
                    : 'Nothing matches those filters in the last day.'}
              </span>
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  )
}
