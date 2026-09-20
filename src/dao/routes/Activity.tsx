import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BIG_AMOUNT,
  BIG_POWER,
  GROUPS,
  KIND_LABEL,
  KIND_TONE,
  councilOf,
  ensureWeights,
  fetchActivity,
  resolveElections,
  fmtDelay,
  fmtTokens,
  weightOf,
  weightsReady,
  wouldFlip,
  type Activity as Row,
  type Flip,
} from '../chain/activity'
import { fetchStandings, type Standing, type Standings as StandingsData } from '../chain/standings'
import { Countdown } from '../components/Countdown'
import { McTag } from '../components/Tags'
import { EXPLORER } from '../format'
import { daoById, refreshDaos, useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'
import { castableSlate, voteAction } from '../chain/votes'
import { isCancel, readableError, type ChainAction } from '../chain/act'
import { useVotes } from '../useVotes'
import { useSession } from '../../wallet/session'
import type { Dao, DaoGroup } from '../chain/daos'

/**
 * What to call a council: the planet, and nothing else.
 *
 * Every DAO here belongs to one of six planets and is either its syndicate or
 * its union, so the titles run "Eyeke", "Eyeke Union", "Kavian"… — twelve
 * entries where six words and a heading say the same thing. The group is the
 * heading; this is the name under it.
 */
const planetOf = (d: Dao) => d.title.replace(/\s+Union$/i, '')
const GROUPS_OF_DAO: { key: DaoGroup; label: string }[] = [
  { key: 'syndicate', label: 'Syndicates' },
  { key: 'union', label: 'Unions' },
]

/**
 * One feed for everything that moves a council: tokens changing hands, slates
 * being cast, and unstake delays being changed.
 *
 * They are one view because they are one subject. Vote power is stake times a
 * delay multiplier, so buying tokens, voting them and lengthening a delay are
 * three ways of doing the same thing, and watching any one of them alone misses
 * two thirds of what happened.
 *
 * Rows arrive one at a time, like the Alien Legends feed — a poll fills a queue
 * and the queue drains, so six transfers landing in one block read as six
 * things happening rather than as the page redrawing.
 *
 * A week rather than an hour: exchanges run at a few an hour, elections at a
 * few a week and delay changes at a few a MONTH, so a short window is an empty
 * page. Only the transfer stream is busy enough to need paging for it.
 */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Pages of the transfer stream on the opening sweep — about 500 a day. */
const FIRST_PAGES = 5
const POLL_MS = 8_000
const OVERLAP_MS = 60_000
const MIN_GAP_MS = 130
const MAX_GAP_MS = 700

type Group = keyof typeof GROUPS

const GROUP_LABEL: Record<Group, string> = {
  exchanges: 'Exchanges',
  votes: 'Votes',
  elections: 'Elections',
  delays: 'Unstake delays',
  payouts: 'Reward payouts',
}

export default function Activity() {
  const { daos } = useDaos()
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [lastAt, setLastAt] = useState<number | null>(null)
  /* ONE control for the page: it chooses which council the standings are for
     AND what the feed is filtered to. They were two, and switching twice to
     look at one council is not a thing anybody wants to do. */
  const [symbol, setSymbol] = useState('')
  /* Payouts off by default: they are most of the volume and none of the point. */
  const [groups, setGroups] = useState<Set<Group>>(new Set(['exchanges', 'votes', 'elections', 'delays']))
  const [bigOnly, setBigOnly] = useState(false)
  const [, redraw] = useState(0)

  /* This page is also where a vote is kept alive. Vote power halves every
     thirty days of vote AGE, so a slate left alone quietly sinks down the
     standings the page is showing — re-casting the same names resets that
     clock, and the button for it belongs next to the ranking it moves. */
  const { votes, refresh: refreshVotes } = useVotes(daos)
  const { session } = useSession()
  const [signing, setSigning] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  const held = useRef(new Map<string, Row>())
  const queue = useRef<Row[]>([])
  const [queued, setQueued] = useState(0)
  const fresh = useRef(new Set<string>())
  const newest = useRef(0)
  /** Elections already acted on, so one is not re-read every eight seconds. */
  const seenElections = useRef(new Set<string>())

  const publish = () => {
    const cutoff = Date.now() - WINDOW_MS
    for (const [k, e] of held.current) if (e.at < cutoff) held.current.delete(k)
    setRows([...held.current.values()].sort((x, y) => y.at - x.at))
  }

  useEffect(() => {
    if (!live) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const since = newest.current ? newest.current - OVERLAP_MS : Date.now() - WINDOW_MS
        const got = await fetchActivity(since, newest.current ? 100 : 1000, newest.current ? 1 : FIRST_PAGES)
        /* An election says which DAC, not who won; that takes a second read.
           Done before the rows are published so a gold row never appears with
           its council missing and then fills in underneath the reader. */
        await resolveElections(got)

        /* An election makes the directory stale in the two ways this page
           shows: the countdown it carries has just run out, and the seated
           custodians are the previous period's. Re-read it, once per election
           rather than once per poll — the row keys are what remember. */
        const fresh = got.filter((e) => e.kind === 'election' && !seenElections.current.has(e.key))
        if (fresh.length) {
          for (const e of fresh) seenElections.current.add(e.key)
          /* Not on the opening sweep: the directory was just loaded. */
          if (newest.current) void refreshDaos()
        }
        if (!alive) return
        setError(null)
        setLastAt(Date.now())

        const first = !newest.current
        const waiting = new Set(queue.current.map((e) => e.key))
        for (const e of got) {
          newest.current = Math.max(newest.current, e.at)
          if (held.current.has(e.key) || waiting.has(e.key)) continue
          if (first) held.current.set(e.key, e)
          else queue.current.push(e)
        }

        if (first) publish()
        else {
          queue.current.sort((x, y) => x.at - y.at)
          setQueued(queue.current.length)
        }
      } catch (err) {
        if (!alive) return
        console.error('dao activity:', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) timer = setTimeout(tick, POLL_MS)
      }
    }

    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [live])

  /* One row at a time, pacing itself to clear inside one poll. */
  useEffect(() => {
    if (!queued) return
    const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, POLL_MS / queued))
    const timer = setTimeout(() => {
      const next = queue.current.shift()
      if (!next) return setQueued(0)
      held.current.set(next.key, next)
      fresh.current.add(next.key)
      setTimeout(() => fresh.current.delete(next.key), 2_000)
      publish()
      setQueued(queue.current.length)
    }, gap)
    return () => clearTimeout(timer)
  }, [queued])

  /* Vote weights, one read per DAC that shows up, the first time it does. */
  useEffect(() => {
    const wanted = new Set<string>()
    for (const r of rows) {
      const id = r.dacId ?? daos.find((d) => d.symbol === r.symbol)?.id
      if (id && !weightsReady(id)) wanted.add(id)
    }
    for (const id of wanted) void ensureWeights(id).then(() => redraw((n) => n + 1))
  }, [rows, daos])

  /** Everyone standing for a seat anywhere, so the feed can mark them. */
  const candidates = useMemo(() => {
    const out = new Set<string>()
    for (const d of daos) for (const c of d.candidates) if (c.is_active) out.add(c.candidate_name)
    return out
  }, [daos])

  const picked = daos.find((d) => d.symbol === symbol) ?? null

  /* The directory lands after the first render, so the page cannot open on a
     council — it takes the first one there is as soon as there is one. There
     is no everything option: one switch drives both halves of this page, and
     standings for "all councils" is a different table answering a different
     question. */
  useEffect(() => {
    if (!symbol && daos.length) {
      setSymbol((daos.find((d) => d.group === 'syndicate') ?? daos[0]).symbol)
    }
  }, [daos, symbol])

  /** The slate held here, trimmed of anyone who has stopped standing. */
  const slate = picked ? castableSlate(picked, votes) : null
  /** Who this wallet votes for, anywhere — enough to mark a name in the feed. */
  const votedAnywhere = useMemo(() => {
    const out = new Set<string>()
    for (const v of votes.values()) for (const n of v.candidates) out.add(n)
    return out
  }, [votes])

  /**
   * Re-cast the slate held in the picked council.
   *
   * One council rather than the whole group, because this page is about one
   * council — the group sweep lives on the Syndicates and Unions pages. Names
   * who have withdrawn come off first: the contract refuses the whole
   * transaction over one of them, and an empty slate is how `votecust`
   * DELETES a vote, so nothing is sent when there is nothing left to keep.
   */
  const refreshVote = async () => {
    if (!session || !picked || !slate?.keep.length || signing) return
    setSigning(true)
    setNote({ text: `Re-casting your ${picked.title} vote — check your wallet…` })
    try {
      const actions: ChainAction[] = [voteAction(session, picked, slate.keep)]
      await session.transact({ actions }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      await refreshVotes()
      await refreshDaos()
      setNote({
        text: [
          `Re-cast your vote in ${picked.title}. Its age is back to zero, so it counts in full again.`,
          slate.drop.length
            ? `Dropped ${slate.drop.map((d) => d.name).join(' and ')} — ${slate.drop[0].why}.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('Vote refresh failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setSigning(false)
    }
  }

  /** The DAC a row is about, which a transfer only says through its symbol. */
  const daoOf = (r: Row): Dao | undefined =>
    r.dacId ? daoById(daos, r.dacId) : daos.find((d) => d.symbol === r.symbol)

  const shownKinds = new Set([...groups].flatMap((g) => GROUPS[g]))

  const enriched = rows
    .filter((r) => shownKinds.has(r.kind))
    .map((r) => {
      const dao = daoOf(r)
      const power = dao ? weightOf(dao.id, r.actor, dao.precision) : null
      let flip: Flip | null = null
      /* Only a vote names who it was cast for. A delay change moves the same
         weight behind whatever that account already votes for, which is a
         second read per row — and they are rare enough that it is not worth
         holding the feed up for. */
      if (dao && r.kind === 'vote' && power) flip = wouldFlip(dao, r.votes ?? [], power)
      const council = r.council ?? councilOf(r.trx)
      const big =
        (r.amount != null && r.amount >= BIG_AMOUNT) || (r.kind === 'vote' && (power ?? 0) >= BIG_POWER)
      /* An election is always worth seeing, whatever the filters say about
         size — it is the thing every other row was leading up to. */
      return { r, dao, power, flip, council, big: big || !!flip || r.kind === 'election' }
    })
    .filter((e) => (e.dao?.symbol ?? e.r.symbol) === symbol && (!bigOnly || e.big))

  const flips = enriched.filter((e) => e.flip).length
  const bigs = enriched.filter((e) => e.big).length

  const toggle = (g: Group) =>
    setGroups((prev) => {
      const next = new Set(prev)
      if (!next.delete(g)) next.add(g)
      return next
    })

  const Account = ({ name }: { name: string }) => (
    <>
      <a href={`${EXPLORER}${encodeURIComponent(name)}`} target="_blank" rel="noopener">
        {name}
      </a>
      {candidates.has(name) ? (
        <span className="tag tag--in" title="Standing for a council seat">
          candidate
        </span>
      ) : null}
      {votedAnywhere.has(name) ? (
        <span className="tag tag--vote" title="You are voting for this candidate">
          &#9733; your vote
        </span>
      ) : null}
      <McTag name={name} />
    </>
  )

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Live activity</h1>
          <p className="page__lead">
            Everything that moves a council, over the last week: elections, tokens changing hands, slates being
            cast, and unstake delays being changed. Vote power is stake times a delay multiplier, so those three
            are one subject — and an election is what they were all leading to. Exchanges over{' '}
            {BIG_AMOUNT.toLocaleString('en-US')} and votes over {BIG_POWER.toLocaleString('en-US')} are marked.
          </p>
        </div>
        <div className="page__actions">
          <span className={`live-dot${live ? ' is-on' : ''}`} aria-hidden="true" />
          <button className="btn" type="button" onClick={() => setLive((v) => !v)}>
            {live ? 'Pause' : 'Resume'}
          </button>
          {session && picked ? (
            <button
              className={`btn${slate?.drop.length ? ' btn--warn' : ''}`}
              type="button"
              onClick={() => void refreshVote()}
              disabled={signing || !slate?.keep.length}
              title={
                slate?.keep.length
                  ? [
                      `Re-cast ${slate.keep.join(', ')} in ${picked.title} so the vote counts at full weight again.`,
                      slate.drop.length
                        ? `${slate.drop.map((d) => d.name).join(' and ')} would be dropped — ${slate.drop[0].why}.`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : slate?.slate.length
                    ? `Every candidate you voted for in ${picked.title} has gone. That needs a new pick, not a refresh.`
                    : `No vote cast in ${picked.title} yet`
              }
            >
              {signing ? 'Signing…' : `Refresh vote · ${picked.symbol}`}
            </button>
          ) : null}
          <RefreshButton />
        </div>
      </header>

      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      {/*
        * Twelve councils, which is two rows of six once they are grouped —
        * every planet has a syndicate and a union, so the planet name is the
        * only part that differs inside a row and the heading carries the rest.
        * On a phone that is still a sideways scroller with nothing to say it
        * scrolls, so the same choice is a grouped dropdown there, which is
        * what a phone does well and what every app of this kind uses.
        */}
      <div className="act-pick">
        {GROUPS_OF_DAO.map(({ key, label }) => (
          <div key={key} className="act-pick__row">
            <span className="act-pick__label">{label}</span>
            <div className="sections act-pick__strip" role="tablist" aria-label={label}>
              {daos
                .filter((d) => d.group === key)
                .map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="tab"
                    aria-selected={symbol === d.symbol}
                    title={`${d.title} · ${d.symbol}`}
                    onClick={() => setSymbol(d.symbol)}
                  >
                    {planetOf(d)}
                  </button>
                ))}
            </div>
          </div>
        ))}

        <label className="act-pick__select">
          <span className="sr-only">Council</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {GROUPS_OF_DAO.map(({ key, label }) => (
              <optgroup key={key} label={label}>
                {daos
                  .filter((d) => d.group === key)
                  .map((d) => (
                    <option key={d.id} value={d.symbol}>
                      {planetOf(d)} · {d.symbol}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <Standings daos={daos} dao={picked} votedFor={new Set(slate?.slate ?? [])} />

      <section className="section">
        <div className="page__actions">
          {(Object.keys(GROUPS) as Group[]).map((g) => (
            <label key={g} className={`pause-chip${groups.has(g) ? ' is-target' : ''}`}>
              <input type="checkbox" checked={groups.has(g)} onChange={() => toggle(g)} />
              <span>{GROUP_LABEL[g]}</span>
            </label>
          ))}
          <label className="pause-chip">
            <input type="checkbox" checked={bigOnly} onChange={() => setBigOnly(!bigOnly)} />
            <span>Notable only</span>
          </label>
        </div>

        <h2 className="dao-h2">
          {enriched.length} event{enriched.length === 1 ? '' : 's'}{' '}
          <span className="dao-dim">
            {flips ? `${flips} would change a council · ` : ''}
            {bigs ? `${bigs} notable · ` : ''}
            {queued ? `${queued} arriving · ` : ''}
            {error ? error : lastAt ? `updated ${new Date(lastAt).toISOString().slice(11, 19)} UTC` : 'reading…'}
          </span>
        </h2>

        <ul className="feed">
          {enriched.map(({ r, dao, power, flip, council, big }) => (
            <li
              key={r.key}
              className={
                `feed__row is-${KIND_TONE[r.kind]}` +
                (fresh.current.has(r.key) ? ' is-new' : '') +
                (big ? ' is-big' : '') +
                (flip ? ' is-flip' : '')
              }
            >
              <span className="feed__time">{new Date(r.at).toISOString().slice(11, 19)}</span>
              <span className="feed__who">
                <Account name={r.actor} />
              </span>
              <span className="feed__what">
                {r.kind === 'election' ? (
                  <>
                    <b className="xch-election">Election in {dao?.title ?? r.dacId}</b>
                    {council?.length ? (
                      <span className="xch-council">
                        <i>New council</i>
                        {council.map((n) => (
                          <span key={n}>
                            <Account name={n} />
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="dao-dim"> — reading who was seated…</span>
                    )}
                  </>
                ) : r.kind === 'vote' ? (
                  <>
                    {/* A vote with nothing staked behind it is legal and
                        counts for nothing, which is worth saying outright
                        rather than printing as "0". */}
                    <b className={`xch-amount${power === 0 ? ' dao-dim' : ''}`}>
                      {power == null ? '…' : power === 0 ? 'No vote power' : `${fmtTokens(power)} ${dao?.symbol ?? ''}`}
                    </b>{' '}
                    voted for{' '}
                    {(r.votes ?? []).map((n, i) => (
                      <span key={n}>
                        {i ? ', ' : ''}
                        <Account name={n} />
                      </span>
                    ))}{' '}
                    <span className="dao-dim">in {dao?.title ?? r.dacId}</span>
                  </>
                ) : r.kind === 'staketime' ? (
                  <>
                    <b className="xch-amount">{fmtDelay(r.delay ?? 0)}</b> unstake delay on{' '}
                    <span className="dao-dim">{dao?.title ?? r.symbol}</span>
                    {power != null && power > 0 ? (
                      <span className="dao-dim"> — {fmtTokens(power)} of vote power behind it</span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <b className="xch-amount">
                      {fmtTokens(r.amount ?? 0)} {r.symbol}
                    </b>{' '}
                    {KIND_LABEL[r.kind]}
                    {r.other && (r.kind === 'sent' || r.kind === 'swapped') ? (
                      <>
                        {' '}
                        to <Account name={r.other} />
                      </>
                    ) : null}
                  </>
                )}

                {flip ? (
                  <i className="xch-flip" title="Estimated: the decayed figure is scaled by the change in raw power, since removing a vote also changes the age it is weighted by">
                    Without this vote, {flip.in} would take {flip.out}&rsquo;s seat
                  </i>
                ) : null}
                {/* An election's memo is the scheduler's greeting, the same
                    sentence every time. */}
                {r.memo && r.kind !== 'election' ? <i className="xch-memo">{r.memo}</i> : null}
              </span>
            </li>
          ))}
          {!enriched.length ? (
            <li className="feed__row">
              <span className="dao-dim">
                {error
                  ? 'The history indexers are not answering.'
                  : !rows.length
                    ? 'Reading…'
                    : 'Nothing matches those filters in the last week.'}
              </span>
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  )
}

/**
 * Who would take the seats if a period ran now.
 *
 * Follows the page's council rather than holding a selector of its own, and
 * costs a handful of reads — balances, stakes, delays — for the one that is
 * picked.
 *
 * Five seats and the first miss by default, which is the whole question of an
 * election. Everyone else is read at the same time and kept behind a toggle:
 * the rest of the field matters perhaps once a period, and putting thirty
 * rows above the feed to serve that would bury the feed.
 */
function Standings({ daos, dao, votedFor }: { daos: Dao[]; dao: Dao | null; votedFor: Set<string> }) {
  const [data, setData] = useState<StandingsData | null>(null)
  const [reading, setReading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!dao) return setData(null)
    let alive = true
    setReading(true)
    setData(null)
    /* A different council is a different field; it should not open expanded
       because the last one was. */
    setShowAll(false)
    void fetchStandings(dao)
      .then((s) => {
        if (!alive) return
        setData(s)
        setReading(false)
      })
      .catch((err: unknown) => {
        console.error('standings:', err)
        if (alive) setReading(false)
      })
    return () => {
      alive = false
    }
  }, [dao?.id, dao?.candidates.length])

  if (!daos.length || !dao) return null

  const rest = data?.rest ?? []

  return (
    <section className="section">
      <div className="page__actions">
        <h2 className="dao-h2">
          Would be elected <span className="dao-dim">{dao.title}</span>
        </h2>
        {/* What the standings above are a prediction FOR. It keeps its own
            second-by-second clock; the date behind it comes back from the
            directory, which an election re-reads. */}
        <span className="stand-when">
          Next election <Countdown due={dao.nextElection} periodLength={dao.periodLength} />
        </span>
      </div>

      <div className="dao-tablewrap cardwrap">
        <table className="dao-table stand-table cardtable">
          <thead>
            <tr>
              <th>Candidate</th>
              <th className="num">Vote power</th>
              <th className="num">Behind them</th>
              <th className="num">Holds</th>
              <th className="num">Staked</th>
              <th className="num">Multiplier</th>
            </tr>
          </thead>
          <tbody>
            {(data?.elected ?? []).map((c, i) => (
              <StandingRow key={c.name} c={c} place={i + 1} dao={dao} votedFor={votedFor} />
            ))}
            {data?.next ? (
              <StandingRow
                c={data.next}
                place={data.seats + 1}
                dao={dao}
                votedFor={votedFor}
                missed
                margin={data.margin}
              />
            ) : null}
            {showAll
              ? rest.map((c, i) => (
                  <StandingRow
                    key={c.name}
                    c={c}
                    place={(data?.seats ?? 5) + 2 + i}
                    dao={dao}
                    votedFor={votedFor}
                    missed
                  />
                ))
              : null}
            {!data ? (
              <tr>
                <td colSpan={6} className="dao-dim">
                  {reading ? 'Reading…' : 'Could not read this council.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {rest.length ? (
        <button className="btn stand-more" type="button" onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? 'Show the seats only'
            : `Show the other ${rest.length} candidate${rest.length === 1 ? '' : 's'}`}
        </button>
      ) : null}

      {data ? (
        <p className="dao-dim">
          Ordered by the figure the chain seats on: the vote power behind a candidate, halved for every thirty
          days of vote age. <b>Holds</b> is the candidate&rsquo;s own balance, of which <b>staked</b> is the part
          that votes at all, multiplied by what their unstake delay is worth.
          {data.next ? (
            <>
              {' '}
              {data.next.name} is <b>{fmtTokens(data.margin)}</b> of vote power short of a seat.
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}

function StandingRow({
  c,
  place,
  dao,
  votedFor,
  missed,
  margin,
}: {
  c: Standing
  place: number
  dao: Dao
  /** The connected wallet's slate here, so its own picks stand out. */
  votedFor: Set<string>
  missed?: boolean
  margin?: number
}) {
  return (
    <tr className={missed ? 'is-missed' : undefined}>
      {/* The place rides with the name rather than holding a column of its own:
          one number in a column is a column a phone cannot spare, and "1." in
          front of a name says the same thing on any screen. */}
      <td className="cardtable__head">
        <span className="stand-place">{place}</span>
        <a href={`${EXPLORER}${encodeURIComponent(c.name)}`} target="_blank" rel="noopener">
          {c.name}
        </a>
        <McTag name={c.name} />
        {votedFor.has(c.name) ? (
          <span className="tag tag--vote" title="You are voting for this candidate">
            &#9733; your vote
          </span>
        ) : null}
        {!missed && !c.seated ? (
          <span className="tag tag--in" title="Not on the council today — would take a seat">
            incoming
          </span>
        ) : null}
        {missed && margin != null ? (
          <span className="tag tag--bad" title={`${fmtTokens(margin)} short of the last seat`}>
            first miss
          </span>
        ) : null}
      </td>
      <td className="num" data-label="Vote power">
        <b>{fmtTokens(c.power)}</b>
      </td>
      <td className="num" data-label="Behind them" title={`${c.voters} account${c.voters === 1 ? '' : 's'} voting`}>
        {fmtTokens(c.raw)}
        <span className="dao-dim">
          {c.voters} voter{c.voters === 1 ? '' : 's'}
        </span>
      </td>
      <td className="num" data-label="Holds">
        {fmtTokens(c.held)}
      </td>
      <td className={`num${c.staked ? '' : ' dao-dim'}`} data-label="Staked">
        {c.staked ? fmtTokens(c.staked) : 'none'}
        {c.held > 0 ? <span className="dao-dim">{Math.round((c.staked / c.held) * 100)}%</span> : null}
      </td>
      <td className="num" data-label="Multiplier" title={`${fmtDelay(c.delay)} unstake delay on ${dao.symbol}`}>
        {c.multiplier.toFixed(2)}&times;
        <span className="dao-dim">{fmtDelay(c.delay)}</span>
      </td>
    </tr>
  )
}
