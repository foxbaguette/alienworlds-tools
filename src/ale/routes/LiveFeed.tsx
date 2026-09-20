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
 */
const WINDOW_MS = 60 * 60 * 1000
const POLL_MS = 4_000
/** How far back a follow-up poll looks, to catch late-indexed actions. */
const OVERLAP_MS = 60_000

export function LiveFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [info, setInfo] = useState<Record<string, PlayerInfo>>({})
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [lastAt, setLastAt] = useState<number | null>(null)
  /** Bumped when a planet's land grid arrives, so travels can be re-described. */
  const [, redraw] = useState(0)

  /** Everything held, newest first, keyed so a repeat is free to ignore. */
  const held = useRef(new Map<string, FeedEvent>())
  const fresh = useRef(new Set<string>())
  const newest = useRef(0)

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
        fresh.current = new Set()
        for (const r of rows) {
          if (!held.current.has(r.key) && !first) fresh.current.add(r.key)
          held.current.set(r.key, r)
          newest.current = Math.max(newest.current, r.at)
        }

        /* Anything older than the window leaves, rather than lingering because
           nothing replaced it. */
        const cutoff = Date.now() - WINDOW_MS
        for (const [k, e] of held.current) if (e.at < cutoff) held.current.delete(k)

        setEvents([...held.current.values()].sort((x, y) => y.at - x.at))
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
        <h2 className="dao-h2">
          Live activity <span className="dao-dim">{events.length} in the last hour</span>
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
