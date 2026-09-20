import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Dao, DaoGroup } from '../chain/daos'
import { WATCHED } from '../chain/daos'
import { MSIG_OPEN, approvalCount, approvalsOf, isExpired, msigTitle, type MsigProposal } from '../chain/proposals'
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

interface Row {
  kind: 'msig' | 'worker'
  dao: Dao
  id: string
  title: string
  proposer: string
  when: number
  whenIs: string
  msig?: MsigProposal
  worker?: WorkerProposal
  wp?: WorkerData
}

export default function AllProposals() {
  const { daos, loading } = useDaos()
  const version = useProposalCaches()
  const [group, setGroup] = useState<DaoGroup>('syndicate')
  const [kind, setKind] = useState<Kind>('all')

  const inGroup = daos.filter((d) => d.group === group)

  /* Both contracts, for every DAO in the group. `ensure` is a no-op once a
     cache is warm, so switching back and forth costs nothing. */
  useEffect(() => {
    for (const dao of inGroup) {
      void ensureProposals(dao.id)
      if (hasWorkerProposals(dao)) void ensureWorker(dao.id)
    }
  }, [group, inGroup.length, version])

  const rows: Row[] = []
  let reading = 0

  for (const dao of inGroup) {
    const props = proposalsOf(dao.id)
    if (props === undefined) reading++
    for (const p of props ?? []) {
      rows.push({
        kind: 'msig',
        dao,
        id: p.proposal_name,
        title: msigTitle(p),
        proposer: p.proposer,
        when: Date.parse(`${p.modified_date}Z`),
        whenIs: 'last activity — msigworlds records no creation time',
        msig: p,
      })
    }

    if (!hasWorkerProposals(dao)) continue
    const wp = workerOf(dao.id)
    if (wp === undefined) reading++
    for (const p of wp?.props ?? []) {
      rows.push({
        kind: 'worker',
        dao,
        id: p.proposal_id,
        title: p.title,
        proposer: p.proposer,
        when: wpTime(p.created_at),
        whenIs: 'created',
        worker: p,
        wp: wp ?? undefined,
      })
    }
  }

  const counts = {
    msig: rows.filter((r) => r.kind === 'msig').length,
    worker: rows.filter((r) => r.kind === 'worker').length,
  }

  const shown = rows
    .filter((r) => kind === 'all' || r.kind === kind)
    /* Newest first. An unparseable date sorts last rather than to the top,
       which is where NaN would otherwise put it. */
    .sort((a, b) => (Number.isFinite(b.when) ? b.when : -Infinity) - (Number.isFinite(a.when) ? a.when : -Infinity))

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
          <div className="sections dao-tabs" role="tablist">
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

      {unions ? (
        <div className="sections dao-tabs dao-tabs--sm" role="tablist">
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

      <section className="section">
        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                <th className="num">Date</th>
                <th>Council</th>
                <th>Proposal</th>
                <th>State</th>
                <th className="num">Approvals</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.dao.id}/${r.kind}/${r.id}`}>
                  <td className="num wp-when" title={r.whenIs}>
                    {Number.isFinite(r.when) ? isoDay(r.when) : '—'}
                    <span className="dao-dim">
                      {Number.isFinite(r.when) ? `${fmtAge(Date.now() - r.when)} ago` : ''}
                    </span>
                  </td>
                  <td className="wp-when">
                    <Link to={`/daos/${r.dao.id}`}>{r.dao.title}</Link>
                    <span className="dao-dim">{r.kind === 'worker' ? 'worker' : 'council'}</span>
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
                    <ApprovalCell row={r} />
                  </td>
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={5} className="dao-dim">
                    {loading || reading ? 'Reading…' : 'No proposals found in this group.'}
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

function ApprovalCell({ row }: { row: Row }) {
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
  const got = approvalCount(p)
  const who = approvalsOf(p)
    .map((a) => a.level?.actor)
    .filter(Boolean)
    .join(', ')
  return (
    <span title={who ? `Signed by ${who}` : 'Nobody has signed yet'}>
      <b className={got >= need ? 'is-enough' : undefined}>{got}</b>
      <span className="dao-dim">/{need}</span>
    </span>
  )
}
