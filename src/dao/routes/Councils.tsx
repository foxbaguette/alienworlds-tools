import { Link } from 'react-router-dom'
import { Countdown } from '../components/Countdown'
import { WATCHED, heldByWatched, isMcControlled, type Dao, type DaoGroup } from '../chain/daos'
import { EXPLORER, fmtAmount } from '../format'
import { useDaos } from '../useDaos'

/**
 * Every DAO of one kind, and who sits on each council.
 *
 * Syndicates and unions are the same view over a different half of the
 * directory, so they are one component taking the group as a prop rather than
 * two that drift apart.
 */
export default function Councils({ group }: { group: DaoGroup }) {
  const { daos, loading, error, refresh } = useDaos()
  const shown = daos.filter((d) => d.group === group)
  const label = group === 'syndicate' ? 'Syndicates' : 'Unions'

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
        <button className="btn" type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      <div className="dao-grid">
        {shown.map((dao) => (
          <DaoCard key={dao.id} dao={dao} />
        ))}
      </div>

      {!shown.length && loading ? <p className="dao-note">Reading councils…</p> : null}
    </div>
  )
}

function DaoCard({ dao }: { dao: Dao }) {
  const held = heldByWatched(dao)

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
      </div>
    </article>
  )
}
