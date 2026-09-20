/**
 * Point allocators — `ptpxy.worlds` (pointsproxy).
 *
 * A different system again from the councils and the worker proposals. An
 * allocator is a multisig account holding a budget of points and handing daily
 * allowances to recipients; the recipients spend against a period budget. There
 * are no elections and no proposals here, which is why it is its own section
 * rather than a tab on a DAO.
 *
 * Two scalings apply and they are NOT the same one, which is the thing to get
 * right when reading this file:
 *
 *   `points()`  divides by ten — every figure in this contract is held at ten
 *               times its face value.
 *   `shards()`  multiplies by three, and does NOT divide. The `allocators`
 *               table alone covers a TEN day period, so tripling it puts an
 *               allocator's budget on the same thirty-day basis as the
 *               allocations beneath it.
 */
import { getPage, getRows } from './nodes'

export const POINTS_CONTRACT = 'ptpxy.worlds'

export interface Allocator {
  allocator: string
  budget: string
  allocated: string
}

export interface Allocation {
  account: string
  allocated: string
}

export interface PointsConfig {
  debug?: number
  running_total?: string
  period_total?: string
  period_budget?: string
  period_end?: string
  period_duration?: string | number
}

const fmt = (n: number) => Math.trunc(n).toLocaleString('en-US')

/** Points are held at ten times face value throughout this contract. */
export const points = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? fmt(n / 10) : '—'
}

/** The allocators table's ten-day figures, put on the same thirty-day basis. */
export const shards = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? fmt(n * 3) : '—'
}

/**
 * `period_duration` is documented as days and defaults to 30, but the
 * contract's own migrate() copies the OLD globals value — which was seconds,
 * defaulting to 30*24*60*60 — straight into it. A row never rewritten since
 * carries 2592000 where 30 is meant. Anything at a day or more is read as
 * seconds; anything smaller is already days.
 */
export function durationDays(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n >= 86_400 ? Math.round(n / 86_400) : n
}

export interface AllocatorData {
  allocators: Allocator[]
  /** allocator -> its allocations. */
  allocations: Map<string, Allocation[]>
  /** recipient -> its own pointsconfig. */
  configs: Map<string, PointsConfig | null>
}

export async function fetchAllocators(): Promise<Allocator[]> {
  return getRows<Allocator>({ code: POINTS_CONTRACT, scope: POINTS_CONTRACT, table: 'allocators', limit: 200 })
}

export async function fetchAllocations(allocator: string): Promise<Allocation[]> {
  return getRows<Allocation>({ code: POINTS_CONTRACT, scope: allocator, table: 'allocations', limit: 200 })
}

export async function fetchPointsConfig(recipient: string): Promise<PointsConfig | null> {
  const rows = await getPage<PointsConfig>({
    code: POINTS_CONTRACT,
    scope: recipient,
    table: 'pointsconfig',
    limit: 1,
  })
  return rows[0] ?? null
}

/**
 * What share of a recipient's funding one allocator provides.
 *
 * `pointsconfig` records only the recipient's own totals — there is no
 * per-funder breakdown anywhere on chain — so attributing spend to one
 * allocator means apportioning by the daily allowances each one sends.
 *
 * Whether this allocator is the SOLE funder matters: if it is, the whole
 * period_budget is its own exactly, with nothing apportioned and no rounding.
 */
export function fundingShare(
  recipient: string,
  allocator: string,
  allocators: Allocator[],
  allocations: Map<string, Allocation[]>,
) {
  let total = 0
  let mine = 0
  const funders = new Set<string>()

  for (const a of allocators) {
    for (const r of allocations.get(a.allocator) ?? []) {
      if (r.account !== recipient) continue
      const v = Number(r.allocated) || 0
      total += v
      funders.add(a.allocator)
      if (a.allocator === allocator) mine = v
    }
  }

  return {
    mine,
    total,
    share: total > 0 ? mine / total : 0,
    only: funders.size === 1 && funders.has(allocator),
  }
}

/**
 * What a recipient may actually spend this period, and how much of it is gone.
 *
 * `period_budget` is the authority, NOT `allocated × days`. The contract's
 * `addbudget` OVERWRITES `allocated` with the latest top-up while ACCUMULATING
 * `period_budget`:
 *
 *     a.allocated = allocation_budget_clamped;   // replaces
 *     manager_settings.period_budget += budget;  // accumulates
 *
 * So `allocated` records only the most recent top-up. Budgeting off it showed
 * theminergame at 124% spent when it is funded solely by trilara: allocated × 30
 * came to 600,000, while its real period_budget is 1,200,000 and 746,065 of that
 * is 62%.
 *
 * The share cancels on both sides, so the percentage is the recipient's true
 * utilisation either way.
 */
export function spendOf(cfg: PointsConfig, share: number, only: boolean) {
  const factor = only ? 1 : share
  const budget = Number(cfg.period_budget ?? 0) * factor
  const spent = Number(cfg.period_total ?? 0) * factor
  return {
    budget,
    spent,
    pct: budget > 0 ? (spent / budget) * 100 : 0,
    /** True when this allocator funds the recipient alone, so nothing is apportioned. */
    exact: only,
  }
}
