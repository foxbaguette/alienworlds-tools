import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  ALE_CONTRACTS,
  fetchConfig,
  fetchStages,
  fromInput,
  kindOf,
  SAFE_DEFAULTS,
  toInput,
  type AbiField,
  type ConfigForm,
  type StageForm,
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
      <StagesEditor key={`stages-${contract}`} contract={contract} />
    </div>
  )
}

/** The most advance steps worth putting in one transaction. */
const ADVANCE_MAX = 25

/**
 * The stages of a tournament, one row at a time.
 *
 * `setstage` is an upsert keyed by index, so the same call edits an existing
 * stage and creates one that is not there yet — which is why a new stage is
 * just a blank row with the next index suggested, and why nothing here needs
 * a separate "create" action.
 *
 * Only shown for a contract whose ABI actually has stages. Today that is
 * tournmnt.ale alone; a second one would need no change here.
 */
function StagesEditor({ contract }: { contract: string }) {
  const { session } = useSession()
  const [form, setForm] = useState<StageForm | null>(null)
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  const [added, setAdded] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  /* 20 is the usage the game itself passes; a run of one is the safe default. */
  const [usage, setUsage] = useState('20')
  const [times, setTimes] = useState('1')

  const rowId = (r: Record<string, unknown>, key: string) => String(r[key] ?? '')

  const read = () => {
    setForm(null)
    setNote(null)
    setAdded([])
    fetchStages(contract)
      .then((f) => {
        setForm(f)
        if (!f) return
        const d: Record<string, Record<string, string>> = {}
        for (const r of f.rows) {
          const id = rowId(r, f.key)
          d[id] = {}
          for (const field of f.fields) d[id][field.name] = toInput(r[field.name], kindOf(field.type))
        }
        setDraft(d)
      })
      .catch((err: unknown) => {
        console.error(`stages for ${contract}:`, err)
        setNote({ text: err instanceof Error ? err.message : String(err), bad: true })
      })
  }

  useEffect(read, [contract])

  const send = async (name: string, data: Record<string, unknown>, id: string, done: string, repeat = 1) => {
    if (!session || busy) return
    setBusy(id)
    setNote(null)
    try {
      setNote({ text: 'Check your wallet…' })
      const authorization = [
        {
          actor: String(session.actor),
          permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
        },
      ]
      /*
        Repeats are copies of the one action in the one transaction, not
        several transactions. They run in order and settle together: either
        every step is taken or none is, which is the point of asking for more
        than one at a time.
      */
      await session.transact(
        {
          actions: Array.from({ length: repeat }, () => ({
            account: contract,
            name,
            authorization,
            /* Exactly the parameters the action declares. setstage and
               delstage take a wallet, advance does not, and a field the ABI
               has never heard of fails to serialise rather than being
               ignored. */
            data,
          })),
        },
        { broadcast: true },
      )
      await new Promise((r) => setTimeout(r, 2500))
      read()
      setNote({ text: done })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error(`${name} failed:`, err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(null)
    }
  }

  if (!form) return null

  const original = (id: string, f: AbiField) => {
    const row = form.rows.find((r) => rowId(r, form.key) === id)
    return row ? toInput(row[f.name], kindOf(f.type)) : ''
  }
  const isNew = (id: string) => added.includes(id)
  const changedIn = (id: string) =>
    form.fields.filter((f) => (draft[id]?.[f.name] ?? '') !== original(id, f)).length

  const save = (id: string) => {
    const data: Record<string, unknown> = { wallet: String(session?.actor ?? '') }
    for (const f of form.fields) data[f.name] = fromInput(draft[id]?.[f.name] ?? '', kindOf(f.type), f.name)
    void send(form.action, data, id, `Stage ${data[form.key]} written.`)
  }

  /* The next index, a thousand clear of the last — the spacing the contract's
     own stages already use, which leaves room to put one in between. */
  const nextIndex = () => {
    const highest = Math.max(0, ...form.rows.map((r) => Number(r[form.key] ?? 0)))
    return String(highest + 1000)
  }
  const addStage = () => {
    const id = nextIndex()
    if (draft[id]) return
    const blank: Record<string, string> = {}
    for (const f of form.fields) blank[f.name] = f.name === form.key ? id : toInput(undefined, kindOf(f.type))
    setDraft((d) => ({ ...d, [id]: blank }))
    setAdded((a) => [...a, id])
  }

  const ids = [...form.rows.map((r) => rowId(r, form.key)), ...added]
  /* A transaction has a size and a CPU ceiling, and a run that trips either
     takes none of its steps. Twenty-five is well inside both. */
  const advanceRuns = Math.min(ADVANCE_MAX, Math.max(0, Math.floor(Number(times) || 0)))

  return (
    <section className="section">
      <h2 className="dao-h2">
        stages <span className="dao-dim">{form.action}</span>
      </h2>
      <p className="dao-dim">
        One row per step of a tournament, in <code>{form.key}</code> order. <code>{form.action}</code> writes a
        single stage and creates one that is not there yet, so each row saves on its own.
      </p>

      {form.advance ? (
        <div className="ale-advance">
          <div className="ale-form">
            {form.advance.map((f) => (
              <label key={f.name} className="ale-field">
                <span className="ale-field__name">
                  {f.name}
                  <i>{f.type}</i>
                </span>
                <input
                  type="number"
                  step="1"
                  value={usage}
                  spellCheck={false}
                  onChange={(e) => setUsage(e.target.value)}
                />
              </label>
            ))}
            <label className="ale-field">
              <span className="ale-field__name">
                times
                <i>steps in one transaction</i>
              </span>
              <input
                type="number"
                min="1"
                max={String(ADVANCE_MAX)}
                step="1"
                value={times}
                onChange={(e) => setTimes(e.target.value)}
              />
            </label>
          </div>

          <div className="page__actions">
            <button
              className="btn btn--go"
              type="button"
              disabled={!session || busy !== null || !advanceRuns}
              onClick={() => {
                const data: Record<string, unknown> = {}
                for (const f of form.advance ?? []) data[f.name] = Number(usage) || 0
                void send(
                  'advance',
                  data,
                  'advance',
                  `advance ran ${advanceRuns} time${advanceRuns === 1 ? '' : 's'}.`,
                  advanceRuns,
                )
              }}
            >
              {busy === 'advance'
                ? 'Signing…'
                : `Advance ${advanceRuns > 1 ? `${advanceRuns}×` : ''}`.trim()}
            </button>
            <span className="dao-dim">
              {!advanceRuns
                ? 'Say how many steps to run.'
                : advanceRuns > 1
                  ? `${advanceRuns} advance actions in one transaction — all of them or none.`
                  : 'One step through the stages.'}
            </span>
          </div>
        </div>
      ) : null}

      {ids.map((id) => {
        const changed = changedIn(id)
        return (
          <div key={id} className={`ale-stage${isNew(id) ? ' is-new' : ''}`}>
            <h3 className="ale-stage__head">
              <code>{id}</code>{' '}
              <span className="dao-dim">{draft[id]?.step_name || (isNew(id) ? 'new stage' : '')}</span>
            </h3>

            <div className="ale-form">
              {form.fields.map((f) => {
                const kind = kindOf(f.type)
                const was = original(id, f)
                const now = draft[id]?.[f.name] ?? ''
                const moved = now !== was
                return (
                  <label key={f.name} className={`ale-field${moved ? ' is-changed' : ''}`}>
                    <span className="ale-field__name">
                      {f.name}
                      <i>{f.name === form.key ? `${f.type} · the key` : f.type}</i>
                    </span>
                    {kind === 'bool' ? (
                      <select
                        value={now}
                        onChange={(e) => setDraft((d) => ({ ...d, [id]: { ...d[id], [f.name]: e.target.value } }))}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input
                        type={kind === 'number' ? 'number' : 'text'}
                        step="any"
                        value={now}
                        spellCheck={false}
                        /* Retyping the key would write a second stage rather
                           than move this one, so it is fixed once it exists. */
                        readOnly={f.name === form.key && !isNew(id)}
                        onChange={(e) => setDraft((d) => ({ ...d, [id]: { ...d[id], [f.name]: e.target.value } }))}
                      />
                    )}
                    {moved && !isNew(id) ? (
                      <span className="ale-field__was">
                        was <code>{was || '(empty)'}</code>
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>

            <div className="page__actions">
              <button
                className="btn btn--go"
                type="button"
                disabled={!session || busy !== null || (!changed && !isNew(id))}
                onClick={() => save(id)}
              >
                {busy === id ? 'Signing…' : isNew(id) ? 'Create stage' : changed ? `Save ${changed}` : 'No changes'}
              </button>
              {form.remove && !isNew(id) ? (
                <button
                  className="btn"
                  type="button"
                  disabled={!session || busy !== null}
                  title={`Remove stage ${id} from ${contract}`}
                  onClick={() => {
                    if (confirm(`Delete stage ${id} (${draft[id]?.step_name || 'unnamed'})? This cannot be undone.`))
                      void send(
                        form.remove as string,
                        { wallet: String(session?.actor ?? ''), [form.key]: Number(id) },
                        id,
                        `Stage ${id} deleted.`,
                      )
                  }}
                >
                  Delete
                </button>
              ) : null}
              {isNew(id) ? (
                <button
                  className="btn"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setAdded((a) => a.filter((x) => x !== id))
                    setDraft((d) => {
                      const { [id]: _gone, ...rest } = d
                      return rest
                    })
                  }}
                >
                  Discard
                </button>
              ) : null}
            </div>
          </div>
        )
      })}

      <div className="page__actions">
        <button className="btn" type="button" onClick={addStage} disabled={busy !== null}>
          Add a stage
        </button>
        <button className="btn" type="button" onClick={read} disabled={busy !== null}>
          Re-read
        </button>
        <span className="dao-dim">
          {session ? 'Each stage is written on its own.' : 'Connect a wallet to change a stage.'}
        </span>
      </div>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}
    </section>
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
