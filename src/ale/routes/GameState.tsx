import { useEffect, useState } from 'react'
import { ALE_CONTRACTS } from '../chain/admin'
import { getPage } from '../../dao/chain/nodes'
import { isCancel, readableError } from '../../dao/chain/act'
import { useSession } from '../../wallet/session'

/**
 * Pausing the game, and what players are told while it is down.
 *
 * `admin.ale` holds both: `pause_scs` is the list of contracts that are
 * currently refusing to act, and `standard_message` is the line shown to anyone
 * who runs into one. Every other `.ale` contract checks that list, so this is
 * the one switch rather than seventeen.
 *
 * It is a form of its own rather than three fields on the generic config page
 * because the generic one would render `pause_scs` as a JSON array to hand-edit
 * — which is a poor way to take the game down in a hurry — and would expose
 * `delete_config` next to it, which is not something to leave within reach of a
 * misclick. That flag is always sent false from here.
 */
interface AdminConfig {
  index?: number
  pause_scs: string[]
  standard_message: string
}

const PAUSABLE = ALE_CONTRACTS.filter((c) => c !== 'admin.ale')

export function GameState() {
  const { session, actor } = useSession()
  const [config, setConfig] = useState<AdminConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const read = () => {
    setError(null)
    setNote(null)
    getPage<AdminConfig>({ code: 'admin.ale', scope: 'admin.ale', table: 'config', limit: 1 })
      .then((rows) => {
        const c = rows[0] ?? { pause_scs: [], standard_message: '' }
        setConfig(c)
        setPaused(new Set(c.pause_scs ?? []))
        setMessage(c.standard_message ?? '')
      })
      .catch((err: unknown) => {
        console.error('admin.ale config:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [])

  const toggle = (name: string) =>
    setPaused((prev) => {
      const next = new Set(prev)
      if (!next.delete(name)) next.add(name)
      return next
    })

  const save = async () => {
    if (!session || !config || busy) return
    setBusy(true)
    setNote({ text: 'Check your wallet…' })
    try {
      await session.transact(
        {
          actions: [
            {
              account: 'admin.ale',
              name: 'setconfig',
              authorization: [
                {
                  actor: String(session.actor),
                  permission: session.permissionLevel.permission
                    ? String(session.permissionLevel.permission)
                    : 'active',
                },
              ],
              data: {
                wallet: String(session.actor),
                /* Sorted so the row does not churn on order alone, and every
                   diff against it means something. */
                pause_scs: [...paused].sort(),
                standard_message: message,
                /* Never from here. */
                delete_config: false,
              },
            },
          ],
        },
        { broadcast: true },
      )
      await new Promise((r) => setTimeout(r, 2500))
      read()
      setNote({ text: 'Saved.' })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('admin.ale setconfig failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="dao-note dao-note--bad">admin.ale: {error}</p>
  if (!config) return <p className="dao-note">Reading admin.ale…</p>

  const live = new Set(config.pause_scs ?? [])
  const changed =
    message !== (config.standard_message ?? '') ||
    paused.size !== live.size ||
    [...paused].some((p) => !live.has(p))

  return (
    <section className={`section game-state${paused.size ? ' is-paused' : ''}`}>
      <h2 className="dao-h2">
        Game state{' '}
        <span className="dao-dim">
          {live.size ? `${live.size} contract${live.size === 1 ? '' : 's'} paused` : 'everything running'}
        </span>
      </h2>

      <div className="pause-grid">
        {PAUSABLE.map((c) => {
          const on = paused.has(c)
          return (
            <label key={c} className={`pause-chip${on ? ' is-on' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(c)} />
              <span>{c.replace('.ale', '')}</span>
            </label>
          )
        })}
      </div>

      <div className="page__actions">
        <button
          className="btn"
          type="button"
          onClick={() => setPaused(new Set(PAUSABLE))}
          disabled={paused.size === PAUSABLE.length}
        >
          Pause everything
        </button>
        <button className="btn" type="button" onClick={() => setPaused(new Set())} disabled={!paused.size}>
          Resume everything
        </button>
      </div>

      <label className="ale-field">
        <span className="ale-field__name">
          Maintenance message<i>shown to anyone who hits a paused contract</i>
        </span>
        <textarea
          rows={2}
          value={message}
          maxLength={512}
          placeholder="Back shortly — we are deploying an update."
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!session || busy || !changed} onClick={save}>
          {busy ? 'Signing…' : changed ? 'Save game state' : 'No changes'}
        </button>
        <button className="btn" type="button" onClick={read} disabled={busy}>
          Re-read
        </button>
        <span className="dao-dim">{session ? `Signed as ${actor}.` : 'Connect a wallet to save.'}</span>
      </div>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
    </section>
  )
}
