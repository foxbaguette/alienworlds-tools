import { useEffect, useState } from 'react'
import { call, start } from './chain/nodes'
import { fetchAllocations, fetchAllocators, type Allocation, type Allocator } from './chain/allocators'

/**
 * Point allocators, read once and shared by the list, the details and the menu.
 *
 * Shares are apportioned across ALL allocators, so a details page cannot work
 * from its own allocator alone — it needs every allocator's allocations to know
 * what fraction of a recipient's funding this one provides.
 */
export interface Signers {
  /** The accounts whose signatures count. */
  members: { actor: string; permission: string; weight: number }[]
  /** How many of them it takes. */
  threshold: number
}

interface Store {
  allocators: Allocator[]
  allocations: Map<string, Allocation[]>
  signers: Map<string, Signers>
  loading: boolean
  error: string | null
}

let store: Store = {
  allocators: [],
  allocations: new Map(),
  signers: new Map(),
  loading: false,
  error: null,
}
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Partial<Store>) {
  store = { ...store, ...next }
  for (const fn of listeners) fn()
}

/**
 * Who has to sign for an allocator to act.
 *
 * These are ordinary account multisigs rather than DAO councils, so the answer
 * is the account's own `active` permission: its member accounts and how many of
 * them the threshold wants. Weights are carried through because nothing
 * promises they are all 1 — a threshold of 3 over weights of 2 and 1 is two
 * signatures, not three.
 */
async function fetchSigners(name: string): Promise<Signers | null> {
  try {
    const acct = await call({ account_name: name }, 'get_account')
    const active = (acct.permissions ?? []).find((p: { perm_name: string }) => p.perm_name === 'active')
    if (!active) return null
    return {
      threshold: Number(active.required_auth.threshold) || 0,
      members: (active.required_auth.accounts ?? []).map(
        (a: { permission: { actor: string; permission: string }; weight: number }) => ({
          actor: a.permission.actor,
          permission: a.permission.permission,
          weight: Number(a.weight) || 1,
        }),
      ),
    }
  } catch (err) {
    console.error(`Could not read who signs for ${name}:`, err)
    return null
  }
}

function load(force = false): Promise<void> {
  if (inFlight) return inFlight
  if (!force && store.allocators.length) return Promise.resolve()

  publish({ loading: true, error: null })
  inFlight = (async () => {
    if (!(await start())) throw new Error('No WAX node answered.')
    const allocators = await fetchAllocators()
    publish({ allocators })

    const [allocationPairs, signerPairs] = await Promise.all([
      Promise.all(
        allocators.map(async (a) => [a.allocator, await fetchAllocations(a.allocator).catch(() => [])] as const),
      ),
      Promise.all(allocators.map(async (a) => [a.allocator, await fetchSigners(a.allocator)] as const)),
    ])

    publish({
      allocations: new Map(allocationPairs),
      signers: new Map(signerPairs.filter((p): p is [string, Signers] => p[1] !== null)),
      loading: false,
    })
  })()
    .catch((err: unknown) => {
      console.error('Could not read the allocators:', err)
      publish({ loading: false, error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

export function useAllocators() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    void load()
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return { ...store, refresh: () => load(true) }
}

/** Subscribe WITHOUT triggering a load — for the sidebar. See useDaoNav. */
export function subscribeAllocators(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export const peekAllocators = () => store.allocators
