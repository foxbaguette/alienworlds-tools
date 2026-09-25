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
  wpStranded,
  wpTally,
  wpTime,
  wpVotingOpen,
  workerAction,
  workerButtons,
  type WorkerData,
  type WorkerProposal,
} from '../chain/worker'
import { EXPLORER, fmtAge, fmtAmount, fmtDays, fmtPower as fmtNumber, isoDay, rawPower } from '../format'
import { daoById, useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'
import { ensureProposals, ensureWorker, proposalsOf, useProposalCaches, workerOf } from '../useProposals'
import { fetchRedirect, type Redirect } from '../chain/inflation'
import { fetchTap, fetchTapMax, fmtRate, planetOf, tapSetAction, type Tap } from '../chain/tap'
import { PROPOSAL_DAYS, proposeAction } from '../chain/propose'
import {
  PERIOD_MAX_DAYS,
  claimBudgetAction,
  claimedThisPeriod,
  hasBudget,
  pendingClaim,
  periodFloorDays,
  setPeriodAction,
} from '../chain/period'
import {
  approveAction,
  canApprove,
  canExecute,
  execAction,
  isCancel,
  readableError,
  type ChainAction,
} from '../chain/act'
import { todoFor } from '../useTodo'
import { ProposalForm } from '../components/ProposalForm'
import { WorkerProposalForm } from '../components/WorkerProposalForm'
import { clearProposalCaches } from '../useProposals'
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

      <DaoTabs
        dao={dao}
        tabs={tabs}
        shown={shown}
        onPick={(key) => navigate(`/daos/${id}/${key}`, { replace: true })}
      />

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
/**
 * The tab strip, with a dot on each tab that holds something waiting on you.
 *
 * The note below says WHAT is waiting; this says WHERE. Without it, opening a
 * union lands on Proposals, which can be empty while the thing the sidebar
 * counted is a worker vote one tab over.
 *
 * A component of its own because the page above returns early before the
 * directory lands, and the hooks this needs cannot sit behind that return.
 */
function DaoTabs({
  dao,
  tabs,
  shown,
  onPick,
}: {
  dao: Dao
  tabs: { key: Tab; label: string }[]
  shown: Tab
  onPick: (key: Tab) => void
}) {
  const { actor } = useSession()
  const version = useProposalCaches()
  void version
  const { byTab } = todoFor(dao, actor)

  return (
    <div className="sections dao-tabs" role="tablist">
      {tabs.map((t) => {
        const waiting = t.key === 'proposals' ? byTab.proposals : t.key === 'worker' ? byTab.worker : 0
        return (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === shown} onClick={() => onPick(t.key)}>
            {t.label}
            {waiting ? (
              <span
                className="tab-dot"
                title={`${waiting} thing${waiting === 1 ? '' : 's'} waiting on you here`}
                aria-label={`${waiting} waiting on you`}
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

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
/**
 * The tap and the mining figure it takes its share of, read once per council
 * and shared: the panel above every tab shows it, and the redirect form on the
 * Proposals tab starts from it. Two components asking should not be two reads.
 */
const tapCache = new Map<string, Promise<{ tap: Tap | null; mining: number | null }>>()

function useTap(dao: Dao) {
  const planet = planetOf(dao)
  const [got, setGot] = useState<{ tap: Tap | null; mining: number | null } | null>(null)

  useEffect(() => {
    if (!planet) return
    let alive = true
    setGot(null)
    let load = tapCache.get(dao.id)
    if (!load) {
      load = Promise.all([
        fetchTap(planet).catch((err) => {
          console.error('tap:', err)
          return null
        }),
        /* The mining leg of the daily inflation split is the number the tap
           takes its percentage of. Allowed to fail on its own: the tap is
           still worth showing without the TLM figure. */
        fetchRedirect(dao)
          .then((r) => r?.miningPerDay ?? null)
          .catch((err) => {
            console.error('tap basis:', err)
            return null
          }),
      ]).then(([tap, mining]) => ({ tap, mining }))
      tapCache.set(dao.id, load)
    }
    void load.then((v) => alive && setGot(v))
    return () => {
      alive = false
    }
  }, [dao.id, planet])

  return { planet, tap: got?.tap ?? null, mining: got?.mining ?? null }
}

/**
 * The contract's ceiling. Null until the code has been read — the panel says
 * nothing about a limit it does not know, and the form will not take a share
 * it cannot check against one.
 */
function useTapMax() {
  const [max, setMax] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    void fetchTapMax().then((v) => alive && setMax(v))
    return () => {
      alive = false
    }
  }, [])
  return max
}

function TapPanel({ dao }: { dao: Dao }) {
  const { planet, tap, mining } = useTap(dao)
  const max = useTapMax()
  if (!planet || !tap) return null

  const perDay = mining != null ? (mining * tap.rateX100) / 10_000 : null

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
          {max == null
            ? ''
            : tap.rateX100 >= max
              ? `That is the most the contract allows (${fmtRate(max)}).`
              : `The contract allows up to ${fmtRate(max)}.`}{' '}
          {tap.bucket > 0
            ? `${Math.trunc(tap.bucket).toLocaleString('en-US')} TLM has been skimmed and not collected yet.`
            : 'Nothing is sitting uncollected.'}
        </span>
      </p>

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

  const max = useTapMax()

  const rateX100 = Math.round(Number(percent) * 100)
  const badRate = max == null || !percent.trim() || !Number.isFinite(rateX100) || rateX100 < 0 || rateX100 > max
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
            Share<i>{max == null ? 'reading the contract\u2019s ceiling\u2026' : `0 to ${fmtRate(max)}, the contract\u2019s ceiling`}</i>
          </span>
          <input
            type="number"
            min={0}
            max={max != null ? max / 100 : undefined}
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
        {max == null
          ? 'Reading the ceiling from the contract.'
          : badRate
            ? `A share has to be between 0 and ${fmtRate(max)}.`
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

type Raise = (inner: Omit<ChainAction, 'authorization'>, title: string, description: string) => Promise<void> | void

/**
 * A new term length.
 *
 * Days in the form, seconds on chain. The bounds are the contract's own, so a
 * number outside them is stopped here rather than at the council's last
 * signature, which is where a bad setperiodlen would otherwise fail.
 */
function PeriodForm({ dao, busy, onCancel, onPropose }: { dao: Dao; busy: boolean; onCancel: () => void; onPropose: Raise }) {
  const floor = periodFloorDays(dao)
  const current = dao.periodLength ? Math.round(dao.periodLength / 86_400) : null
  const [days, setDays] = useState(String(current ?? 7))
  /* null until typed in: the suggested text is written INTO the fields and
     follows the number of days, and only stops following once somebody has
     put their own words there. */
  const [title, setTitle] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)

  const n = Math.round(Number(days))
  const bad = !days.trim() || !Number.isFinite(n) || n < floor || n > PERIOD_MAX_DAYS
  const unchanged = n === current
  const plural = (x: number) => `${x} day${x === 1 ? '' : 's'}`
  const fallbackTitle = `Set the election period to ${bad ? '?' : plural(n)}`
  const fallbackWhy = `Change the election period for ${dao.title} from ${current != null ? plural(current) : 'unknown'} to ${bad ? '?' : plural(n)}.`

  return (
    <div className="tap-form">
      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Days per term<i>{floor} to {PERIOD_MAX_DAYS}, the contract&rsquo;s bounds</i>
          </span>
          <input type="number" min={floor} max={PERIOD_MAX_DAYS} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      </div>

      <p className="dao-dim">
        {bad
          ? `A term has to be between ${plural(floor)} and ${plural(PERIOD_MAX_DAYS)}.`
          : unchanged
            ? 'That is the term already.'
            : `Today it is ${current != null ? plural(current) : 'unknown'}. The new length applies from the election after the council executes this.`}
      </p>

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Title<i>what the council sees in its list</i>
          </span>
          <input type="text" value={title ?? fallbackTitle} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="ale-field">
        <span className="ale-field__name">
          Why<i>what the council reads when it opens it</i>
        </span>
        <textarea rows={3} value={description ?? fallbackWhy} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="page__actions">
        <button
          className="btn btn--go"
          type="button"
          disabled={busy || bad || unchanged}
          onClick={() =>
            void onPropose(setPeriodAction(dao, n), (title ?? '').trim() || fallbackTitle, (description ?? '').trim() || fallbackWhy)
          }
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

/**
 * Drawing this period's budget.
 *
 * claimbudget takes nothing but the DAO — the contract works out the amount
 * from the DAO's own budget setting — so the form is a confirmation with the
 * two facts that decide whether it will go through.
 */
function BudgetForm({ dao, busy, onCancel, onPropose }: { dao: Dao; busy: boolean; onCancel: () => void; onPropose: Raise }) {
  const already = claimedThisPeriod(dao)
  /* The Proposals tab this form sits on has already read the list. */
  const pending = pendingClaim(dao, proposalsOf(dao.id))
  const got = pending ? approvalCount(pending) : 0
  const need = dao.approvalThreshold
  const when = (ms: number | null) => {
    if (ms == null) return 'never'
    const age = Date.now() - ms
    return `${isoDay(ms)} (${age < 86_400_000 ? 'today' : `${fmtAge(age)} ago`})`
  }
  const title = `Claim the ${dao.title} budget`
  const description = `Claim this period\u2019s budget for ${dao.title}.`

  return (
    <div className="tap-form">
      <p>
        Budget set to <b>{dao.budgetPercent}%</b>. Last drawn <b>{when(dao.lastClaimBudget)}</b>; this term began{' '}
        {when(dao.lastPeriod)}.
      </p>
      <p className={already ? 'dao-note dao-note--bad' : 'dao-dim'}>
        {already
          ? `Already drawn this term. Every syndicate claims once between elections, so this would only execute after the next one${
              dao.nextElection ? `, on ${isoDay(dao.nextElection)}` : ''
            } — the proposal stays open ${PROPOSAL_DAYS} days.`
          : pending
            ? 'Not drawn yet this term — but a claim is already on its way.'
            : 'Not drawn yet this term, so it can execute as soon as it has its signatures.'}
      </p>
      {/* The claim already raised, if there is one. A second would be a
          second thing for the council to sign that can never run once the
          first has, so this says where the first one stands instead. */}
      {pending ? (
        <p className="dao-note dao-note--info">
          <b>&ldquo;{msigTitle(pending)}&rdquo;</b> was proposed by {pending.proposer} and is open —{' '}
          {got >= need
            ? `it has its ${need} signatures and only needs executing.`
            : `${got} of ${need} signatures so far.`}{' '}
          Expires {isoDay(msigExpiry(pending.packed_transaction))}. Sign or run it in the list below rather than raising
          another.
        </p>
      ) : null}

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={busy} onClick={() => void onPropose(claimBudgetAction(dao), title, description)}>
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
  const { session, actor } = useSession()
  const [filter, setFilter] = useState<'active' | 'executed'>('active')
  /* null means closed; a proposal means "copy that one"; 'new' means blank;
     the others are the three settings proposals that have a form of their own. */
  const [writing, setWriting] = useState<MsigProposal | 'new' | 'period' | 'tap' | 'budget' | null>(null)
  const { planet, tap, mining } = useTap(dao)
  const toggle = (w: 'new' | 'period' | 'tap' | 'budget') => setWriting(writing === w ? null : w)

  /**
   * Raise a proposal carrying one owner-authorised action.
   *
   * The same path for all three settings: the action runs as the DAO's owner,
   * which nobody holds alone, so what gets signed here is the PROPOSAL and the
   * council's approvals are what eventually run it.
   */
  const raise = async (inner: Omit<ChainAction, 'authorization'>, title: string, description: string) => {
    if (!session || busy) return
    setBusy('raise')
    setNote({ text: 'Building the proposal — check your wallet…' })
    try {
      const action = await proposeAction(session, dao, inner, { title, description })
      await session.transact({ actions: [action] }, { broadcast: true })
      setWriting(null)
      await new Promise((r) => setTimeout(r, 2500))
      clearProposalCaches()
      setNote({
        text: `Proposed. The council has ${PROPOSAL_DAYS} days to sign it, and ${dao.approvalThreshold} signatures execute it.`,
      })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('proposal failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(null)
    }
  }
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const version = useProposalCaches()

  /**
   * Signing on one proposal, from the council's own page.
   *
   * The overview can approve a dozen across every council in one transaction;
   * this is the other half of that — you are looking at one council, and the
   * thing you want to act on is in front of you.
   */
  const sign = async (p: MsigProposal, what: 'approve' | 'exec') => {
    if (!session || busy) return
    const label = what === 'approve' ? `Approving ${msigTitle(p)}` : `Executing ${msigTitle(p)}`
    setBusy(`${p.proposal_name}:${what}`)
    setNote({ text: `${label} — check your wallet…` })
    try {
      const action = what === 'approve' ? approveAction(session, dao, p) : execAction(session, dao, p)
      await session.transact({ actions: [action] }, { broadcast: true })
      /* A block has to land before a re-read shows the change. */
      await new Promise((r) => setTimeout(r, 2500))
      clearProposalCaches()
      setNote({ text: `${label} done.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error(`${what} failed:`, err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(null)
    }
  }

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

      <div className="page__actions">
        <div className="sections dao-tabs dao-tabs--sm" role="tablist">
          <button type="button" role="tab" aria-selected={filter === 'active'} onClick={() => setFilter('active')}>
            Active
          </button>
          <button type="button" role="tab" aria-selected={filter === 'executed'} onClick={() => setFilter('executed')}>
            Settled
          </button>
        </div>
        {/* Every proposal a council raises, side by side: the free-form one,
            and the settings that have a form of their own because getting
            their arguments wrong is easy and the contract is unforgiving. */}
        <button className="btn" type="button" aria-pressed={writing === 'new'} onClick={() => toggle('new')}>
          New proposal
        </button>
        <button
          className="btn"
          type="button"
          aria-pressed={writing === 'period'}
          disabled={!session}
          title={session ? 'Propose a new length for this council\u2019s term' : 'Connect a wallet to propose'}
          onClick={() => toggle('period')}
        >
          Election period
        </button>
        {planet && tap ? (
          <button
            className="btn"
            type="button"
            aria-pressed={writing === 'tap'}
            disabled={!session}
            title={session ? `Propose a new share or destination for ${planet}\u2019s mining redirect` : 'Connect a wallet to propose'}
            onClick={() => toggle('tap')}
          >
            Mining redirect
          </button>
        ) : null}
        {hasBudget(dao) ? (
          <button
            className="btn"
            type="button"
            aria-pressed={writing === 'budget'}
            disabled={!session}
            title={session ? 'Propose drawing this period\u2019s budget' : 'Connect a wallet to propose'}
            onClick={() => toggle('budget')}
          >
            Claim budget
          </button>
        ) : null}
      </div>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      {writing === 'period' ? (
        <PeriodForm dao={dao} busy={busy === 'raise'} onCancel={() => setWriting(null)} onPropose={raise} />
      ) : writing === 'tap' && planet && tap ? (
        <TapForm
          dao={dao}
          tap={tap}
          mining={mining}
          busy={busy === 'raise'}
          onCancel={() => setWriting(null)}
          onPropose={(rateX100, destination, title, description) =>
            void raise(tapSetAction([], planet, rateX100, destination), title, description)
          }
        />
      ) : writing === 'budget' ? (
        <BudgetForm dao={dao} busy={busy === 'raise'} onCancel={() => setWriting(null)} onPropose={raise} />
      ) : writing === 'new' || (writing && typeof writing === 'object') ? (
        <ProposalForm
          dao={dao}
          from={writing === 'new' ? null : writing}
          onDone={clearProposalCaches}
          onClose={() => setWriting(null)}
        />
      ) : null}

      <div className="dao-tablewrap">
        <table className="dao-table">
          <thead>
            <tr>
              <th>Proposal</th>
              <th>State</th>
              <th className="num">Approvals</th>
              <th className="num">Expires</th>
              <th />
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
                  <td className="num wp-acts">
                    {canApprove(p, dao, actor) ? (
                      <button
                        className="btn btn--tiny"
                        type="button"
                        disabled={!!busy}
                        title={`Add your signature — ${got} of ${need} so far`}
                        onClick={() => void sign(p, 'approve')}
                      >
                        {busy === `${p.proposal_name}:approve` ? 'Signing…' : 'Approve'}
                      </button>
                    ) : null}
                    {canExecute(p, dao, got) ? (
                      <button
                        className="btn btn--tiny btn--go"
                        type="button"
                        disabled={!!busy}
                        title="It has its signatures — anyone may run it"
                        onClick={() => void sign(p, 'exec')}
                      >
                        {busy === `${p.proposal_name}:exec` ? 'Signing…' : 'Execute'}
                      </button>
                    ) : null}
                    <button
                      className="btn btn--tiny"
                      type="button"
                      title="Open a new proposal prefilled with this one's actions"
                      onClick={() => setWriting(writing === p ? null : p)}
                    >
                      Copy
                    </button>
                  </td>
                </tr>
              )
            })}
            {!shown.length ? (
              <tr>
                <td colSpan={5} className="dao-dim">
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
  const [writing, setWriting] = useState(false)
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

      <div className="page__actions">
        <div className="sections dao-tabs dao-tabs--sm" role="tablist">
          <button type="button" role="tab" aria-selected={live} onClick={() => setLive(true)}>
            Live
          </button>
          <button type="button" role="tab" aria-selected={!live} onClick={() => setLive(false)}>
            All {all.length || ''}
          </button>
        </div>
        <button className="btn" type="button" disabled={!wp} onClick={() => setWriting(!writing)}>
          New worker proposal
        </button>
      </div>

      {writing && wp ? (
        <WorkerProposalForm dao={dao} wp={wp} onDone={clearProposalCaches} onClose={() => setWriting(false)} />
      ) : null}

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
              ? shown.map((p) => (
                  <WorkerRow key={p.proposal_id} dao={dao} p={p} wp={wp} onDone={clearProposalCaches} />
                ))
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

function WorkerRow({
  dao,
  p,
  wp,
  onDone,
}: {
  dao: Dao
  p: WorkerProposal
  wp: WorkerData
  onDone: () => void
}) {
  const { session, actor } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const tally = wpTally(dao, p, wp)
  const state = wpEffectiveState(p)
  const stale = state !== p.state
  const doc = wpDocUrl(p.content_hash)
  const buttons = workerButtons(dao, p, wp, actor)
  const stranded = wpStranded(p, wp)

  const act = async (which: Parameters<typeof workerAction>[3], label: string) => {
    if (!session || busy) return
    setBusy(which)
    setNote({ text: `${label} — check your wallet…` })
    try {
      const level = {
        actor: String(session.actor),
        permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
      }
      await session.transact({ actions: [workerAction(level, dao, p, which)] }, { broadcast: true })
      /* A block has to land before the tables move. */
      await new Promise((r) => setTimeout(r, 2500))
      onDone()
      setNote({ text: `${label} done.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error(`${which} failed:`, err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(null)
    }
  }

  /* Which clock matters depends on the stage: an open vote is racing its
     expiry, a finished job is waiting out its hold, everything else is
     history. */
  let when = `created ${fmtAge(Date.now() - wpTime(p.created_at))} ago`
  if (state === WP_PENDING || state === WP_APPROVED) {
    when = `voting ends in ${fmtDays((wpTime(p.expiry) - Date.now()) / 1000)}`
  } else if (state === WP_FINALIZING || state === WP_FINAPPR) {
    const left = wpPayableAt(p, wp) - Date.now()
    when = left > 0 ? `payable in ${fmtDays(left / 1000)}` : 'payable now'
  }

  return (
    <tr>
      <td>
        {/* A stranded proposal reads "ready to pay" on chain, which is the one
            thing it is not. The badge says the truth and the note below it says
            why. */}
        <span
          className={`wp-chip is-${stranded ? 'bad' : (WP_TONE[state] ?? 'wait')}`}
          title={
            stale
              ? `The chain still records this as "${WP_LABEL[p.state] ?? p.state}". Its voting window closed ${isoDay(
                  wpTime(p.expiry),
                )}, and the row only flips to expired when someone next votes on it.`
              : `State on chain: ${p.state}`
          }
        >
          {stranded ? 'stranded' : (WP_LABEL[state] ?? state)}
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

        {stranded ? (
          <p className="dao-note dao-note--bad">
            No escrow left. <code>startwork</code> moved the pay into <code>escrw.worlds</code> and{' '}
            <code>finalize</code> is what releases it — but the escrow carries its own expiry, and once past it
            the treasury may take the money back. There is none here now, so finalize would be refused and
            nothing can move this proposal on.
          </p>
        ) : null}

        {buttons.length ? (
          <div className="wp-acts">
            {buttons.map((b) => (
              <button
                key={b.act}
                className={`btn btn--tiny${b.done ? ' is-done' : ''}`}
                type="button"
                disabled={!!b.blocked || !!busy}
                title={b.blocked ?? undefined}
                onClick={() => void act(b.act, b.label)}
              >
                {busy === b.act ? 'Signing…' : b.label}
              </button>
            ))}
          </div>
        ) : null}
        {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
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
        <span className="dao-dim">
          raised {isoDay(wpTime(p.created_at))} · {fmtDays(p.job_duration)} job
        </span>
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
