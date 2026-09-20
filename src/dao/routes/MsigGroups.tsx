import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  durationDays,
  fetchAllocations,
  fetchAllocators,
  fetchPointsConfig,
  fundingShare,
  points,
  shards,
  spendOf,
  type Allocation,
  type Allocator,
  type PointsConfig,
} from '../chain/allocators'
import { start } from '../chain/nodes'
import { EXPLORER, fmtAge, isoDay } from '../format'

/**
 * Point allocators, loaded once and shared between the list and the details.
 *
 * Shares are apportioned across ALL allocators, so a details page cannot work
 * from its own allocator alone — it needs every allocator's allocations to know
 * what fraction of a recipient's funding this one provides.
 */
interface Store {
  allocators: Allocator[]
  allocations: Map<string, Allocation[]>
  loading: boolean
  error: string | null
}

let store: Store = { allocators: [], allocations: new Map(), loading: false, error: null }
let inFlight: Promise<void> | null = null
const listeners = new Set<(s: Store) => void>()

function publish(next: Partial<Store>) {
  store = { ...store, ...next }
  for (const fn of listeners) fn(store)
}

function load(): Promise<void> {
  if (inFlight) return inFlight
  if (store.allocators.length) return Promise.resolve()

  publish({ loading: true, error: null })
  inFlight = (async () => {
    if (!(await start())) throw new Error('No WAX node answered.')
    const allocators = await fetchAllocators()
    publish({ allocators })
    const pairs = await Promise.all(
      allocators.map(async (a) => [a.allocator, await fetchAllocations(a.allocator).catch(() => [])] as const),
    )
    publish({ allocations: new Map(pairs), loading: false })
  })()
    .catch((err: unknown) => {
      console.error('Could not read the allocators:', err)
      publish({ loading: false, error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

function useAllocators() {
  const [state, setState] = useState(store)
  useEffect(() => {
    listeners.add(setState)
    void load()
    return () => {
      listeners.delete(setState)
    }
  }, [])
  return state
}

/* ---------- the list ---------- */

export default function MsigGroups() {
  const { allocators, loading, error } = useAllocators()

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
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      <div className="dao-grid">
        {allocators.map((a) => {
          const budget = Number(a.budget)
          const used = Number(a.allocated)
          const left = budget - used
          const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0
          return (
            <article key={a.allocator} className="dao-card">
              <div className="dao-card__top">
                <h2>
                  <Link to={`/msig/${a.allocator}`}>{a.allocator}</Link>
                </h2>
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

/* ---------- one allocator ---------- */

export function MsigGroupDetails() {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  const { allocators, allocations, loading, error } = useAllocators()
  const [configs, setConfigs] = useState<Map<string, PointsConfig | null>>(new Map())

  const rows = allocations.get(name) ?? []

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

      <section className="section">
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
