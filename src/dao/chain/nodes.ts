/**
 * The node pool the DAO tools read through.
 *
 * Separate from `src/chain/rpc.ts`, which serves the stats routes, because this
 * side needs two things that one does not: reads that must agree with each
 * other pinned to a single node, and endpoints other than `get_table_rows`.
 * What it borrows is the important part — the "simple request" trick below.
 *
 * Every node is probed at once, reads start on the first that answers, and the
 * rest of the pool joins behind it. Each node carries its own budget, so the
 * aggregate rate is simply how many of them are up.
 */

/**
 * `text/plain` rather than `application/json`.
 *
 * A POST with `content-type: application/json` is not a CORS "simple request",
 * so the browser sends an OPTIONS preflight first and waits for it — two round
 * trips for every read. `text/plain` keeps it simple, the preflight never
 * happens, and WAX nodes parse the body the same either way because they go by
 * content, not by the header.
 *
 * It also widens the pool. Several nodes answer GET and POST perfectly well and
 * simply do not handle OPTIONS; they were unusable before and are fine now.
 */
const CONTENT_TYPE = 'text/plain'

export const ENDPOINTS: readonly string[] = [
  'https://wax.blacklusion.io',
  'https://api.waxsweden.org',
  'https://wax.eosdac.io',
  'https://wax.api.eosnation.io',
  'https://api.wax.bountyblok.io',
  'https://api.hivebp.io',
  'https://wax.eosphere.io',
  'https://wax.eosusa.io',
  'https://wax.greymass.com',
  'https://wax.cryptolions.io',
  'https://waxapi.ledgerwise.io',
]

/** Reads a node will take in any RATE_WINDOW. Per node, so the pool multiplies it. */
const RATE_LIMIT = 12
const RATE_WINDOW = 2_000
/** A node that cannot answer this fast is not one to read from. */
const PROBE_TIMEOUT = 1_500
const REQUEST_TIMEOUT = 15_000
/** Consecutive failures before a node sits out, and for how long. */
const BENCH_AFTER = 2
const BENCH_MS = 60_000
const MAX_ATTEMPTS = 3
/** A node further behind head than this is serving from an older chain state. */
const MAX_LAG_SECONDS = 180

interface Node {
  url: string
  /** When each recent call was made, so the window can roll forward. */
  recent: number[]
  fails: number
  benchedUntil: number
}

let pool: Node[] = []
let ready = false

export const isReady = () => ready
/** The node signing follows, so a transaction goes where the reads went. */
export const preferredUrl = () => pool[0]?.url ?? ENDPOINTS[0]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rawPost(body: unknown, url: string, timeout: number, path = 'get_table_rows') {
  const res = await fetch(`${url}/v1/chain/${path}`, {
    method: 'POST',
    headers: { 'content-type': CONTENT_TYPE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * Hands out a node with room in its window, waiting rather than overspending
 * when every one is busy.
 *
 * `count` reserves that many slots on ONE node. Reads that have to agree with
 * each other must come from the same node: spread across the pool they can
 * straddle a block boundary and return figures from two different chain states,
 * which is subtly wrong rather than visibly broken.
 */
async function acquire(count = 1): Promise<Node> {
  for (;;) {
    const now = Date.now()
    let best: Node | null = null
    let soonest = Infinity
    let benched = 0

    for (const node of pool) {
      if (node.benchedUntil > now) {
        benched++
        continue
      }
      while (node.recent.length && now - node.recent[0] >= RATE_WINDOW) node.recent.shift()
      if (node.recent.length + count <= RATE_LIMIT) {
        if (!best || node.recent.length < best.recent.length) best = node
      } else if (node.recent.length) {
        soonest = Math.min(soonest, node.recent[0] + RATE_WINDOW - now)
      }
    }

    if (best) {
      for (let i = 0; i < count; i++) best.recent.push(now)
      return best
    }
    /* Everything is benched: a wrong node beats no node. */
    if (pool.length && benched === pool.length) {
      for (const node of pool) node.benchedUntil = 0
      continue
    }
    await sleep(Math.max(40, Math.min(soonest === Infinity ? 200 : soonest, 200)))
  }
}

function penalise(node: Node) {
  node.fails += 1
  if (node.fails >= BENCH_AFTER) node.benchedUntil = Date.now() + BENCH_MS
}

/** One call, retried on a different node before giving up. */
export async function call(body: unknown, path = 'get_table_rows', pinned?: string) {
  if (pinned) return rawPost(body, pinned, REQUEST_TIMEOUT, path)

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const node = await acquire()
    try {
      const data = await rawPost(body, node.url, REQUEST_TIMEOUT, path)
      node.fails = 0
      return data
    } catch (err) {
      lastError = err
      penalise(node)
    }
  }
  throw lastError
}

/**
 * Runs a group of reads that must agree against one node, moving the WHOLE
 * group elsewhere if it fails. Retrying only the failed member would reintroduce
 * exactly the split this exists to prevent.
 */
export async function pinned<T extends readonly Promise<unknown>[]>(
  count: number,
  build: (url: string | undefined) => T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const node = await acquire(count)
    try {
      /* The tuple mapped type is what keeps the four reads four DIFFERENT types
         on the way out. A plain Promise<T>[] collapses them to whichever the
         first one is, and the call site then has to lie about the rest. */
      return (await Promise.all(build(node.url))) as { -readonly [K in keyof T]: Awaited<T[K]> }
    } catch (err) {
      lastError = err
      penalise(node)
    }
  }
  throw lastError
}

async function probe(url: string, timeout: number) {
  const started = performance.now()
  try {
    /*
     * get_table_rows, because it is the request these tools actually make. A
     * node at its own rate limit answers with an error carrying no CORS
     * headers, and the endpoint being rate limited is the one being hammered —
     * so probing the cheap endpoint says a node is up, while probing this one
     * says it will serve us.
     */
    const data = await rawPost(
      { json: true, code: 'index.worlds', scope: 'index.worlds', table: 'dacs', limit: 1 },
      url,
      timeout,
    )
    if (!Array.isArray(data.rows)) return null
    return { url, ms: performance.now() - started, at: Date.now() }
  } catch {
    return null
  }
}

/** How far behind head a node is serving from, or null if it will not say. */
async function lagOf(url: string): Promise<number | null> {
  try {
    const info = await rawPost({}, url, PROBE_TIMEOUT, 'get_info')
    const head = Date.parse(`${info.head_block_time}Z`)
    return Number.isFinite(head) ? (Date.now() - head) / 1000 : null
  } catch {
    return null
  }
}

/** Resolves with the first probe that answers, or null if every one fails. */
function firstAnswer<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let left = promises.length
    if (!left) return resolve(null)
    let done = false
    for (const p of promises) {
      void p.then((r) => {
        if (r && !done) {
          done = true
          resolve(r)
        }
        if (--left === 0 && !done) resolve(null)
      })
    }
  })
}

let starting: Promise<boolean> | null = null

/**
 * Brings the pool up. Concurrent callers share one run, so every route can ask
 * without coordinating.
 *
 * Reads start on the first node that answers rather than waiting for all of
 * them: waiting cost more than a second at the head of every load, nearly all
 * of it spent on nodes that were never going to reply.
 */
export function start(): Promise<boolean> {
  if (ready) return Promise.resolve(true)
  if (starting) return starting

  starting = (async () => {
    const pending = ENDPOINTS.map((u) => probe(u, PROBE_TIMEOUT))
    const first = await firstAnswer(pending)

    if (!first) {
      /* Ten cold TLS handshakes at once on a slow connection can blow a short
         deadline on every one of them. An empty first round means "too slow",
         not "nothing is there". */
      const all = (await Promise.all(ENDPOINTS.map((u) => probe(u, 6_000)))).filter(Boolean)
      if (!all.length) {
        starting = null
        return false
      }
      all.sort((a, b) => a!.ms - b!.ms)
      pool = all.map((r) => ({ url: r!.url, recent: [r!.at], fails: 0, benchedUntil: 0 }))
      ready = true
      return true
    }

    pool = [{ url: first.url, recent: [first.at], fails: 0, benchedUntil: 0 }]
    ready = true

    /* The rest join as they answer. Reads already in flight simply find more
       nodes to spread over on their next turn. No lag check on the first node:
       it costs the round trip this exists to save, and with one candidate in
       hand a stale node would fail the whole load rather than be skipped. */
    const have = new Set([first.url])
    for (const p of pending) {
      void p.then(async (r) => {
        if (!r || have.has(r.url)) return
        const lag = await lagOf(r.url)
        if (lag != null && lag > MAX_LAG_SECONDS) return
        have.add(r.url)
        pool.push({ url: r.url, recent: [r.at], fails: 0, benchedUntil: 0 })
      })
    }
    return true
  })()

  return starting
}

export interface TableQuery {
  code: string
  scope: string
  table: string
  limit?: number
  lower_bound?: string
  upper_bound?: string
  index_position?: number
  key_type?: string
  reverse?: boolean
}

/** Every row, following `more` rather than trusting one page. */
export async function getRows<T>(q: TableQuery, pinnedUrl?: string): Promise<T[]> {
  const out: T[] = []
  let lower = q.lower_bound
  for (let page = 0; page < 10; page++) {
    const data = await call({ json: true, limit: 100, ...q, lower_bound: lower }, 'get_table_rows', pinnedUrl)
    if (!Array.isArray(data.rows)) throw new Error(`no rows for ${q.code}/${q.scope}/${q.table}`)
    out.push(...data.rows)
    if (!data.more || !data.next_key) break
    lower = data.next_key
  }
  return out
}

/** One page, for reads off a sorted index where paging would undo the order. */
export async function getPage<T>(q: TableQuery, pinnedUrl?: string): Promise<T[]> {
  const data = await call({ json: true, limit: 100, ...q }, 'get_table_rows', pinnedUrl)
  return Array.isArray(data.rows) ? data.rows : []
}
