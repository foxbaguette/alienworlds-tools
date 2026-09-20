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
import { EXPLORER, fmtAge, fmtAmount, fmtDays, fmtPower as fmtNumber, isoDay, rawPower } from '../format'
import { daoById, useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'
import { ensureProposals, ensureWorker, proposalsOf, useProposalCaches, workerOf } from '../useProposals'
import { fetchRedirect, type Redirect } from '../chain/inflation'
import { TAP_MAX_X100, fetchTap, fmtRate, planetOf, tapSetAction, type Tap } from '../chain/tap'
import { PROPOSAL_DAYS, proposeAction } from '../chain/propose'
import { isCancel, readableError, type ChainAction } from '../chain/act'
import { todoFor } from '../useTodo'
import { useSession } from '../../wallet/session'

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

      <TodoNote dao={dao} />

      {hasWorkerProposals(dao) ? (
        <>
          <RedirectPanel dao={dao} />
          <TapPanel dao={dao} />
        </>
      ) : null}

      {shown === 'council' ? <CouncilTab dao={dao} /> : null}
      {shown === 'proposals' ? <ProposalsTab dao={dao} /> : null}
      {shown === 'worker' ? <WorkerTab dao={dao} /> : null}
    </div>
  )
}

/**
 * What is waiting on the connected account here, spelled out.
 *
 * The sidebar badge is a number, and a number on its own invites the question
 * this answers. It is quiet when there is nothing, and it says WHAT rather than
 * how many, because the tab a thing lives on is not obvious from the count —
 * a council with every proposal executed can still owe three worker votes.
 */
function TodoNote({ dao }: { dao: Dao }) {
  const { actor } = useSession()
  /* Recomputed as the caches fill; the tabs below are what fills them. */
  const version = useProposalCaches()
  void version
  const todo = todoFor(dao, actor)
  if (!todo.n) return null

  return (
    <div className="dao-note todo-note">
      <b>
        {todo.n} thing{todo.n === 1 ? '' : 's'} waiting on {actor}
      </b>
      <ul>
        {todo.why.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
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

/**
 * Where the union sends part of its planet's mining game.
 *
 * The mirror of the panel above: that one is the union's income, this is a
 * standing order it controls that pays somebody else. m.federation skims a
 * percentage off the planet's mining rewards into a bucket, and the destination
 * empties the bucket whenever it likes — so "waiting to be collected" is a fact
 * about the destination's housekeeping rather than about the union.
 *
 * Only the union can change it, and only through its council: every pltdtapset
 * on chain is signed by the union's owner account. So what is offered here is a
 * PROPOSAL, not a write.
 */
function TapPanel({ dao }: { dao: Dao }) {
  const { session, actor } = useSession()
  const [tap, setTap] = useState<Tap | null>(null)
  const [mining, setMining] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const planet = planetOf(dao)

  useEffect(() => {
    if (!planet) return
    let alive = true
    setTap(null)
    setMining(null)
    setOpen(false)
    void fetchTap(planet)
      .then((t) => alive && setTap(t))
      .catch((err) => console.error('tap:', err))
    /* The mining leg of the daily inflation split is the number the tap takes
       its percentage of. Read here rather than handed down from the income
       panel: the two are independent, and one failing should not blank the
       other. */
    void fetchRedirect(dao)
      .then((r) => alive && setMining(r?.miningPerDay ?? null))
      .catch((err) => console.error('tap basis:', err))
    return () => {
      alive = false
    }
  }, [dao.id, planet])

  if (!planet || !tap) return null

  const perDay = mining != null ? (mining * tap.rateX100) / 10_000 : null
  const seated = actor ? dao.custodians.includes(actor) : false

  const propose = async (rateX100: number, destination: string, title: string, description: string) => {
    if (!session || busy) return
    setBusy(true)
    setNote({ text: 'Building the proposal — check your wallet…' })
    try {
      const action: ChainAction = await proposeAction(session, dao, tapSetAction([], planet, rateX100, destination), {
        title,
        description,
      })
      await session.transact({ actions: [action] }, { broadcast: true })
      setOpen(false)
      setNote({
        text: `Proposed. The council has ${PROPOSAL_DAYS} days to sign it, and ${dao.approvalThreshold} signatures execute it.`,
      })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('tap proposal failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dao-note redirect redirect--out">
      <p>
        <b>{fmtRate(tap.rateX100)}</b> of <code>{planet}</code>&rsquo;s mining rewards are redirected to{' '}
        <code>{tap.destination ?? 'nobody'}</code>
        {perDay != null ? (
          <>
            {' '}
            — about <b>{Math.trunc(perDay).toLocaleString('en-US')} TLM</b> a day.
          </>
        ) : null}
        <span className="dao-dim">
          {' '}
          {tap.rateX100 >= TAP_MAX_X100
            ? `That is the most the contract allows (${fmtRate(TAP_MAX_X100)}).`
            : `The contract allows up to ${fmtRate(TAP_MAX_X100)}.`}{' '}
          {tap.bucket > 0
            ? `${Math.trunc(tap.bucket).toLocaleString('en-US')} TLM has been skimmed and not collected yet.`
            : 'Nothing is sitting uncollected.'}
        </span>
      </p>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      {open ? (
        <TapForm dao={dao} tap={tap} mining={mining} busy={busy} onCancel={() => setOpen(false)} onPropose={propose} />
      ) : (
        <p className="page__actions">
          <button className="btn" type="button" disabled={!session} onClick={() => setOpen(true)}>
            Propose a change
          </button>
          <span className="dao-dim">
            {!session
              ? 'Connect a wallet to propose a change.'
              : seated
                ? `Raises a council proposal — ${dao.approvalThreshold} signatures execute it.`
                : `Anyone may raise it; ${dao.approvalThreshold} council signatures execute it.`}
          </span>
        </p>
      )}
    </div>
  )
}

/**
 * The form behind "propose a change".
 *
 * pltdtapset sets the rate and the destination together — there is no action
 * for one without the other — so both fields start at what is on chain, and an
 * untouched one re-states the current value rather than clearing it.
 */
function TapForm({
  dao,
  tap,
  mining,
  busy,
  onCancel,
  onPropose,
}: {
  dao: Dao
  tap: Tap
  mining: number | null
  busy: boolean
  onCancel: () => void
  onPropose: (rateX100: number, destination: string, title: string, description: string) => void
}) {
  /* Percent in the form, hundredths on chain: nobody thinks in x100. */
  const [percent, setPercent] = useState(String(tap.rateX100 / 100))
  const [destination, setDestination] = useState(tap.destination ?? '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const rateX100 = Math.round(Number(percent) * 100)
  const badRate = !percent.trim() || !Number.isFinite(rateX100) || rateX100 < 0 || rateX100 > TAP_MAX_X100
  const badName = !/^[a-z1-5.]{1,13}$/.test(destination)
  const unchanged = rateX100 === tap.rateX100 && destination === tap.destination
  const preview = mining != null && !badRate ? (mining * rateX100) / 10_000 : null

  /* A default that says what the proposal does, so a council reading a list of
     titles can tell one tap change from another without opening it. */
  const fallbackTitle = `Redirect ${badRate ? '?' : fmtRate(rateX100)} of ${tap.planet} mining to ${destination || '…'}`

  return (
    <div className="tap-form">
      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Share<i>0 to {fmtRate(TAP_MAX_X100)}, the contract&rsquo;s ceiling</i>
          </span>
          <input
            type="number"
            min={0}
            max={TAP_MAX_X100 / 100}
            step={0.01}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Destination<i>the account the skim is paid to</i>
          </span>
          <input type="text" value={destination} onChange={(e) => setDestination(e.target.value.trim())} />
        </label>
      </div>

      <p className="dao-dim">
        {badRate
          ? `A share has to be between 0 and ${fmtRate(TAP_MAX_X100)}.`
          : badName
            ? 'That is not a valid WAX account name.'
            : unchanged
              ? 'That is what the tap is set to already.'
              : preview != null
                ? `Would send about ${Math.trunc(preview).toLocaleString('en-US')} TLM a day to ${destination}.`
                : `Would set the tap to ${fmtRate(rateX100)}, paid to ${destination}.`}
      </p>

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Title<i>what the council sees in its list</i>
          </span>
          <input type="text" value={title} placeholder={fallbackTitle} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="ale-field">
        <span className="ale-field__name">
          Why<i>the case for the change</i>
        </span>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="page__actions">
        <button
          className="btn btn--go"
          type="button"
          disabled={busy || badRate || badName || unchanged || !description.trim()}
          onClick={() => onPropose(rateX100, destination, title.trim() || fallbackTitle, description.trim())}
        >
          {busy ? 'Signing…' : `Propose to ${dao.title}`}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
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
const fmtPower = (raw: string, dao: Dao): string => fmtNumber(rawPower(raw, dao.precision))
