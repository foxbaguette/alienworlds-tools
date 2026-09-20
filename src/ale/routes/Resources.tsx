import { useEffect, useState } from 'react'
import {
  RESOURCE_ACCOUNTS,
  fetchAllResources,
  fmtBytes,
  fmtMicros,
  tone,
  type Resources,
} from '../chain/resources'

/**
 * RAM, CPU and NET across every Alien Legends account.
 *
 * Sorted by how full the RAM is rather than alphabetically. The question this
 * page answers is "is anything about to break", and the answer is always at one
 * end of the RAM column — an account at 95% is one busy day from refusing
 * writes, and it should not have to be hunted for in a list of twenty-three.
 */
export function ResourceStatus() {
  const [rows, setRows] = useState<Resources[] | null>(null)
  const [at, setAt] = useState<number | null>(null)

  const read = () => {
    setRows(null)
    void fetchAllResources().then((r) => {
      setRows(r)
      setAt(Date.now())
    })
  }

  useEffect(read, [])

  const sorted = rows ? [...rows].sort((a, b) => b.ram.share - a.ram.share) : []
  const worst = sorted.filter((r) => tone('ram', r.ram.share) !== 'ok')

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Resources</h1>
          <p className="page__lead">
            RAM, CPU and NET on all {RESOURCE_ACCOUNTS.length} Alien Legends accounts. RAM is the one to watch: it
            is bought rather than rented, and a contract that fills its quota stops being able to write.
          </p>
        </div>
        <div className="page__actions">
          {at ? <span className="dao-dim">read {new Date(at).toISOString().slice(11, 19)} UTC</span> : null}
          <button className="btn" type="button" onClick={read} disabled={!rows}>
            Re-read
          </button>
        </div>
      </header>

      {rows && worst.length ? (
        <p className="dao-note">
          <b>
            {worst.length} account{worst.length === 1 ? '' : 's'} above 75% RAM
          </b>{' '}
          — {worst.map((r) => `${r.account} (${r.ram.share.toFixed(0)}%)`).join(', ')}.
        </p>
      ) : null}

      <section className="section">
        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">RAM</th>
                <th>&nbsp;</th>
                <th className="num">CPU</th>
                <th className="num">NET</th>
                <th className="num">Staked</th>
                <th className="num">WAX</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.account}>
                  <td>
                    <b className="dao-rowtitle">{r.account}</b>
                    {r.error ? <span className="dao-rowmeta">{r.error}</span> : null}
                  </td>
                  <td className="num" title={`${fmtBytes(r.ram.used)} of ${fmtBytes(r.ram.quota)}`}>
                    <b className={`res-pct is-${tone('ram', r.ram.share)}`}>{r.ram.share.toFixed(0)}%</b>
                  </td>
                  <td className="res-barcell">
                    <span className="res-bar">
                      <i
                        className={`res-bar__fill is-${tone('ram', r.ram.share)}`}
                        style={{ width: `${Math.min(100, r.ram.share)}%` }}
                      />
                    </span>
                    <span className="dao-dim">{fmtBytes(r.ram.quota - r.ram.used)} free</span>
                  </td>
                  <td className="num" title={`${fmtMicros(r.cpu.used)} of ${fmtMicros(r.cpu.max)}`}>
                    <span className={`res-pct is-${tone('cpu', r.cpu.share)}`}>{r.cpu.share.toFixed(0)}%</span>
                  </td>
                  <td className="num" title={`${fmtBytes(r.net.used)} of ${fmtBytes(r.net.max)}`}>
                    <span className={`res-pct is-${tone('net', r.net.share)}`}>{r.net.share.toFixed(0)}%</span>
                  </td>
                  <td className="num" title="WAX staked for CPU and NET">
                    {(r.cpuStaked + r.netStaked).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </td>
                  <td className="num">
                    {r.wax != null ? r.wax.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
                  </td>
                </tr>
              ))}
              {!rows ? (
                <tr>
                  <td colSpan={7} className="dao-dim">
                    Reading {RESOURCE_ACCOUNTS.length} accounts…
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
