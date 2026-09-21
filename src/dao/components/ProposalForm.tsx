import { useEffect, useState } from 'react'
import {
  PROPOSAL_DAYS,
  blankDraftAction,
  decodeProposal,
  proposeActions,
  type DraftAction,
} from '../chain/propose'
import { isCancel, readableError } from '../chain/act'
import { getAbi, msigDescription, msigTitle, type MsigProposal } from '../chain/proposals'
import { TLM_CONTRACT, TLM_SYMBOL, type Dao } from '../chain/daos'
import {
  actionNames,
  actionShape,
  blankOf,
  hintFor,
  isSimpleList,
  problemsOf,
  scalarProblem,
  tidy,
  type AbiDef,
  type Shape,
} from '../chain/abiform'
import { fmtAmount } from '../format'
import { useSession } from '../../wallet/session'

/**
 * Writing a council proposal, from scratch or from an existing one.
 *
 * Two kinds, because councils raise two kinds:
 *
 *   A PAYMENT — nearly every proposal on chain. Across the syndicates, three
 *   in four are one `alien.worlds::transfer` out of the council's own account,
 *   so that is the default and it asks only what differs: who, how much, and
 *   the memo.
 *
 *   CUSTOM ACTIONS — anything else. Name the contract, pick one of the
 *   actions its ABI offers, and fill in the arguments as fields generated from
 *   that same ABI. A field the ABI cannot make a sensible box for gets a JSON
 *   box of its own, and every action can drop to raw JSON when that is easier.
 *
 * Copying is the same form prefilled — most proposals are last month's with a
 * number changed — and a copied payment opens as a payment.
 */
type Mode = 'payment' | 'custom'

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
  const [mode, setMode] = useState<Mode>('payment')
  const [title, setTitle] = useState(from ? `Copy of ${msigTitle(from)}` : '')
  const [description, setDescription] = useState(from ? msigDescription(from) : '')
  const [days, setDays] = useState(String(PROPOSAL_DAYS))
  const [pay, setPay] = useState({ to: '', amount: '', memo: '' })
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
        const payment = actions.length === 1 ? asPayment(dao, actions[0]) : null
        if (payment) {
          setMode('payment')
          setPay(payment)
        } else {
          setMode('custom')
          setRows(actions.length ? actions : [blankDraftAction()])
        }
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
    setRows((prev) => prev.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  /* ---- the payment, checked as it is typed ---- */
  const payer = dao.owner
  const amount = Number(pay.amount)
  const badTo = pay.to ? scalarProblem('name', pay.to) : null
  const badAmount =
    pay.amount && (!Number.isFinite(amount) || amount <= 0 || !/^\d+(\.\d{1,4})?$/.test(pay.amount.trim()))
      ? 'a positive amount, up to four decimals'
      : null
  /* The balance on the directory is the SPENDING account's. For a syndicate
     that is the council's own account and the number is the one that
     matters; for a union they differ, and quoting the wrong balance would be
     worse than quoting none. */
  const balance = dao.treasury === payer && dao.tlm ? Number(String(dao.tlm).split(' ')[0]) : null
  const short = balance != null && Number.isFinite(amount) && amount > balance

  const submit = async () => {
    if (!session || busy) return
    if (!payer) return setNote({ text: 'This council has no owner account to propose against.', bad: true })
    if (!title.trim()) return setNote({ text: 'Give it a title — it is what the council will see.', bad: true })

    let actions: DraftAction[]
    if (mode === 'payment') {
      if (!pay.to || badTo) return setNote({ text: 'Who is it paying? That needs a valid account name.', bad: true })
      if (!pay.amount || badAmount) return setNote({ text: 'How much? A positive amount of TLM, up to four decimals.', bad: true })
      actions = [
        {
          account: TLM_CONTRACT,
          name: 'transfer',
          data: JSON.stringify({ from: payer, to: pay.to, quantity: `${amount.toFixed(4)} ${TLM_SYMBOL}`, memo: pay.memo }),
        },
      ]
    } else {
      const used = rows.filter((r) => r.account.trim() && r.name.trim())
      if (!used.length) return setNote({ text: 'A proposal needs at least one action.', bad: true })
      /* The fields hold exactly what was typed, so typing is never fought —
         a trailing space mid-way through "1.0000 TLM" survives, and so does
         Enter in a one-per-line list. Tidied once, here, against the same ABI
         the fields came from. */
      try {
        actions = await Promise.all(used.map(tidyRow))
      } catch (err) {
        return setNote({ text: readableError(err), bad: true })
      }
    }

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
        actions.map((r) => ({ ...r, account: r.account.trim(), name: r.name.trim() })),
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
        <div className="sections dao-tabs dao-tabs--sm" role="tablist" aria-label="Kind of proposal">
          <button type="button" role="tab" aria-selected={mode === 'payment'} onClick={() => setMode('payment')}>
            Payment
          </button>
          <button type="button" role="tab" aria-selected={mode === 'custom'} onClick={() => setMode('custom')}>
            Custom actions
          </button>
        </div>
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

      {decoding ? <p className="dao-dim">Reading the original…</p> : null}

      {mode === 'payment' && !decoding ? (
        <>
          <div className="ale-form">
            <label className="ale-field">
              <span className="ale-field__name">
                Pay to<i>the account that receives it</i>
              </span>
              <input
                type="text"
                value={pay.to}
                placeholder="account name"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setPay({ ...pay, to: e.target.value.trim().toLowerCase() })}
              />
              {badTo ? <span className="cp-bad">{badTo}</span> : null}
            </label>
            <label className="ale-field">
              <span className="ale-field__name">
                Amount<i>TLM</i>
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={pay.amount}
                placeholder="0.0000"
                onChange={(e) => setPay({ ...pay, amount: e.target.value.replace(',', '.') })}
              />
              {badAmount ? <span className="cp-bad">{badAmount}</span> : null}
            </label>
          </div>
          <label className="ale-field">
            <span className="ale-field__name">
              Memo<i>optional — tlmsplitting reads it as the accounts to split between</i>
            </span>
            <input type="text" value={pay.memo} spellCheck={false} onChange={(e) => setPay({ ...pay, memo: e.target.value })} />
          </label>
          <p className={short ? 'dao-note dao-note--bad' : 'dao-dim'}>
            Paid from <code>{payer ?? '—'}</code>
            {balance != null ? <>, which holds {fmtAmount(`${balance} TLM`)} TLM today</> : null}.{' '}
            {short
              ? 'That is more than it holds — the council can still sign it, but it will only execute once there is enough in the account, for instance after the budget is claimed.'
              : `${dao.approvalThreshold} council signatures send it.`}
          </p>
        </>
      ) : null}

      {mode === 'custom' && !decoding ? (
        <>
          <h3 className="ale-field__name">
            Actions<i>{`${rows.length} action${rows.length === 1 ? '' : 's'}, run in order`}</i>
          </h3>

          {rows.map((r, i) => (
            <ActionEditor
              key={i}
              dao={dao}
              row={r}
              canRemove={rows.length > 1}
              onChange={(patch) => setRow(i, patch)}
              onRemove={() => setRows(rows.filter((_, n) => n !== i))}
            />
          ))}

          <div className="page__actions">
            <button className="btn" type="button" onClick={() => setRows([...rows, blankDraftAction()])}>
              Add another action
            </button>
          </div>

          <p className="dao-dim">
            Every action is authorised by <code>{payer ?? '—'}</code>, which is what the council&rsquo;s{' '}
            {dao.approvalThreshold} signatures satisfy. Nothing runs until they are collected.
          </p>
        </>
      ) : null}

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!session || busy || decoding} onClick={submit}>
          {busy ? 'Signing…' : 'Create proposal'}
        </button>
        {!session ? <span className="dao-dim">Connect a wallet to raise a proposal.</span> : null}
      </div>
    </section>
  )
}

/** One custom action with its blank optionals nulled and its values trimmed. */
async function tidyRow(r: DraftAction): Promise<DraftAction> {
  const account = r.account.trim()
  const name = r.name.trim()
  let data: unknown
  try {
    data = JSON.parse(r.data)
  } catch (err) {
    throw new Error(`${account}::${name} — arguments are not valid JSON: ${(err as Error).message}`)
  }
  const abi = (await getAbi(account)) as AbiDef | null
  const shape = abi ? actionShape(abi, name) : null
  const problems = shape ? problemsOf(shape, data) : []
  if (problems.length) {
    throw new Error(`${account}::${name} — ${problems.map((p) => `${p.path}: ${p.problem}`).join('; ')}`)
  }
  return { account, name, data: JSON.stringify(shape ? tidy(shape, data) : data) }
}

/** A copied action that is just a TLM payment out of the council's account. */
function asPayment(dao: Dao, a: DraftAction): { to: string; amount: string; memo: string } | null {
  if (a.account !== TLM_CONTRACT || a.name !== 'transfer') return null
  try {
    const d = JSON.parse(a.data) as { from?: string; to?: string; quantity?: string; memo?: string }
    const [amount, symbol] = String(d.quantity ?? '').split(' ')
    if (d.from !== dao.owner || symbol !== TLM_SYMBOL) return null
    return { to: String(d.to ?? ''), amount: String(Number(amount)), memo: String(d.memo ?? '') }
  } catch {
    return null
  }
}

/* ---------------- one custom action ---------------- */

/**
 * A contract's ABI, read once the account box holds something that could be
 * an account, and not on every keystroke on the way there.
 */
function useAbi(account: string) {
  const [state, setState] = useState<{ for: string; abi: AbiDef | null; error?: string } | null>(null)
  const name = account.trim()
  const plausible = /^[a-z1-5.]{1,12}[a-j1-5.]?$/.test(name)

  useEffect(() => {
    if (!plausible) return setState(null)
    let alive = true
    const t = setTimeout(() => {
      void getAbi(name)
        .then((abi) => alive && setState({ for: name, abi: (abi as AbiDef) ?? null }))
        .catch((err: unknown) => alive && setState({ for: name, abi: null, error: readableError(err) }))
    }, 350)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [name, plausible])

  return {
    abi: state?.for === name ? state.abi : null,
    loading: plausible && state?.for !== name,
    error: state?.for === name ? (state.error ?? (state.abi ? null : `No contract is deployed on ${name}.`)) : null,
  }
}

function parseData(data: string): { value: unknown; ok: boolean } {
  try {
    return { value: JSON.parse(data), ok: true }
  } catch {
    return { value: null, ok: false }
  }
}

function ActionEditor({
  dao,
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  dao: Dao
  row: DraftAction
  canRemove: boolean
  onChange: (patch: Partial<DraftAction>) => void
  onRemove: () => void
}) {
  const { abi, loading, error } = useAbi(row.account)
  const names = actionNames(abi)
  const shape = abi && row.name ? actionShape(abi, row.name) : null
  const parsed = parseData(row.data)
  const [asJson, setAsJson] = useState(false)

  /* The data as the form sees it: whatever parses, laid over a blank of the
     action's shape so every field exists even before it is touched. */
  const value =
    shape?.kind === 'struct' && parsed.ok && parsed.value && typeof parsed.value === 'object'
      ? { ...(blankOf(shape) as object), ...(parsed.value as object) }
      : shape
        ? blankOf(shape)
        : null
  const problems = shape && !asJson ? problemsOf(shape, value) : []

  /* Two arguments with only one right answer inside a council's own
     proposal: which DAC it is about, and — for anything that moves tokens —
     that they move out of the account the council's signatures stand for. */
  const pick = (name: string) => {
    const next = abi ? actionShape(abi, name) : null
    const blank = (next ? blankOf(next) : {}) as Record<string, unknown>
    if (next?.kind === 'struct') {
      for (const f of next.fields) {
        if (f.shape.kind !== 'scalar' || f.shape.type !== 'name') continue
        if (f.name === 'dac_id') blank[f.name] = dao.id
        if (f.name === 'from' && dao.owner) blank[f.name] = dao.owner
      }
    }
    onChange({ name, data: JSON.stringify(blank, null, 2) })
  }

  return (
    <div className="cp-action">
      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Contract<i>the account the action runs on</i>
          </span>
          <input
            type="text"
            value={row.account}
            placeholder="alien.worlds"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => onChange({ account: e.target.value.trim().toLowerCase() })}
          />
          {loading ? <span className="dao-dim">Reading its actions…</span> : error ? <span className="cp-bad">{error}</span> : null}
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Action<i>{names.length ? `${names.length} on this contract` : 'name a contract first'}</i>
          </span>
          <select value={names.includes(row.name) ? row.name : ''} disabled={!names.length} onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>
              {names.length ? 'Pick an action…' : row.name || '—'}
            </option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {row.name && abi && !names.includes(row.name) ? (
            <span className="cp-bad">{row.account} has no action called {row.name}</span>
          ) : null}
        </label>
        <div className="ale-field">
          <span className="ale-field__name">&nbsp;</span>
          <button className="btn" type="button" disabled={!canRemove} onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      {shape && !asJson ? (
        <>
          <ShapeFields
            shape={shape}
            value={value}
            onChange={(next) => onChange({ data: JSON.stringify(next, null, 2) })}
          />
          <p className="cp-foot">
            {problems.length ? (
              <span className="cp-bad">
                {problems
                  .slice(0, 3)
                  .map((p) => `${p.path}: ${p.problem}`)
                  .join(' · ')}
                {problems.length > 3 ? ` · and ${problems.length - 3} more` : ''}
              </span>
            ) : (
              <span className="dao-dim">Ready to serialise.</span>
            )}
            <button className="cp-link" type="button" onClick={() => setAsJson(true)}>
              Edit as JSON
            </button>
          </p>
        </>
      ) : row.name || row.data.trim() !== '{}' ? (
        <label className="ale-field">
          <span className="ale-field__name">
            Arguments<i>JSON, serialised against the contract&rsquo;s own ABI</i>
            {shape ? (
              <button className="cp-link" type="button" disabled={!parsed.ok} onClick={() => setAsJson(false)}>
                {parsed.ok ? 'Back to fields' : 'fix the JSON to go back to fields'}
              </button>
            ) : null}
          </span>
          <textarea
            rows={Math.min(16, (row.data.match(/\n/g)?.length ?? 0) + 3)}
            value={row.data}
            spellCheck={false}
            onChange={(e) => onChange({ data: e.target.value })}
          />
        </label>
      ) : null}
    </div>
  )
}

/* ---------------- fields from a shape ---------------- */

function ShapeFields({ shape, value, onChange }: { shape: Shape; value: unknown; onChange: (v: unknown) => void }) {
  if (shape.kind !== 'struct') return <Field label="value" shape={shape} value={value} onChange={onChange} />
  if (!shape.fields.length) return <p className="dao-dim">This action takes no arguments.</p>
  const obj = (value ?? {}) as Record<string, unknown>
  return (
    <div className="ale-form cp-fields">
      {shape.fields.map((f) => (
        <Field key={f.name} label={f.name} shape={f.shape} value={obj[f.name]} onChange={(v) => onChange({ ...obj, [f.name]: v })} />
      ))}
    </div>
  )
}

const typeLabel = (s: Shape): string =>
  s.kind === 'scalar'
    ? s.type
    : s.kind === 'bool'
      ? 'bool'
      : s.kind === 'struct'
        ? s.name
        : s.kind === 'list'
          ? `list of ${typeLabel(s.of)}`
          : s.kind === 'optional'
            ? `${typeLabel(s.of)}, optional`
            : s.type

function Field({ label, shape, value, onChange }: { label: string; shape: Shape; value: unknown; onChange: (v: unknown) => void }) {
  const inner = shape.kind === 'optional' ? shape.of : shape
  const optional = shape.kind === 'optional'

  if (inner.kind === 'bool') {
    return (
      <label className="ale-field cp-check">
        <span className="ale-field__name">
          {label}
          <i>{typeLabel(shape)}</i>
        </span>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </label>
    )
  }

  if (inner.kind === 'scalar') {
    const text = value == null ? '' : String(value)
    const problem = text || !optional ? (text ? scalarProblem(inner.type, text) : null) : null
    const long = inner.type === 'string' && (label === 'memo' || label.includes('desc') || text.length > 60)
    return (
      <label className="ale-field">
        <span className="ale-field__name">
          {label}
          <i>{typeLabel(shape)}</i>
        </span>
        {long ? (
          <textarea rows={2} value={text} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input
            type="text"
            value={text}
            placeholder={hintFor(inner.type)}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => onChange(optional && !e.target.value ? null : e.target.value)}
          />
        )}
        {problem ? <span className="cp-bad">{problem}</span> : null}
      </label>
    )
  }

  if (inner.kind === 'struct') {
    return (
      <fieldset className="cp-group">
        <legend className="ale-field__name">
          {label}
          <i>{typeLabel(shape)}</i>
        </legend>
        <ShapeFields shape={inner} value={value ?? blankOf(inner)} onChange={onChange} />
      </fieldset>
    )
  }

  if (isSimpleList(inner)) {
    const list = Array.isArray(value) ? value.map(String) : []
    return (
      <label className="ale-field">
        <span className="ale-field__name">
          {label}
          <i>{typeLabel(shape)} — one per line</i>
        </span>
        <textarea
          rows={Math.min(8, Math.max(2, list.length + 1))}
          value={list.join('\n')}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value.split('\n'))}
        />
      </label>
    )
  }

  return <JsonField label={label} type={typeLabel(shape)} value={value} onChange={onChange} />
}

/**
 * One argument the ABI cannot make a sensible box for — a variant, a list of
 * structs. Its own text is kept while it does not parse, so typing through an
 * invalid middle state does not throw what was typed away.
 */
function JsonField({ label, type, value, onChange }: { label: string; type: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => (value == null ? '' : JSON.stringify(value, null, 2)))
  const [bad, setBad] = useState(false)
  return (
    <label className="ale-field cp-wide">
      <span className="ale-field__name">
        {label}
        <i>{type} — as JSON</i>
      </span>
      <textarea
        rows={Math.min(10, (text.match(/\n/g)?.length ?? 0) + 2)}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          if (!e.target.value.trim()) {
            setBad(false)
            return onChange(null)
          }
          try {
            onChange(JSON.parse(e.target.value))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
      />
      {bad ? <span className="cp-bad">not valid JSON yet</span> : null}
    </label>
  )
}
