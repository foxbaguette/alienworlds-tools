import { useEffect, useState } from 'react'
import { loadDaos, type Dao } from './chain/daos'

/**
 * Every DAO, loaded once per session and shared by every route that needs it.
 *
 * Module-level rather than per-component: the grid, the details and the
 * proposal overview all want the same twelve councils, and reading them three
 * times would be three times the chain traffic for the same answer.
 *
 * Councils arrive one at a time and each one repaints, so the first card shows
 * within a second instead of the page waiting on the slowest.
 */
type State = { daos: Dao[]; loading: boolean; error: string | null }

let cache: State = { daos: [], loading: false, error: null }
let inFlight: Promise<void> | null = null
const listeners = new Set<(s: State) => void>()

function publish(next: Partial<State>) {
  cache = { ...cache, ...next }
  for (const fn of listeners) fn(cache)
}

function load(force = false): Promise<void> {
  if (inFlight) return inFlight
  if (!force && cache.daos.length) return Promise.resolve()

  publish({ loading: true, error: null })
  inFlight = loadDaos((daos) => publish({ daos }))
    .then((daos) => publish({ daos, loading: false }))
    .catch((err: unknown) => {
      console.error('Could not read the DAO directory:', err)
      publish({ loading: false, error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

export function useDaos() {
  const [state, setState] = useState(cache)

  useEffect(() => {
    listeners.add(setState)
    void load()
    return () => {
      listeners.delete(setState)
    }
  }, [])

  return { ...state, refresh: () => load(true) }
}

export const daoById = (daos: Dao[], id: string) => daos.find((d) => d.id === id)
