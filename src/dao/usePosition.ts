import { useEffect, useState } from 'react'
import {
  TLM_CONTRACT,
  TLM_SYMBOL,
  readBalances,
  readPosition,
  readStakeConfig,
  readSwapTargets,
  type Position,
  type StakeConfig,
} from './chain/stake'
import type { Dao } from './chain/daos'

/**
 * What the signed-in account holds, per DAO.
 *
 * Shared rather than per-card, because the expensive part is not the per-DAO
 * read: one read of each token contract gets every balance that holder has, so
 * twelve DAOs cost three balance reads instead of twelve. The staking tables
 * are then read per DAO and pinned to one node each.
 *
 * Loaded on demand — nothing here is needed until somebody opens the actions,
 * and a page that only lists councils should not be reading anyone's wallet.
 */
interface Store {
  actor: string | null
  positions: Map<string, Position>
  configs: Map<string, StakeConfig | null>
  /** Token symbol to what stake.worlds calls that DAO. */
  swaps: Map<string, string>
  tlm: string | null
  loading: boolean
  error: string | null
}

let store: Store = {
  actor: null,
  positions: new Map(),
  configs: new Map(),
  swaps: new Map(),
  tlm: null,
  loading: false,
  error: null,
}

let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Partial<Store>) {
  store = { ...store, ...next }
  for (const fn of listeners) fn()
}

export function loadPositions(daos: Dao[], actor: string | null, force = false): Promise<void> {
  if (!actor || !daos.length) {
    publish({ actor: null, positions: new Map(), tlm: null })
    return Promise.resolve()
  }
  if (inFlight) return inFlight
  if (!force && store.actor === actor && store.positions.size) return Promise.resolve()

  publish({ loading: true, error: null })
  inFlight = (async () => {
    const contracts = [...new Set(daos.map((d) => d.tokenContract).filter((c): c is string => !!c))]
    const [tlmBalances, ...perContract] = await Promise.all([
      readBalances(TLM_CONTRACT, actor).catch(() => new Map<string, string>()),
      ...contracts.map((c) => readBalances(c, actor).catch(() => new Map<string, string>())),
    ])

    /* Keyed by contract AND symbol: two DAOs can share a token contract. */
    const balances = new Map<string, string>()
    contracts.forEach((c, i) => {
      for (const [code, asset] of perContract[i]) balances.set(`${c}:${code}`, asset)
    })

    const pairs = await Promise.all(
      daos.map(async (dao) => {
        if (!dao.tokenContract) return null
        const balance = balances.get(`${dao.tokenContract}:${dao.symbol}`) ?? null
        const p = await readPosition(dao, actor, balance).catch((err) => {
          console.error(`Could not read your position in ${dao.id}:`, err)
          return null
        })
        return p ? ([dao.id, p] as const) : null
      }),
    )

    const positions = new Map(pairs.filter((p): p is readonly [string, Position] => !!p))

    /* Only a DAO holding a stake WITHOUT an explicit delay needs its config
       read to know the floor — usually none of them. */
    const needConfig = daos.filter((d) => {
      const e = positions.get(d.id)
      return e?.staked && e.delay == null
    })
    const configs = new Map(store.configs)
    await Promise.all(
      needConfig.map(async (dao) => {
        const cfg = await readStakeConfig(dao).catch(() => null)
        configs.set(dao.id, cfg)
        const e = positions.get(dao.id)
        if (cfg && e) positions.set(dao.id, { ...e, delay: cfg.min, delayIsMinimum: true })
      }),
    )

    publish({
      actor,
      positions,
      configs,
      tlm: tlmBalances.get(TLM_SYMBOL) ?? null,
      swaps: store.swaps.size ? store.swaps : await readSwapTargets().catch(() => new Map()),
      loading: false,
    })
  })()
    .catch((err: unknown) => {
      console.error('Could not read your holdings:', err)
      publish({ loading: false, error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/** The stake config for one DAO, read on demand and kept. */
export async function ensureStakeConfig(dao: Dao): Promise<StakeConfig | null> {
  if (store.configs.has(dao.id)) return store.configs.get(dao.id) ?? null
  const cfg = await readStakeConfig(dao).catch(() => null)
  publish({ configs: new Map(store.configs).set(dao.id, cfg) })
  return cfg
}

export function usePositions(daos: Dao[], actor: string | null) {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])

  useEffect(() => {
    void loadPositions(daos, actor)
  }, [actor, daos.length])

  return { ...store, refresh: () => loadPositions(daos, actor, true) }
}
