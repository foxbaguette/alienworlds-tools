import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Dao, DaoGroup } from '../chain/daos'
import { WATCHED } from '../chain/daos'
import { MSIG_OPEN, approvalCount, approvalsOf, isExpired, msigTitle, type MsigProposal } from '../chain/proposals'
import {
  approveAction,
  canApprove,
  canExecute,
  execAction,
  hasAction,
  isCancel,
  readableError,
  type ChainAction,
} from '../chain/act'
import {
  WP_LABEL,
  WP_TONE,
  hasWorkerProposals,
  wpEffectiveState,
  wpTally,
  wpTime,
  wpVotingOpen,
  type WorkerData,
  type WorkerProposal,
} from '../chain/worker'
import { EXPLORER, fmtAge, isoDay } from '../format'
import { useDaos } from '../useDaos'
import { ensureProposals, ensureWorker, proposalsOf, useProposalCaches, workerOf } from '../useProposals'
import { RefreshButton } from '../components/RefreshButton'
import { clearProposalCaches } from '../useProposals'
import { useSession } from '../../wallet/session'

/**
 * Every proposal in one group, newest first.
 *
 * The per-DAO tabs answer "what is waiting on this council". This answers the
 * other question — what has been happening across the whole group — which no
 * per-DAO view can, because it spans twelve scopes.
 *
 * On the unions it merges in the worker proposals from prop.worlds. They keep
 * their own badges rather than being flattened into msig's three states: a
 * different contract and a different state machine. What the two share is a
 * date and a council, which is what the list is ordered and grouped by.
 */
type Kind = 'all' | 'msig' | 'worker'
type Phase = 'active' | 'settled'

interface Row {
  kind: 'msig' | 'worker'
  dao: Dao
  id: string
  key: string
  title: string
  proposer: string
  when: number
  whenIs: string
  /** Still live, as against finished, expired or cancelled. */
  active: boolean
  msig?: MsigProposal
  worker?: WorkerProposal
  wp?: WorkerData
}

export default function AllProposals() {
  const { daos, loading } = useDaos()
  const version = useProposalCaches()
  const { session, actor } = useSession()
  const [group, setGroup] = useState<DaoGroup>('syndicate')
  const [kind, setKind] = useState<Kind>('all')
  const [phase, setPhase] = useState<Phase>('active')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const inGroup = daos.filter((d) => d.group === group)

  useEffect(() => {
    for (const dao of inGroup) {
      void ensureProposals(dao.id)
      if (hasWorkerProposals(dao)) void ensureWorker(dao.id)
    }
  }, [group, inGroup.length, version])

  /* Switching what is on screen must not leave a selection behind that is no
     longer visible — a button counting proposals you cannot see is a trap. */
  useEffect(() => setPicked(new Set()), [group, kind, phase, actor])

  const { rows, reading } = useMemo(() => {
    const out: Row[] = []
    let waiting = 0

    for (const dao of inGroup) {
      const props = proposalsOf(dao.id)
      if (props === undefined) waiting++
      for (const p of props ?? []) {
        out.push({
          kind: 'msig',
          dao,
          id: p.proposal_name,
          key: `${dao.id}/msig/${p.proposal_name}`,
          title: msigTitle(p),
          proposer: p.proposer,
          when: Date.parse(`${p.modified_date}Z`),
          whenIs: 'last activity — msigworlds records no creation time',
          active: p.state === MSIG_OPEN && !isExpired(p),
          msig: p,
        })
      }

      if (!hasWorkerProposals(dao)) continue
      const wp = workerOf(dao.id)
      if (wp === undefined) waiting++
      for (const p of wp?.props ?? []) {
        out.push({
          kind: 'worker',
          dao,
          id: p.proposal_id,
          key: `${dao.id}/worker/${p.proposal_id}`,
          title: p.title,
          proposer: p.proposer,
          when: wpTime(p.created_at),
          whenIs: 'created',
          active: wpVotingOpen(p),
          worker: p,
          wp: wp ?? undefined,
        })
      }
    }

    return { rows: out, reading: waiting }
  }, [inGroup, version])

  const counts = {
    msig: rows.filter((r) => r.kind === 'msig').length,
    worker: rows.filter((r) => r.kind === 'worker').length,
  }

  const shown = rows
    .filter((r) => (kind === 'all' || r.kind === kind) && (phase === 'active' ? r.active : !r.active))
    /* Newest first. An unparseable date sorts last rather than to the top,
       which is where NaN would otherwise put it. */
    .sort((a, b) => (Number.isFinite(b.when) ? b.when : -Infinity) - (Number.isFinite(a.when) ? a.when : -Infinity))

  /* What this account could actually do, per row. Worker proposals are left out
     of the batch: their actions are a different contract with a different
     signature, and rolling them in would make one button mean several things. */
  const actionable = shown.filter(
    (r) => r.kind === 'msig' && hasAction(r.msig!, r.dao, actor, approvalCount(r.msig!)),
  )
  const chosen = shown.filter((r) => picked.has(r.key))
  const toApprove = chosen.filter((r) => r.kind === 'msig' && canApprove(r.msig!, r.dao, actor))
  const toExec = chosen.filter(
    (r) => r.kind === 'msig' && canExecute(r.msig!, r.dao, approvalCount(r.msig!)),
  )

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const selectActionable = () =>
    setPicked((prev) => (prev.size === actionable.length ? new Set() : new Set(actionable.map((r) => r.key))))

  /**
   * One transaction for the lot.
   *
   * Approvals go in before executions on purpose: a proposal one signature short
   * can be approved and run in the same transaction, and the contract sees the
   * actions in order.
   */
  const submit = async (what: 'approve' | 'exec' | 'both') => {
    if (!session || busy) return
    const actions: ChainAction[] = []
    if (what !== 'exec') for (const r of toApprove) actions.push(approveAction(session, r.dao, r.msig!))
    if (what !== 'approve') for (const r of toExec) actions.push(execAction(session, r.dao, r.msig!))
    if (!actions.length) return

    setBusy(true)
    setNote({ text: `${actions.length} action${actions.length === 1 ? '' : 's'} — check your wallet…` })
    try {
      await session.transact({ actions }, { broadcast: true })
      setNote({ text: `Sent ${actions.length} action${actions.length === 1 ? '' : 's'}. Re-reading…` })
      /* The chain needs a moment to settle before a re-read shows the change. */
      await new Promise((r) => setTimeout(r, 2500))
      setPicked(new Set())
      clearProposalCaches()
      setNote({ text: 'Done.' })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('Proposal actions failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const unions = group === 'union'

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">All proposals</h1>
          <p className="page__lead">
            Everything raised across the {unions ? 'six unions' : 'six syndicates'}, newest first.{' '}
            {unions ? 'Council multisigs and worker proposals together.' : 'Council multisigs.'}
          </p>
        </div>
        <div className="page__actions">
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={!unions} onClick={() => setGroup('syndicate')}>
              Syndicates
            </button>
            <button type="button" role="tab" aria-selected={unions} onClick={() => setGroup('union')}>
              Unions
            </button>
          </div>
          <RefreshButton />
        </div>
      </header>

      <div className="page__actions">
        <div className="sections" role="tablist">
          <button type="button" role="tab" aria-selected={phase === 'active'} onClick={() => setPhase('active')}>
            Active
          </button>
          <button type="button" role="tab" aria-selected={phase === 'settled'} onClick={() => setPhase('settled')}>
            Settled
          </button>
        </div>

        {unions ? (
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={kind === 'all'} onClick={() => setKind('all')}>
              Everything {counts.msig + counts.worker || ''}
            </button>
            <button type="button" role="tab" aria-selected={kind === 'msig'} onClick={() => setKind('msig')}>
              Council {counts.msig || ''}
            </button>
            <button type="button" role="tab" aria-selected={kind === 'worker'} onClick={() => setKind('worker')}>
              Worker {counts.worker || ''}
            </button>
          </div>
        ) : null}
      </div>

      {session ? (
        <div className="batch">
          <button
            className="btn"
            type="button"
            onClick={selectActionable}
            disabled={!actionable.length}
            title="Everything here you hold a seat for and have not already signed, plus anything ready to run"
          >
            {picked.size === actionable.length && actionable.length
              ? 'Clear selection'
              : `Select what needs me (${actionable.length})`}
          </button>

          <button className="btn btn--go" type="button" onClick={() => void submit('both')} disabled={busy || !chosen.length}>
            {busy
              ? 'Signing…'
              : toApprove.length && toExec.length
                ? `Approve ${toApprove.length} and run ${toExec.length}`
                : toExec.length
                  ? `Run ${toExec.length}`
                  : `Approve ${toApprove.length}`}
          </button>

          <span className="batch__note">
            {chosen.length} selected
            {chosen.length && !toApprove.length && !toExec.length
              ? ' · nothing selected needs anything from this wallet'
              : ''}
          </span>

          {note ? <span className={`batch__msg${note.bad ? ' is-bad' : ''}`}>{note.text}</span> : null}
        </div>
      ) : null}

      <section className="section">
        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                {session ? <th className="tick" /> : null}
                <th className="num">Date</th>
                <th>Council</th>
                <th>Proposal</th>
                <th>State</th>
                <th className="num">Approvals</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                /* Dimmed when this wallet cannot act on it — most often because
                   it holds no seat on that council. Signed out, nothing is
                   dimmed: there is no "you" to be unable to act. */
                const mine = !actor || (r.kind === 'msig' && hasAction(r.msig!, r.dao, actor, approvalCount(r.msig!)))
                const seat = !actor || r.dao.custodians.includes(actor)
                return (
                  <tr key={r.key} className={`${mine ? '' : 'is-dim'}${picked.has(r.key) ? ' is-picked' : ''}`}>
                    {session ? (
                      <td className="tick">
                        {r.kind === 'msig' && r.active ? (
                          <input
                            type="checkbox"
                            checked={picked.has(r.key)}
                            onChange={() => toggle(r.key)}
                            aria-label={`Select ${r.title}`}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td className="num wp-when" title={r.whenIs}>
                      {Number.isFinite(r.when) ? isoDay(r.when) : '—'}
                      <span className="dao-dim">
                        {Number.isFinite(r.when) ? `${fmtAge(Date.now() - r.when)} ago` : ''}
                      </span>
                    </td>
                    <td className="wp-when">
                      <Link to={`/daos/${r.dao.id}`}>{r.dao.title}</Link>
                      <span className="dao-dim">
                        {r.kind === 'worker' ? 'worker' : 'council'}
                        {actor && !seat ? ' · no seat' : ''}
                      </span>
                    </td>
                    <td>
                      <b className="dao-rowtitle">{r.title}</b>
                      <span className="dao-rowmeta">
                        <a
                          className={`dao-who${WATCHED.has(r.proposer) ? ' is-watched' : ''}`}
                          href={`${EXPLORER}${encodeURIComponent(r.proposer)}`}
                          target="_blank"
                          rel="noopener"
                        >
                          {r.proposer}
                        </a>
                        <span className="dao-rowid">{r.id}</span>
                      </span>
                    </td>
                    <td>
                      <StateCell row={r} />
                    </td>
                    <td className="num">
                      <ApprovalCell row={r} actor={actor} />
                    </td>
                  </tr>
                )
              })}
              {!shown.length ? (
                <tr>
                  <td colSpan={session ? 6 : 5} className="dao-dim">
                    {loading || reading ? 'Reading…' : `Nothing ${phase} in this group.`}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {reading ? <p className="dao-note">Reading {reading} more…</p> : null}
      </section>
    </div>
  )
}

/** Each kind in its own vocabulary — they are genuinely different states. */
function StateCell({ row }: { row: Row }) {
  if (row.kind === 'worker' && row.worker) {
    const state = wpEffectiveState(row.worker)
    return <span className={`wp-chip is-${WP_TONE[state] ?? 'wait'}`}>{WP_LABEL[state] ?? state}</span>
  }
  const p = row.msig!
  const expired = p.state === MSIG_OPEN && isExpired(p)
  const label = expired ? 'expired' : p.state === MSIG_OPEN ? 'open' : p.state === 1 ? 'executed' : 'cancelled'
  const tone = expired ? 'dead' : p.state === MSIG_OPEN ? 'wait' : p.state === 1 ? 'done' : 'bad'
  return <span className={`wp-chip is-${tone}`}>{label}</span>
}

function ApprovalCell({ row, actor }: { row: Row; actor: string | null }) {
  if (row.kind === 'worker' && row.worker && row.wp) {
    const t = wpTally(row.dao, row.worker, row.wp)
    return (
      <span title={`${t.yes} of ${t.need} in the ${t.round} round`}>
        <b className={t.yes >= t.need && wpVotingOpen(row.worker) ? 'is-enough' : undefined}>{t.yes}</b>
        <span className="dao-dim">/{t.need}</span>
      </span>
    )
  }
  const p = row.msig!
  const need = row.dao.approvalThreshold
  const signers = approvalsOf(p)
    .map((a) => a.level?.actor)
    .filter(Boolean) as string[]
  const got = signers.length
  const signed = !!actor && signers.includes(actor)
  return (
    <span title={signers.length ? `Signed by ${signers.join(', ')}` : 'Nobody has signed yet'}>
      <b className={got >= need ? 'is-enough' : undefined}>{got}</b>
      <span className="dao-dim">
        /{need}
        {signed ? ' · you' : ''}
      </span>
    </span>
  )
}
