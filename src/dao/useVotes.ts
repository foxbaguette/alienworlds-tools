import { useEffect, useState } from 'react'
import { getRows } from './chain/nodes'
import type { Dao } from './chain/daos'
import type { VoteRow } from './chain/votes'
import { currentSession } from '../wallet/session'

/**
 * The signed-in account's vote in every DAO.
 *
 * Two maps, and the distinction between them is the point. `votes` holds the
 * rows that exist; `read` holds every DAO that ANSWERED, including the ones
 * that answered "no row". Never having voted somewhere and being unable to ask
 * it are completely different facts, and `votes` alone cannot tell them apart —
 * both leave the id absent.
 *
 * Getting that wrong is what once disabled the refresh button for anyone who
 * voted in two unions out of six, with a tooltip claiming their votes could not
 * be read. They could; there were none there to find.
 */
interface State {
  votes: Map<string, VoteRow>
  read: Set<string>
  loading: boolean
}

let state: State = { votes: new Map(), read: new Set(), loading: false }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
let loadedFor: string | null = null

function publish(next: Partial<State>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

export async function loadVotes(daos: Dao[], force = false): Promise<void> {
  const session = currentSession()
  const actor = session ? String(session.actor) : null

  if (!actor || !daos.length) {
    if (state.votes.size || state.read.size) publish({ votes: new Map(), read: new Set() })
    loadedFor = null
    return
  }
  if (inFlight) return inFlight
  if (!force && loadedFor === actor && state.read.size >= daos.length) return

  publish({ loading: true })
  const votes = new Map<string, VoteRow>()
  const read = new Set<string>()

  inFlight = Promise.all(
    daos.map(async (dao) => {
      if (!dao.custodianContract) return
      try {
        const rows = await getRows<VoteRow>({
          code: dao.custodianContract,
          scope: dao.id,
          table: 'votes',
          limit: 1,
          lower_bound: actor,
          upper_bound: actor,
        })
        if (rows[0]) votes.set(dao.id, rows[0])
        /* Recorded even with no row: an empty answer is an answer. It says this
           account has never voted here, which is a DAO to skip rather than one
           to worry about. */
        read.add(dao.id)
      } catch (err) {
        /* Left out of BOTH, so the button can tell this apart from a DAO that
           simply holds no vote. */
        console.error(`Could not read your vote in ${dao.id}:`, err)
      }
    }),
  )
    .then(() => {
      loadedFor = actor
      publish({ votes, read, loading: false })
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

export function useVotes(daos: Dao[]) {
  const [, bump] = useState(0)

  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])

  const session = currentSession()
  const actor = session ? String(session.actor) : null

  useEffect(() => {
    void loadVotes(daos)
  }, [actor, daos.length])

  return { ...state, refresh: () => loadVotes(daos, true) }
}
