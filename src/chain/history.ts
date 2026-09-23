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

export const HISTORY_ENDPOINTS: string[] = [
  'https://wax.cryptolions.io',
  'https://api.waxsweden.org',
  'https://wax.hivebp.io',
  'https://hyperion.wax.detroitledger.tech',
  'https://wax.eosphere.io',
]

/**
 * Narrows the pool to the servers named.
 *
 * Indexers keep different amounts of the past: most hold a few months, two
 * hold the better part of a year. Reading a day from six months ago through
 * the whole pool means most answers are an empty page that the crawl then has
 * to prove is not a short read — slow, and hard on servers that have nothing
 * to give. A backfill says which servers still have that far back; the nightly
 * run leaves the pool alone.
 */
export function useHistoryServers(list: string[]): void {
  if (!list.length) return
  HISTORY_ENDPOINTS.splice(0, HISTORY_ENDPOINTS.length, ...list)
}

/**
 * Pause between pages of one crawl.
 *
 * A quarter of a second suits a nightly run of one day. A backfill reading
 * months through servers that have started refusing us needs to ask more
 * slowly than that, so it can be raised for a run.
 */
let PAGE_GAP_MS = 250

export function useHistoryGap(ms: number): void {
  if (ms > 0) PAGE_GAP_MS = ms
}

/**
 * Which way a crawl walks its window.
 *
 * Forwards by default. One indexer — eosphere — refuses a window older than
 * ninety days when asked for it in ascending order, and answers the same
 * window happily in descending order; walking backwards is what makes its
 * whole year of history usable. The rows are the same either way: a day is
 * read in full before it is counted, and each row is keyed, so nothing
 * depends on the order they arrive in.
 */
let BACKWARDS = false

export function useHistoryBackwards(on: boolean): void {
  BACKWARDS = on
}

/*
  How many requests may be in the air at once.

  Pacing pages is not enough on its own: a day is read as several slices at
  the same time, and a project reads each of its paying accounts at the same
  time again, so a "polite" run could still put a dozen requests on one server
  in the same instant. That is what gets us refused. This queue is where every
  request passes, so one number decides how hard a run leans on a server —
  a backfill sets it to one, the nightly run leaves it alone.
*/
let inFlightLimit = Infinity
let inFlight = 0
const queue: (() => void)[] = []

export function useHistoryConcurrency(n: number): void {
  if (n > 0) inFlightLimit = n
}

/*
  How far through the current read we are, in rows.

  A day of Alien Worlds is a third of a million rows and a quarter of an hour;
  a progress report that only counts finished days says nothing for fifteen
  minutes at a stretch. Every crawl adds its rows here as they arrive, so a
  watcher can say "196,838 of 345,221" while the day is still being read.
*/
let rowsSeen = 0
let rowsWanted = 0

export function historyProgress(): { seen: number; wanted: number } {
  return { seen: rowsSeen, wanted: rowsWanted }
}

/** Starts a fresh count — called when a new day, or a new part of one, begins. */
export function resetHistoryProgress(): void {
  rowsSeen = 0
  rowsWanted = 0
}

async function takeTurn(): Promise<() => void> {
  if (inFlight >= inFlightLimit) await new Promise<void>((go) => queue.push(go))
  inFlight++
  let freed = false
  return () => {
    if (freed) return
    freed = true
    inFlight--
    queue.shift()?.()
  }
}

/**
 * The largest page to ask for.
 *
 * A thousand rows is what most indexers hand out, but not all: some answer
 * 500 to anything above a hundred. A backfill that leans on one of those says
 * so, and pays for it in requests rather than in failures.
 */
export let HISTORY_PAGE = 1000

export function useHistoryPage(rows: number): void {
  if (rows > 0) HISTORY_PAGE = rows
}

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

/**
 * Waits until the history servers have indexed the chain up to `at`. They
 * index a few minutes behind it, so a count of "everything until now" read
 * straight away misses the last few minutes. Gives up after ten minutes.
 */
export async function historyReaches(at: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const page = await historyGet<{ last_indexed_block_time?: string }>('/v2/history/get_actions', { limit: 1 }).catch(
      () => null,
    )
    const t = page?.last_indexed_block_time
    if (t && historyTime(t) >= at) return
    await sleep(15_000)
  }
  throw new Error(`history servers have not reached ${iso(at)}`)
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
export async function historyGet<T>(
  path: string,
  params: Record<string, string | number>,
  /** Ask only this server — for a crawl that must not mix servers' answers. */
  pinned?: string,
): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString()
  const done = await takeTurn()
  try {
    return await ask<T>(path, query, pinned)
  } finally {
    done()
  }
}

async function ask<T>(path: string, query: string, pinned?: string): Promise<T> {
  let lastError: unknown
  for (let round = 0; round < ROUNDS; round++) {
    for (let attempt = 0; attempt < HISTORY_ENDPOINTS.length; attempt++) {
      const base = pinned ?? HISTORY_ENDPOINTS[next % HISTORY_ENDPOINTS.length]
      next++
      /*
        Benched servers are skipped — unless it is the last round and nothing
        else is left, or there is nothing else at all. A backfill often reads
        through one server (the only one holding that month), and benching it
        for a minute after a single 503 threw away the whole day's work.
      */
      const alone = HISTORY_ENDPOINTS.length === 1
      if (!pinned && !alone && (benchedUntil.get(base) ?? 0) > Date.now() && round < ROUNDS - 1) continue
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

/**
 * A crawl that came back with fewer rows than its window holds.
 *
 * Only thrown when the caller asks for exactness — the collectors, which
 * would otherwise save a short day as if it were whole.
 */
export class ShortReadError extends Error {}

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
  /** Retry a short read, then throw ShortReadError rather than return it. */
  exact = false,
): Promise<R[]> {
  /*
    First as usual, spread over the servers. If that comes back short, the
    servers disagree — one is missing rows another has — so each retry is held
    to a single server, whose total and rows then describe the same history.
  */
  const tries = exact ? 1 + HISTORY_ENDPOINTS.length : 1
  let last = ''
  /* The target, for an exact crawl: the largest count any server gives. A
     server holding only part of the window counts only that part, and a
     crawl measured against it would stop early and call itself complete. */
  let most = exact ? await largestCount(path, params, from, until) : 0
  for (let attempt = 0; attempt < tries; attempt++) {
    const pinned = attempt ? HISTORY_ENDPOINTS[attempt - 1] : undefined
    try {
      const { rows, total } = await crawlOnce(path, params, from, until, pick, timeOf, key, maxPages, onProgress, pinned)
      /* Held to the largest total any server gave: one that has dropped the
         day reports a smaller window and would otherwise look complete. */
      if (total !== null) most = Math.max(most, total)
      if (!exact || total === null || rows.length >= most) return rows
      last = `read ${rows.length} of ${most} rows`
    } catch (err) {
      /* A pinned server that fails is one of several to try, not the end. */
      if (!pinned) throw err
      last = err instanceof Error ? err.message : String(err)
    }
  }
  throw new ShortReadError(`${path} ${JSON.stringify(params)}: ${last}`)
}

/**
 * How many rows a window holds, asked of every server, the largest kept.
 *
 * A server that has dropped a day counts what it still holds — often nothing
 * — without an error. None counts rows that do not exist, so the largest is
 * right. 0 when no server gives an exact count.
 */
export async function largestCount(
  path: string,
  params: Record<string, string | number>,
  from: number,
  until: number,
): Promise<number> {
  const answers = await Promise.allSettled(
    HISTORY_ENDPOINTS.map((server) =>
      historyGet<{ total?: { value?: number; relation?: string } }>(
        path,
        { ...params, after: iso(from), before: iso(until), limit: 1, track: 'true' },
        server,
      ),
    ),
  )
  let most = 0
  let counted = false
  for (const a of answers) {
    if (a.status !== 'fulfilled' || a.value.total?.relation !== 'eq') continue
    counted = true
    most = Math.max(most, Number(a.value.total.value) || 0)
  }
  /*
    A day nobody counted is not a day of nothing. Returning 0 here wrote
    'no mines, no claims, no players' into sixty days of Alien Worlds whose
    only fault was that the server was busy at the time. Refusing costs a
    retry; answering costs the truth.
  */
  if (!counted) throw new Error()
  return most
}

/*
  One pass over a window.

  It pages until the window's exact total is reached — the servers count it
  when asked (`track=true`) — rather than until a short page. A short page
  is not the end on every server: some cap pages below what was asked, and
  stopping there cut whole days short without a word. Where no exact total
  is given, a short page still ends it, as before.
*/
async function crawlOnce<R>(
  path: string,
  params: Record<string, string | number>,
  from: number,
  until: number,
  pick: (page: unknown) => R[],
  timeOf: (row: R) => number,
  key: (row: R) => string | number,
  maxPages: number,
  onProgress?: Progress,
  pinned?: string,
): Promise<{ rows: R[]; total: number | null }> {
  const seen = new Set<string | number>()
  const out: R[] = []
  let cursor = BACKWARDS ? until : from
  let total: number | null = null
  /*
    Rows past the start of the page, for the one case paging by time cannot
    pass: more than a page of rows sharing one timestamp — a batch action that
    credits thousands of accounts in one block. Starting the next page at that
    timestamp returns the same page again, so it steps through by count
    instead until it is out the other side.
  */
  let skip = 0
  let empties = 0
  let firstEmpties = 0
  for (let page = 0; page < maxPages; page++) {
    /*
      One page failing is not a reason to throw away the tens of thousands of
      rows already read: a 503 in the middle of a busy day used to cost the
      whole day, and the day would then be read again from the beginning.
    */
    let body: { total?: { value?: number; relation?: string } } | undefined
    let pageError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        body = await historyGet<{ total?: { value?: number; relation?: string } }>(path, {
          ...params,
          after: iso(BACKWARDS ? from : cursor),
          before: iso(BACKWARDS ? cursor : until),
          sort: BACKWARDS ? 'desc' : 'asc',
          limit: HISTORY_PAGE,
          ...(skip ? { skip } : {}),
          ...(page === 0 ? { track: 'true' } : {}),
        }, pinned)
        pageError = undefined
        break
      } catch (e) {
        pageError = e
        await sleep(5_000 * (attempt + 1))
      }
    }
    if (!body) throw pageError instanceof Error ? pageError : new Error('a page could not be read')
    const rows = pick(body)
    /* The first page says how many rows the window holds. */
    if (page === 0) {
      if (body.total?.relation === 'eq' && Number.isFinite(Number(body.total.value))) total = Number(body.total.value)
      onProgress?.(0, Number(body.total?.value ?? rows.length))
      rowsWanted += Number(body.total?.value ?? rows.length) || 0
    }
    let fresh = 0
    for (const r of rows) {
      const k = key(r)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
      fresh++
    }
    onProgress?.(fresh, 0)
    rowsSeen += fresh
    if (!rows.length) {
      /* The same on the first page would read as an empty window — believed
         only once every server has said so. */
      if (!pinned && page === 0 && firstEmpties++ < HISTORY_ENDPOINTS.length - 1) {
        page--
        continue
      }
      /* A server that no longer holds the day answers with nothing rather
         than an error. Short of the known total, that is a server to skip —
         the next request goes to another — not the end of the window. */
      if (!pinned && total !== null && out.length < total && empties++ < HISTORY_ENDPOINTS.length) continue
      break
    }
    empties = 0
    if (total !== null ? out.length >= total : rows.length < HISTORY_PAGE) break
    const last = timeOf(rows[rows.length - 1])
    if (fresh === 0 || (last === cursor && rows.length >= HISTORY_PAGE)) {
      /* Stuck on one timestamp: step through it by count. Without an exact
         total to aim for, there is no telling what is left, so stop. */
      if (total === null) break
      skip += HISTORY_PAGE
    } else {
      cursor = last
      skip = 0
    }
    await sleep(PAGE_GAP_MS)
  }
  return { rows: out, total }
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
  /** See historyCrawl: fail rather than return a short read. */
  exact = false,
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
        exact,
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
