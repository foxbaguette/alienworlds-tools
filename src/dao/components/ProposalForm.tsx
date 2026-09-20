import { useEffect, useState } from 'react'
import {
  PROPOSAL_DAYS,
  blankDraftAction,
  decodeProposal,
  proposeActions,
  type DraftAction,
} from '../chain/propose'
import { isCancel, readableError } from '../chain/act'
import { msigDescription, msigTitle, type MsigProposal } from '../chain/proposals'
import { useSession } from '../../wallet/session'
import type { Dao } from '../chain/daos'

/**
 * Writing a council proposal, from scratch or from an existing one.
 *
 * Copying is the same form prefilled, which is the whole reason it is worth
 * having: most proposals a council raises are last month's with a number
 * changed, and retyping a transfer's arguments from a block explorer is how
 * mistakes get in.
 *
 * Arguments stay as JSON rather than becoming generated fields. The ABI would
 * give enough to build a form per action, but an action's arguments are often
 * nested — a transfer's memo, an extended_asset — and a half-built form is
 * harder to trust than the JSON it came from.
 */
export function ProposalForm({
  dao,
  from,
  onDone,
  onClose,
}: {
  dao: Dao
  /** The proposal being copied, if this is a copy. */
  from?: MsigProposal | null
  onDone: () => Promise<void> | void
  onClose: () => void
}) {
  const { session } = useSession()
  const [title, setTitle] = useState(from ? `Copy of ${msigTitle(from)}` : '')
  const [description, setDescription] = useState(from ? msigDescription(from) : '')
  const [days, setDays] = useState(String(PROPOSAL_DAYS))
  const [rows, setRows] = useState<DraftAction[]>([blankDraftAction()])
  const [decoding, setDecoding] = useState(!!from)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  useEffect(() => {
    if (!from) return
    let alive = true
    setDecoding(true)
    void decodeProposal(from)
      .then((actions) => {
        if (!alive) return
        setRows(actions.length ? actions : [blankDraftAction()])
        setDecoding(false)
      })
      .catch((err: unknown) => {
        console.error('Could not read the source proposal:', err)
        if (!alive) return
        setDecoding(false)
        setNote({ text: `Could not decode that proposal: ${readableError(err)}`, bad: true })
      })
    return () => {
      alive = false
    }
  }, [from?.proposal_name])

  const setRow = (i: number, patch: Partial<DraftAction>) =>
    setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  const submit = async () => {
    if (!session || busy) return
    if (!dao.owner) return setNote({ text: 'This council has no owner account to propose against.', bad: true })
    if (!title.trim()) return setNote({ text: 'Give it a title — it is what the council will see.', bad: true })
    const usable = rows.filter((r) => r.account.trim() && r.name.trim())
    if (!usable.length) return setNote({ text: 'A proposal needs at least one action.', bad: true })

    const n = Math.min(90, Math.max(1, Math.round(Number(days) || PROPOSAL_DAYS)))

    setBusy(true)
    setNote({ text: 'Building the proposal — check your wallet…' })
    try {
      const level = {
        actor: String(session.actor),
        permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
      }
      const action = await proposeActions(
        level,
        dao,
        usable.map((r) => ({ ...r, account: r.account.trim(), name: r.name.trim() })),
        { title: title.trim(), description: description.trim(), days: n },
      )
      await session.transact({ actions: [action] }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      await onDone()
      setNote({ text: `Raised in ${dao.title}. ${dao.approvalThreshold} signatures execute it.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('Create failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section cp-form">
      <div className="page__actions">
        <h2 className="dao-h2">
          {from ? 'Copy a proposal' : 'New proposal'} <span className="dao-dim">{dao.title}</span>
        </h2>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Title<i>what the council sees in its list</i>
          </span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Days to sign<i>1 to 90; after that it can only be started again</i>
          </span>
          <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      </div>

      <label className="ale-field">
        <span className="ale-field__name">
          Description<i>the case for it</i>
        </span>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <h3 className="ale-field__name">
        Actions
        <i>{decoding ? 'decoding the original…' : `${rows.length} action${rows.length === 1 ? '' : 's'}`}</i>
      </h3>

      {rows.map((r, i) => (
        <div key={i} className="cp-action">
          <div className="ale-form">
            <label className="ale-field">
              <span className="ale-field__name">
                Contract<i>the account the action runs on</i>
              </span>
              <input
                type="text"
                value={r.account}
                placeholder="alien.worlds"
                spellCheck={false}
                onChange={(e) => setRow(i, { account: e.target.value })}
              />
            </label>
            <label className="ale-field">
              <span className="ale-field__name">
                Action<i>its name on that contract</i>
              </span>
              <input
                type="text"
                value={r.name}
                placeholder="transfer"
                spellCheck={false}
                onChange={(e) => setRow(i, { name: e.target.value })}
              />
            </label>
            <div className="ale-field">
              <span className="ale-field__name">&nbsp;</span>
              <button
                className="btn"
                type="button"
                disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((_, n) => n !== i))}
              >
                Remove
              </button>
            </div>
          </div>
          <label className="ale-field">
            <span className="ale-field__name">
              Arguments<i>JSON, serialised against that contract&rsquo;s own ABI</i>
            </span>
            <textarea
              rows={Math.min(16, (r.data.match(/\n/g)?.length ?? 0) + 3)}
              value={r.data}
              spellCheck={false}
              onChange={(e) => setRow(i, { data: e.target.value })}
            />
          </label>
        </div>
      ))}

      <div className="page__actions">
        <button className="btn" type="button" onClick={() => setRows([...rows, blankDraftAction()])}>
          Add another action
        </button>
      </div>

      <p className="dao-dim">
        Every action is authorised by <code>{dao.owner ?? '—'}</code>, which is what the council&rsquo;s{' '}
        {dao.approvalThreshold} signatures satisfy. Nothing runs until they are collected.
      </p>

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!session || busy || decoding} onClick={submit}>
          {busy ? 'Signing…' : 'Create proposal'}
        </button>
        {!session ? <span className="dao-dim">Connect a wallet to raise a proposal.</span> : null}
      </div>
    </section>
  )
}
