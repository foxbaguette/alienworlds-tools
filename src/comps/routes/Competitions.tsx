import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  AUDITING,
  COMP_LABEL,
  COMP_TONE,
  auditAction,
  compImage,
  compTime,
  compUrl,
  fetchComps,
  fetchPlayers,
  fetchSponsors,
  isAuditor,
  isLive,
  isOpen,
  needsAudit,
  pct,
  preparingIsNear,
  type CompPlayer,
  type CompRow,
  type CompSponsor,
} from '../chain/comps'
import { start } from '../../dao/chain/nodes'
import { isCancel, readableError } from '../../dao/chain/act'
import { EXPLORER, fmtAge, fmtAmount, isoMinute } from '../../dao/format'
import { useSession } from '../../wallet/session'

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

/** Whether this wallet holds one of the auditor keys. One read, per account. */
function useAuditor() {
  const { actor } = useSession()
  const [auditor, setAuditor] = useState(false)
  useEffect(() => {
    if (!actor) return setAuditor(false)
    let alive = true
    void isAuditor(actor).then((ok) => alive && setAuditor(ok))
    return () => {
      alive = false
    }
  }, [actor])
  return auditor
}

/* ---------- the list ---------- */

type Filter = 'now' | 'all'

/**
 * Every competition, grouped by what is happening to it.
 *
 * The source admin page is one flat list newest-first, which buries the two
 * actually running under forty that finished months ago. The same rows are
 * grouped here by state — and **auditing comes first**, because it is the only
 * state waiting on a person rather than on a clock.
 *
 * `preparing` is filtered rather than listed whole: these are created weeks
 * ahead, and a page showing all of them shows mostly things that will not
 * happen for a month. See `preparingIsNear`.
 */
export default function Competitions() {
  const { comps, error, loading, refresh } = useComps()
  const [filter, setFilter] = useState<Filter>('now')
  const auditor = useAuditor()

  const near = comps.filter((c) => (c.state === 'preparing' ? preparingIsNear(c) : true))
  const shown = filter === 'now' ? near.filter(isOpen) : comps
  const awaiting = comps.filter(needsAudit).length

  const by = (state: string) => shown.filter((c) => c.state === state)
  const groups = [
    { label: 'Waiting on an audit', rows: by(AUDITING), lead: 'Approve or reject these before they can pay out.' },
    { label: 'Running now', rows: by('1.playing') },
    { label: 'Working out the results', rows: by('2.processing') },
    { label: 'Paying out', rows: by('4.rewarding') },
    { label: 'Starting soon', rows: by('preparing') },
    {
      label: 'Finished',
      rows: shown.filter((c) => ['5.complete', 'rejected', 'expired', 'deleting'].includes(String(c.state))),
    },
  ].filter((g) => g.rows.length)

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
            <button type="button" role="tab" aria-selected={filter === 'now'} onClick={() => setFilter('now')}>
              Happening {near.filter(isOpen).length || ''}
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

      {awaiting && !auditor ? (
        <p className="dao-note">
          {awaiting} competition{awaiting === 1 ? ' is' : 's are'} waiting on an audit. Approving or rejecting one
          is signed as <code>comp.worlds@auditor</code>, which this wallet does not hold a key for.
        </p>
      ) : null}

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      {groups.map((g) => (
        <section key={g.label} className={`section${g.rows.some(needsAudit) ? ' section--audit' : ''}`}>
          <h2 className="dao-h2">
            {g.label} <span className="dao-dim">{g.rows.length}</span>
          </h2>
          {g.lead ? <p className="dao-dim">{g.lead}</p> : null}
          <div className="dao-grid">
            {g.rows.map((c) => (
              <CompCard key={c.id} comp={c} />
            ))}
          </div>
        </section>
      ))}

      {!groups.length ? (
        <p className="dao-note">
          {loading ? 'Reading competitions…' : filter === 'now' ? 'Nothing happening right now.' : 'None found.'}
        </p>
      ) : null}
    </div>
  )
}

function CompCard({ comp: c }: { comp: CompRow }) {
  const startAt = compTime(c.start_time)
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
      ? startAt > now
        ? `starts in ${fmtAge(startAt - now)}`
        : 'due to start'
      : `ended ${fmtAge(now - end)} ago`

  const full = c.max_players ? Math.min(100, (c.num_players / c.max_players) * 100) : 0

  return (
    <article className={`dao-card comp-card${needsAudit(c) ? ' is-audit' : ''}`}>
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
        <Link className={`btn${needsAudit(c) ? ' btn--go' : ''}`} to={`/comps/${c.id}`}>
          {needsAudit(c) ? 'Audit' : 'Standings'}
        </Link>
      </div>
    </article>
  )
}

/* ---------- one competition ---------- */

export function CompetitionDetails() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { comps, loading, refresh } = useComps()
  const comp = comps.find((c) => String(c.id) === id)
  const auditor = useAuditor()

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

      {needsAudit(comp) ? <AuditPanel comp={comp} auditor={auditor} onDone={() => void refresh()} /> : null}

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

/**
 * The decision.
 *
 * Sits above everything else on the page, because it is the reason for being
 * here — but the standings are still below it, unread, which is deliberate:
 * approving releases a prize pool and the evidence should be in front of you.
 *
 * Rejecting takes a reason. The contract stores it on the competition for
 * everyone to read afterwards, so it is required rather than optional here.
 */
function AuditPanel({ comp, auditor, onDone }: { comp: CompRow; auditor: boolean; onDone: () => void }) {
  const { session } = useSession()
  const [notice, setNotice] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const sign = async (verdict: 'approve' | 'reject') => {
    if (!session || busy) return
    if (verdict === 'reject' && !notice.trim()) {
      return setNote({ text: 'A rejection needs a reason — it is stored on the competition.', bad: true })
    }
    setBusy(true)
    setNote({ text: `${verdict === 'approve' ? 'Approving' : 'Rejecting'} #${comp.id} — check your wallet…` })
    try {
      await session.transact({ actions: [auditAction(comp.id, verdict, notice.trim())] }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      onDone()
      setNote({ text: `#${comp.id} ${verdict === 'approve' ? 'approved' : 'rejected'}.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('Audit failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="audit">
      <div className="audit__head">
        <h2 className="dao-h2">This competition is waiting on an audit</h2>
        <p className="dao-dim">
          Approving releases {fmtAmount(comp.winnings_budget)} TLM to the {comp.num_players} players below by the
          shares its admin declared. Rejecting sends it back with your reason attached.
        </p>
      </div>

      {!session ? (
        <p className="dao-dim">Connect a wallet to audit.</p>
      ) : !auditor ? (
        <p className="dao-dim">
          Auditing is signed as <code>comp.worlds@auditor</code>, and this wallet holds none of that permission&rsquo;s
          keys. The buttons are left off rather than offering a transaction the chain would refuse.
        </p>
      ) : (
        <>
          <div className="audit__acts">
            <button className="btn btn--go" type="button" disabled={busy} onClick={() => void sign('approve')}>
              Approve and pay out
            </button>
            <button className="btn btn--warn" type="button" disabled={busy} onClick={() => setRejecting((v) => !v)}>
              {rejecting ? 'Cancel rejection' : 'Reject…'}
            </button>
          </div>

          {rejecting ? (
            <div className="audit__reject">
              <label className="cp-field">
                <span>Why it is being rejected</span>
                <input
                  type="text"
                  value={notice}
                  maxLength={256}
                  placeholder="Stored on the competition for everyone to read"
                  onChange={(e) => setNotice(e.target.value)}
                />
              </label>
              <button className="btn btn--warn" type="button" disabled={busy} onClick={() => void sign('reject')}>
                Reject #{comp.id}
              </button>
            </div>
          ) : null}
        </>
      )}

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
    </section>
  )
}
