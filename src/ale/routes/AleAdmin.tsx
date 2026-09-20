import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  ALE_CONTRACTS,
  fetchConfig,
  fromInput,
  kindOf,
  SAFE_DEFAULTS,
  toInput,
  type ConfigForm,
} from '../chain/admin'
import { isCancel, readableError } from '../../dao/chain/act'
import { useSession } from '../../wallet/session'
import { GameState } from './GameState'

/**
 * Editing an Alien Legends contract's settings.
 *
 * The whole form is generated from the contract's ABI — one field per parameter
 * of its `setconfig`, typed by what the ABI says it is, filled from the row as
 * it stands. Nothing about any particular contract is written here, so a
 * contract that gains a setting gains a field without this page changing.
 *
 * Every value is pre-filled and then sent back whole, including the ones you
 * did not touch: `setconfig` takes the entire config, not a patch, so leaving a
 * field out would set it to a default rather than leave it alone.
 */
export default function AleAdmin() {
  const { contract: routed } = useParams()
  const [contract, setContract] = useState<string>(routed ?? ALE_CONTRACTS[0])

  useEffect(() => {
    if (routed) setContract(routed)
  }, [routed])

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">ALE Admin</h1>
          <p className="page__lead">
            The settings each Alien Legends contract holds in its <code>config</code> table. Fields are built from
            the contract&rsquo;s own ABI and filled with what is on chain right now.
          </p>
        </div>
      </header>

      <GameState />

      <div className="sections ale-picker" role="tablist">
        {ALE_CONTRACTS.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={c === contract} onClick={() => setContract(c)}>
            {c.replace('.ale', '')}
          </button>
        ))}
      </div>

      <ConfigEditor key={contract} contract={contract} />
    </div>
  )
}

function ConfigEditor({ contract }: { contract: string }) {
  const { session, actor } = useSession()
  const [form, setForm] = useState<ConfigForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const read = () => {
    setForm(null)
    setError(null)
    setNote(null)
    fetchConfig(contract)
      .then((f) => {
        setForm(f)
        const v: Record<string, string> = {}
        for (const field of f.fields) v[field.name] = toInput(f.current[field.name], kindOf(field.type))
        setValues(v)
      })
      .catch((err: unknown) => {
        console.error(`config for ${contract}:`, err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [contract])

  const submit = async () => {
    if (!form || !session || busy) return
    setBusy(true)
    setNote(null)
    try {
      /* The whole config goes back, not just what changed — setconfig takes
         every field, so an omission is a reset rather than a no-op. */
      const data: Record<string, unknown> = { wallet: String(session.actor), ...SAFE_DEFAULTS }
      for (const field of form.fields) {
        data[field.name] = fromInput(values[field.name] ?? '', kindOf(field.type), field.name)
      }

      setNote({ text: 'Check your wallet…' })
      await session.transact(
        {
          actions: [
            {
              account: form.contract,
              name: form.action,
              authorization: [
                {
                  actor: String(session.actor),
                  permission: session.permissionLevel.permission
                    ? String(session.permissionLevel.permission)
                    : 'active',
                },
              ],
              data,
            },
          ],
        },
        { broadcast: true },
      )
      await new Promise((r) => setTimeout(r, 2500))
      read()
      setNote({ text: `${form.contract} updated.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('setconfig failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <p className="dao-note dao-note--bad">
        {contract}: {error}
      </p>
    )
  }
  if (!form) return <p className="dao-note">Reading {contract}…</p>

  /* Has anything actually been changed? A form that always offers to write is
     one people write by accident. */
  const dirty = form.fields.filter((f) => values[f.name] !== toInput(form.current[f.name], kindOf(f.type)))

  return (
    <section className="section">
      <h2 className="dao-h2">
        {form.contract} <span className="dao-dim">{form.action}</span>
      </h2>

      {form.readOnly.length ? (
        <p className="dao-dim">
          Not settable here:{' '}
          {form.readOnly.map((f) => (
            <code key={f.name}>{f.name}</code>
          ))}{' '}
          — on the row but not taken by <code>{form.action}</code>.
        </p>
      ) : null}

      <div className="ale-form">
        {form.fields.map((f) => {
          const kind = kindOf(f.type)
          const changed = values[f.name] !== toInput(form.current[f.name], kind)
          return (
            <label key={f.name} className={`ale-field${changed ? ' is-changed' : ''}`}>
              <span className="ale-field__name">
                {f.name}
                <i>{f.type}</i>
              </span>

              {kind === 'bool' ? (
                <select value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : kind === 'json' ? (
                <textarea
                  rows={Math.min(10, (values[f.name]?.match(/\n/g)?.length ?? 0) + 2)}
                  value={values[f.name] ?? ''}
                  spellCheck={false}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              ) : (
                <input
                  type={kind === 'number' ? 'number' : 'text'}
                  step="any"
                  value={values[f.name] ?? ''}
                  spellCheck={false}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              )}

              {changed ? (
                <span className="ale-field__was">
                  was <code>{toInput(form.current[f.name], kind) || '(empty)'}</code>
                </span>
              ) : null}
            </label>
          )
        })}
      </div>

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!session || busy || !dirty.length} onClick={submit}>
          {busy ? 'Signing…' : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'No changes'}
        </button>
        <button className="btn" type="button" onClick={read} disabled={busy}>
          Re-read
        </button>
        <span className="dao-dim">
          {!session
            ? 'Connect a wallet to save.'
            : `Signed as ${actor}. The whole config is written, not just what changed.`}
        </span>
      </div>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
    </section>
  )
}
