import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Countdown } from '../components/Countdown'
import { WATCHED, heldByWatched, isMcControlled, type Dao, type DaoGroup } from '../chain/daos'
import { castableSlate, groupVotes, voteAction, type Slate, type VoteRow } from '../chain/votes'
import { isCancel, readableError, type ChainAction } from '../chain/act'
import { EXPLORER, fmtAge, fmtAmount } from '../format'
import { useDaos } from '../useDaos'
import { useVotes } from '../useVotes'
import { RefreshButton } from '../components/RefreshButton'
import { useSession } from '../../wallet/session'

/**
 * Every DAO of one kind, and who sits on each council.
 *
 * Syndicates and unions are the same view over a different half of the
 * directory, so they are one component taking the group as a prop rather than
 * two that drift apart.
 */
export default function Councils({ group }: { group: DaoGroup }) {
  const { daos, loading, error } = useDaos()
  const shown = daos.filter((d) => d.group === group)
  const { votes, read, refresh: refreshVotes } = useVotes(daos)
  const { session } = useSession()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const label = group === 'syndicate' ? 'Syndicates' : 'Unions'
  const state = groupVotes(shown, votes, read)

  /**
   * Re-cast every vote this account holds in the group, in one transaction.
   *
   * The slates are trimmed of candidates who have stopped standing — they would
   * refuse the whole transaction, and they are not being voted for in any real
   * sense either, since the contract stopped counting them the moment they went
   * inactive. Anything left with nothing to re-cast is EXCLUDED rather than
   * swept along: an empty slate deletes a vote instead of refreshing it.
   */
  const sign = async (actions: ChainAction[], describe: string, after: string) => {
    if (!session || busy || !actions.length) return
    setBusy(true)
    setNote({ text: `${describe} — check your wallet…` })
    try {
      await session.transact({ actions }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      await refreshVotes()
      setNote({ text: after })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('Vote refresh failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const refreshGroup = () => {
    const actions = state.eligible.map((h) => voteAction(session!, h.dao, h.keep))
    const cut = state.trimmed.flatMap((h) => h.drop.map((d) => `${d.name} in ${h.dao.id}`))
    const left = [
      ...state.missing.map((d) => `${d.id} could not be read`),
      ...state.emptied.map((h) => `${h.dao.id} has no candidate left standing`),
    ]
    void sign(
      actions,
      `Refreshing ${actions.length} vote${actions.length === 1 ? '' : 's'}`,
      [
        `Refreshed ${actions.length} vote${actions.length === 1 ? '' : 's'}.`,
        cut.length ? `Dropped ${cut.join(', ')} — no longer standing.` : '',
        left.length ? `Left out: ${left.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }

  const notes: string[] = []
  if (!state.complete && state.missing.length) {
    notes.push(
      `${state.missing.length} of these could not be read (${state.missing
        .map((d) => d.id)
        .join(', ')}), so a vote held there is not in this batch.`,
    )
  }
  for (const h of state.trimmed) {
    notes.push(
      `In ${h.dao.title} this drops ${h.drop.map((d) => d.name).join(' and ')} — ${h.drop[0].why} — and re-casts ${h.keep.join(', ')}.`,
    )
  }
  for (const h of state.emptied) {
    notes.push(
      `${h.dao.title} is left out: every candidate you voted for there (${h.slate.join(', ')}) has gone. ` +
        `Re-casting an empty slate is how votecust deletes a vote, so that one needs a new pick, not a refresh.`,
    )
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{label}</h1>
          <p className="page__lead">
            {shown.length
              ? `${shown.length} councils, re-elected every period.`
              : loading
                ? 'Reading the directory…'
                : 'None found.'}{' '}
            {group === 'syndicate'
              ? 'Syndicates hold a treasury; the unions do not.'
              : 'Unions run the worker proposals and hold the proposal funds.'}
          </p>
        </div>
        <div className="page__actions">
          {session ? (
            <button
              className={`btn${state.trimmed.length || state.emptied.length || !state.complete ? ' btn--warn' : ''}`}
              type="button"
              onClick={refreshGroup}
              disabled={busy || !state.eligible.length}
              title={
                state.eligible.length
                  ? [`Re-cast your slate in ${state.eligible.map((h) => h.dao.title).join(', ')}.`, ...notes].join(' ')
                  : notes.join(' ') || `No votes cast in any ${label.toLowerCase()} yet`
              }
            >
              {busy ? 'Signing…' : `Refresh votes · ${state.eligible.length}`}
            </button>
          ) : null}
          <RefreshButton />
        </div>
      </header>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      <div className="dao-grid">
        {shown.map((dao) => (
          <DaoCard
            key={dao.id}
            dao={dao}
            vote={votes.get(dao.id)}
            slate={castableSlate(dao, votes)}
            busy={busy}
            onRefresh={(s) =>
              void sign(
                [voteAction(session!, dao, s.keep)],
                `Refreshing your vote in ${dao.title}`,
                `Vote refreshed in ${dao.title}.${
                  s.drop.length ? ` Dropped ${s.drop.map((d) => d.name).join(', ')} — no longer standing.` : ''
                }`,
              )
            }
          />
        ))}
      </div>

      {!shown.length && loading ? <p className="dao-note">Reading councils…</p> : null}
    </div>
  )
}

function DaoCard({
  dao,
  vote,
  slate,
  busy,
  onRefresh,
}: {
  dao: Dao
  vote?: VoteRow
  slate: Slate
  busy: boolean
  onRefresh: (s: Slate) => void
}) {
  const { session } = useSession()
  const held = heldByWatched(dao)
  const votedFor = new Set(vote?.candidates ?? [])
  const votedAt = vote ? Date.parse(`${vote.vote_time_stamp}Z`) : NaN

  return (
    <article className="dao-card">
      <div className="dao-card__top">
        <h2>
          <Link to={`/daos/${dao.id}`}>{dao.title}</Link>
        </h2>
        <Countdown due={dao.nextElection} periodLength={dao.periodLength} />
      </div>

      <p className="dao-card__meta">
        <span className="dao-card__id">{dao.id}</span>
        {dao.tlm ? (
          <span
            className="chip"
            title={`${dao.tlm} held by ${dao.treasury} — the account this ${dao.group} can spend from`}
          >
            {fmtAmount(dao.tlm)} <i>TLM</i>
          </span>
        ) : null}
        {isMcControlled(dao) ? (
          <span
            className="chip chip--watched"
            title={`${held} of ${dao.custodians.length} seats held by the watched accounts`}
          >
            MC controlled
          </span>
        ) : null}
        {Number.isFinite(votedAt) ? (
          <span className="chip" title={`You voted for ${vote!.candidates.join(', ')}`}>
            voted {fmtAge(Date.now() - votedAt)} ago
          </span>
        ) : null}
      </p>

      <ul className="council">
        {dao.error ? (
          <li className="council__none">Unavailable — {dao.error}</li>
        ) : !dao.custodians.length ? (
          <li className="council__none">No custodians seated</li>
        ) : (
          dao.custodians.map((name) => {
            /* Seated today, but below the cut on today's ranking — they lose the
               seat if a period runs before the votes move. */
            const risk = dao.atRisk.has(name)
            const place = dao.rankOf.get(name)
            return (
              <li key={name}>
                <a
                  className={WATCHED.has(name) ? 'is-watched' : undefined}
                  href={`${EXPLORER}${encodeURIComponent(name)}`}
                  target="_blank"
                  rel="noopener"
                >
                  {name}
                </a>
                {votedFor.has(name) ? (
                  <span className="tag tag--vote" title="You voted for this custodian">
                    ★ your vote
                  </span>
                ) : null}
                {risk ? (
                  <span
                    className="tag tag--bad"
                    title={`Ranked ${place ?? 'below'} of the standing candidates, for ${
                      dao.council.length
                    } seats — would lose this seat if a period ran now`}
                  >
                    at risk
                  </span>
                ) : null}
              </li>
            )
          })
        )}
      </ul>

      <div className="dao-card__foot">
        <Link className="btn" to={`/daos/${dao.id}`}>
          Details
        </Link>
        {session && slate.slate.length ? (
          <button
            className={`btn${slate.drop.length ? ' btn--warn' : ''}`}
            type="button"
            disabled={busy || !slate.keep.length}
            onClick={() => onRefresh(slate)}
            title={
              slate.drop.length
                ? `${slate.drop.map((d) => `${d.name} ${d.why}`).join(', ')}. ${
                    slate.keep.length
                      ? `Re-casts ${slate.keep.join(', ')} alone.`
                      : 'Nothing left to re-cast — pick someone new first.'
                  }`
                : `Re-cast ${slate.keep.join(', ')} to reset this vote's age`
            }
          >
            Refresh vote{slate.drop.length ? ' !' : ''}
          </button>
        ) : null}
      </div>
    </article>
  )
}
