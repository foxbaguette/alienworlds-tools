import { useEffect, useState } from 'react'
import { Chains, SessionKit, type Session } from '@wharfkit/session'
import WebRenderer from '@wharfkit/web-renderer'
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor'
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet'
import { ENDPOINTS, preferredUrl, start } from '../dao/chain/nodes'

/**
 * One wallet for the whole site.
 *
 * The DAO tools, the MSIG groups and the competitions all sign against the same
 * chain as the same account, so they share one session rather than each opening
 * their own. The stats routes never sign anything and simply ignore it.
 *
 * Signing follows the reads: whichever node the pool settled on is the one
 * pushed here, so a transaction is broadcast where the data came from rather
 * than to some other node at a different height.
 */
export const sessionKit = new SessionKit({
  appName: 'Alien Worlds Tools',
  /* A placeholder. Nothing is signed or restored before pointAtALiveNode()
     has replaced it with a node the pool found answering. */
  chains: [{ id: Chains.WAX.id, url: ENDPOINTS[0] }],
  ui: new WebRenderer(),
  walletPlugins: [new WalletPluginCloudWallet(), new WalletPluginAnchor()],
})

/**
 * Point the session at a node that answers, before it is used for anything.
 *
 * The kit is built at import time, when the only url available is the first
 * one in the list — and that node can be down. It was: blacklusion answered
 * nothing at all, so a session restored on page load was bound to a dead
 * endpoint, failed to load, and dropped the reader back to the connect dialog
 * with somebody else's wallet listed first. Logging in got away with it
 * because it already asked the pool; restoring never did.
 */
async function pointAtALiveNode() {
  try {
    await start()
  } catch (err) {
    /* The pool keeps its own counsel about which nodes are up. If it cannot
       be asked at all, the placeholder is no worse than before. */
    console.error('Node pool:', err)
  }
  sessionKit.setEndpoint(Chains.WAX.id, preferredUrl())
}

interface State {
  session: Session | null
  /** Restoring on load, or a login in flight. */
  busy: boolean
  error: string | null
}

let state: State = { session: null, busy: false, error: null }
const listeners = new Set<(s: State) => void>()
let restored = false

function publish(next: Partial<State>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn(state)
}

/** The account name, or null — what almost every caller actually wants. */
export const actorOf = (s: Session | null) => (s ? String(s.actor) : null)

/**
 * A wallet cancellation is a decision, not a failure. WharfKit reports it as a
 * thrown error like any other, so it is recognised and reported as "cancelled"
 * rather than shown as something going wrong.
 */
const isCancel = (err: unknown) => {
  const m = err instanceof Error ? err.message : String(err)
  return /cancel|closed|abort|declin|reject/i.test(m)
}

export async function login() {
  if (state.busy) return
  publish({ busy: true, error: null })
  try {
    await pointAtALiveNode()
    const { session } = await sessionKit.login()
    publish({ session, busy: false })
  } catch (err) {
    publish({ busy: false, error: isCancel(err) ? null : err instanceof Error ? err.message : String(err) })
  }
}

export async function logout() {
  try {
    await sessionKit.logout()
  } catch (err) {
    /* Already gone as far as this page is concerned; there is nothing for the
       reader to do about a failed cleanup on the wallet's side. */
    console.error('Logout:', err)
  }
  publish({ session: null })
}

/** Brings back a session from a previous visit, once per page load. */
async function restore() {
  if (restored) return
  restored = true
  publish({ busy: true })
  try {
    await pointAtALiveNode()
    const session = await sessionKit.restore()
    publish({ session: session ?? null, busy: false })
  } catch (err) {
    console.error('Could not restore the wallet session:', err)
    publish({ busy: false })
  }
}

export function useSession() {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    void restore()
    return () => {
      listeners.delete(setS)
    }
  }, [])
  return { ...s, actor: actorOf(s.session), login, logout }
}

/** Read the current session without subscribing — for non-React callers. */
export const currentSession = () => state.session
