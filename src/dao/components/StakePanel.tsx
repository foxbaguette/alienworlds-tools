import { useEffect, useState } from 'react'
import {
  assetUnits,
  buyActions,
  cancelAction,
  claimAction,
  sellAction,
  stakeAction,
  fetchMemberTerms,
  mustAgree,
  stakeAndVoteActions,
  stakeTimeAction,
  toAsset,
  unstakeAction,
  TLM_SYMBOL,
  type MemberTerms,
  type Position,
  type StakeConfig,
} from '../chain/stake'
import { isCancel, readableError, type ChainAction } from '../chain/act'
import { candidacyOf, withdrawBlocker, withdrawCandidacyAction } from '../chain/candidacy'
import { voteBlocker } from '../chain/votes'
import { fmtAmount, fmtDays, isoMinute } from '../format'
import { ensureStakeConfig } from '../usePosition'
import { Overlay } from '../../components/Overlay'
import { useSession } from '../../wallet/session'
import type { Dao } from '../chain/daos'

/**
 * Which block a signed transaction landed in.
 *
 * Read defensively: what a wallet hands back differs between them, and the
 * figure is an optimisation — knowing it means the panel can wait for the
 * chain instead of guessing at a pause. Not knowing it should not break
 * signing, so a wallet that says nothing simply reads back straight away.
 */
const blockOf = (result: unknown): number | undefined => {
  const processed = (result as { response?: { processed?: { block_num?: number | string } } })?.response
    ?.processed
  const n = Number(processed?.block_num)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

type Op = 'stake' | 'unstake' | 'buy' | 'sell' | 'delay' | 'stakevote' | 'withdraw'

const OPS: { key: Op; label: string; blurb: string }[] = [
  { key: 'stake', label: 'Stake', blurb: 'Locks tokens you hold. Staked tokens are what your vote weighs.' },
  { key: 'unstake', label: 'Unstake', blurb: 'Starts the delay. The tokens come back when it runs out.' },
  { key: 'buy', label: 'TLM → token', blurb: 'Converts Trilium into this DAO’s token, one for one.' },
  { key: 'sell', label: 'Token → TLM', blurb: 'Burns the token and refunds Trilium, one for one.' },
  { key: 'delay', label: 'Unstake delay', blurb: 'How long a future unstake waits. A longer delay weighs more.' },
  {
    key: 'stakevote',
    label: 'Stake and vote',
    blurb:
      'Trilium in, staked, the delay set and a slate cast — in one transaction, so it all happens or none of it does.',
  },
  {
    key: 'withdraw',
    label: 'Unregister as candidate',
    blurb: 'Stops standing for this council. The stake stays where it is, and can then be unstaked.',
  },
]

/**
 * Everything one account can do in a DAO.
 *
 * Mostly its token: staking, unstaking, converting either way, and the delay
 * a future unstake waits. They are one panel rather than a button each because
 * they all read the same position, and after any of them that position has to
 * be re-read.
 *
 * Standing for the council is the exception — it is about candidacy rather
 * than a balance — but it belongs here all the same, because the chain ties
 * the two together: `stakeobsv` will not let a registered candidate unstake
 * anything at all, so withdrawing is the step that unblocks the button beside
 * it. It opens over the page rather than
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
  /* Given the block its transaction landed in, so the figures it reads back
     are from after it rather than from whichever node answered first. */
  onDone: (block?: number) => Promise<void> | void
  onClose: () => void
}) {
  const { session } = useSession()
  const [op, setOp] = useState<Op | null>(null)
  const [amount, setAmount] = useState('')
  const [days, setDays] = useState('')
  const [config, setConfig] = useState<StakeConfig | null>(null)
  /* One box per seat the contract allows, so the slate cannot be too long. */
  const [slate, setSlate] = useState<string[]>([])
  /* The DAO's member terms, and whether this account has agreed to them. */
  const [terms, setTerms] = useState<MemberTerms | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  useEffect(() => {
    void ensureStakeConfig(dao).then(setConfig)
  }, [dao.id])

  useEffect(() => {
    setTerms(null)
    setAgreed(false)
    if (!session) return
    void fetchMemberTerms(dao, String(session.actor)).then(setTerms).catch((err: unknown) => {
      console.error('member terms:', err)
    })
  }, [dao.id, session])

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
      const result = await session.transact({ actions }, { broadcast: true })
      await onDone(blockOf(result))
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

  /*
    The delay this account may not go below.

    Lowering it would cut the weight behind a vote being cast in the same
    breath, so the floor here is whatever is already set rather than the
    contract's own minimum — which is only the floor for somebody who has
    never chosen one.
  */
  const delayFloor = Math.max(position?.delay ?? 0, config?.min ?? 0)
  /* What the contract will take, not what looks right: maxvotes is two on
     every council today, and votecust refuses a longer slate. */
  const seats = dao.maxVotes || 2

  const standing = dao.candidates.filter((c) => c.is_active).sort((a, b) => Number(b.rank) - Number(a.rank))

  /* How this account itself stands here — null while the list is unread. */
  const mine = candidacyOf(dao, session ? String(session.actor) : null)
  const cannotWithdraw = withdrawBlocker(mine)

  const go = () => {
    if (!session) return
    const l = level()

    if (op === 'stakevote') return void stakeAndVote(l)

    if (op === 'withdraw') {
      if (cannotWithdraw) return setNote({ text: cannotWithdraw, bad: true })
      return void sign([withdrawCandidacyAction(l, dao)], `Unregister as a candidate in ${dao.title}`)
    }

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

  /**
   * The whole errand in one transaction.
   *
   * Four steps that only make sense together: Trilium bought, the token
   * staked, the delay set, the slate cast. In one transaction either every
   * step happens or none does — half of this would be Trilium converted into
   * a token sitting unstaked, with a vote never cast.
   *
   * The order is the order the chain needs: nothing can be staked before it
   * exists, and a vote weighs what is staked at the moment it is counted.
   */
  const stakeAndVote = async (l: ReturnType<typeof level>) => {
    if (!swapTarget) return setNote({ text: 'This DAO is not listed for TLM swaps.', bad: true })

    const tlmQty = toAsset(amount, 4, TLM_SYMBOL)
    const tokenQty = toAsset(amount, dao.precision, dao.symbol)
    if (!tlmQty || !tokenQty) return setNote({ text: 'Enter an amount above zero.', bad: true })
    if (assetUnits(tlmQty) > assetUnits(tlm)) {
      return setNote({ text: `You hold ${fmtAmount(tlm ?? '0')}.`, bad: true })
    }

    const n = Number(String(days).trim())
    if (!Number.isFinite(n) || n <= 0) return setNote({ text: 'Enter a number of days.', bad: true })
    const seconds = Math.round(n * 86_400)
    if (seconds < delayFloor) {
      return setNote({ text: `The delay cannot go below ${fmtDays(delayFloor)}.`, bad: true })
    }
    if (config && seconds > config.max) {
      return setNote({ text: `The longest the contract allows is ${fmtDays(config.max)}.`, bad: true })
    }

    /*
      Membership first, or the vote at the end is refused — and refused for
      the whole transaction, the Trilium with it. Three ways to fail it:
      never registered, agreed to nothing, or agreed to terms since
      superseded, which is the one that catches people who believe they are
      already members.
    */
    const needsTerms = mustAgree(terms)
    if (needsTerms && !agreed) {
      return setNote({ text: 'Agree to the member terms to vote here.', bad: true })
    }

    const picked = slate.filter(Boolean)
    if (new Set(picked).size !== picked.length) {
      return setNote({ text: 'Two different candidates.', bad: true })
    }
    if (picked.length !== seats) {
      return setNote({ text: `Choose ${seats} candidate${seats === 1 ? '' : 's'}.`, bad: true })
    }
    /* The contract refuses a slate naming somebody who has withdrawn, and it
       refuses the WHOLE transaction — the stake and the delay with it. */
    for (const name of picked) {
      const why = voteBlocker(dao, name)
      if (why) return setNote({ text: `${name} ${why}.`, bad: true })
    }

    await sign(
      stakeAndVoteActions(l, dao, {
        planet: swapTarget,
        tlm: tlmQty,
        token: tokenQty,
        seconds,
        slate: picked,
        agree: needsTerms ? terms!.hash : null,
      }),
      `Stake ${tokenQty} and vote for ${picked.join(' and ')}`,
    )
    setSlate([])
  }

  const fill = () => {
    if (op === 'stake') return setAmount(String(position?.notStaked ?? '').split(' ')[0])
    if (op === 'unstake') return setAmount(String(position?.staked ?? '').split(' ')[0])
    if (op === 'sell') return setAmount(String(position?.notStaked ?? '').split(' ')[0])
    if (op === 'buy' || op === 'stakevote') return setAmount(String(tlm ?? '').split(' ')[0])
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
              /* The floor, so the box opens at a value the contract will take. */
              setDays(
                position?.delay != null
                  ? String(Math.round((position.delay / 86_400) * 10) / 10)
                  : o.key === 'stakevote' && config
                    ? String(Math.round((config.min / 86_400) * 10) / 10)
                    : '',
              )
              setSlate([])
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {chosen ? (
        <div className="tap-form">
          <p className="dao-dim">{chosen.blurb}</p>

          {op === 'stakevote' ? (
            <>
              <div className="ale-form">
                <label className="ale-field">
                  <span className="ale-field__name">
                    Trilium<i>you hold {tlm ? fmtAmount(tlm) : '0'}</i>
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    placeholder="0"
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="ale-field">
                  <span className="ale-field__name">
                    Unstake delay, days
                    <i>
                      {config
                        ? `${fmtDays(delayFloor)} to ${fmtDays(config.max)}`
                        : 'reading the contract’s range…'}
                    </i>
                  </span>
                  <input
                    type="number"
                    min={Math.round((delayFloor / 86_400) * 10) / 10}
                    step={0.1}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                  />
                </label>
              </div>

              <div className="ale-form">
                {Array.from({ length: seats }, (_, i) => (
                  <label key={i} className="ale-field">
                    <span className="ale-field__name">
                      Candidate {i + 1}
                      <i>{standing.length} standing</i>
                    </span>
                    <select
                      value={slate[i] ?? ''}
                      onChange={(e) =>
                        setSlate((was) => {
                          const next = [...was]
                          next[i] = e.target.value
                          return next
                        })
                      }
                    >
                      <option value="">Choose a candidate…</option>
                      {standing.map((c) => (
                        <option
                          key={c.candidate_name}
                          value={c.candidate_name}
                          /* The same name twice is a slate the chain refuses. */
                          disabled={slate.some((n, j) => j !== i && n === c.candidate_name)}
                        >
                          {c.candidate_name}
                          {dao.custodians.includes(c.candidate_name) ? ' · seated' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              {mustAgree(terms) ? (
                <label className="stake-terms">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>
                    {terms!.agreed == null
                      ? `This account is not a member of ${dao.title}.`
                      : `This account agreed to version ${terms!.agreed}, and ${dao.title} is now on ${terms!.version}.`}{' '}
                    Voting needs the current terms, so signing this agrees to{' '}
                    <a href={`https://ipfs.io/ipfs/${terms!.terms}`} target="_blank" rel="noopener">
                      version {terms!.version} of the member terms
                    </a>{' '}
                    as well.
                  </span>
                </label>
              ) : null}

              {/* Voting replaces a slate rather than adding to it, which is
                  not obvious and is not undoable by looking away. */}
              <p className="dao-note">
                This casts a new slate of {seats}. Whatever this account votes for in {dao.title} now is
                replaced — and the delay can only go up from {fmtDays(delayFloor)}, since lowering it would
                cut the weight behind the vote being cast with it.
              </p>

              {!swapTarget ? (
                <p className="dao-note dao-note--bad">
                  <code>stake.worlds</code> does not list {dao.symbol}, so Trilium cannot be converted here.
                </p>
              ) : null}
            </>
          ) : op === 'withdraw' ? (
            <>
              {mine == null ? (
                <p className="dao-note dao-note--bad">
                  {dao.title}'s candidate list could not be read, so whether this account is standing
                  there cannot be told. Refresh before signing.
                </p>
              ) : !mine.registered ? (
                <p className="dao-note">
                  This account has never stood for {dao.title}, so there is nothing to unregister.
                </p>
              ) : !mine.standing ? (
                <p className="dao-note">
                  This account has already withdrawn from {dao.title}. The row stays on the table for
                  good — every council keeps its withdrawn candidates — but it is not standing.
                </p>
              ) : (
                <>
                  <p className="dao-note">
                    This stops {session ? String(session.actor) : 'this account'} standing for{' '}
                    {dao.title}. Votes cast for it stay on the candidate row, and standing again means{' '}
                    <code>nominatecane</code> with a requested pay — not something this panel does.
                  </p>
                  {mine.seated ? (
                    <p className="dao-note">
                      It does not give up the seat this account holds now. A withdrawn candidate is
                      simply one <code>newperiod</code> will not seat again, so the seat is held until
                      the next election.
                    </p>
                  ) : null}
                  {position?.staked && assetUnits(position.staked) > 0 ? (
                    <p className="dao-note">
                      {fmtAmount(position.staked)} stays staked. Unstaking is what candidacy blocks, so
                      it is this that has to come first.
                    </p>
                  ) : null}
                </>
              )}
            </>
          ) : op === 'delay' ? (
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

          {op === 'unstake' && mine?.standing ? (
            <p className="dao-note dao-note--bad">
              This account is a registered candidate in {dao.title}, and <code>stakeobsv</code> refuses
              an unstake from one. Unregister first — the action beside this one.
            </p>
          ) : null}
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
            <button
              className="btn btn--go"
              type="button"
              disabled={busy || (op === 'withdraw' && (!mine || !!cannotWithdraw))}
              onClick={go}
            >
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
