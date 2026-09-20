import { useEffect, useState } from 'react'
import {
  buyActions,
  cancelAction,
  claimAction,
  sellAction,
  stakeAction,
  stakeTimeAction,
  toAsset,
  unstakeAction,
  TLM_SYMBOL,
  type Position,
  type StakeConfig,
} from '../chain/stake'
import { isCancel, readableError, type ChainAction } from '../chain/act'
import { fmtAmount, fmtDays, isoMinute } from '../format'
import { ensureStakeConfig } from '../usePosition'
import { Overlay } from '../../components/Overlay'
import { useSession } from '../../wallet/session'
import type { Dao } from '../chain/daos'

type Op = 'stake' | 'unstake' | 'buy' | 'sell' | 'delay'

const OPS: { key: Op; label: string; blurb: string }[] = [
  { key: 'stake', label: 'Stake', blurb: 'Locks tokens you hold. Staked tokens are what your vote weighs.' },
  { key: 'unstake', label: 'Unstake', blurb: 'Starts the delay. The tokens come back when it runs out.' },
  { key: 'buy', label: 'TLM → token', blurb: 'Converts Trilium into this DAO’s token, one for one.' },
  { key: 'sell', label: 'Token → TLM', blurb: 'Burns the token and refunds Trilium, one for one.' },
  { key: 'delay', label: 'Unstake delay', blurb: 'How long a future unstake waits. A longer delay weighs more.' },
]

/**
 * Everything one account can do with a DAO's token.
 *
 * Five actions over one balance, which is why they are one panel rather than
 * five buttons on a card: they all read the same position, and after any of
 * them that position has to be re-read. It opens over the page rather than
 * below the grid — it is about one council, and the grid it was opened from is
 * not what you are reading any more.
 *
 * The delay is the odd one out — it governs a FUTURE unstake, so setting it
 * while something is already unstaking changes nothing about what is in
 * flight, and the panel says so rather than letting it look like a fix.
 */
export function StakePanel({
  dao,
  position,
  tlm,
  swapTarget,
  onDone,
  onClose,
}: {
  dao: Dao
  position: Position | null
  tlm: string | null
  swapTarget: string | undefined
  onDone: () => Promise<void> | void
  onClose: () => void
}) {
  const { session } = useSession()
  const [op, setOp] = useState<Op | null>(null)
  const [amount, setAmount] = useState('')
  const [days, setDays] = useState('')
  const [config, setConfig] = useState<StakeConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  useEffect(() => {
    void ensureStakeConfig(dao).then(setConfig)
  }, [dao.id])

  const now = Date.now()
  const released = (position?.unstakes ?? []).filter((u) => u.release <= now)
  const waiting = (position?.unstakes ?? []).filter((u) => u.release > now)

  const level = () => ({
    actor: String(session!.actor),
    permission: session!.permissionLevel.permission ? String(session!.permissionLevel.permission) : 'active',
  })

  const sign = async (actions: ChainAction[], describe: string) => {
    if (!session || busy) return
    setBusy(true)
    setNote({ text: `${describe} — check your wallet…` })
    try {
      await session.transact({ actions }, { broadcast: true })
      /* A block has to land before the tables move. */
      await new Promise((r) => setTimeout(r, 2500))
      await onDone()
      setAmount('')
      setOp(null)
      setNote({ text: `${describe} done.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error(`${describe} failed:`, err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const go = () => {
    if (!session) return
    const l = level()

    if (op === 'delay') {
      const n = Number(String(days).trim())
      if (!Number.isFinite(n) || n <= 0) return setNote({ text: 'Enter a number of days.', bad: true })
      const seconds = Math.round(n * 86_400)
      if (config && (seconds < config.min || seconds > config.max)) {
        return setNote({ text: `Must be between ${fmtDays(config.min)} and ${fmtDays(config.max)}.`, bad: true })
      }
      return void sign([stakeTimeAction(l, dao, seconds)], `Unstake delay ${fmtDays(seconds)}`)
    }

    /* Only the TLM leg is counted in Trilium; everything else is in the DAO's
       own token, which is four decimals on all of them but not by assumption. */
    const isTlm = op === 'buy'
    const q = toAsset(amount, isTlm ? 4 : dao.precision, isTlm ? TLM_SYMBOL : dao.symbol)
    if (!q) return setNote({ text: 'Enter an amount above zero.', bad: true })

    if (op === 'stake') return void sign([stakeAction(l, dao, q)], `Stake ${q}`)
    if (op === 'unstake') return void sign([unstakeAction(l, dao, q)], `Unstake ${q}`)
    if (op === 'sell') return void sign([sellAction(l, dao, q)], `Convert ${q} to TLM`)
    if (op === 'buy') {
      if (!swapTarget) return setNote({ text: 'This DAO is not listed for TLM swaps.', bad: true })
      return void sign(buyActions(l, swapTarget, q), `Convert ${q} to ${dao.symbol}`)
    }
  }

  const fill = () => {
    if (op === 'stake') return setAmount(String(position?.notStaked ?? '').split(' ')[0])
    if (op === 'unstake') return setAmount(String(position?.staked ?? '').split(' ')[0])
    if (op === 'sell') return setAmount(String(position?.notStaked ?? '').split(' ')[0])
    if (op === 'buy') return setAmount(String(tlm ?? '').split(' ')[0])
  }

  const chosen = OPS.find((o) => o.key === op) ?? null

  return (
    <Overlay
      title={dao.title}
      subtitle={`${dao.symbol} · ${dao.id}`}
      onClose={busy ? () => undefined : onClose}
    >
      {!session ? (
        <p className="dao-note">Connect a wallet to stake, unstake or convert here.</p>
      ) : !position ? (
        <p className="dao-note">Reading your position…</p>
      ) : (
        <ul className="stake-figures">
          <li>
            <span>Not staked</span>
            <b>{fmtAmount(position.notStaked)}</b>
          </li>
          <li>
            <span>Staked</span>
            <b>{position.staked ? fmtAmount(position.staked) : '0'}</b>
          </li>
          <li>
            <span>Trilium</span>
            <b>{tlm ? fmtAmount(tlm) : '0'}</b>
          </li>
          <li>
            <span>Unstake delay</span>
            <b title={position.delayIsMinimum ? 'The contract minimum — you have not set one' : undefined}>
              {position.delay != null ? fmtDays(position.delay) : '—'}
              {position.delayIsMinimum ? <i className="council__decay">min</i> : null}
            </b>
          </li>
        </ul>
      )}

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      {released.length ? (
        <p className="dao-note">
          <b>{released.length} unstake{released.length === 1 ? '' : 's'} ready</b> —{' '}
          {released.map((u) => u.stake).join(', ')}.{' '}
          <button className="btn" type="button" disabled={!session || busy} onClick={() => sign([claimAction(level(), dao)], 'Claim')}>
            Claim
          </button>
        </p>
      ) : null}

      {waiting.length ? (
        <div className="stake-waiting">
          {waiting.map((u) => (
            <span key={u.key} className="stake-wait">
              <b>{fmtAmount(u.stake)}</b>
              <i>releases {isoMinute(u.release)} UTC</i>
              <button
                className="btn"
                type="button"
                disabled={!session || busy}
                onClick={() => sign([cancelAction(level(), dao, u.key)], `Cancel unstake ${u.stake}`)}
              >
                Cancel
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="page__actions">
        {OPS.map((o) => (
          <button
            key={o.key}
            className={`btn${op === o.key ? ' btn--go' : ''}`}
            type="button"
            disabled={!session || busy}
            onClick={() => {
              setOp(op === o.key ? null : o.key)
              setNote(null)
              setAmount('')
              setDays(position?.delay != null ? String(Math.round((position.delay / 86_400) * 10) / 10) : '')
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {chosen ? (
        <div className="tap-form">
          <p className="dao-dim">{chosen.blurb}</p>

          {op === 'delay' ? (
            <div className="ale-form">
              <label className="ale-field">
                <span className="ale-field__name">
                  Days<i>
                    {config ? `${fmtDays(config.min)} to ${fmtDays(config.max)}` : 'reading the contract’s range…'}
                  </i>
                </span>
                <input type="number" min={0} step={0.1} value={days} onChange={(e) => setDays(e.target.value)} />
              </label>
            </div>
          ) : (
            <div className="ale-form">
              <label className="ale-field">
                <span className="ale-field__name">
                  Amount<i>in {op === 'buy' ? TLM_SYMBOL : dao.symbol}</i>
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  placeholder="0"
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <div className="ale-field">
                <span className="ale-field__name">&nbsp;</span>
                <button className="btn" type="button" onClick={fill}>
                  Use the lot
                </button>
              </div>
            </div>
          )}

          {op === 'delay' && waiting.length ? (
            <p className="dao-note">
              This governs the NEXT unstake. The {waiting.length} already in flight keep the delay they were
              started with.
            </p>
          ) : null}
          {op === 'buy' && !swapTarget ? (
            <p className="dao-note dao-note--bad">
              <code>stake.worlds</code> does not list {dao.symbol}, so it cannot be bought with Trilium.
            </p>
          ) : null}

          <div className="page__actions">
            <button className="btn btn--go" type="button" disabled={busy} onClick={go}>
              {busy ? 'Signing…' : chosen.label}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setOp(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </Overlay>
  )
}
