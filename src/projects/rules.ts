import type { ProjectDef } from './defs'

/**
 * A project's day, summarised the same way for every project: who was
 * active, what they did, and what the project paid them.
 */
export interface ProjectDay {
  date: string
  active: number
  /** Kept so a week or month can count each wallet once. */
  wallets: string[]
  /** `contract::action` → how many times players did it. */
  actions: Record<string, number>
  /** Token symbol → amount paid out to players, whole tokens. */
  paid: Record<string, number>
  /** Token symbol → how many wallets received it. */
  paidTo: Record<string, number>
  /** Token symbol → wallet → what it received that day, for the list of who was paid. */
  received?: Record<string, Record<string, number>>
  /** Token symbol → wallet → entry fees it paid in that day. */
  feesBy?: Record<string, Record<string, number>>
  /**
   * Token symbol → entry fees players paid in, whole tokens. Where a project
   * pays rewards out of its players' own stakes, what it paid out is not all
   * new to them: `paid` less this is.
   */
  stakes?: Record<string, number>
  /** NFTs sent to players. */
  nfts: number
  /**
   * What players paid in, as `kind|symbol` → payments and amount — see
   * ProjectDef.incoming. Absent on days collected before it was measured.
   */
  incoming?: Record<string, { count: number; amount: number }>
  /**
   * Reward kind (by memo) and token, as `kind|symbol` → payments and amount,
   * for projects that label them. One kind can pay in more than one token.
   */
  categories: Record<string, { count: number; amount: number }>
}

export interface ProjectFile {
  generatedAt: string
  days: ProjectDay[]
}

/** One of the project's actions, and who signed it. */
export interface ActionSeen {
  name: string
  signers: string[]
}

/** Something a wallet sent the project. */
export interface StakeSeen {
  from: string
  symbol: string
  amount: number
  memo: string
}

/** Something the project sent a wallet. */
export interface PayoutSeen {
  to: string
  symbol: string
  amount: number
  memo: string
  /** NFTs in the transfer, when it is an NFT transfer. */
  nfts?: number
}

/* Accounts that are never players, whatever project. */
const SYSTEM = new Set(['eosio', 'eosio.token', 'atomicassets', 'm.federation', 'federation', 'alien.worlds'])

/**
 * A wallet that belongs to a person rather than a game: not one of the
 * project's own accounts, not a game contract (*.ale, *.mc, *.worlds), not
 * a system account.
 */
export function isPlayerWallet(wallet: string, def: ProjectDef): boolean {
  if (!wallet || SYSTEM.has(wallet) || wallet.startsWith('eosio.')) return false
  if (def.contracts.includes(wallet) || def.payers.includes(wallet)) return false
  return !['.ale', '.mc', '.worlds'].some((s) => wallet.endsWith(s))
}

export function summariseProjectDay(
  def: ProjectDef,
  date: string,
  actions: ActionSeen[],
  payouts: PayoutSeen[],
  stakes: StakeSeen[] = [],
): ProjectDay {
  const counts: Record<string, number> = {}
  const signers = new Set<string>()
  for (const a of actions) {
    counts[a.name] = (counts[a.name] ?? 0) + 1
    /* Whoever signed it — or, for an action signed on a player's behalf, the player it names. */
    for (const s of a.signers) if (isPlayerWallet(s, def)) signers.add(s)
  }

  const paid: Record<string, number> = {}
  const to: Record<string, Set<string>> = {}
  const received: Record<string, Record<string, number>> = {}
  const recipients = new Set<string>()
  const categories: ProjectDay['categories'] = {}
  let nfts = 0
  for (const p of payouts) {
    if (!isPlayerWallet(p.to, def)) continue
    const makesActive = !def.activeSymbols || def.activeSymbols.includes(p.nfts ? 'NFT' : p.symbol)
    if (p.nfts) {
      if (!def.nftRewards) continue
      if (makesActive) recipients.add(p.to)
      nfts += p.nfts
      continue
    }
    if (p.symbol !== 'Shards' && def.rewardMemos && !def.rewardMemos.some((m) => m.test(p.memo))) continue
    if (makesActive) recipients.add(p.to)
    paid[p.symbol] = (paid[p.symbol] ?? 0) + p.amount
    ;(to[p.symbol] ??= new Set()).add(p.to)
    const r = (received[p.symbol] ??= {})
    r[p.to] = (r[p.to] ?? 0) + p.amount
    for (const c of def.categories ?? []) {
      if (!c.memo.test(p.memo)) continue
      const e = (categories[`${c.key}|${p.symbol}`] ??= { count: 0, amount: 0 })
      e.count += 1
      e.amount += p.amount
      break
    }
  }

  const staked: Record<string, number> = {}
  const feesBy: Record<string, Record<string, number>> = {}
  for (const s of stakes) {
    if (!isPlayerWallet(s.from, def) || !def.entryMemos?.some((m) => m.test(s.memo))) continue
    staked[s.symbol] = (staked[s.symbol] ?? 0) + s.amount
    const f = (feesBy[s.symbol] ??= {})
    f[s.from] = (f[s.from] ?? 0) + s.amount
  }
  const round = (o: Record<string, number>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10_000) / 10_000]))
  const roundAll = (o: Record<string, Record<string, number>>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]))

  const active = def.activeFrom === 'signers' ? signers : recipients
  return {
    date,
    active: active.size,
    wallets: [...active].sort(),
    actions: counts,
    paid: round(paid),
    paidTo: Object.fromEntries(Object.entries(to).map(([k, v]) => [k, v.size])),
    received: roundAll(received),
    ...(def.entryMemos ? { stakes: round(staked), feesBy: roundAll(feesBy) } : {}),
    nfts,
    categories,
  }
}

/** A token transfer into one of the project's accounts. */
export interface InflowSeen {
  from: string
  to: string
  symbol: string
  amount: number
  memo: string
}

/** Players' payments in, by kind and token. Anything no kind claims is left out. */
export function summariseIncoming(def: ProjectDef, inflows: InflowSeen[]): NonNullable<ProjectDay['incoming']> {
  const out: NonNullable<ProjectDay['incoming']> = {}
  for (const t of inflows) {
    if (!isPlayerWallet(t.from, def)) continue
    const kind = def.incoming?.find((k) => k.account === t.to && k.memo.test(t.memo))
    if (!kind) continue
    const e = (out[`${kind.key}|${t.symbol}`] ??= { count: 0, amount: 0 })
    e.count += 1
    e.amount = Math.round((e.amount + t.amount) * 10_000) / 10_000
  }
  return out
}

/** A metric's count on a day: the sum of the actions it is made of. */
export function metricOf(day: ProjectDay, actions: string[]): number {
  return actions.reduce((n, a) => n + (day.actions[a] ?? 0), 0)
}

export interface ProjectRange {
  days: number
  uniqueActive: number
  avgDaily: number
  peak: { date: string; active: number } | null
  paid: Record<string, number>
  nfts: number
}

export function summariseProjectRange(days: ProjectDay[]): ProjectRange {
  const who = new Set<string>()
  const paid: Record<string, number> = {}
  let nfts = 0
  let peak: ProjectRange['peak'] = null
  for (const d of days) {
    for (const w of d.wallets) who.add(w)
    for (const [k, v] of Object.entries(d.paid)) paid[k] = (paid[k] ?? 0) + v
    nfts += d.nfts
    if (!peak || d.active > peak.active) peak = { date: d.date, active: d.active }
  }
  return {
    days: days.length,
    uniqueActive: who.size,
    avgDaily: days.length ? days.reduce((n, d) => n + d.active, 0) / days.length : 0,
    peak,
    paid,
    nfts,
  }
}

/**
 * How many wallets were seen for the first time on each day — the nearest
 * thing to signups for a project that keeps no player list. Only as good as
 * the history behind it: on the first days collected, everyone is new.
 */
export function firstSeenByDay(days: ProjectDay[]): Record<string, number> {
  const seen = new Set<string>()
  const out: Record<string, number> = {}
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    let n = 0
    for (const w of d.wallets) {
      if (seen.has(w)) continue
      seen.add(w)
      n++
    }
    out[d.date] = n
  }
  return out
}
