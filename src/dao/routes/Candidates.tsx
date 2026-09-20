import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchHoldings, type Holdings } from '../chain/holdings'
import { WATCHED, type Dao } from '../chain/daos'
import { EXPLORER, decayedPower, fmtPower, rawPower } from '../format'
import { McTag } from '../components/Tags'
import { useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'

/**
 * Everyone standing for a council, and what they hold.
 *
 * A candidate's vote power is what OTHER people have put behind them. This page
 * asks the other question — what they hold themselves — because the two come
 * apart: a candidate with a large slate and no stake of their own is a
 * different proposition from one with both.
 *
 * Holdings are the total held, staked included. `accounts` is scoped by the
 * holder, so one read per account brings back every planetary token at once;
 * fifty-odd candidates is about a hundred reads, which the node pool paces.
 *
 * Standing candidates only, by default. Every council keeps its withdrawn ones
 * on the table forever — four hundred rows across the twelve — and reading
 * holdings for all of them would cost eight hundred reads to list people who
 * are not asking for a seat.
 */
type SortKey = 'name' | 'power' | 'tlm' | string

export default function Candidates() {
  const { daos, loading } = useDaos()
  const [holdings, setHoldings] = useState<Map<string, Holdings>>(new Map())
  const [reading, setReading] = useState(false)
  const [where, setWhere] = useState<string>('all')
  const [standing, setStanding] = useState(true)
  const [sort, setSort] = useState<SortKey>('power')
  const [desc, setDesc] = useState(true)

  /** Every council a candidate is standing in, keyed by candidate. */
  const entries = useMemo(() => {
    const byName = new Map<string, { name: string; daos: Dao[]; power: number; own: number; seats: string[] }>()
    for (const dao of daos) {
      if (where !== 'all' && dao.id !== where) continue
      for (const c of dao.candidates) {
        if (standing && !c.is_active) continue
        const got = byName.get(c.candidate_name) ?? {
          name: c.candidate_name,
          daos: [],
          power: 0,
          own: 0,
          seats: [],
        }
        got.daos.push(dao)
        /* Summed across councils, and both figures kept: the support behind
           them, and how much of it the chain still counts today. */
        got.own += rawPower(c.total_vote_power, dao.precision)
        got.power += decayedPower(c.rank, dao.precision)
        if (dao.custodians.includes(c.candidate_name)) got.seats.push(dao.title)
        byName.set(c.candidate_name, got)
      }
    }
    return [...byName.values()]
  }, [daos, where, standing])

  /* The token columns, in directory order so the six planets stay paired with
     their unions rather than sorting alphabetically into a mess. */
  const columns = useMemo(
    () => [...new Set(daos.filter((d) => (where === 'all' ? true : d.id === where)).map((d) => d.symbol))],
    [daos, where],
  )

  const names = entries.map((e) => e.name).join(',')
  useEffect(() => {
    if (!entries.length) return
    let alive = true
    setReading(true)
    const contracts = daos.map((d) => d.tokenContract).filter((c): c is string => !!c)
    void fetchHoldings(
      entries.map((e) => e.name),
      contracts,
    )
      .then((h) => {
        if (!alive) return
        setHoldings(h)
        setReading(false)
      })
      .catch((err: unknown) => {
        console.error('candidate holdings:', err)
        if (alive) setReading(false)
      })
    return () => {
      alive = false
    }
  }, [names])

  const valueOf = (e: (typeof entries)[number], key: SortKey): number | string => {
    if (key === 'name') return e.name
    if (key === 'power') return e.own
    if (key === 'tlm') return holdings.get(e.name)?.tlm ?? -1
    return holdings.get(e.name)?.tokens.get(key) ?? -1
  }

  const rows = [...entries].sort((a, b) => {
    const x = valueOf(a, sort)
    const y = valueOf(b, sort)
    const cmp = typeof x === 'string' ? String(x).localeCompare(String(y)) : Number(x) - Number(y)
    return desc ? -cmp : cmp
  })

  const head = (key: SortKey, label: string, numeric = true) => (
    <th
      key={key}
      className={`${numeric ? 'num ' : ''}cand-th${sort === key ? ' is-sorted' : ''}`}
      onClick={() => {
        if (sort === key) setDesc(!desc)
        else {
          setSort(key)
          setDesc(key !== 'name')
        }
      }}
      title={`Sort by ${label}`}
    >
      {label}
      {sort === key ? <i>{desc ? '▾' : '▴'}</i> : null}
    </th>
  )

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Candidates</h1>
          <p className="page__lead">
            Everyone standing for a council, and what they hold themselves — Trilium and every planetary
            governance token. Balances are the total held, staked included. Click a column to sort.
          </p>
        </div>
        <div className="page__actions">
          <RefreshButton />
        </div>
      </header>

      <section className="section">
        <div className="page__actions">
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={where === 'all'} onClick={() => setWhere('all')}>
              Every council
            </button>
            {daos.map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={where === d.id}
                onClick={() => setWhere(d.id)}
              >
                {d.title}
              </button>
            ))}
          </div>
          <label className="pause-chip">
            <input type="checkbox" checked={standing} onChange={() => setStanding(!standing)} />
            <span>Standing only</span>
          </label>
        </div>

        <h2 className="dao-h2">
          {loading && !entries.length ? 'Reading the directory…' : `${rows.length} candidate${rows.length === 1 ? '' : 's'}`}{' '}
          <span className="dao-dim">{reading ? 'reading holdings…' : ''}</span>
        </h2>

        <div className="dao-tablewrap">
          <table className="dao-table cand-table">
            <thead>
              <tr>
                {head('name', 'Candidate', false)}
                <th>Standing in</th>
                {head('power', 'Vote power')}
                {head('tlm', 'TLM')}
                {columns.map((c) => head(c, c))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const h = holdings.get(e.name)
                return (
                  <tr key={e.name}>
                    <td>
                      <a
                        className={WATCHED.has(e.name) ? 'is-watched' : undefined}
                        href={`${EXPLORER}${encodeURIComponent(e.name)}`}
                        target="_blank"
                        rel="noopener"
                      >
                        {e.name}
                      </a>
                      <McTag name={e.name} />
                      {e.seats.length ? (
                        <span className="tag tag--in" title={`Seated on ${e.seats.join(', ')}`}>
                          {e.seats.length === 1 ? 'custodian' : `custodian ×${e.seats.length}`}
                        </span>
                      ) : null}
                    </td>
                    <td className="cand-where">
                      {e.daos.map((d) => (
                        <Link key={d.id} to={`/daos/${d.id}`} title={d.title}>
                          {d.symbol}
                        </Link>
                      ))}
                    </td>
                    <td
                      className="num"
                      title={`${fmtPower(e.own)} voted onto them. The chain counts ${fmtPower(e.power)} of it today — votes halve every 30 days of age.`}
                    >
                      {fmtPower(e.own)}
                    </td>
                    <td className="num">{h ? fmtPower(h.tlm) : '…'}</td>
                    {columns.map((c) => {
                      const v = h?.tokens.get(c) ?? 0
                      return (
                        <td key={c} className={`num${v ? '' : ' dao-dim'}`}>
                          {h ? (v ? fmtPower(v) : '—') : '…'}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {!rows.length && !loading ? (
                <tr>
                  <td colSpan={4 + columns.length} className="dao-dim">
                    No candidates.
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
