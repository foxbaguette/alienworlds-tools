/**
 * Reading tables from WAX nodes.
 *
 * A small cut of the game's own client: the same public nodes, used in
 * turn, falling through to the next on an error or an empty answer under
 * load. No wallet and no signing — this project only ever reads.
 */

export const RPC_ENDPOINTS: readonly string[] = [
  'https://wax.greymass.com',
  'https://api.hivebp.io',
  'https://wax.eosdac.io',
  'https://api.waxsweden.org',
  'https://wax.eosusa.io',
  'https://wax.eosphere.io',
  'https://wax.cryptolions.io',
]

export interface TableQuery {
  code: string
  scope: string
  table: string
  lower_bound?: string
  upper_bound?: string
  limit?: number
  index_position?: number
  key_type?: string
  reverse?: boolean
}

interface TablePage<T> {
  rows: T[]
  more: boolean
  next_key?: string
}

let next = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* A node that hangs would hold up every read that lands on it: it gets eight
   seconds, and after failing it is skipped for a minute. */
const REQUEST_TIMEOUT_MS = 8_000
const BENCH_MS = 60_000
const benchedUntil = new Map<string, number>()

export async function getRows<T>(query: TableQuery): Promise<TablePage<T>> {
  let lastError: unknown
  for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
    const base = RPC_ENDPOINTS[next % RPC_ENDPOINTS.length]
    next++
    /* Benched nodes are passed over, unless every other one has failed too. */
    if ((benchedUntil.get(base) ?? 0) > Date.now() && attempt < RPC_ENDPOINTS.length - 1) continue
    try {
      const res = await fetch(`${base}/v1/chain/get_table_rows`, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        /* text/plain keeps the request "simple", so no CORS preflight. */
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ json: true, limit: 1000, ...query }),
      })
      if (!res.ok) throw new Error(`${base} answered ${res.status}`)
      const page = (await res.json()) as TablePage<T>
      if (!Array.isArray(page.rows)) throw new Error(`${base} sent no rows`)
      benchedUntil.delete(base)
      return page
    } catch (e) {
      lastError = e
      benchedUntil.set(base, Date.now() + BENCH_MS)
      await sleep(150)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No WAX node answered')
}

/** Every row of a table, page by page. */
export async function getAllRows<T>(query: TableQuery, maxPages = 50): Promise<T[]> {
  const out: T[] = []
  let lower = query.lower_bound
  for (let i = 0; i < maxPages; i++) {
    const page = await getRows<T>({ ...query, lower_bound: lower })
    out.push(...page.rows)
    if (!page.more || !page.next_key) break
    lower = page.next_key
    await sleep(150)
  }
  return out
}

/* A short-lived memo, so screens that ask for the same table share it. */
const memo = new Map<string, { at: number; value: Promise<unknown> }>()

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
  const value = load()
  memo.set(key, { at: Date.now(), value })
  value.catch(() => memo.delete(key))
  return value
}

const NAME_CHARS = '.12345abcdefghijklmnopqrstuvwxyz'

/**
 * `eosio::name` to its 64-bit value — base-32, five bits per character for
 * the first twelve and four for the thirteenth.
 */
export function nameToUint64(name: string): bigint {
  let value = 0n
  for (let i = 0; i <= 12; i++) {
    let c = 0n
    if (i < name.length) {
      const k = NAME_CHARS.indexOf(name[i])
      if (k < 0) throw new Error(`Not a valid account name: ${name}`)
      c = BigInt(k)
    }
    if (i < 12) value |= (c & 0x1fn) << BigInt(64 - 5 * (i + 1))
    else value |= c & 0x0fn
  }
  return value
}
