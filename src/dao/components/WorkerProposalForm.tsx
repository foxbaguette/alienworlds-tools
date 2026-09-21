import { useEffect, useRef, useState } from 'react'
import {
  createPropActions,
  fetchArbiters,
  uploadToIpfs,
  wpFeeShortfall,
  type Arbiter,
  type WorkerData,
  type WorkerDraft,
} from '../chain/worker'
import { isCancel, readableError } from '../chain/act'
import { useSession } from '../../wallet/session'
import type { Dao } from '../chain/daos'

/**
 * Raising a worker proposal.
 *
 * Everything `createprop` refuses is checked before the wallet is opened — the
 * whitelist, the member terms, the arbiter's rating, the two pay amounts — and
 * said as a sentence. The contract's own refusals arrive as an assertion code
 * in a wallet dialog, which is no way to learn that somebody has to add you to
 * a whitelist first.
 *
 * The fee is the other thing that is not obvious: it comes out of a deposit
 * prop.worlds holds per account, not out of the wallet, so an account with no
 * deposit raises a proposal in two actions rather than one.
 */
export function WorkerProposalForm({
  dao,
  wp,
  onDone,
  onClose,
}: {
  dao: Dao
  wp: WorkerData
  onDone: () => Promise<void> | void
  onClose: () => void
}) {
  const { session, actor } = useSession()
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<WorkerDraft>({
    title: '',
    summary: '',
    url: '',
    arbiter: wp.arbiters[0]?.arbiter ?? '',
    pay: '',
    arbiterPay: '',
    days: 7,
    category: 0,
  })
  /* The whitelist as it stands now, not as it stood when the page loaded:
     the custodians can add, remove and re-rate arbiters at any time. The
     cached list is shown until the fresh one arrives. */
  const [arbiters, setArbiters] = useState<Arbiter[]>(wp.arbiters)
  const [arbitersFresh, setArbitersFresh] = useState(false)
  useEffect(() => {
    let alive = true
    void fetchArbiters(dao.id)
      .then((list) => {
        if (!alive) return
        setArbiters(list)
        setArbitersFresh(true)
        /* A picked arbiter who has since left the whitelist is dropped. */
        setDraft((d) => (list.some((a) => a.arbiter === d.arbiter) ? d : { ...d, arbiter: list[0]?.arbiter ?? '' }))
      })
      .catch((err: unknown) => console.error('arbiters:', err))
    return () => {
      alive = false
    }
  }, [dao.id])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const set = (patch: Partial<WorkerDraft>) => setDraft({ ...draft, ...patch })

  const fee = wp.config.proposal_fee
  const short = wpFeeShortfall(wp)
  const sym = String(fee?.quantity ?? '').split(' ')[1] ?? 'TLM'

  /* Everything the contract checks, stated before anything is signed. */
  const blocks: string[] = []
  if (!session || !actor) blocks.push('Connect a wallet to raise a proposal.')
  else {
    if (!wp.receivers.has(actor)) {
      blocks.push(
        `${actor} is not on this DAO’s receiver whitelist, which createprop requires of the proposer. ` +
          'A custodian has to add you with addrecwl first.',
      )
    }
    if (wp.member === false) {
      blocks.push(`${actor} has not agreed to the latest member terms (version ${wp.latestTerms}).`)
    }
    if (arbitersFresh && !arbiters.length) blocks.push('This DAO has no active arbiter on its whitelist.')
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setNote({ text: `Pinning ${file.name}…` })
    try {
      const { cid, already } = await uploadToIpfs(file)
      set({ url: cid })
      setNote({ text: already ? `${file.name} was already pinned — using its CID.` : `${file.name} pinned as ${cid}.` })
    } catch (err) {
      console.error('IPFS upload failed:', err)
      setNote({ text: `Could not upload ${file.name}: ${readableError(err)}`, bad: true })
    } finally {
      setUploading(false)
    }
  }

  const submit = async () => {
    if (!session || busy) return
    const level = {
      actor: String(session.actor),
      permission: session.permissionLevel.permission ? String(session.permissionLevel.permission) : 'active',
    }
    const built = createPropActions(level, dao, wp, draft)
    if (typeof built === 'string') return setNote({ text: built, bad: true })

    setBusy(true)
    setNote({ text: 'Raising the proposal — check your wallet…' })
    try {
      await session.transact({ actions: built }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      await onDone()
      setNote({ text: `Raised “${draft.title.trim()}”. The council votes on it next.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('createprop failed:', err)
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
          New worker proposal <span className="dao-dim">{dao.title}</span>
        </h2>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>

      {blocks.map((b) => (
        <p key={b} className="dao-note dao-note--bad">
          {b}
        </p>
      ))}
      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Title<i>what the job is</i>
          </span>
          <input type="text" maxLength={255} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Arbiter<i>settles a dispute; cannot be you</i>
          </span>
          <select value={draft.arbiter} onChange={(e) => set({ arbiter: e.target.value })}>
            {arbiters.length ? (
              arbiters.map((a) => (
                <option key={a.arbiter} value={a.arbiter}>
                  {a.rating > 0 ? a.arbiter : `${a.arbiter} · rating 0`}
                </option>
              ))
            ) : (
              <option value="">none available</option>
            )}
          </select>
        </label>
      </div>

      <label className="ale-field">
        <span className="ale-field__name">
          Summary<i>a few lines the council reads first</i>
        </span>
        <textarea rows={4} value={draft.summary} onChange={(e) => set({ summary: e.target.value })} />
      </label>

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Pay<i>in {sym}, to you, on completion</i>
          </span>
          <input type="text" inputMode="decimal" value={draft.pay} onChange={(e) => set({ pay: e.target.value })} />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Arbiter pay<i>must be above zero</i>
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.arbiterPay}
            onChange={(e) => set({ arbiterPay: e.target.value })}
          />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Job duration<i>days</i>
          </span>
          <input
            type="number"
            min={1}
            value={draft.days}
            onChange={(e) => set({ days: Number(e.target.value) || 1 })}
          />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Category<i>a number the council uses to group work</i>
          </span>
          <input
            type="number"
            min={0}
            value={draft.category}
            onChange={(e) => set({ category: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <label className="ale-field">
        <span className="ale-field__name">
          Document<i>an IPFS CID, or a link to the full proposal</i>
        </span>
        <div className="wp-doc">
          <input type="text" value={draft.url} spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
          <button
            className="btn"
            type="button"
            disabled={uploading}
            title="Pin a file to IPFS and fill the field with its CID"
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              void upload(e.target.files?.[0])
              /* Cleared so re-picking the same file after a failure still fires. */
              e.target.value = ''
            }}
          />
        </div>
      </label>

      {fee ? (
        <p className="dao-dim">
          This DAO charges <b>{fee.quantity}</b> to raise a proposal, taken from your deposit with{' '}
          <code>prop.worlds</code> rather than from your wallet
          {short ? (
            <>
              , and that deposit is short — <b>{short.quantity}</b> will be transferred in the same transaction.
            </>
          ) : (
            <>, already covered by your deposit.</>
          )}
        </p>
      ) : null}

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!session || busy || !!blocks.length} onClick={submit}>
          {busy ? 'Signing…' : 'Raise proposal'}
        </button>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  )
}
