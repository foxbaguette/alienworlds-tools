import { useEffect, useState } from 'react'
import {
  amountOf,
  fetchCollect,
  progressOf,
  symbolOf,
  type CollectState,
  type Distribution,
} from '../chain/collect'

/**
 * `collect.ale` — the game's income and what it is waiting to pay out.
 *
 * The question this page exists for is the developer payout: `waxdev` banks
 * 80% of what comes in and releases nothing until it reaches 100,000 WAX. So
 * that reserve leads, in full, and the others follow as a table.
 */
export function CollectStatus() {
  const [state, setState] = useState<CollectState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const read = () => {
    setState(null)
    setError(null)
    void fetchCollect()
      .then(setState)
      .catch((err: unknown) => {
        console.error('collect.ale:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [])

  /* The developer reserve first, then whatever is closest to paying out. */
  const ordered = state
    ? [...state.distributions].sort((a, b) => {
        if (a.payout_name === 'waxdevs') return -1
        if (b.payout_name === 'waxdevs') return 1
        return progressOf(b).percent - progressOf(a).percent
      })
    : []
  const lead = ordered[0] ?? null
  const claimed = state?.tracking?.last_planet_claim
    ? Date.parse(`${state.tracking.last_planet_claim}Z`)
    : null

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Income &amp; payouts</h1>
          <p className="page__lead">
            <code>collect.ale</code> banks what the planets pay in and splits it into named reserves. Each one
            holds its balance until it crosses a threshold, then pays the wallets under it.
          </p>
        </div>
        <div className="page__actions">
          <button className="btn" type="button" onClick={read} disabled={!state && !error}>
            Re-read
          </button>
        </div>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}
      {!state && !error ? <p className="dao-note">Reading…</p> : null}

      {lead ? <Headline d={lead} state={state!} /> : null}

      {state ? (
        <section className="section">
          <h2 className="dao-h2">
            Every reserve <span className="dao-dim">{state.distributions.length}</span>
          </h2>
          <div className="dao-tablewrap">
            <table className="dao-table">
              <thead>
                <tr>
                  <th>Reserve</th>
                  <th className="num">Takes</th>
                  <th className="num">Held</th>
                  <th className="num">Releases at</th>
                  <th>Progress</th>
                  <th>Pays</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((d) => {
                  const p = progressOf(d)
                  const sym = symbolOf(d.current_reserve_amount)
                  const to = state.payouts.get(d.payout_name) ?? []
                  return (
                    <tr key={d.distribution_name}>
                      <td>
                        <b className="dao-rowtitle">{d.distribution_name}</b>
                        <span className="dao-rowmeta">
                          <span className="dao-rowid">{d.payout_name}</span>
                        </span>
                      </td>
                      <td className="num">{d.percentage}%</td>
                      <td className="num">
                        {p.have.toLocaleString('en-US', { maximumFractionDigits: 2 })} {sym}
                      </td>
                      <td className="num">
                        {p.always ? (
                          <span className="dao-dim">every claim</span>
                        ) : (
                          `${p.need.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${sym}`
                        )}
                      </td>
                      <td className="res-barcell">
                        <span className="res-bar">
                          <i
                            className={`res-bar__fill is-${p.ready ? 'ready' : 'ok'}`}
                            style={{ width: `${p.percent}%` }}
                          />
                        </span>
                        <span className="dao-dim">{p.ready ? 'ready' : `${p.percent.toFixed(1)}%`}</span>
                      </td>
                      <td className="dao-dim">
                        {to.length
                          ? to.map((t) => `${t.payout_target_wallet} ${t.payout_percent}%`).join(', ')
                          : 'nobody'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {state ? (
        <section className="section">
          <h2 className="dao-h2">Where the money comes from</h2>
          <p className="dao-note">
            Claiming from{' '}
            <b>
              {state.scopes.filter((s) => s.active).length} of {state.scopes.length} planets
            </b>{' '}
            — {state.scopes.map((s) => `${s.scope}${s.active ? '' : ' (off)'}`).join(', ')}.
            {claimed ? (
              <>
                {' '}
                Last claim <b>{new Date(claimed).toISOString().replace('T', ' ').slice(0, 16)} UTC</b>.
              </>
            ) : null}
            {state.tracking ? (
              <span className="dao-dim">
                {' '}
                Unsorted on the contract: {state.tracking.wax_overflow}, {state.tracking.tlm_overflow}.
              </span>
            ) : null}
          </p>
        </section>
      ) : null}
    </div>
  )
}

/**
 * The reserve that matters, said in a sentence.
 *
 * A percentage on its own does not answer "how close are we" — what is missing
 * in WAX is the part anyone can act on, so that is what leads.
 */
function Headline({ d, state }: { d: Distribution; state: CollectState }) {
  const p = progressOf(d)
  const sym = symbolOf(d.current_reserve_amount)
  const to = state.payouts.get(d.payout_name) ?? []
  const short = Math.max(0, p.need - p.have)
  const required = amountOf(d.required_in_reserve_amount)

  return (
    <section className="section collect-lead">
      <h2 className="dao-h2">
        {d.payout_name === 'waxdevs' ? 'Developer payout' : d.distribution_name}{' '}
        <span className="dao-dim">{d.distribution_name}</span>
      </h2>

      <p className="collect-big">
        {p.have.toLocaleString('en-US', { maximumFractionDigits: 2 })} {sym}
        {p.always ? null : (
          <span className="dao-dim">
            {' '}
            of {p.need.toLocaleString('en-US', { maximumFractionDigits: 0 })} {sym}
          </span>
        )}
      </p>

      <span className="res-bar res-bar--tall">
        <i className={`res-bar__fill is-${p.ready ? 'ready' : 'ok'}`} style={{ width: `${p.percent}%` }} />
      </span>

      <p>
        {p.always ? (
          <>This reserve has no threshold — it pays out on every claim.</>
        ) : p.ready ? (
          <>
            <b>Ready to pay.</b> The threshold has been reached; the next claim releases it.
          </>
        ) : (
          <>
            <b>{p.percent.toFixed(1)}% of the way there</b> —{' '}
            {short.toLocaleString('en-US', { maximumFractionDigits: 0 })} {sym} short.
          </>
        )}{' '}
        <span className="dao-dim">
          Takes {d.percentage}% of what comes in
          {required > 0 ? `, keeping ${required.toLocaleString('en-US')} ${sym} back` : ''}. Paid to{' '}
          {to.length ? to.map((t) => `${t.payout_target_wallet} (${t.payout_percent}%)`).join(' and ') : 'nobody'}.
        </span>
      </p>
    </section>
  )
}
