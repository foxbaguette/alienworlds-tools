import { useEffect, useState } from 'react'
import { ALE_CONTRACTS } from '../chain/admin'
import { getPage } from '../../dao/chain/nodes'
import { isCancel, readableError, type ChainAction } from '../../dao/chain/act'
import { useSession } from '../../wallet/session'

/**
 * Pausing the game, and what players are told while it is down.
 *
 * WHERE THE STATE ACTUALLY LIVES. Each contract holds its own `pause` row —
 * `{ config_id, game_paused }` — and flips it with its own
 * `setpause(wallet, game_paused)`. That row is the truth.
 *
 * `admin.ale`'s `config.pause_scs` is NOT that. It is a registry of which
 * contracts take part in the pause system, and it is populated whether or not
 * anything is paused. Reading it as state reported eight contracts down while
 * the game was plainly running — the live feed was full of dungeons being
 * cleared at the time.
 *
 * The maintenance message does live on admin.ale, as `standard_message`, so
 * that half is written there and the pause half is written per contract.
 */
interface PauseRow {
  config_id: number
  game_paused: number | boolean
}

interface AdminConfig {
  pause_scs?: string[]
  standard_message?: string
}

const PAUSABLE = ALE_CONTRACTS.filter((c) => c !== 'admin.ale')

export function GameState() {
  const { session, actor } = useSession()
  /** Contract to its real, on-chain paused flag. Absent = no pause table. */
  const [onChain, setOnChain] = useState<Map<string, boolean> | null>(null)
  const [message, setMessage] = useState('')
  const [liveMessage, setLiveMessage] = useState('')
  const [registry, setRegistry] = useState<string[]>([])
  const [want, setWant] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const read = () => {
    setError(null)
    setNote(null)
    Promise.all([
      getPage<AdminConfig>({ code: 'admin.ale', scope: 'admin.ale', table: 'config', limit: 1 }).catch(() => []),
      ...PAUSABLE.map(async (c) => {
        /* A contract without a pause table is simply not pausable; it is left
           out rather than shown as running. */
        const rows = await getPage<PauseRow>({ code: c, scope: c, table: 'pause', limit: 1 }).catch(() => [])
        return [c, rows[0]] as const
      }),
    ])
      .then(([adminRows, ...pairs]) => {
        const admin = (adminRows as AdminConfig[])[0] ?? {}
        setRegistry(admin.pause_scs ?? [])
        setMessage(admin.standard_message ?? '')
        setLiveMessage(admin.standard_message ?? '')

        const state = new Map<string, boolean>()
        for (const [c, row] of pairs as [string, PauseRow | undefined][]) {
          if (row) state.set(c, !!Number(row.game_paused))
        }
        setOnChain(state)
        setWant(new Set([...state].filter(([, paused]) => paused).map(([c]) => c)))
      })
      .catch((err: unknown) => {
        console.error('game state:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [])

  const toggle = (name: string) =>
    setWant((prev) => {
      const next = new Set(prev)
      if (!next.delete(name)) next.add(name)
      return next
    })

  const level = (): ChainAction['authorization'][number] => ({
    actor: String(session!.actor),
    permission: session!.permissionLevel.permission ? String(session!.permissionLevel.permission) : 'active',
  })

  /**
   * One transaction for the lot.
   *
   * A `setpause` per contract that is changing, and a `setconfig` on admin.ale
   * only if the message changed — pausing eight contracts and rewriting the
   * message should not be nine trips to the wallet.
   */
  const save = async () => {
    if (!session || !onChain || busy) return

    const actions: ChainAction[] = []
    for (const [c, paused] of onChain) {
      const next = want.has(c)
      if (next === paused) continue
      actions.push({
        account: c,
        name: 'setpause',
        authorization: [level()],
        data: { wallet: String(session.actor), game_paused: next },
      })
    }

    if (message !== liveMessage) {
      actions.push({
        account: 'admin.ale',
        name: 'setconfig',
        authorization: [level()],
        data: {
          wallet: String(session.actor),
          /* Written back untouched: this is the registry, not something this
             panel is in the business of editing. */
          pause_scs: registry,
          standard_message: message,
          delete_config: false,
        },
      })
    }

    if (!actions.length) return

    setBusy(true)
    setNote({ text: `${actions.length} action${actions.length === 1 ? '' : 's'} — check your wallet…` })
    try {
      await session.transact({ actions }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      read()
      setNote({ text: 'Saved.' })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('game state save failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="dao-note dao-note--bad">{error}</p>
  if (!onChain) return <p className="dao-note">Reading the game state…</p>

  const pausedNow = [...onChain].filter(([, p]) => p).length
  const changes =
    [...onChain].filter(([c, p]) => want.has(c) !== p).length + (message !== liveMessage ? 1 : 0)

  return (
    <section className={`section game-state${pausedNow ? ' is-paused' : ''}`}>
      <h2 className="dao-h2">
        Game state{' '}
        <span className="dao-dim">
          {pausedNow
            ? `${pausedNow} of ${onChain.size} contract${pausedNow === 1 ? '' : 's'} paused`
            : `everything running · ${onChain.size} contracts`}
        </span>
      </h2>

      <div className="pause-grid">
        {[...onChain.keys()].map((c) => {
          const on = want.has(c)
          const live = onChain.get(c)
          return (
            <label
              key={c}
              className={`pause-chip${on ? ' is-on' : ''}${on !== live ? ' is-changed' : ''}`}
              title={on === live ? (live ? 'paused' : 'running') : live ? 'will resume on save' : 'will pause on save'}
            >
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
          onClick={() => setWant(new Set(onChain.keys()))}
          disabled={want.size === onChain.size}
        >
          Pause everything
        </button>
        <button className="btn" type="button" onClick={() => setWant(new Set())} disabled={!want.size}>
          Resume everything
        </button>
      </div>

      <label className="ale-field">
        <span className="ale-field__name">
          Maintenance message<i>admin.ale · shown while a contract is paused</i>
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
        <button className="btn btn--go" type="button" disabled={!session || busy || !changes} onClick={save}>
          {busy ? 'Signing…' : changes ? `Save ${changes} change${changes === 1 ? '' : 's'}` : 'No changes'}
        </button>
        <button className="btn" type="button" onClick={read} disabled={busy}>
          Re-read
        </button>
        <span className="dao-dim">
          {session ? `Signed as ${actor}. One transaction, whatever changed.` : 'Connect a wallet to save.'}
        </span>
      </div>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
    </section>
  )
}
