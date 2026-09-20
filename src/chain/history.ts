/**
 * Hyperion — the WAX history API.
 *
 * Every other read in the app asks a node what a table holds *now*. The pool
 * statistics need what happened: which payouts went out, and what a pool held
 * yesterday afternoon. Nodes do not keep that; history indexers do.
 *
 * Five public indexers, used in turn. Three things learned the hard way:
 *
 *   * **Timestamps need their `Z`.** Without it one indexer reads the time as
 *     its own local zone and quietly returns 32 hours for a 24-hour window.
 *     `iso()` below is the only way a time leaves this file.
 *   * **They rate-limit.** A 429 or a network failure moves on to the next
 *     indexer rather than retrying the same one, and pages are paced.
 *   * **`skip` runs out.** Past about ten thousand rows an offset stops
 *     working, so long listings page by time instead — see `historyCrawl`.
 */

export const HISTORY_ENDPOINTS: readonly string[] = [
  'https://wax.cryptolions.io',
  'https://api.waxsweden.org',
  'https://wax.hivebp.io',
  'https://hyperion.wax.detroitledger.tech',
  'https://wax.eosphere.io',
]

/** Pause between pages of one crawl. */
const PAGE_GAP_MS = 250

/** The largest page the indexers hand out. */
export const HISTORY_PAGE = 1000

let next = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An ISO time the indexers all read the same way. */
export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** A history timestamp — which arrives without its zone — as milliseconds. */
export function historyTime(s: string): number {
  return Date.parse(s.endsWith('Z') ? s : s + 'Z')
}

/** One GET against whichever indexer is next, falling through on failure. */
/** How long one request may take before the next server is tried. */
const REQUEST_TIMEOUT_MS = 8_000
/** How long a server that failed is left alone. */
const BENCH_MS = 60_000
/** Full passes over the servers before a request is given up on. */
const ROUNDS = 5

/* When each server may be tried again, after a failure. */
const benchedUntil = new Map<string, number>()

/**
 * One GET, tried across the servers until one answers.
 *
 * A server that times out, errors or rate-limits is benched for a minute so
 * the requests that follow go straight to the ones that work. If every server
 * fails, the whole pass is repeated after a growing pause — five passes — before
 * giving up, because under a heavy crawl most failures are momentary.
 */
export async function historyGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString()
  let lastError: unknown
  for (let round = 0; round < ROUNDS; round++) {
    for (let attempt = 0; attempt < HISTORY_ENDPOINTS.length; attempt++) {
      const base = HISTORY_ENDPOINTS[next % HISTORY_ENDPOINTS.length]
      next++
      /* Benched servers are skipped — unless it is the last round and nothing else is left. */
      if ((benchedUntil.get(base) ?? 0) > Date.now() && round < ROUNDS - 1) continue
      try {
        const res = await fetch(`${base}${path}?${query}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`${base} answered ${res.status}`)
        const body = (await res.json()) as T
        benchedUntil.delete(base)
        return body
      } catch (e) {
        lastError = e
        benchedUntil.set(base, Date.now() + BENCH_MS)
      }
    }
    /* 2, 4, 8, 16 s — together about as long as a bench, so a rate-limited server is back by the last pass. */
    if (round < ROUNDS - 1) await sleep(2_000 * 2 ** round)
  }
  throw lastError instanceof Error ? lastError : new Error('No history server answered')
}

/**
 * Every row between two times, oldest first, paging by time.
 *
 * Each page starts at the last timestamp of the one before rather than at an
 * offset, so there is no ceiling on how far it can go. Starting *at* that
 * timestamp re-reads the rows of its last block, which is what `key`
 * deduplicates — cheaper than risking the rows of a block split across two
 * pages.
 */
/**
 * Progress through a crawl: rows just read, and — once, from each window's
 * first page — how many rows that window holds.
 */
export type Progress = (rowsRead: number, windowTotal: number) => void

/**
 * Adds up progress from several crawls into one fraction, 0 to 1.
 */
export function progressMeter(onFraction: (fraction: number) => void): Progress {
  let read = 0
  let total = 0
  return (rows, windowTotal) => {
    read += rows
    total += windowTotal
    onFraction(total > 0 ? Math.min(1, read / total) : 0)
  }
}

export async function historyCrawl<R>(
  path: string,
  params: Record<string, string | number>,
  from: number,
  until: number,
  pick: (page: unknown) => R[],
  timeOf: (row: R) => number,
  key: (row: R) => string | number,
  maxPages = 40,
  onProgress?: Progress,
): Promise<R[]> {
  const seen = new Set<string | number>()
  const out: R[] = []
  let cursor = from
  for (let page = 0; page < maxPages; page++) {
    const body = await historyGet<{ total?: { value?: number } }>(path, {
      ...params,
      after: iso(cursor),
      before: iso(until),
      sort: 'asc',
      limit: HISTORY_PAGE,
    })
    const rows = pick(body)
    /* The first page says how many rows the window holds. */
    if (page === 0) onProgress?.(0, Number(body.total?.value ?? rows.length))
    let fresh = 0
    for (const r of rows) {
      const k = key(r)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
      fresh++
    }
    onProgress?.(fresh, 0)
    if (rows.length < HISTORY_PAGE || fresh === 0) break
    cursor = timeOf(rows[rows.length - 1])
    await sleep(PAGE_GAP_MS)
  }
  return out
}

/**
 * A window read as several slices at once.
 *
 * One crawl is a chain of pages, each waiting on the last. Cut the window
 * into slices and the chains run side by side, spread over the history
 * servers in turn — a fraction of the wait for the same number of requests.
 * Each slice starts a second early so a block on the seam is read by both;
 * `key` removes the repeats.
 */
export async function historySliced<R>(
  path: string,
  params: Record<string, string | number>,
  from: number,
  until: number,
  pick: (page: unknown) => R[],
  timeOf: (row: R) => number,
  key: (row: R) => string | number,
  slices = 6,
  onProgress?: Progress,
): Promise<R[]> {
  const OVERLAP_MS = 1_000
  const step = (until - from) / slices
  const parts = await Promise.all(
    Array.from({ length: slices }, (_, i) =>
      historyCrawl<R>(
        path,
        params,
        Math.max(from, from + step * i - OVERLAP_MS),
        i === slices - 1 ? until : from + step * (i + 1),
        pick,
        timeOf,
        key,
        200,
        onProgress,
      ),
    ),
  )
  const seen = new Set<string | number>()
  const out: R[] = []
  for (const r of parts.flat()) {
    const k = key(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}
