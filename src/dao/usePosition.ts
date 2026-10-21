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
import { call, pinned } from './chain/nodes'
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
  /**
   * The head block the node serving this read was on.
   *
   * What makes it worth keeping is that `notStaked` is arithmetic across
   * tables — balance less stake less what is unstaking — so a caller that has
   * just signed something needs to know whether these figures are from before
   * or after it. See `refreshPast`.
   */
  head: number
  loading: boolean
  error: string | null
}

let store: Store = {
  actor: null,
  positions: new Map(),
  configs: new Map(),
  swaps: new Map(),
  tlm: null,
  head: 0,
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

    /*
      The whole pass on ONE node.

      `notStaked` is not a figure anyone reports; it is arithmetic across
      tables — the balance, less what is staked, less what is unstaking and not
      yet released. readPosition already pinned its three staking tables
      together for that reason, and then the balance, the fourth number in the
      same subtraction, was read wherever the pool felt like.

      That is how converting Trilium left the Stake action short. The swap puts
      new tokens in `accounts`; a node a few seconds behind — and one in the
      pool is routinely six — still has the old balance, while the staking
      tables come from a node that is current. The difference reads as tokens
      that are not there.

      One node means the subtraction is of four numbers from one moment. It may
      be a moment slightly in the past, which is what `head` below is for, but
      it is never four different moments.
    */
    const [got] = await pinned(1 + contracts.length + daos.length * 3, (url) => [
      (async () => {
        const [tlmBalances, ...perContract] = await Promise.all([
          readBalances(TLM_CONTRACT, actor, url).catch(() => new Map<string, string>()),
          ...contracts.map((c) => readBalances(c, actor, url).catch(() => new Map<string, string>())),
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
            const p = await readPosition(dao, actor, balance, url).catch((err) => {
              console.error(`Could not read your position in ${dao.id}:`, err)
              return null
            })
            return p ? ([dao.id, p] as const) : null
          }),
        )

        return { tlmBalances, pairs, head: await headOf(url) }
      })(),
    ] as const)

    const { tlmBalances, pairs, head } = got
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
      head,
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

/** Which block the node answering was on, or 0 if it would not say. */
async function headOf(url: string | undefined): Promise<number> {
  try {
    const info = (await call({}, 'get_info', url)) as { head_block_num?: number }
    return Number(info.head_block_num) || 0
  } catch {
    return 0
  }
}

/**
 * Reads again until the figures are from after a transaction, or time is up.
 *
 * A fixed pause after signing was the other half of the stale Stake amount: two
 * and a half seconds is five blocks, and a node six seconds behind has not seen
 * the swap yet however long the browser waits. So this waits on the chain
 * rather than the clock — it reads, and if the node it reached was still short
 * of the block the transaction landed in, it tries again.
 *
 * It gives up rather than spinning. Figures a few seconds old are a small
 * wrong; a page that never stops loading is a larger one, and the next thing
 * the reader does will read again anyway.
 */
export async function refreshPast(
  daos: Dao[],
  actor: string | null,
  block: number,
  waitMs = 15_000,
): Promise<void> {
  const until = Date.now() + waitMs
  for (;;) {
    await loadPositions(daos, actor, true)
    /* 0 means the node would not say what block it was on, which is no reason
       to read it over and over. */
    if (!block || !store.head || store.head >= block || Date.now() >= until) return
    await new Promise((r) => setTimeout(r, 1_500))
  }
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

  return {
    ...store,
    /* With a block, it waits for figures from after it — see refreshPast. */
    refresh: (block?: number) =>
      block ? refreshPast(daos, actor, block) : loadPositions(daos, actor, true),
  }
}
