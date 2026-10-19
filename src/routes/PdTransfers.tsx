import { useEffect, useMemo, useRef, useState } from 'react'
import { historySliced, historyTime, progressMeter } from '@/chain/history'
import { formatNumber } from '@/format'

/**
 * Every DEF transfer, newest first, read live.
 *
 * Not collected nightly like the reports are: DEF moves four thousand times a
 * day and nearly all of it is noise — of 2,500 consecutive transfers, 2,017
 * were under half a DEF, mostly mission entries of two hundredths. Keeping a
 * daily summary of that would answer no question anybody has. What is worth
 * seeing is the handful of large movements, and those are rare enough —
 * two or three a day above 500 DEF — that reading the window on demand and
 * sieving it here is both cheaper and more useful than any stored figure.
 *
 * Hence the floor, and hence its default of 500: it is set where the list
 * stops being a log and starts being a short list of things that happened.
 * It can be taken down to nothing, because the whole window is held either
 * way — the slider only decides what is drawn.
 *
 * Every DEF transfer is here, not only Planetary Defense's own. The token
 * exists for the game, so its contracts are most of the traffic, but swaps on
 * Alcor are where DEF meets a price and leaving them out would make the
 * largest movements of the week vanish.
 */

const DEF_CONTRACT = 'defensetoken'
const DEF_SYMBOL = 'DEF'

/**
 * How far back to read.
 *
 * A week by default. A day is too short to show anything above the floor at
 * all on a quiet day, and a month is about a hundred and twenty pages of
 * history — worth having, but a choice rather than what the page does on
 * arrival.
 */
const SPANS = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const

/**
 * Where the slider can reach, and where it starts.
 *
 * Two thousand is chosen from the traffic rather than for roundness: of 2,500
 * consecutive transfers the largest was a thousand DEF, so the slider covers
 * the whole range anything actually moves in, at a step fine enough to pick
 * out a single hundred. The box beside it takes any figure at all, for the
 * rare week where that is not enough.
 */
const FLOOR_MAX = 2_000
const FLOOR_STEP = 10
const FLOOR_DEFAULT = 500

interface Act {
  global_sequence: number
  '@timestamp': string
  act: {
    data: { from?: string; to?: string; amount?: number; quantity?: string; symbol?: string; memo?: string }
  }
}

interface Move {
  key: number
  at: number
  from: string
  to: string
  amount: number
  memo: string
}

const whole = (v: number) => formatNumber(Math.round(v))
const exact = (v: number) =>
  v >= 100 ? whole(v) : v.toLocaleString('en-GB', { maximumFractionDigits: 4 })

const stamp = (at: number) =>
  new Date(at).toLocaleString('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

export default function PdTransfers() {
  const [days, setDays] = useState<number>(7)
  const [moves, setMoves] = useState<Move[] | null>(null)
  const [floor, setFloor] = useState(FLOOR_DEFAULT)
  const [error, setError] = useState<string | null>(null)
  /* A month is well over a hundred pages of history, so the wait is told. */
  const [read, setRead] = useState(0)
  /* So an answer that arrives after the span was changed again is dropped. */
  const run = useRef(0)

  useEffect(() => {
    const mine = ++run.current
    setMoves(null)
    setError(null)
    setRead(0)
    const until = Date.now()
    const from = until - days * 86_400_000

    historySliced<Act>(
      '/v2/history/get_actions',
      { account: DEF_CONTRACT, filter: `${DEF_CONTRACT}:transfer` },
      from,
      until,
      (page) => (page as { actions?: Act[] }).actions ?? [],
      (a) => historyTime(a['@timestamp']),
      (a) => a.global_sequence,
      /* One slice per few days: enough to read a month without waiting on a
         single thread of pages, few enough not to arrive as a burst. */
      Math.min(6, Math.max(2, Math.round(days / 5))),
      progressMeter((fraction) => {
        if (run.current === mine) setRead(fraction)
      }),
    )
      .then((rows) => {
        if (run.current !== mine) return
        const out: Move[] = []
        for (const a of rows) {
          const d = a.act.data
          const symbol = d.symbol ?? String(d.quantity ?? '').split(' ')[1]
          /* The contract issues and retires DEF as well as moving it; only a
             transfer of DEF itself belongs in a list of DEF transfers. */
          if (symbol !== DEF_SYMBOL) continue
          const amount = Number(d.amount ?? String(d.quantity ?? '0').split(' ')[0]) || 0
          out.push({
            key: a.global_sequence,
            at: historyTime(a['@timestamp']),
            from: String(d.from ?? ''),
            to: String(d.to ?? ''),
            amount,
            memo: String(d.memo ?? ''),
          })
        }
        out.sort((a, b) => b.at - a.at)
        setMoves(out)
      })
      .catch((err: unknown) => {
        if (run.current !== mine) return
        console.error('DEF transfers:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [days])

  /* Above the floor, not at it: a floor of 500 hides a transfer of exactly 500. */
  const shown = useMemo(() => (moves ?? []).filter((m) => m.amount > floor), [moves, floor])
  const moved = useMemo(() => shown.reduce((n, m) => n + m.amount, 0), [shown])
  const span = SPANS.find((s) => s.days === days)

  return (
    <section className="section">
      <div className="page__actions">
        <h2 className="dao-h2">
          DEF transfers <span className="dao-dim">last {span?.label ?? `${days} days`}</span>
        </h2>
        <select className="pdp__find" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {SPANS.map((s) => (
            <option key={s.days} value={s.days}>
              Last {s.label}
            </option>
          ))}
        </select>
      </div>

      <label className="deft__floor">
        <span>
          Hide transfers of <b>{whole(floor)} DEF</b> or less
        </span>
        <input
          type="range"
          min={0}
          max={FLOOR_MAX}
          step={FLOOR_STEP}
          /* Past the slider's reach it sits at the end rather than jumping
             back, so typing 50,000 does not silently become 2,000. */
          value={Math.min(floor, FLOOR_MAX)}
          onChange={(e) => setFloor(Number(e.target.value))}
        />
        <input
          type="number"
          className="deft__exact"
          min={0}
          step={FLOOR_STEP}
          value={floor}
          onChange={(e) => setFloor(Math.max(0, Number(e.target.value) || 0))}
        />
        <span className="dao-dim">{floor === 0 ? 'showing everything' : 'DEF'}</span>
      </label>

      {error ? (
        <p className="dao-note dao-note--bad">The history servers would not answer: {error}</p>
      ) : !moves ? (
        <p className="loading">
          <span className="spinner" /> Reading {span?.label ?? `${days} days`} of history
          {read > 0 ? ` — ${Math.min(99, Math.round(read * 100))}%` : ''}…
        </p>
      ) : (
        <>
          <p className="dao-dim">
            {whole(shown.length)} transfer{shown.length === 1 ? '' : 's'} above {whole(floor)} DEF, moving{' '}
            {whole(moved)} DEF in all — out of {whole(moves.length)} read.
          </p>

          {!shown.length ? (
            <p className="dao-note">
              Nothing above {whole(floor)} DEF in the last {span?.label ?? `${days} days`}. Lower the slider or
              read further back.
            </p>
          ) : (
            <div className="pdp__scroll">
              <table className="pdp">
                <thead>
                  <tr>
                    <th>When (UTC)</th>
                    <th>From</th>
                    <th>To</th>
                    <th className="num">DEF</th>
                    <th>Memo</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 500).map((m) => (
                    <tr key={m.key}>
                      <td className="pdp__wallet">{stamp(m.at)}</td>
                      <td className="pdp__wallet">{m.from}</td>
                      <td className="pdp__wallet">{m.to}</td>
                      <td className="num">{exact(m.amount)}</td>
                      <td className="deft__memo" title={m.memo}>
                        {m.memo || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      {shown.length > 500
                        ? `first 500 of ${whole(shown.length)}, total over all`
                        : 'Total'}
                    </td>
                    <td className="num">{whole(moved)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
