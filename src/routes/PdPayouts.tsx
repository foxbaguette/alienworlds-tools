import { useEffect, useMemo, useState } from 'react'
import { fetchMcMembers, fetchProjectFile, type McMember } from '@/projects/queries'
import type { ProjectDay } from '@/projects/rules'
import { formatNumber } from '@/format'

/**
 * Planetary Defense, player by player: what each wallet was paid, and what it
 * paid in.
 *
 * The gHubs report answers "how much did the game pay out"; this answers "to
 * whom", which is a different question and a longer table. Both sides are
 * shown because either alone misleads: a wallet paid 442,911 TLM that spent
 * 507,600 on entries and the forge is not the same as one paid 161,081 that
 * spent 9,030.
 *
 * It begins in August 2026 — early enough to cover the game as it runs now,
 * late enough that every day in it was collected the same way.
 *
 * Gamertags come from Mission Control's member table, the one place a WAX
 * wallet is tied to a name players recognise. Most Planetary Defense players
 * are not members; those wallets show as wallets.
 */

const FROM = '2026-08-01'
const CURRENCIES = ['TLM', 'Shards', 'DEF'] as const
/* Shards cannot be spent in this game, so there is no column for spending them. */
const SPENDABLE = ['TLM', 'DEF'] as const

const whole = (v: number) => formatNumber(Math.round(v))

const monthName = (m: string) =>
  new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

interface Row {
  wallet: string
  tag?: string
  got: Record<string, number>
  paid: Record<string, number>
}

type Column = { key: string; label: string; of: (r: Row) => number | string }

export default function PdPayouts() {
  const [days, setDays] = useState<ProjectDay[] | null>(null)
  const [members, setMembers] = useState<McMember[]>([])
  const [find, setFind] = useState('')
  const [month, setMonth] = useState('')
  const [sort, setSort] = useState({ key: 'TLM received', down: true })

  useEffect(() => {
    void fetchProjectFile('pd').then((f) => setDays(f.days.filter((d) => d.date >= FROM)))
    fetchMcMembers()
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [])

  const tags = useMemo(
    () => new Map(members.filter((m) => m.tag).map((m) => [m.wallet, m.tag as string])),
    [members],
  )

  const months = useMemo(
    () => [...new Set((days ?? []).map((d) => d.date.slice(0, 7)))].sort().reverse(),
    [days],
  )

  const inMonth = useMemo(
    () => (days ?? []).filter((d) => !month || d.date.startsWith(month)),
    [days, month],
  )

  const rows = useMemo(() => {
    const by = new Map<string, Row>()
    const at = (wallet: string) => {
      const row = by.get(wallet) ?? { wallet, got: {}, paid: {} }
      by.set(wallet, row)
      return row
    }
    for (const day of inMonth) {
      for (const [symbol, wallets] of Object.entries(day.received ?? {})) {
        for (const [wallet, amount] of Object.entries(wallets)) at(wallet).got[symbol] = (at(wallet).got[symbol] ?? 0) + amount
      }
      /* Everything a player sent the game: entry fees, the forge, its shop,
         land and sign-up fees. Days read before that was recorded per wallet
         fall back to the entry fees alone. */
      for (const [symbol, wallets] of Object.entries(day.incomingBy ?? day.feesBy ?? {})) {
        for (const [wallet, amount] of Object.entries(wallets)) at(wallet).paid[symbol] = (at(wallet).paid[symbol] ?? 0) + amount
      }
    }
    return [...by.values()].map((r) => ({ ...r, tag: tags.get(r.wallet) }))
  }, [inMonth, tags])

  const columns: Column[] = [
    { key: 'Player', label: 'Player', of: (r) => r.tag ?? r.wallet },
    ...CURRENCIES.map((c) => ({ key: `${c} received`, label: `${c} received`, of: (r: Row) => r.got[c] ?? 0 })),
    ...SPENDABLE.map((c) => ({ key: `${c} spent`, label: `${c} spent`, of: (r: Row) => r.paid[c] ?? 0 })),
  ]

  const shown = useMemo(() => {
    const needle = find.trim().toLowerCase()
    const matching = needle
      ? rows.filter((r) => r.wallet.includes(needle) || (r.tag ?? '').toLowerCase().includes(needle))
      : rows
    const column = columns.find((c) => c.key === sort.key) ?? columns[1]
    return [...matching].sort((a, b) => {
      const x = column.of(a)
      const y = column.of(b)
      const by = typeof x === 'string' ? String(x).localeCompare(String(y)) : Number(x) - Number(y)
      return sort.down ? -by : by
    })
    /* columns is rebuilt each render but depends only on the data below. */
  }, [rows, find, sort])

  const totals = useMemo(() => {
    const got: Record<string, number> = {}
    const paid: Record<string, number> = {}
    for (const r of shown) {
      for (const c of CURRENCIES) got[c] = (got[c] ?? 0) + (r.got[c] ?? 0)
      for (const c of SPENDABLE) paid[c] = (paid[c] ?? 0) + (r.paid[c] ?? 0)
    }
    return { got, paid }
  }, [shown])

  const click = (key: string) =>
    setSort((was) => (was.key === key ? { key, down: !was.down } : { key, down: key !== 'Player' }))

  const arrow = (key: string) => (sort.key === key ? (sort.down ? ' ↓' : ' ↑') : '')
  const last = inMonth.length ? inMonth[inMonth.length - 1].date : ''

  return (
    <section className="section">
      <div className="page__actions">
        <h2 className="dao-h2">
          Planetary Defense payouts{' '}
          <span className="dao-dim">{month ? monthName(month) : 'since 1 August 2026'}</span>
        </h2>
        <select className="pdp__find" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">Every month</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthName(m)}
            </option>
          ))}
        </select>
        <input
          type="search"
          className="pdp__find"
          placeholder="wallet or gamertag"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
      </div>

      {!days ? (
        <p className="loading">
          <span className="spinner" /> Loading…
        </p>
      ) : !rows.length ? (
        <p className="dao-note">Nothing collected for this month yet.</p>
      ) : (
        <>
          <p className="dao-dim">
            {whole(shown.length)} wallet{shown.length === 1 ? '' : 's'}
            {find ? ` matching “${find}”` : ''} · {inMonth.length} day{inMonth.length === 1 ? '' : 's'} to {last}.
            Received means rewards from magordefense and miss.pdef; spent means TLM and DEF sent to the game — mission
            entries, the forge, its shop, land and sign-up fees.
          </p>

          <div className="pdp__scroll">
            <table className="pdp">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={`pdp__sort${c.key === 'Player' ? '' : ' num'}${sort.key === c.key ? ' on' : ''}`}
                      onClick={() => click(c.key)}
                      title="Sort by this column"
                    >
                      {c.label}
                      {arrow(c.key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((r) => (
                  <tr key={r.wallet}>
                    <td>
                      <span className="pdp__wallet">{r.wallet}</span>
                      {r.tag ? <span className="pdp__tag">{r.tag}</span> : null}
                    </td>
                    {CURRENCIES.map((c) => (
                      <td key={`got-${c}`} className="num">
                        {r.got[c] ? whole(r.got[c]) : '—'}
                      </td>
                    ))}
                    {SPENDABLE.map((c) => (
                      <td key={`paid-${c}`} className="num pdp__spent">
                        {r.paid[c] ? whole(r.paid[c]) : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{shown.length > 500 ? `first 500 of ${whole(shown.length)}, totals over all` : 'Total'}</td>
                  {CURRENCIES.map((c) => (
                    <td key={`t-got-${c}`} className="num">
                      {whole(totals.got[c] ?? 0)}
                    </td>
                  ))}
                  {SPENDABLE.map((c) => (
                    <td key={`t-paid-${c}`} className="num pdp__spent">
                      {whole(totals.paid[c] ?? 0)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
