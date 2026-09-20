import { useMemo, useState } from 'react'
import { formatNumber } from '@/format'

/** One player's share of what a game paid out in a period. */
export interface RecipientRow {
  wallet: string
  received: number
  /** Entry fees the player paid in, for a game that takes them. */
  fees?: number
  /** Days in the period the player was paid anything. */
  days: number
}

type SortKey = 'player' | 'received' | 'fees' | 'net' | 'share' | 'days'

const PAGE = 100

/**
 * Who received a token, and how much — opened from its "paid out" tile.
 *
 * Sortable by every column and searchable by name or wallet. Where players
 * also paid entry fees, what they paid in and what they came out with stand
 * beside what they received, so a large payout that was mostly their own
 * money coming back reads as that.
 */
export function Recipients({
  symbol,
  rows,
  tags,
  rangeLabel,
  format,
  onClose,
}: {
  symbol: string
  /** null while it loads. */
  rows: RecipientRow[] | null
  tags: Record<string, string>
  rangeLabel: string
  format: (v: number) => string
  onClose: () => void
}) {
  const withFees = !!rows?.some((r) => r.fees)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'received', desc: true })
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)

  const total = (rows ?? []).reduce((n, r) => n + r.received, 0)
  const feesTotal = (rows ?? []).reduce((n, r) => n + (r.fees ?? 0), 0)

  const list = useMemo(() => {
    const name = (w: string) => tags[w] ?? w
    const value = (r: RecipientRow, key: SortKey): number | string =>
      key === 'player'
        ? name(r.wallet).toLowerCase()
        : key === 'fees'
          ? (r.fees ?? 0)
          : key === 'net'
            ? r.received - (r.fees ?? 0)
            : key === 'share'
              ? r.received
              : r[key]
    const q = query.trim().toLowerCase()
    const found = q
      ? (rows ?? []).filter((r) => r.wallet.includes(q) || (tags[r.wallet] ?? '').toLowerCase().includes(q))
      : (rows ?? [])
    return [...found].sort((a, b) => {
      const x = value(a, sort.key)
      const y = value(b, sort.key)
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)
      return (sort.desc ? -c : c) || a.wallet.localeCompare(b.wallet)
    })
  }, [rows, sort, query, tags])

  const columns: { key: SortKey; label: string; num?: boolean }[] = [
    { key: 'player', label: 'Player' },
    { key: 'received', label: `${symbol} received`, num: true },
    ...(withFees
      ? [
          { key: 'fees' as const, label: 'Entry fees paid in', num: true },
          { key: 'net' as const, label: 'Net', num: true },
        ]
      : []),
    { key: 'share', label: 'Share', num: true },
    { key: 'days', label: 'Days paid', num: true },
  ]
  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'player' }))
  const visible = all ? list : list.slice(0, PAGE)

  return (
    <div className="card recipients">
      <div className="recipients__head">
        <div>
          <h3 className="card__title">Who received {symbol}</h3>
          <p className="faint recipients__sum">
            {rows
              ? `${formatNumber(rows.length)} players received ${format(total)} ${symbol} in the last ${rangeLabel}` +
                (withFees ? `, and paid ${format(feesTotal)} ${symbol} in entry fees.` : '.')
              : 'Loading…'}
          </p>
        </div>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      {rows && rows.length > 0 && (
        <>
          <div className="recipients__toolbar">
            <input
              className="input"
              type="search"
              placeholder="Search by name or wallet"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search players"
            />
            {query && (
              <span className="faint">
                {formatNumber(list.length)} of {formatNumber(rows.length)} players
              </span>
            )}
          </div>
          <div className="table-wrap">
            <table className="table table--sortable">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={c.num ? 'r' : undefined}
                      aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                    >
                      <button type="button" onClick={() => sortBy(c.key)}>
                        {c.label}
                        <span className="sortmark" aria-hidden="true">
                          {sort.key === c.key ? (sort.desc ? '▼' : '▲') : ''}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const net = r.received - (r.fees ?? 0)
                  return (
                    <tr key={r.wallet}>
                      <td>
                        <span className="pwho">
                          <strong>{tags[r.wallet] ?? r.wallet}</strong>
                          {tags[r.wallet] && <span className="faint mono">{r.wallet}</span>}
                        </span>
                      </td>
                      <td className="r">{format(r.received)}</td>
                      {withFees && <td className="r">{r.fees ? format(r.fees) : '—'}</td>}
                      {withFees && (
                        <td className={`r ${net < 0 ? 'is-down' : ''}`}>
                          {net < 0 ? '−' : ''}
                          {format(Math.abs(net))}
                        </td>
                      )}
                      <td className="r">{total ? `${((r.received / total) * 100).toFixed(1)}%` : '—'}</td>
                      <td className="r">{formatNumber(r.days)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!all && list.length > PAGE && (
            <button type="button" className="btn recipients__more" onClick={() => setAll(true)}>
              Show all {formatNumber(list.length)} players
            </button>
          )}
        </>
      )}
      {rows && rows.length === 0 && <p className="faint">Nobody received {symbol} in this period.</p>}
    </div>
  )
}
