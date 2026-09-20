import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  durationDays,
  fetchPointsConfig,
  fundingShare,
  points,
  shards,
  spendOf,
  type Allocation,
  type PointsConfig,
} from '../chain/allocators'
import {
  ALLOC_OPS,
  PERIOD_MAX_DAYS,
  PERIOD_MIN_DAYS,
  budgetProposal,
  councilSigners,
  type AllocOp,
} from '../chain/budgets'
import { isCancel, readableError } from '../chain/act'
import { EXPLORER, fmtAge, isoDay } from '../format'
import { useAllocators, type Signers } from '../useAllocators'
import { useDaos } from '../useDaos'
import { useSession } from '../../wallet/session'

/* ---------- the list ---------- */

export default function MsigGroups() {
  const { allocators, signers, loading, error, refresh } = useAllocators()

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">MSIG groups</h1>
          <p className="page__lead">
            Point allocators on <code>ptpxy.worlds</code>. Each one is a multisig account holding a budget and
            handing daily allowances to recipients. Figures here cover a thirty-day period.
          </p>
        </div>
        <button className="btn" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      <div className="dao-grid">
        {allocators.map((a) => {
          const budget = Number(a.budget)
          const used = Number(a.allocated)
          const left = budget - used
          const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0
          const sign = signers.get(a.allocator)
          return (
            <article key={a.allocator} className="dao-card">
              <div className="dao-card__top">
                <h2>
                  <Link to={`/msig/${a.allocator}`}>{a.allocator}</Link>
                </h2>
                {sign ? (
                  <span className="chip" title={`${sign.threshold} of ${sign.members.length} must sign`}>
                    {sign.threshold} of {sign.members.length}
                  </span>
                ) : null}
              </div>
              <p className="dao-card__meta">
                <span className="dao-card__id">point allocator</span>
              </p>

              <dl className="alloc-figs">
                <div>
                  <dt>Budget</dt>
                  <dd>{shards(a.budget)}</dd>
                </div>
                <div>
                  <dt>Allocated</dt>
                  <dd className={used > budget ? 'is-over' : undefined}>{shards(a.allocated)}</dd>
                </div>
                <div>
                  <dt>Unallocated</dt>
                  <dd className={left < 0 ? 'is-over' : undefined}>{shards(left)}</dd>
                </div>
              </dl>

              <div className="bar" title={`${Math.round(pct)}% of the budget is allocated`}>
                <span style={{ width: `${pct}%` }} className={used > budget ? 'is-over' : undefined} />
              </div>

              {sign ? <SignerList signers={sign} compact /> : null}

              <div className="dao-card__foot">
                <Link className="btn" to={`/msig/${a.allocator}`}>
                  Allocations
                </Link>
              </div>
            </article>
          )
        })}
      </div>

      {!allocators.length && loading ? <p className="dao-note">Reading allocators…</p> : null}
    </div>
  )
}

/**
 * Who signs for this group, and how many of them it takes.
 *
 * Weights are shown only when one is not 1: a threshold of 3 over weights of
 * 2 and 1 is two signatures, not three, and printing ":1" against every member
 * the rest of the time is noise for a case that does not arise.
 */
function SignerList({ signers, compact }: { signers: Signers; compact?: boolean }) {
  const { actor } = useSession()
  const weighted = signers.members.some((m) => m.weight !== 1)

  return (
    <div className={`signers${compact ? ' signers--compact' : ''}`}>
      <span className="signers__head">
        {signers.threshold} of {signers.members.length} must sign
      </span>
      <ul>
        {signers.members.map((m) => (
          <li key={`${m.actor}@${m.permission}`} className={m.actor === actor ? 'is-me' : undefined}>
            <a href={`${EXPLORER}${encodeURIComponent(m.actor)}`} target="_blank" rel="noopener">
              {m.actor}
            </a>
            {m.permission !== 'active' ? <span className="dao-dim">@{m.permission}</span> : null}
            {weighted ? <span className="dao-dim">×{m.weight}</span> : null}
            {m.actor === actor ? <span className="tag tag--vote">you</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------- one allocator ---------- */

export function MsigGroupDetails() {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  const { allocators, allocations, signers, loading, error } = useAllocators()
  const [configs, setConfigs] = useState<Map<string, PointsConfig | null>>(new Map())

  const rows = allocations.get(name) ?? []
  const sign = signers.get(name)

  /* Each recipient's own pointsconfig. Only the ones this allocator funds, and
     only once — the map is keyed by recipient, not by allocator. */
  useEffect(() => {
    let alive = true
    const wanted = [...new Set(rows.map((r) => r.account))]
    if (!wanted.length) return
    void Promise.all(
      wanted.map(async (account) => [account, await fetchPointsConfig(account).catch(() => null)] as const),
    ).then((pairs) => alive && setConfigs(new Map(pairs)))
    return () => {
      alive = false
    }
  }, [name, rows.length])

  if (!loading && !allocators.some((a) => a.allocator === name)) {
    return (
      <div className="page">
        <p className="dao-note">{error ?? `No allocator called “${name}”.`}</p>
        <Link className="btn" to="/msig">
          All MSIG groups
        </Link>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <button className="dao-back" type="button" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <h1 className="page__title">{name}</h1>
          <p className="page__lead">
            {rows.length} allocation{rows.length === 1 ? '' : 's'} · figures are this allocator&rsquo;s share unless it
            is the recipient&rsquo;s only funder
          </p>
        </div>
      </header>

      {sign ? (
        <section className="section">
          <h2 className="dao-h2">Who signs</h2>
          <SignerList signers={sign} />
          <p className="dao-dim">
            Changing a budget here needs <b>{sign.threshold}</b> of these {sign.members.length} signatures, collected
            as a multisig proposal against <code>{name}</code>&rsquo;s active permission.
          </p>
        </section>
      ) : null}

      <BudgetActions name={name} signers={sign ?? null} rows={rows} configs={configs} />

      <section className="section">
        <h2 className="dao-h2">Allocations</h2>
        <div className="dao-tablewrap">
          <table className="dao-table is-roomy">
            <thead>
              <tr>
                <th>Recipient</th>
                <th className="num">Per day</th>
                <th className="num">Period spent</th>
                <th className="num">Period budget</th>
                <th className="num">Period ends</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cfg = configs.get(r.account)
                const { share, only } = fundingShare(r.account, name, allocators, allocations)
                const spend = cfg ? spendOf(cfg, share, only) : null
                const ends = cfg?.period_end ? Date.parse(`${cfg.period_end}Z`) : NaN
                const lapsed = Number.isFinite(ends) && ends < Date.now()
                const days = durationDays(cfg?.period_duration) ?? 30

                return (
                  <tr key={r.account}>
                    <td>
                      <a href={`${EXPLORER}${encodeURIComponent(r.account)}`} target="_blank" rel="noopener">
                        {r.account}
                      </a>
                      {cfg?.debug ? (
                        <span className="tag tag--bad" title="This recipient is in debug mode, not live">
                          debug
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{points(r.allocated)}</td>
                    <td className="num">
                      {spend ? points(spend.spent) : '—'}
                      {spend && spend.budget > 0 ? (
                        <div
                          className="bar bar--sm"
                          title={`${Math.round(spend.pct)}% of the period budget${
                            spend.exact ? '' : ', apportioned by this allocator’s share of the funding'
                          }`}
                        >
                          <span
                            style={{ width: `${Math.min(100, spend.pct)}%` }}
                            className={spend.pct > 100 ? 'is-over' : undefined}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{spend ? points(spend.budget) : '—'}</td>
                    <td className={`num${lapsed ? ' is-lapsed' : ''}`}>
                      {Number.isFinite(ends)
                        ? lapsed
                          ? `${fmtAge(Date.now() - ends)} ago`
                          : `in ${fmtAge(ends - Date.now())}`
                        : '—'}
                      <span className="dao-dim">
                        {Number.isFinite(ends) ? isoDay(ends) : ''} · {days}d period
                      </span>
                    </td>
                  </tr>
                )
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={5} className="dao-dim">
                    {loading ? 'Reading…' : 'No allocations.'}
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
 * Moving a budget.
 *
 * None of this can be signed directly: the three actions all need the
 * ALLOCATOR's authority, and an allocator is a multisig account. So the button
 * raises a proposal on `eosio.msig` for its signers to approve — and, where a
 * signer is itself a DAO, a council proposal carrying that DAO's approval, in
 * the same transaction. See budgets.ts.
 */
function BudgetActions({
  name,
  signers,
  rows,
  configs,
}: {
  name: string
  signers: Signers | null
  rows: Allocation[]
  configs: Map<string, PointsConfig | null>
}) {
  const { session, actor } = useSession()
  const { daos } = useDaos()
  const { refresh } = useAllocators()
  const [op, setOp] = useState<AllocOp | null>(null)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const councils = councilSigners(signers, daos, actor)
  const current = rows.find((r) => r.account === to)
  const period = durationDays(configs.get(to)?.period_duration) ?? 30

  const open = (next: AllocOp) => {
    setOp(next)
    setNote(null)
    /* An increase or a decrease is always ABOUT an existing allocation, so it
       starts on one; a new one starts empty, because naming an account that
       already has an allocation is the one thing setbudget refuses. */
    setTo(next === 'new' ? '' : (rows[0]?.account ?? ''))
    setAmount('')
  }

  const submit = async () => {
    if (!session || !signers || busy || !op) return
    const value = Number(String(amount).replace(/,/g, ''))
    if (!Number.isFinite(value) || value <= 0) return setNote({ text: 'Enter an amount above zero.', bad: true })
    if (!to.trim()) return setNote({ text: 'Name the recipient account.', bad: true })
    const n = Math.round(Number(days))
    if (op === 'new' && (!Number.isFinite(n) || n < PERIOD_MIN_DAYS || n > PERIOD_MAX_DAYS)) {
      return setNote({ text: `The contract only accepts a period of ${PERIOD_MIN_DAYS} to ${PERIOD_MAX_DAYS} days.`, bad: true })
    }

    setBusy(true)
    setNote({ text: 'Building the proposal — check your wallet…' })
    try {
      const level = {
        actor: String(session.actor),
        permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
      }
      const actions = await budgetProposal(level, name, signers, { op, to: to.trim(), amount: value, days: n }, councils.mine)
      await session.transact({ actions }, { broadcast: true })
      setOp(null)
      await refresh()
      setNote({
        text:
          `Proposed. ${signers.threshold} of ${signers.members.length} signatures release it` +
          (councils.mine.length
            ? `, and ${councils.mine.length} council proposal${councils.mine.length === 1 ? '' : 's'} went out with it.`
            : '.'),
      })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('budget proposal failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section">
      <h2 className="dao-h2">Move a budget</h2>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      <div className="page__actions">
        {(Object.keys(ALLOC_OPS) as AllocOp[]).map((k) => (
          <button
            key={k}
            className={`btn${op === k ? ' btn--go' : ''}`}
            type="button"
            disabled={!session || !signers || busy}
            onClick={() => (op === k ? setOp(null) : open(k))}
          >
            {ALLOC_OPS[k].verb}
          </button>
        ))}
        <span className="dao-dim">
          {!session
            ? 'Connect a wallet to raise a proposal.'
            : !signers
              ? 'Reading who has to sign…'
              : `Every change is a proposal — ${signers.threshold} of ${signers.members.length} signatures release it.`}
        </span>
      </div>

      {op && signers ? (
        <div className="tap-form">
          <p className="dao-dim">{ALLOC_OPS[op].blurb}</p>

          <div className="ale-form">
            <label className="ale-field">
              <span className="ale-field__name">
                Recipient<i>{op === 'new' ? 'an account with no allocation yet' : 'one this allocator already funds'}</i>
              </span>
              {op === 'new' ? (
                <input type="text" value={to} placeholder="theminergame" onChange={(e) => setTo(e.target.value.trim())} />
              ) : (
                <select value={to} onChange={(e) => setTo(e.target.value)}>
                  {rows.map((r) => (
                    <option key={r.account} value={r.account}>
                      {r.account}
                    </option>
                  ))}
                </select>
              )}
            </label>

            <label className="ale-field">
              <span className="ale-field__name">
                Amount for the period<i>at face value, as shown on this page</i>
              </span>
              <input type="text" inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
            </label>

            {op === 'new' ? (
              <label className="ale-field">
                <span className="ale-field__name">
                  Period length<i>{PERIOD_MIN_DAYS} to {PERIOD_MAX_DAYS} days</i>
                </span>
                <input type="number" min={PERIOD_MIN_DAYS} max={PERIOD_MAX_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
              </label>
            ) : null}
          </div>

          <p className="dao-dim">
            Every figure in this contract is held at ten times face value, so what you type is multiplied by ten
            before it is sent.
            {op !== 'new' && current ? (
              <>
                {' '}
                <code>{current.account}</code> currently gets{' '}
                <b>{points(Number(current.allocated) * period)}</b> per {period}-day period.
              </>
            ) : null}
          </p>

          {councils.mine.length || councils.others.length ? (
            <p className="dao-note">
              {councils.mine.length + councils.others.length} of these signers are DAOs and cannot approve
              directly — each needs a proposal on its own council, and <code>msig.worlds</code> only accepts one
              from a seated custodian.{' '}
              {councils.mine.length
                ? `This raises ${councils.mine.length} of them, on ${councils.mine.map((d) => d.title).join(', ')} — ${councils.mine.length + 1} proposals in one transaction.`
                : 'You sit on none of them.'}{' '}
              {councils.others.length
                ? `${councils.others.map((d) => d.title).join(', ')} you do not sit on, so a custodian there has to raise those.`
                : ''}
            </p>
          ) : null}

          <div className="page__actions">
            <button className="btn btn--go" type="button" disabled={busy} onClick={submit}>
              {busy ? 'Signing…' : 'Create proposal'}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setOp(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
