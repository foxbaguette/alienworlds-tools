import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  COMP_LABEL,
  COMP_TONE,
  compImage,
  compTime,
  compUrl,
  fetchComps,
  fetchPlayers,
  fetchSponsors,
  isLive,
  isOpen,
  pct,
  type CompPlayer,
  type CompRow,
  type CompSponsor,
} from '../chain/comps'
import { start } from '../../dao/chain/nodes'
import { EXPLORER, fmtAge, fmtAmount, isoMinute } from '../../dao/format'

/* One read of the competitions, shared by the list and the details. */
let cache: CompRow[] = []
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()
let failure: string | null = null

function load(force = false): Promise<void> {
  if (inFlight) return inFlight
  if (!force && cache.length) return Promise.resolve()
  inFlight = (async () => {
    if (!(await start())) throw new Error('No WAX node answered.')
    cache = await fetchComps()
    failure = null
  })()
    .catch((err: unknown) => {
      console.error('Could not read the competitions:', err)
      failure = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      inFlight = null
      for (const fn of listeners) fn()
    })
  return inFlight
}

function useComps() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    void load()
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return { comps: cache, error: failure, loading: !!inFlight, refresh: () => load(true) }
}

/* ---------- the list ---------- */

type Filter = 'open' | 'all'

/**
 * Every competition, grouped by what is happening to it.
 *
 * The source admin page is one flat list newest-first, which buries the two
 * that are actually running under forty that finished months ago. The same rows
 * are grouped here by state instead — running, about to run, waiting on the
 * admin, done — because that is the question anyone opening this page has.
 */
export default function Competitions() {
  const { comps, error, loading, refresh } = useComps()
  const [filter, setFilter] = useState<Filter>('open')

  const shown = filter === 'open' ? comps.filter(isOpen) : comps

  const groups = useMemo(() => {
    const by = (state: string) => shown.filter((c) => c.state === state)
    return [
      { label: 'Running now', rows: by('1.playing') },
      { label: 'Starting soon', rows: by('preparing') },
      { label: 'Waiting on the admin', rows: [...by('2.processing'), ...by('4.rewarding')] },
      { label: 'Finished', rows: by('5.complete') },
    ].filter((g) => g.rows.length)
  }, [shown])

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Competitions</h1>
          <p className="page__lead">
            Games running prize competitions on <code>comp.worlds</code>. Players register against one, scores
            accrue while it runs, and the pool is split by the shares its admin declares at the end.
          </p>
        </div>
        <div className="page__actions">
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={filter === 'open'} onClick={() => setFilter('open')}>
              Open {comps.filter(isOpen).length || ''}
            </button>
            <button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>
              All {comps.length || ''}
            </button>
          </div>
          <button className="btn" type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      {groups.map((g) => (
        <section key={g.label} className="section">
          <h2 className="dao-h2">
            {g.label} <span className="dao-dim">{g.rows.length}</span>
          </h2>
          <div className="dao-grid">
            {g.rows.map((c) => (
              <CompCard key={c.id} comp={c} />
            ))}
          </div>
        </section>
      ))}

      {!comps.length ? <p className="dao-note">{loading ? 'Reading competitions…' : 'None found.'}</p> : null}
    </div>
  )
}

function CompCard({ comp: c }: { comp: CompRow }) {
  const start = compTime(c.start_time)
  const end = compTime(c.end_time)
  const now = Date.now()
  const img = compImage(c)

  /* Which clock matters depends on the stage, the same way it does for a worker
     proposal: one is counting down to a start, the next to an end. */
  const when = isLive(c)
    ? end > now
      ? `ends in ${fmtAge(end - now)}`
      : 'past its end time'
    : c.state === 'preparing'
      ? start > now
        ? `starts in ${fmtAge(start - now)}`
        : 'due to start'
      : `ended ${fmtAge(now - end)} ago`

  const full = c.max_players ? Math.min(100, (c.num_players / c.max_players) * 100) : 0

  return (
    <article className="dao-card comp-card">
      {img ? <img className="comp-card__img" src={img} alt="" loading="lazy" /> : null}

      <div className="dao-card__top">
        <h2>
          <Link to={`/comps/${c.id}`}>{c.title}</Link>
        </h2>
        <span className={`wp-chip is-${COMP_TONE[c.state] ?? 'wait'}`}>{COMP_LABEL[c.state] ?? c.state}</span>
      </div>

      <p className="dao-card__meta">
        <span className="dao-card__id">#{c.id}</span>
        <a className="chip" href={`${EXPLORER}${encodeURIComponent(c.admin)}`} target="_blank" rel="noopener">
          {c.admin}
        </a>
      </p>

      <dl className="alloc-figs comp-figs">
        <div>
          <dt>Prize pool</dt>
          <dd>{fmtAmount(c.winnings_budget)}</dd>
        </div>
        <div>
          <dt>Players</dt>
          <dd>{c.num_players.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>{isLive(c) ? 'Ends' : c.state === 'preparing' ? 'Starts' : 'Ended'}</dt>
          <dd className="comp-when">{when}</dd>
        </div>
      </dl>

      {c.max_players ? (
        <div className="bar" title={`${c.num_players} of at most ${c.max_players} players`}>
          <span style={{ width: `${full}%` }} />
        </div>
      ) : null}

      <div className="dao-card__foot">
        <Link className="btn" to={`/comps/${c.id}`}>
          Standings
        </Link>
      </div>
    </article>
  )
}

/* ---------- one competition ---------- */

export function CompetitionDetails() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { comps, loading } = useComps()
  const comp = comps.find((c) => String(c.id) === id)

  const [players, setPlayers] = useState<CompPlayer[] | null>(null)
  const [sponsors, setSponsors] = useState<CompSponsor[]>([])

  useEffect(() => {
    if (!comp) return
    let alive = true
    setPlayers(null)
    void fetchPlayers(comp.id)
      .then((rows) => alive && setPlayers(rows))
      .catch((err) => {
        console.error('players:', err)
        if (alive) setPlayers([])
      })
    void fetchSponsors(comp.id)
      .then((rows) => alive && setSponsors(rows))
      .catch(() => alive && setSponsors([]))
    return () => {
      alive = false
    }
  }, [comp?.id])

  if (!comp) {
    return (
      <div className="page">
        <p className="dao-note">{loading ? 'Reading competitions…' : `No competition #${id}.`}</p>
        <Link className="btn" to="/comps">
          All competitions
        </Link>
      </div>
    )
  }

  const url = compUrl(comp)
  const pool = comp.winnings_budget

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <button className="dao-back" type="button" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <h1 className="page__title">{comp.title}</h1>
          <p className="page__lead">
            #{comp.id} · run by <code>{comp.admin}</code> ·{' '}
            <span className={`wp-chip is-${COMP_TONE[comp.state] ?? 'wait'}`}>
              {COMP_LABEL[comp.state] ?? comp.state}
            </span>
          </p>
        </div>
        {url ? (
          <a className="btn" href={url} target="_blank" rel="noopener">
            Open the game
          </a>
        ) : null}
      </header>

      {comp.notice ? <p className="dao-note">{comp.notice}</p> : null}
      {comp.description ? <p className="page__lead">{comp.description}</p> : null}

      <section className="section">
        <dl className="alloc-figs comp-figs--wide">
          <div>
            <dt>Prize pool</dt>
            <dd>{fmtAmount(pool)}</dd>
            <span className="dao-dim">{fmtAmount(comp.winnings_claimed)} claimed</span>
          </div>
          <div>
            <dt>Shards</dt>
            <dd>{comp.shards_budget.toLocaleString('en-US')}</dd>
            <span className="dao-dim">{comp.shards_claimed.toLocaleString('en-US')} claimed</span>
          </div>
          <div>
            <dt>Players</dt>
            <dd>{comp.num_players.toLocaleString('en-US')}</dd>
            <span className="dao-dim">
              {comp.min_players} needed, {comp.max_players.toLocaleString('en-US')} allowed
            </span>
          </div>
          <div>
            <dt>Runs</dt>
            <dd className="comp-when">{isoMinute(compTime(comp.start_time))}</dd>
            <span className="dao-dim">to {isoMinute(compTime(comp.end_time))} UTC</span>
          </div>
        </dl>

        {comp.admin_pay_perc_x_100 || comp.winnings_allocated_perc_x_100 ? (
          <p className="dao-note">
            {comp.winnings_allocated_perc_x_100
              ? `${pct(comp.winnings_allocated_perc_x_100)}% of the pool is allocated to players. `
              : ''}
            {comp.admin_pay_perc_x_100 ? `${pct(comp.admin_pay_perc_x_100)}% goes to the admin.` : ''}
          </p>
        ) : null}
      </section>

      {sponsors.length ? (
        <section className="section">
          <h2 className="dao-h2">
            Sponsors <span className="dao-dim">{sponsors.length}</span>
          </h2>
          <div className="dao-tablewrap">
            <table className="dao-table">
              <thead>
                <tr>
                  <th>Sponsor</th>
                  <th className="num">Put up</th>
                </tr>
              </thead>
              <tbody>
                {sponsors.map((s) => (
                  <tr key={s.sponsor}>
                    <td>{s.sponsor}</td>
                    <td className="num">{fmtAmount(s.reward)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="section">
        <h2 className="dao-h2">
          Standings <span className="dao-dim">{players ? `${players.length} registered` : 'reading…'}</span>
        </h2>
        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Player</th>
                <th className="num">Score</th>
                <th className="num">Share</th>
                <th className="num">Wins</th>
                <th>Claimed</th>
              </tr>
            </thead>
            <tbody>
              {(players ?? []).map((p, i) => {
                const share = pct(p.reward_perc_x_100)
                /* What their share of the pool actually comes to, which is the
                   number a player is looking for and the one the source page
                   never worked out. */
                const won = (Number(String(pool).split(' ')[0]) || 0) * (share / 100)
                return (
                  <tr key={p.player}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <a href={`${EXPLORER}${encodeURIComponent(p.player)}`} target="_blank" rel="noopener">
                        {p.player}
                      </a>
                    </td>
                    <td className="num">{Number(p.live_score).toLocaleString('en-US')}</td>
                    <td className="num">{share ? `${share}%` : '—'}</td>
                    <td className="num">{share ? Math.trunc(won).toLocaleString('en-US') : '—'}</td>
                    <td>
                      {p.claimed ? <span className="wp-chip is-done">claimed</span> : <span className="dao-dim">—</span>}
                    </td>
                  </tr>
                )
              })}
              {players && !players.length ? (
                <tr>
                  <td colSpan={6} className="dao-dim">
                    Nobody has registered yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
