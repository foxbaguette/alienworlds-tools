import { useEffect, useState } from 'react'
import {
  RESOURCE_ACCOUNTS,
  fetchAllResources,
  fmtBytes,
  fmtMicros,
  tone,
  type Resources,
} from '../chain/resources'
import { buyRamAction, costOfBytes, fetchRamMarket, perMegabyte, type RamMarket } from '../chain/ram'
import { isCancel, readableError } from '../../dao/chain/act'
import { Overlay } from '../../components/Overlay'
import { useSession } from '../../wallet/session'

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
  const [market, setMarket] = useState<RamMarket | null>(null)
  const [buying, setBuying] = useState<string | null>(null)

  const read = () => {
    setRows(null)
    void fetchAllResources().then((r) => {
      setRows(r)
      setAt(Date.now())
    })
  }

  useEffect(read, [])

  /* The price, read once — it moves, but not between one glance and the next,
     and the contract prices the purchase itself when it lands. */
  useEffect(() => {
    void fetchRamMarket()
      .then(setMarket)
      .catch((err) => console.error('ram market:', err))
  }, [])

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
            {market ? (
              <>
                {' '}
                RAM is <b>
                  {perMegabyte(market).toLocaleString('en-US', { maximumFractionDigits: 2 })} WAX
                </b>{' '}
                a MB today.
              </>
            ) : null}
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
                <th />
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
                  <td className="num">
                    <button
                      className="btn btn--tiny"
                      type="button"
                      title={`Buy RAM for ${r.account}, paid from your wallet`}
                      onClick={() => setBuying(buying === r.account ? null : r.account)}
                    >
                      Add RAM
                    </button>
                  </td>
                </tr>
              ))}
              {!rows ? (
                <tr>
                  <td colSpan={8} className="dao-dim">
                    Reading {RESOURCE_ACCOUNTS.length} accounts…
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {buying && rows ? (
        <BuyRam
          account={buying}
          ram={rows.find((r) => r.account === buying)!.ram}
          market={market}
          onDone={read}
          onClose={() => setBuying(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * Topping one account up.
 *
 * RAM is paid for by the SIGNER and delivered to the account named, so this is
 * spending real WAX out of the connected wallet — which is why the cost is on
 * screen before the wallet opens rather than only inside it.
 *
 * The size is asked for in MB and sent as bytes. `buyrambytes` lets the
 * contract work out the WAX itself at the price in the block that lands, so a
 * market that moves between the estimate and the signature costs a little more
 * WAX rather than quietly delivering fewer bytes.
 */
function BuyRam({
  account,
  ram,
  market,
  onDone,
  onClose,
}: {
  account: string
  ram: Resources['ram']
  market: RamMarket | null
  onDone: () => void
  onClose: () => void
}) {
  const { session } = useSession()
  const [mb, setMb] = useState('1')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const bytes = Math.round((Number(mb) || 0) * (1 << 20))
  const cost = market && bytes > 0 ? costOfBytes(market, bytes) : NaN
  const after = ram.quota + bytes
  const shareAfter = after > 0 ? (ram.used / after) * 100 : 0

  const buy = async () => {
    if (!session || busy) return
    if (!(bytes > 0)) return setNote({ text: 'Enter a size above zero.', bad: true })
    setBusy(true)
    setNote({ text: `Buying ${fmtBytes(bytes)} for ${account} — check your wallet…` })
    try {
      const level = {
        actor: String(session.actor),
        permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
      }
      await session.transact({ actions: [buyRamAction(level, account, bytes)] }, { broadcast: true })
      /* A block has to land before get_account shows the new quota. */
      await new Promise((r) => setTimeout(r, 2500))
      onDone()
      setNote({ text: `${fmtBytes(bytes)} added to ${account}.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('buyrambytes failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay
      title={
        <>
          Add RAM to <code>{account}</code>
        </>
      }
      subtitle={`${ram.share.toFixed(0)}% of ${fmtBytes(ram.quota)} used · ${fmtBytes(
        ram.quota - ram.used,
      )} free`}
      onClose={busy ? () => undefined : onClose}
    >
      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Size<i>in MB</i>
          </span>
          <input type="number" min={0} step={0.25} value={mb} onChange={(e) => setMb(e.target.value)} />
        </label>
        <div className="ale-field">
          <span className="ale-field__name">
            Quick<i>common top-ups</i>
          </span>
          <div className="page__actions">
            {['1', '2', '5', '10'].map((n) => (
              <button key={n} className="btn" type="button" onClick={() => setMb(n)}>
                {n} MB
              </button>
            ))}
          </div>
        </div>
      </div>

      <p>
        {market && Number.isFinite(cost) ? (
          <>
            <b>{cost.toLocaleString('en-US', { maximumFractionDigits: 2 })} WAX</b> for{' '}
            <b>{fmtBytes(bytes)}</b>, including the 0.5% buy fee.{' '}
            <span className="dao-dim">
              About {perMegabyte(market).toLocaleString('en-US', { maximumFractionDigits: 2 })} WAX a MB at
              today&rsquo;s market price. It is paid from the connected wallet, not from {account}.
            </span>
          </>
        ) : (
          <span className="dao-dim">Reading the RAM market…</span>
        )}
      </p>

      <p className="dao-dim">
        {account} would go from <b>{ram.share.toFixed(0)}%</b> of {fmtBytes(ram.quota)} to{' '}
        <b>{shareAfter.toFixed(0)}%</b> of {fmtBytes(after)}.
      </p>

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!session || busy || !(bytes > 0)} onClick={buy}>
          {busy ? 'Signing…' : `Buy ${fmtBytes(bytes)}`}
        </button>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {!session ? <span className="dao-dim">Connect a wallet to buy RAM.</span> : null}
      </div>
    </Overlay>
  )
}
