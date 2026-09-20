import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BIG_AMOUNT,
  BIG_POWER,
  GROUPS,
  KIND_LABEL,
  KIND_TONE,
  ensureWeights,
  fetchActivity,
  fmtDelay,
  fmtTokens,
  weightOf,
  weightsReady,
  wouldFlip,
  type Activity as Row,
  type Flip,
} from '../chain/activity'
import {
  fetchStandings,
  glanceAll,
  type Standing,
  type Standings as StandingsData,
} from '../chain/standings'
import { McTag } from '../components/Tags'
import { EXPLORER } from '../format'
import { daoById, useDaos } from '../useDaos'
import { RefreshButton } from '../components/RefreshButton'
import type { Dao } from '../chain/daos'

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
 * Two days rather than an hour: real exchanges run at a few an hour and delay
 * changes at a few a MONTH, so a short window is an empty page.
 */
const WINDOW_MS = 48 * 60 * 60 * 1000
const POLL_MS = 8_000
const OVERLAP_MS = 60_000
const MIN_GAP_MS = 130
const MAX_GAP_MS = 700

type Group = keyof typeof GROUPS

const GROUP_LABEL: Record<Group, string> = {
  exchanges: 'Exchanges',
  votes: 'Votes',
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
    const [symbol, setSymbol] = useState('all')
  /* Payouts off by default: they are most of the volume and none of the point. */
  const [groups, setGroups] = useState<Set<Group>>(new Set(['exchanges', 'votes', 'delays']))
  const [bigOnly, setBigOnly] = useState(false)
  const [, redraw] = useState(0)

  const held = useRef(new Map<string, Row>())
  const queue = useRef<Row[]>([])
  const [queued, setQueued] = useState(0)
  const fresh = useRef(new Set<string>())
  const newest = useRef(0)

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
        const got = await fetchActivity(since, newest.current ? 100 : 800)
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

  const picked = symbol === 'all' ? null : (daos.find((d) => d.symbol === symbol) ?? null)

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
      const big =
        (r.amount != null && r.amount >= BIG_AMOUNT) || (r.kind === 'vote' && (power ?? 0) >= BIG_POWER)
      return { r, dao, power, flip, big: big || !!flip }
    })
    .filter((e) => (symbol === 'all' || (e.dao?.symbol ?? e.r.symbol) === symbol) && (!bigOnly || e.big))

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
      <McTag name={name} />
    </>
  )

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Live activity</h1>
          <p className="page__lead">
            Everything that moves a council, over the last two days: tokens changing hands, slates being cast, and
            unstake delays being changed. Vote power is stake times a delay multiplier, so all three are the same
            subject. Exchanges over {BIG_AMOUNT.toLocaleString('en-US')} and votes over{' '}
            {BIG_POWER.toLocaleString('en-US')} are marked.
          </p>
        </div>
        <div className="page__actions">
          <span className={`live-dot${live ? ' is-on' : ''}`} aria-hidden="true" />
          <button className="btn" type="button" onClick={() => setLive((v) => !v)}>
            {live ? 'Pause' : 'Resume'}
          </button>
          <RefreshButton />
        </div>
      </header>

      <div className="page__actions act-pick">
        <div className="sections" role="tablist">
          <button type="button" role="tab" aria-selected={symbol === 'all'} onClick={() => setSymbol('all')}>
            Every council
          </button>
          {daos.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={symbol === d.symbol}
              title={d.title}
              onClick={() => setSymbol(d.symbol)}
            >
              {d.symbol}
            </button>
          ))}
        </div>
      </div>

      <Standings daos={daos} dao={picked} onPick={setSymbol} />

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
          {enriched.map(({ r, dao, power, flip, big }) => (
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
                {r.kind === 'vote' ? (
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
                {r.memo ? <i className="xch-memo">{r.memo}</i> : null}
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
                    : 'Nothing matches those filters in the last two days.'}
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
 * Follows the page's council rather than holding a selector of its own. With
 * one picked it costs a handful of reads — balances, stakes, delays — and shows
 * them; with none picked it shows every council instead, which costs nothing at
 * all, because the ranks arrive with the directory and the seating order is a
 * sort of what is already in hand.
 */
function Standings({ daos, dao, onPick }: { daos: Dao[]; dao: Dao | null; onPick: (symbol: string) => void }) {
  const [data, setData] = useState<StandingsData | null>(null)
  const [reading, setReading] = useState(false)

  useEffect(() => {
    if (!dao) return setData(null)
    let alive = true
    setReading(true)
    setData(null)
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

  if (!daos.length) return null
  if (!dao) return <AllCouncils daos={daos} onPick={onPick} />

  return (
    <section className="section">
      <h2 className="dao-h2">
        Would be elected <span className="dao-dim">{dao.title}</span>
      </h2>

      <div className="dao-tablewrap">
        <table className="dao-table stand-table">
          <thead>
            <tr>
              <th className="num">#</th>
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
              <StandingRow key={c.name} c={c} place={i + 1} dao={dao} />
            ))}
            {data?.next ? (
              <StandingRow c={data.next} place={data.seats + 1} dao={dao} missed margin={data.margin} />
            ) : null}
            {!data ? (
              <tr>
                <td colSpan={7} className="dao-dim">
                  {reading ? 'Reading…' : 'Could not read this council.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

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

/**
 * Every council at once, when none is picked.
 *
 * The question it answers is which one to look INTO: a council whose last seat
 * is held by a hair is where the next vote matters, and a council whose
 * standing no longer matches its custodians is already mid-change. Both come
 * out of the directory, so this costs no reads and a row opens the detail.
 */
function AllCouncils({ daos, onPick }: { daos: Dao[]; onPick: (symbol: string) => void }) {
  const rows = useMemo(() => glanceAll(daos), [daos])

  return (
    <section className="section">
      <h2 className="dao-h2">
        Would be elected <span className="dao-dim">every council — pick one above for the detail</span>
      </h2>

      <div className="dao-tablewrap">
        <table className="dao-table stand-table">
          <thead>
            <tr>
              <th>Council</th>
              <th className="num">Seats</th>
              <th>Would be elected</th>
              <th className="num">Last seat holds by</th>
              <th>Changes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.dao.id} className="is-clickable" onClick={() => onPick(g.dao.symbol)}>
                <td>
                  <b className="dao-rowtitle">{g.dao.title}</b>
                  <span className="dao-rowmeta">
                    <span className="dao-rowid">{g.dao.symbol}</span>
                  </span>
                </td>
                <td className="num">{g.seats}</td>
                <td className="stand-names">
                  {g.elected.map((n) => (
                    <span key={n} className={g.incoming.includes(n) ? 'is-incoming' : undefined}>
                      {n}
                      <McTag name={n} />
                    </span>
                  ))}
                </td>
                <td className="num" title={g.next ? `${g.next} is next in line` : 'Nobody else is standing'}>
                  {g.next ? fmtTokens(g.margin) : <span className="dao-dim">unopposed</span>}
                  {g.next ? <span className="dao-dim">over {g.next}</span> : null}
                </td>
                <td>
                  {g.incoming.length || g.leaving.length ? (
                    <span className="tag tag--bad" title={`${g.leaving.join(', ')} out, ${g.incoming.join(', ')} in`}>
                      {g.incoming.length} would change
                    </span>
                  ) : (
                    <span className="dao-dim">settled</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="dao-dim">
        Ordered as the directory lists them. <b>Last seat holds by</b> is the vote power between the final seat
        and the first candidate who would miss it — the smaller it is, the less it takes to change the council.
      </p>
    </section>
  )
}

function StandingRow({
  c,
  place,
  dao,
  missed,
  margin,
}: {
  c: Standing
  place: number
  dao: Dao
  missed?: boolean
  margin?: number
}) {
  return (
    <tr className={missed ? 'is-missed' : undefined}>
      <td className="num">{place}</td>
      <td>
        <a href={`${EXPLORER}${encodeURIComponent(c.name)}`} target="_blank" rel="noopener">
          {c.name}
        </a>
        <McTag name={c.name} />
        {!missed && !c.seated ? (
          <span className="tag tag--in" title="Not on the council today — would take a seat">
            incoming
          </span>
        ) : null}
        {missed ? (
          <span className="tag tag--bad" title={`${fmtTokens(margin ?? 0)} short of the last seat`}>
            first miss
          </span>
        ) : null}
      </td>
      <td className="num">
        <b>{fmtTokens(c.power)}</b>
      </td>
      <td className="num" title={`${c.voters} account${c.voters === 1 ? '' : 's'} voting`}>
        {fmtTokens(c.raw)}
        <span className="dao-dim">
          {c.voters} voter{c.voters === 1 ? '' : 's'}
        </span>
      </td>
      <td className="num">{fmtTokens(c.held)}</td>
      <td className={`num${c.staked ? '' : ' dao-dim'}`}>
        {c.staked ? fmtTokens(c.staked) : 'none'}
        {c.held > 0 ? <span className="dao-dim">{Math.round((c.staked / c.held) * 100)}%</span> : null}
      </td>
      <td className="num" title={`${fmtDelay(c.delay)} unstake delay on ${dao.symbol}`}>
        {c.multiplier.toFixed(2)}&times;
        <span className="dao-dim">{fmtDelay(c.delay)}</span>
      </td>
    </tr>
  )
}
