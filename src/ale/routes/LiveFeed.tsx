import { useEffect, useRef, useState } from 'react'
import { describe, fetchFeed, toneOf, type FeedEvent } from '../chain/feed'
import { fetchPlayerTags } from '../../players'
import { EXPLORER } from '../../dao/format'

/**
 * Everything happening in Alien Legends, as it happens.
 *
 * One hour of history, polled every fifteen seconds, with anything new sliding
 * in at the top. Events are keyed by transaction and ordinal, so a poll that
 * overlaps the last one adds nothing twice — and the ones already on screen
 * keep their identity, which is what lets only the new rows animate.
 *
 * Bookkeeping actions are filtered out in the chain layer rather than here; see
 * feed.ts for why that is an allowlist.
 */
const WINDOW_MS = 60 * 60 * 1000
const POLL_MS = 15_000

export function LiveFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [tags, setTags] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [lastAt, setLastAt] = useState<number | null>(null)
  /** Keys already on screen, so a poll only animates what it actually added. */
  const seen = useRef(new Set<string>())
  const fresh = useRef(new Set<string>())

  useEffect(() => {
    void fetchPlayerTags()
      .then(setTags)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!live) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const rows = await fetchFeed(Date.now() - WINDOW_MS)
        if (!alive) return
        setError(null)
        setLastAt(Date.now())

        fresh.current = new Set(rows.filter((r) => !seen.current.has(r.key)).map((r) => r.key))
        /* First load is not "new" — the whole hour would animate at once. */
        if (!seen.current.size) fresh.current = new Set()
        for (const r of rows) seen.current.add(r.key)

        /* Trimmed to the window here as well as in the query: a row that has
           aged out should leave, not linger because nothing replaced it. */
        const cutoff = Date.now() - WINDOW_MS
        setEvents(rows.filter((r) => r.at >= cutoff))
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

  const name = (wallet: string) => tags[wallet] || wallet

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
          {error
            ? error
            : lastAt
              ? `updated ${new Date(lastAt).toISOString().slice(11, 19)} UTC`
              : 'reading…'}
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
              {tags[e.player] ? <i>{e.player}</i> : null}
            </span>
            <span className="feed__what">{describe(e)}</span>
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
