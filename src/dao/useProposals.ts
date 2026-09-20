import { useEffect, useState } from 'react'
import { fetchProposals, type MsigProposal } from './chain/proposals'
import { fetchWorker, type WorkerData } from './chain/worker'

/**
 * Proposals, read once per DAO and shared.
 *
 * The details view wants one council's proposals; the overview wants every
 * council's at once. Without a shared cache, opening the overview and then a
 * DAO from it would read the same rows twice — and the overview alone is
 * already a dozen scopes.
 *
 * `null` in a cache means "asked, and it failed", which is a different thing
 * from absent: absent means nobody has asked yet, and something should.
 */
const msig = new Map<string, MsigProposal[] | null>()
const worker = new Map<string, WorkerData | null>()
const pending = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()

let version = 0
function bump() {
  version++
  for (const fn of listeners) fn()
}

/** One read per DAO, however many callers ask at once. */
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const live = pending.get(key)
  if (live) return live as Promise<T>
  const p = run().finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}

export function ensureProposals(daoId: string): Promise<void> {
  if (msig.has(daoId)) return Promise.resolve()
  return once(`msig:${daoId}`, () =>
    fetchProposals(daoId)
      .then((rows) => msig.set(daoId, rows))
      .catch((err: unknown) => {
        console.error(`proposals for ${daoId}:`, err)
        msig.set(daoId, null)
      })
      .then(bump),
  )
}

export function ensureWorker(daoId: string): Promise<void> {
  if (worker.has(daoId)) return Promise.resolve()
  return once(`worker:${daoId}`, () =>
    fetchWorker(daoId)
      .then((data) => worker.set(daoId, data))
      .catch((err: unknown) => {
        console.error(`worker proposals for ${daoId}:`, err)
        worker.set(daoId, null)
      })
      .then(bump),
  )
}

export const proposalsOf = (daoId: string) => msig.get(daoId)
export const workerOf = (daoId: string) => worker.get(daoId)

/** Drops everything, so the next ask goes back to the chain. */
export function clearProposalCaches() {
  msig.clear()
  worker.clear()
  bump()
}

/**
 * Re-renders when any cached proposal set changes.
 *
 * A version counter rather than the data itself: callers read straight from the
 * maps, so what they need is a nudge, not a copy of twelve councils' rows on
 * every update.
 */
export function useProposalCaches() {
  const [, setV] = useState(version)
  useEffect(() => {
    const fn = () => setV(version)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return version
}
