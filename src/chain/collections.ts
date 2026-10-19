/**
 * Which collection an NFT belongs to — so every NFT figure on the site can
 * count Alien Worlds NFTs (`alien.worlds`) and nothing else.
 *
 * An atomicassets transfer names only asset ids. The collection is in the
 * `logtransfer` that accompanies it, but the history servers cannot find those
 * by account, so it is asked of the AtomicAssets API instead, a hundred ids at
 * a time. A collection never changes, so each id is asked about once; burned
 * assets are still answered.
 *
 * A failed lookup throws rather than guessing: a day counted without it would
 * be wrong in a way nobody could see, where a failed day is simply collected
 * again on the next run.
 */

export const AW_COLLECTION = 'alien.worlds'

const APIS = ['https://wax.api.atomicassets.io', 'https://wax-aa.eu.eosamsterdam.net']
const BATCH = 100
/* A request the API never answers must not hold a whole collection run. */
const TIMEOUT_MS = 20_000
/* Between batches: the APIs rate-limit, and a limited request can simply hang. */
const GAP_MS = 250
const ROUNDS = 3
const known = new Map<string, string>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ask(ids: string[]): Promise<Map<string, string>> {
  let lastError: unknown
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await sleep(2_000 * round)
    for (const api of APIS) {
      try {
        return await askOne(api, ids)
      } catch (err) {
        lastError = err
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function askOne(api: string, ids: string[]): Promise<Map<string, string>> {
  const res = await fetch(`${api}/atomicassets/v1/assets?ids=${ids.join(',')}&limit=${ids.length}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${api}: HTTP ${res.status}`)
  const body = (await res.json()) as { success?: boolean; data?: { asset_id: string; collection?: { collection_name?: string } }[] }
  if (!body.success || !body.data) throw new Error(`${api}: no data`)
  return new Map(body.data.map((a) => [String(a.asset_id), String(a.collection?.collection_name ?? '')]))
}

/** The collection of every id given, looked up once each. */
export async function collectionsOf(ids: Iterable<string | number>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].map(String))].filter((id) => !known.has(id))
  for (let i = 0; i < wanted.length; i += BATCH) {
    if (i) await sleep(GAP_MS)
    const batch = wanted.slice(i, i + BATCH)
    const got = await ask(batch)
    /* An id the API does not know is not an Alien Worlds NFT it can vouch for. */
    for (const id of batch) known.set(id, got.get(id) ?? '')
  }
  const out = new Map<string, string>()
  for (const id of ids) out.set(String(id), known.get(String(id)) ?? '')
  return out
}

export interface AwTransfer {
  at: number
  from: string
  to: string
  memo: string
  assetIds: string[]
}

/**
 * Every Alien Worlds NFT transfer in or out of one account, oldest first.
 *
 * The same API, asked the other way round. Above, a list of ids goes out and
 * their collections come back; here the collection is the question and the
 * answer is only the transfers that match it — which history cannot do, since
 * an atomicassets transfer names ids and nothing else.
 *
 * It is the difference between a tractable figure and an intractable one. The
 * Alien Worlds NFTs in Planetary Defense's custody have moved twelve times in
 * their whole history, and this returns those twelve in one request. Finding
 * them in history means every transfer the holding account has ever made —
 * eleven thousand of them — and then asking this API which collection each of
 * nearly nine thousand distinct assets belongs to, to throw away nine in ten
 * of the answers.
 *
 * A page that fails is a throw, not an empty page. A transfer silently missed
 * here is an asset missing from every later day of a chart.
 */
export async function awTransfersFor(account: string): Promise<AwTransfer[]> {
  const out: AwTransfer[] = []
  for (let page = 1; page <= 100; page++) {
    if (page > 1) await sleep(GAP_MS)
    const rows = await transferPage(account, page)
    out.push(...rows)
    if (rows.length < BATCH) break
  }
  return out
}

interface TransferRow {
  created_at_time: string | number
  sender_name?: string
  recipient_name?: string
  memo?: string
  assets?: { asset_id: string }[]
}

async function transferPage(account: string, page: number): Promise<AwTransfer[]> {
  let lastError: unknown
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await sleep(2_000 * round)
    for (const api of APIS) {
      try {
        const url =
          `${api}/atomicassets/v1/transfers?account=${account}&collection_name=${AW_COLLECTION}` +
          `&page=${page}&limit=${BATCH}&order=asc&sort=created`
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!res.ok) throw new Error(`${api}: HTTP ${res.status}`)
        const body = (await res.json()) as { success?: boolean; data?: TransferRow[] }
        if (!body.success || !body.data) throw new Error(`${api}: no data`)
        return body.data.map((t) => ({
          at: Number(t.created_at_time),
          from: String(t.sender_name ?? ''),
          to: String(t.recipient_name ?? ''),
          memo: String(t.memo ?? ''),
          assetIds: (t.assets ?? []).map((a) => String(a.asset_id)),
        }))
      } catch (err) {
        lastError = err
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** How many of these ids are Alien Worlds NFTs. */
export async function countAw(ids: Iterable<string | number>): Promise<number> {
  const list = [...ids].map(String)
  if (!list.length) return 0
  const cols = await collectionsOf(list)
  return list.filter((id) => cols.get(id) === AW_COLLECTION).length
}
