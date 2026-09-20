import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Countdown } from '../components/Countdown'
import { WATCHED, heldByWatched, isMcControlled, type Dao } from '../chain/daos'
import { MSIG_OPEN, approvalCount, approvalsOf, isExpired, msigExpiry, msigTitle, type MsigProposal } from '../chain/proposals'
import {
  WP_APPROVED,
  WP_FINAPPR,
  WP_FINALIZING,
  WP_LABEL,
  WP_PENDING,
  WP_TONE,
  hasWorkerProposals,
  wpDocUrl,
  wpEffectiveState,
  wpIsLive,
  wpPayableAt,
  wpTally,
  wpTime,
  wpVotingOpen,
  type WorkerData,
  type WorkerProposal,
} from '../chain/worker'
import { EXPLORER, fmtAge, fmtAmount, fmtDays, isoDay } from '../format'
import { daoById, useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'
import { ensureProposals, ensureWorker, proposalsOf, useProposalCaches, workerOf } from '../useProposals'
import { fetchRedirect, type Redirect } from '../chain/inflation'

type Tab = 'council' | 'proposals' | 'worker'

/**
 * One DAO, in depth.
 *
 * Three jobs that have nothing to do with each other — who sits on the council,
 * what the council is being asked to sign, and what work has been proposed to
 * it — so one is on screen at a time rather than all three as a wall.
 */
export default function DaoDetails() {
  const { id = '', tab } = useParams()
  const navigate = useNavigate()
  const { daos, loading } = useDaos()
  const dao = daoById(daos, id)

  if (!dao) {
    return (
      <div className="page">
        <p className="dao-note">{loading ? 'Reading the directory…' : `No DAO called “${id}”.`}</p>
        <p>
          <Link className="btn" to="/daos/syndicates">
            All DAOs
          </Link>
        </p>
      </div>
    )
  }

  /*
   * The tab is a route, not component state, so each one is linkable, survives
   * a reload, and can appear in the sidebar as a page of its own. A syndicate
   * has no worker tab, so asking for one falls back rather than opening a tab
   * with nothing behind it.
   */
  const tabs: { key: Tab; label: string }[] = [
    { key: 'proposals', label: 'Proposals' },
    ...(hasWorkerProposals(dao) ? [{ key: 'worker' as Tab, label: 'Worker proposals' }] : []),
    { key: 'council', label: 'Council & candidates' },
  ]
  const shown = (tabs.find((t) => t.key === tab)?.key ?? 'proposals') as Tab

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <button className="dao-back" type="button" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <h1 className="page__title">{dao.title}</h1>
          <p className="page__lead">
            {dao.id} · {dao.symbol} · {dao.group}
            {dao.treasury ? ` · spends from ${dao.treasury}` : ''}
            {dao.tlm ? ` · ${fmtAmount(dao.tlm)} TLM` : ''}
            {isMcControlled(dao)
              ? ` · ${heldByWatched(dao)} of ${dao.custodians.length} seats held by watched accounts`
              : ''}
          </p>
        </div>
        <div className="page__actions">
          <Countdown due={dao.nextElection} periodLength={dao.periodLength} />
          <RefreshButton />
        </div>
      </header>

      <div className="sections dao-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === shown}
            onClick={() => navigate(`/daos/${id}/${t.key}`, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {hasWorkerProposals(dao) ? <RedirectPanel dao={dao} /> : null}

      {shown === 'council' ? <CouncilTab dao={dao} /> : null}
      {shown === 'proposals' ? <ProposalsTab dao={dao} /> : null}
      {shown === 'worker' ? <WorkerTab dao={dao} /> : null}
    </div>
  )
}

/**
 * Where a union's money comes from.
 *
 * Its proposal funds are filled by a redirected share of its planet's daily
 * inflation and by nothing else, so this is the whole of its income. Unions
 * only: a syndicate is not on the receiving end of that split.
 *
 * Quiet until it has an answer, and absent if it never gets one — history
 * indexers are the flakiest thing this app talks to, and an empty panel saying
 * "unavailable" on every load would be worse than no panel.
 */
/** A whole number stays whole: floating point makes 7 into 7.000000001. */
function fmtPercent(n: number): string {
  const one = Math.round(n * 10) / 10
  return Number.isInteger(one) ? String(one) : one.toFixed(1)
}

function RedirectPanel({ dao }: { dao: Dao }) {
  const [redirect, setRedirect] = useState<Redirect | null>(null)

  useEffect(() => {
    let alive = true
    setRedirect(null)
    void fetchRedirect(dao)
      .then((r) => alive && setRedirect(r))
      .catch((err) => console.error('redirect:', err))
    return () => {
      alive = false
    }
  }, [dao.id])

  if (!redirect) return null

  return (
    <p className="dao-note redirect">
      <b>{redirect.percent != null ? `${fmtPercent(redirect.percent)}%` : 'A share'}</b>{' '}
      of {redirect.planet ?? 'its planet'}&rsquo;s daily inflation is redirected to{' '}
      <code>{redirect.to}</code> — about <b>{Math.trunc(redirect.perDay).toLocaleString('en-US')} TLM</b> a day
      <span className="dao-dim">
        {' '}
        averaged over the last {redirect.days} daily claim{redirect.days === 1 ? '' : 's'}. This is the whole of
        what funds this union&rsquo;s proposals.
      </span>
    </p>
  )
}

/* ---------- council and candidates ---------- */

function CouncilTab({ dao }: { dao: Dao }) {
  /* Already in hand from the grid load — the candidates table comes back with
     the council, so this tab costs no reads at all. */
  const standing = dao.candidates
    .filter((c) => c.is_active)
    .sort((a, b) => Number(b.rank) - Number(a.rank))

  return (
    <>
      <section className="section">
        <h2 className="dao-h2">
          Council <span className="dao-dim">{dao.council.length} seated</span>
        </h2>
        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Custodian</th>
                <th className="num">Vote power</th>
                <th className="num">Voters</th>
                <th className="num">Vote age</th>
              </tr>
            </thead>
            <tbody>
              {dao.council.map((c, i) => {
                const age = Date.parse(`${c.avg_vote_time_stamp}Z`)
                const risk = dao.atRisk.has(c.cust_name)
                return (
                  <tr key={c.cust_name}>
                    <td className="num">{i + 1}</td>
                    <td>
                      <Account name={c.cust_name} />
                      {risk ? (
                        <span className="tag tag--bad" title={`Ranked ${dao.rankOf.get(c.cust_name) ?? '?'} today`}>
                          at risk
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{fmtPower(c.total_vote_power, dao)}</td>
                    <td className="num">{c.number_voters}</td>
                    <td className="num">{Number.isFinite(age) ? fmtAge(Date.now() - age) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <h2 className="dao-h2">
          Candidates <span className="dao-dim">{standing.length} standing</span>
        </h2>
        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                <th>Candidate</th>
                <th className="num">Vote power</th>
                <th className="num">Voters</th>
                <th className="num">Vote age</th>
                <th className="num">Seat</th>
              </tr>
            </thead>
            <tbody>
              {standing.map((c) => {
                const seat = dao.custodians.indexOf(c.candidate_name)
                const age = Date.parse(`${c.avg_vote_time_stamp}Z`)
                return (
                  <tr key={c.candidate_name}>
                    <td>
                      <Account name={c.candidate_name} />
                      {dao.wouldSeat.includes(c.candidate_name) && seat < 0 ? (
                        <span className="tag tag--in" title="Ranked inside the seat count — would take a seat now">
                          incoming
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{fmtPower(c.total_vote_power, dao)}</td>
                    <td className="num">{c.number_voters}</td>
                    <td className="num">{Number.isFinite(age) ? fmtAge(Date.now() - age) : '—'}</td>
                    <td className="num">{seat >= 0 ? seat + 1 : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

/* ---------- council proposals ---------- */

function ProposalsTab({ dao }: { dao: Dao }) {
  const [filter, setFilter] = useState<'active' | 'executed'>('active')
  const version = useProposalCaches()

  /* Shared with the all-proposals overview: opening a council from that list
     should not re-read what the list already has. Keyed on the cache version
     as well as the DAO, so clearing the caches is what makes this ask again. */
  useEffect(() => {
    void ensureProposals(dao.id)
  }, [dao.id, version])

  const cached = proposalsOf(dao.id)
  const props = cached ?? null
  const failed = cached === null

  const need = dao.approvalThreshold
  /* Active means still open AND still inside its transaction expiry: an expired
     proposal can never execute, so it is not "active" in any useful sense. */
  const shown = (props ?? []).filter((p) =>
    filter === 'executed' ? p.state !== MSIG_OPEN : p.state === MSIG_OPEN && !isExpired(p),
  )

  return (
    <section className="section">
      <h2 className="dao-h2">
        Proposals{' '}
        <span className="dao-dim">
          {failed ? 'unavailable' : props ? `${shown.length} of ${props.length}` : 'reading…'}
        </span>
      </h2>

      <div className="sections dao-tabs dao-tabs--sm" role="tablist">
        <button type="button" role="tab" aria-selected={filter === 'active'} onClick={() => setFilter('active')}>
          Active
        </button>
        <button type="button" role="tab" aria-selected={filter === 'executed'} onClick={() => setFilter('executed')}>
          Settled
        </button>
      </div>

      <div className="dao-tablewrap">
        <table className="dao-table">
          <thead>
            <tr>
              <th>Proposal</th>
              <th>State</th>
              <th className="num">Approvals</th>
              <th className="num">Expires</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const got = approvalCount(p)
              const exp = msigExpiry(p.packed_transaction)
              const who = approvalsOf(p)
                .map((a) => a.level?.actor)
                .filter(Boolean)
                .join(', ')
              return (
                <tr key={p.proposal_name}>
                  <td>
                    <b className="dao-rowtitle">{msigTitle(p)}</b>
                    <span className="dao-rowmeta">
                      <Account name={p.proposer} plain />
                      <span className="dao-rowid">{p.proposal_name}</span>
                    </span>
                  </td>
                  <td>
                    <StateChip state={p} />
                  </td>
                  <td className="num" title={who ? `Signed by ${who}` : 'Nobody has signed yet'}>
                    <b className={got >= need ? 'is-enough' : undefined}>{got}</b>
                    <span className="dao-dim">/{need}</span>
                  </td>
                  <td className="num">{Number.isFinite(exp) ? isoDay(exp) : '—'}</td>
                </tr>
              )
            })}
            {!shown.length ? (
              <tr>
                <td colSpan={4} className="dao-dim">
                  {failed
                    ? 'Could not read the proposals for this council.'
                    : !props
                      ? 'Reading…'
                      : filter === 'active'
                        ? 'Nothing open and unexpired.'
                        : 'Nothing settled yet.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StateChip({ state: p }: { state: MsigProposal }) {
  const expired = p.state === MSIG_OPEN && isExpired(p)
  const label = expired ? 'expired' : p.state === MSIG_OPEN ? 'open' : p.state === 1 ? 'executed' : 'cancelled'
  const tone = expired ? 'dead' : p.state === MSIG_OPEN ? 'wait' : p.state === 1 ? 'done' : 'bad'
  return <span className={`wp-chip is-${tone}`}>{label}</span>
}

/* ---------- worker proposals ---------- */

function WorkerTab({ dao }: { dao: Dao }) {
  const [live, setLive] = useState(true)
  const version = useProposalCaches()

  useEffect(() => {
    void ensureWorker(dao.id)
  }, [dao.id, version])

  const cached = workerOf(dao.id)
  const wp = cached ?? null
  const failed = cached === null

  const all = wp?.props ?? []
  const shown = live ? all.filter(wpIsLive) : all

  return (
    <section className="section">
      <h2 className="dao-h2">
        Worker proposals{' '}
        <span className="dao-dim">{failed ? 'unavailable' : wp ? `${shown.length} of ${all.length}` : 'reading…'}</span>
      </h2>

      <div className="sections dao-tabs dao-tabs--sm" role="tablist">
        <button type="button" role="tab" aria-selected={live} onClick={() => setLive(true)}>
          Live
        </button>
        <button type="button" role="tab" aria-selected={!live} onClick={() => setLive(false)}>
          All {all.length || ''}
        </button>
      </div>

      <div className="dao-tablewrap">
        <table className="dao-table">
          <thead>
            <tr>
              <th>State</th>
              <th>Proposal</th>
              <th className="num">Pay</th>
              <th className="num">Approvals</th>
              <th className="num">Timing</th>
            </tr>
          </thead>
          <tbody>
            {wp
              ? shown.map((p) => <WorkerRow key={p.proposal_id} dao={dao} p={p} wp={wp} />)
              : null}
            {!shown.length ? (
              <tr>
                <td colSpan={5} className="dao-dim">
                  {failed
                    ? `${dao.id} could not be read from prop.worlds.`
                    : !wp
                      ? 'Reading…'
                      : all.length
                        ? `Nothing live — all ${all.length} are finished or expired.`
                        : 'No worker proposals have been raised here.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function WorkerRow({ dao, p, wp }: { dao: Dao; p: WorkerProposal; wp: WorkerData }) {
  const tally = wpTally(dao, p, wp)
  const state = wpEffectiveState(p)
  const stale = state !== p.state
  const doc = wpDocUrl(p.content_hash)

  /* Which clock matters depends on the stage: an open vote is racing its
     expiry, a finished job is waiting out its hold, everything else is
     history. */
  let when = `created ${fmtAge(Date.now() - wpTime(p.created_at))} ago`
  if (state === WP_PENDING || state === WP_APPROVED) {
    when = `voting ends in ${fmtDays((wpTime(p.expiry) - Date.now()) / 1000)}`
  } else if (state === WP_FINALIZING || state === WP_FINAPPR) {
    const left = wpPayableAt(p, wp) - Date.now()
    when = left > 0 ? `payable in ${fmtDays(left / 1000)}` : 'past its hold'
  }

  return (
    <tr>
      <td>
        <span
          className={`wp-chip is-${WP_TONE[state] ?? 'wait'}`}
          title={
            stale
              ? `The chain still records this as "${WP_LABEL[p.state] ?? p.state}". Its voting window closed ${isoDay(
                  wpTime(p.expiry),
                )}, and the row only flips to expired when someone next votes on it.`
              : `State on chain: ${p.state}`
          }
        >
          {WP_LABEL[state] ?? state}
        </span>
        <span className="dao-dim">{tally.round} round</span>
      </td>
      <td>
        <b className="dao-rowtitle">{p.title}</b>
        <span className="dao-rowmeta">
          <Account name={p.proposer} plain />
          <span className="dao-rowid">{p.proposal_id}</span>
        </span>
        <p className="wp-summary">{p.summary}</p>
        <span className="dao-rowmeta">
          <span className="dao-dim">arbiter</span>
          <Account name={p.arbiter} plain />
          {p.arbiter_agreed ? (
            <span className="tag tag--in">agreed</span>
          ) : (
            <span className="tag tag--bad" title="startwork is refused until the arbiter agrees">
              not agreed
            </span>
          )}
          {doc ? (
            <a className="btn btn--tiny" href={doc} target="_blank" rel="noopener">
              View document
            </a>
          ) : null}
        </span>
      </td>
      <td className="num wp-pay">
        <b>{fmtAmount(p.proposal_pay.quantity)}</b>
        <span className="dao-dim">+{fmtAmount(p.arbiter_pay.quantity)} arb</span>
      </td>
      <td className="num" title={`${tally.yes} of ${tally.need} this round${tally.no ? `, ${tally.no} against` : ''}`}>
        <b className={tally.yes >= tally.need && wpVotingOpen(p) ? 'is-enough' : undefined}>{tally.yes}</b>
        <span className="dao-dim">/{tally.need}</span>
      </td>
      <td className="num wp-when">
        {when}
        <span className="dao-dim">{fmtDays(p.job_duration)} job</span>
      </td>
    </tr>
  )
}

/* ---------- shared bits ---------- */

function Account({ name, plain }: { name: string; plain?: boolean }) {
  return (
    <a
      className={`${plain ? 'dao-who' : ''}${WATCHED.has(name) ? ' is-watched' : ''}`}
      href={`${EXPLORER}${encodeURIComponent(name)}`}
      target="_blank"
      rel="noopener"
    >
      {name}
    </a>
  )
}

/** Vote power is a running sum of balances, in this DAO's own token. */
function fmtPower(raw: string, dao: Dao): string {
  const n = Number(raw) / 10 ** dao.precision
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(0)
}
