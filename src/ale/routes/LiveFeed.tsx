import { useEffect, useRef, useState } from 'react'
import { describe, fetchFeed, toneOf, type FeedEvent } from '../chain/feed'
import { ensureLands, landsReady } from '../chain/lands'
import { fetchPlayerInfo, type PlayerInfo } from '../../players'
import { EXPLORER } from '../../dao/format'

/**
 * Everything happening in Alien Legends, as it happens.
 *
 * Polled every four seconds, and each poll is tiny: after the first sweep it
 * asks only for what is NEWER than the newest thing already on screen, less a
 * minute of overlap. That overlap matters — the indexers do not present every
 * action the instant it lands, and a strict "after the last one" cursor would
 * skip anything indexed late. Duplicates cost nothing, since events are keyed
 * by transaction and ordinal.
 *
 * Which is also what makes four seconds affordable. Re-reading the whole hour
 * at that rate would be fifteen full sweeps a minute against servers that
 * rate-limit; this is fifteen requests that usually return a handful of rows.
 *
 * What ARRIVES in a batch is not shown as one. A poll routinely returns half a
 * dozen actions at once — the chain produces them in blocks, and the indexer
 * hands over whatever landed since the last ask — and six rows appearing
 * together reads as a page redraw rather than as things happening. So a poll
 * fills a queue and the queue is drained one row at a time, oldest first, so
 * each lands on top in the order it happened.
 *
 * The drain paces itself to clear within one poll, so a busy minute speeds up
 * instead of falling further behind: a feed that is thirty seconds behind the
 * chain is not a live feed.
 */
const WINDOW_MS = 60 * 60 * 1000
const POLL_MS = 4_000
/** How far back a follow-up poll looks, to catch late-indexed actions. */
const OVERLAP_MS = 60_000
/** The gap between one row and the next, clamped either side of POLL_MS/queued. */
const MIN_GAP_MS = 130
const MAX_GAP_MS = 700

export function LiveFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [info, setInfo] = useState<Record<string, PlayerInfo>>({})
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [lastAt, setLastAt] = useState<number | null>(null)
  /** Bumped when a planet's land grid arrives, so travels can be re-described. */
  const [, redraw] = useState(0)

  /** Everything on screen, keyed so a repeat is free to ignore. */
  const held = useRef(new Map<string, FeedEvent>())
  /** Arrived, not shown yet. Oldest first, so each release lands on top. */
  const queue = useRef<FeedEvent[]>([])
  const [queued, setQueued] = useState(0)
  const fresh = useRef(new Set<string>())
  const newest = useRef(0)

  /** Drops anything that has fallen out of the hour, then publishes. */
  const publish = () => {
    const cutoff = Date.now() - WINDOW_MS
    for (const [k, e] of held.current) if (e.at < cutoff) held.current.delete(k)
    setEvents([...held.current.values()].sort((x, y) => y.at - x.at))
  }

  useEffect(() => {
    void fetchPlayerInfo()
      .then(setInfo)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!live) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        /* First pass takes the hour; after that, only what is new. */
        const since = newest.current ? newest.current - OVERLAP_MS : Date.now() - WINDOW_MS
        const rows = await fetchFeed(since, newest.current ? 100 : 250)
        if (!alive) return
        setError(null)
        setLastAt(Date.now())

        const first = !newest.current
        const waiting = new Set(queue.current.map((e) => e.key))
        for (const r of rows) {
          newest.current = Math.max(newest.current, r.at)
          if (held.current.has(r.key) || waiting.has(r.key)) continue
          /* The opening sweep is an hour of history, not news: it goes up
             whole. Draining 250 rows one at a time would take two minutes. */
          if (first) held.current.set(r.key, r)
          else queue.current.push(r)
        }

        if (first) publish()
        else {
          queue.current.sort((x, y) => x.at - y.at)
          setQueued(queue.current.length)
        }
      } catch (err) {
        if (!alive) return
        console.error('live feed:', err)
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

  /*
   * The queue, one row at a time.
   *
   * A timeout rather than an interval, because the gap is recomputed after
   * every release: the more is waiting, the faster it goes, so a burst clears
   * inside one poll rather than pushing the feed behind the chain.
   *
   * Deliberately not tied to `live`. Pausing stops asking for more; it should
   * not strand what has already arrived half shown.
   */
  useEffect(() => {
    if (!queued) return
    const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, POLL_MS / queued))
    const timer = setTimeout(() => {
      const next = queue.current.shift()
      if (!next) return setQueued(0)
      held.current.set(next.key, next)
      fresh.current.add(next.key)
      /* Long enough for the entry animation, short enough that a row does not
         carry "new" into its second minute on screen. */
      setTimeout(() => fresh.current.delete(next.key), 2_000)
      publish()
      setQueued(queue.current.length)
    }, gap)
    return () => clearTimeout(timer)
  }, [queued])

  /*
   * A travel gives a grid position and nothing else, so the planet comes from
   * the player's own row and the land from that planet's grid. Each planet is
   * fetched once, the first time somebody travels on it.
   */
  useEffect(() => {
    const wanted = new Set<string>()
    for (const e of events) {
      if (e.kind !== 'travel') continue
      const planet = e.planet ?? info[e.player]?.planet
      if (planet && !landsReady(planet)) wanted.add(planet)
    }
    for (const planet of wanted) void ensureLands(planet).then(() => redraw((n) => n + 1))
  }, [events, info])

  const name = (wallet: string) => info[wallet]?.tag || wallet

  return (
    <section className="section">
      <div className="page__actions">
        {/* The page above already says "Live activity"; saying it twice costs a
            line, which on a phone is a line of the feed. */}
        <h2 className="dao-h2">
          {events.length} in the last hour
          {queued ? <span className="dao-dim"> · {queued} arriving</span> : null}
        </h2>
        <span className={`live-dot${live ? ' is-on' : ''}`} aria-hidden="true" />
        <button className="btn" type="button" onClick={() => setLive((v) => !v)}>
          {live ? 'Pause' : 'Resume'}
        </button>
        <span className="dao-dim">
          {error ? error : lastAt ? `updated ${new Date(lastAt).toISOString().slice(11, 19)} UTC` : 'reading…'}
        </span>
      </div>

      <ul className="feed">
        {events.map((e) => (
          <li key={e.key} className={`feed__row is-${toneOf(e.kind)}${fresh.current.has(e.key) ? ' is-new' : ''}`}>
            <span className="feed__time">{new Date(e.at).toISOString().slice(11, 19)}</span>
            <span className="feed__who">
              <a href={`${EXPLORER}${encodeURIComponent(e.player)}`} target="_blank" rel="noopener">
                {name(e.player)}
              </a>
              {info[e.player]?.tag ? <i>{e.player}</i> : null}
            </span>
            <span className="feed__what">
              {describe({ ...e, planet: e.planet ?? info[e.player]?.planet })}
            </span>
          </li>
        ))}
        {!events.length ? (
          <li className="feed__row">
            <span className="dao-dim">{error ? 'The history indexers are not answering.' : 'Reading…'}</span>
          </li>
        ) : null}
      </ul>
    </section>
  )
}

/** The feed on a page of its own, which is how the menu reaches it. */
export function LiveFeedPage() {
  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Live activity</h1>
          <p className="page__lead">
            Everything players are doing in Alien Legends, read from the history indexers as it happens. One hour,
            newest first. A dungeon shows its score when it is cleared.
          </p>
        </div>
      </header>
      <LiveFeed />
    </div>
  )
}
