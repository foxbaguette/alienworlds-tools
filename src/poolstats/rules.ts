/**
 * Pool statistics: what left each pool, to whom, and how full it has been.
 *
 * Pure — the history reads live in `queries.ts`, and everything here is
 * arithmetic over what they return, so it can be tested without a network.
 *
 * The payout records (`rwrdlog.ale::addhistory`) do not name the pool the
 * money left, in two cases that between them hide a third of what the pools
 * pay:
 *
 *   * **Landowner cuts** are recorded against `tlmlndowner`/`shrdlndowner`,
 *     which are labels, not pools. The money comes out of the pool of the
 *     building that was used — a tavern's cut from `tlmtavern`, a dungeon's
 *     from `tlmdung` — which `claimbreward` names in the same transaction.
 *   * **Quest rewards** leave the quest pools when a quest is *handed out*:
 *     `qpremine` works out the reward and moves it to `quests.ale` in escrow.
 *     The claim later is paid by `quests.ale`, out of that escrow.
 *
 * So every payment is given a kind and, for a landowner cut, the pool it was
 * really drawn from. What a pool "paid out" is then what left it: player
 * mines, landowner cuts, quest escrow, and anything another contract paid
 * from it — except quest claims, whose money already left at escrow.
 */

export type PoolTable = 'tlmpools' | 'shardpools'

export type PayoutKind = 'mine' | 'landowner' | 'escrow' | 'claim'

export interface Payout {
  /** The action's global sequence — unique, and what deduplicates a crawl. */
  seq: number
  trx: string
  time: number
  /** The contract that paid: `pools.ale`, `quests.ale`, `recovery.ale`. */
  payer: string
  player: string
  /** `tlm` or `shards`. */
  type: string
  /** The pool as recorded. */
  pool: string
  /** Whole tokens, e.g. 98.6401. */
  amount: number
  kind?: PayoutKind
  /** The pool the money actually left, where that differs from `pool`. */
  source?: string
  /**
   * How many payments this row stands for — 1 for a single payment, more
   * for a day's worth folded into one row by the collector.
   */
  count?: number
  /** The largest single payment among them. */
  max?: number
}

export interface BalancePoint {
  t: number
  /** Whole tokens. */
  v: number
}

/** `pools.ale::claimbreward` — a landowner's cut, and the pools it draws on. */
export interface BuildingClaim {
  seq: number
  trx: string
  planet: string
  land: string
  tlmPool?: string
  shardPool?: string
}

/** `lands.ale::addbldrwrd` — what one land was credited, in raw units. */
export interface BuildingReward {
  seq: number
  trx: string
  planet: string
  land: string
  /** Raw, four places. */
  tlm: number
  /** Raw, one place. */
  shards: number
}

/** The contract whose pools this page is about. */
export const POOLS_CONTRACT = 'pools.ale'
export const QUESTS_CONTRACT = 'quests.ale'

export const KIND_LABEL: Record<PayoutKind, string> = {
  mine: 'Player mines',
  landowner: 'Landowner cuts',
  escrow: 'Moved into escrow',
  claim: 'Paid out by a game contract',
}

/** The Candle: TLM reaches it from its pool first, then it pays players. */
export const CANDLE_CONTRACT = 'recovery.ale'

/**
 * The games' own contracts — Alien Legends (`*.ale`), Mission Control
 * (`*.mc`), Alien Worlds (`*.worlds`). Money a pool sends one of them has not
 * reached a player yet, and none of them is ever listed as a player.
 */
export function isGameContract(wallet: string): boolean {
  return ['.ale', '.mc', '.worlds'].some((s) => wallet.endsWith(s))
}

/**
 * Money a contract pays players out of what a pool already gave it.
 *
 * Quest rewards leave their pool into escrow at `quests.ale` when quests are
 * handed out; the Candle's TLM leaves `tlmrec` for `recovery.ale` before it
 * is shared out. Either way the money left the pool once, on the way in, and
 * the payment to players is that same money arriving — counting it again
 * would count it twice. (The Candle's shards and WAX have no transfer from
 * a pool on record, so those still count when the Candle pays.)
 */
export function paidFromEscrow(p: Payout): boolean {
  if (p.kind !== 'claim') return false
  return p.payer === QUESTS_CONTRACT || (p.payer === CANDLE_CONTRACT && p.type === 'tlm')
}

/**
 * Classifies what the payment record alone can tell: who paid, and whether a
 * pool paid a player or one of the game's contracts. Also applied to collected
 * days when they are read, so a rule refined later reaches them too.
 */
export function classify(p: Payout): Payout {
  if (p.kind === 'escrow') return p
  /* A land claim: the landowner collecting what their building held. */
  if (p.payer === LANDS_CONTRACT) return { ...p, kind: 'landowner' }
  /* Claimed from an account or campaign: TLM reaching a player at last. */
  if (p.payer === 'players.ale' || (p.payer === CANDLE_CONTRACT && p.type === 'tlm')) return { ...p, kind: 'claim' }
  if (p.payer !== POOLS_CONTRACT) return { ...p, kind: 'claim' }
  if (isGameContract(p.player)) return { ...p, kind: 'escrow' }
  /*
     A landowner's TLM cut is not paid to them: it goes to `lands.ale` and
     waits on the building until they claim it. Shards are sent straight to
     the landowner, so those are paid.
  */
  if (p.kind === 'landowner' && p.type === 'tlm') return { ...p, kind: 'escrow' }
  return p
}

/** Holds landowners' TLM on their buildings until they claim it. */
export const LANDS_CONTRACT = 'lands.ale'

/** The pool a building's landowner cut is drawn from, by building. */
export const BUILDING_POOL: Record<string, { tlm: string; shards: string }> = {
  tavern: { tlm: 'tlmtavern', shards: 'shrdtavern' },
  dungeon: { tlm: 'tlmdung', shards: 'shrddung' },
  arena: { tlm: 'tlmarena', shards: 'shrdarena' },
}

/**
 * Short names for the pools, beside the game's own longer `pooldesc`.
 *
 * "Reward for beating a dungeon" is right for a ledger line and too long for
 * a card title; the pool id is exact and unreadable. Anything not listed
 * falls back to the description, then the id.
 */
export const POOL_NAMES: Record<string, string> = {
  /* The source everything else is released from — see PoolSummary.parent. */
  tlm: 'All reward TLM · source',
  tlmdung: 'Dungeon Wins',
  shrddung: 'Dungeon Wins',
  tlmarena: 'Arena Wins',
  shrdarena: 'Arena Wins',
  tlmarenadom: 'Arena Domination',
  shrdarenadom: 'Arena Domination',
  tlmdunglb: 'Dungeon Leaderboard',
  tlmarenalbd: 'Arena Leaderboard · daily',
  tlmarenalbw: 'Arena Leaderboard · weekly',
  tlmlndowner: 'Landowner Rewards (source not traced)',
  shrdlndowner: 'Landowner Rewards (source not traced)',
  tlmquests: 'Quests',
  shrdquests: 'Quests',
  tlmrec: 'Candle Recovery',
  shrdrec: 'Candle Recovery',
  tlmtavern: 'Taverns',
  shrdtavern: 'Taverns',
  tlmtourna: 'Tournament',
  waxrec: 'Candle Recovery',
  tlmarenalb: 'Arena Leaderboards · claimed',
}

/**
 * Where a contract's payments to players come from, for the contracts that
 * hold TLM for players until they claim it. The claim is the payment: the
 * transfer to the player, with the contract's own memo.
 */
export const CLAIMED_PAYOUTS: { contract: string; memo: string; pool: string }[] = [
  /* A landowner collecting their building's cuts; the pool comes from the building. */
  { contract: 'lands.ale', memo: 'Land reward claimed', pool: '' },
  /* A Candle mission's winnings, claimed. */
  { contract: 'recovery.ale', memo: 'Alien Legends - Claim Campaign reward', pool: 'tlmrec' },
  /*
     Unclaimed TLM on the player's account, claimed from Rewards. It is fed
     by the Arena leaderboards (via arena.ale), and a claim does not say
     whether from the daily or the weekly board, so both share one entry.
  */
  { contract: 'players.ale', memo: 'Claiming Player Rewards', pool: 'tlmarenalb' },
]

/**
 * Pools left off the page altogether — their cards, the totals, the counts.
 *
 * Arena Domination's shard side is not a pool players work towards: the
 * game's own Rewards screen does not list it, and what trickles out of it is
 * a few shards a day. Showing it beside the real pools misleads more than it
 * informs.
 */
export const HIDDEN_POOLS: ReadonlySet<string> = new Set(['shrdarenadom'])

export function poolName(pool: string, descriptions?: Map<string, string>): string {
  return POOL_NAMES[pool] ?? descriptions?.get(pool) ?? pool
}

/** Which balance table a pool lives in, from its currency. */
export function poolTable(type: string): PoolTable {
  /* There is no WAX pool table; a WAX pool has no balance row to read. */
  return type === 'shards' ? 'shardpools' : 'tlmpools'
}

function isLandowner(pool: string): boolean {
  return pool.endsWith('lndowner')
}

/* ---------- attribution ---------- */

/**
 * Give every payment its kind and, for a landowner cut, its real pool.
 *
 * A landowner payout is matched to the `addbldrwrd` in its own transaction
 * crediting the same amount — which names the land — and the land to the
 * `claimbreward` that names the pools. A transaction can carry several
 * claims (the mining task batches them), so matching on the amount is what
 * keeps two lands in one transaction apart. Where there is exactly one claim
 * in the transaction, no amount is needed.
 */
export function attribute(
  payouts: Payout[],
  claims: BuildingClaim[],
  rewards: BuildingReward[],
): Payout[] {
  const claimsByTrx = group(claims, (c) => c.trx)
  const rewardsByTrx = group(rewards, (r) => r.trx)

  return payouts.map((raw) => {
    const p = classify(raw)
    if (p.kind === 'escrow' || p.kind === 'claim') return p
    if (!isLandowner(p.pool)) return { ...p, kind: 'mine' }

    const shards = p.type === 'shards'
    const trxClaims = claimsByTrx.get(p.trx) ?? []
    let claim: BuildingClaim | undefined
    if (trxClaims.length === 1) {
      claim = trxClaims[0]
    } else {
      const raw = Math.round(p.amount * (shards ? 10 : 10_000))
      const pending = rewardsByTrx.get(p.trx) ?? []
      const i = pending.findIndex((r) => (shards ? r.shards : r.tlm) === raw)
      if (i >= 0) {
        const r = pending.splice(i, 1)[0]
        claim = trxClaims.find((c) => c.planet === r.planet && c.land === r.land)
      }
    }
    const source = claim ? (shards ? claim.shardPool : claim.tlmPool) : undefined
    return classify({ ...p, kind: 'landowner', source })
  })
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

/** The pool a payment should be counted against. */
export function poolOf(p: Payout): string {
  return p.source ?? p.pool
}

/**
 * Whether a payment counts as paid out to players.
 *
 * Everything that reached a player does — mines, landowner cuts, and what a
 * contract paid out of escrow (quest rewards claimed, Candle payouts). Money
 * moved into escrow does not: it has only moved inside the game, and whatever
 * of it reaches players is counted when it does.
 */
export function leftPool(p: Payout): boolean {
  return p.kind !== 'escrow'
}

/** Whether a payment reached a player's wallet (escrow has not yet). */
export function reachedPlayer(p: Payout): boolean {
  return p.kind !== 'escrow'
}

/* ---------- summaries ---------- */

export interface PoolSummary {
  pool: string
  type: string
  /** Everything that left the pool in the window. */
  out: number
  byKind: Record<PayoutKind, number>
  /** Moved into escrow (quests, the Candle) — not paid out yet, so not in `out`. */
  intoEscrow: number
  /** Payments that reached a player. */
  payouts: number
  players: number
  biggest: number
  /** The live balance, where the pool has a row. */
  balance?: number
  /**
   * A pool that feeds other pools instead of paying players.
   *
   * `tlm` is the one: everything the game earns lands there and is released
   * into the sub-pools, which are what actually pay out. It is on the page to
   * be WATCHED — its balance is where a shortfall would show first — but it is
   * kept out of every total, because what leaves it is already counted when
   * the sub-pool it went to pays somebody.
   */
  parent?: boolean
  /** Held back from the sub-pools, waiting to be released. Parents only. */
  reserve?: number
}

const emptyKinds = (): Record<PayoutKind, number> => ({ mine: 0, landowner: 0, escrow: 0, claim: 0 })

/**
 * Per pool: what left it, how, and to how many players.
 *
 * Pools with a balance row but nothing paid in the window are kept at zero —
 * a pool nobody drew on is itself worth seeing.
 */
export function summarisePools(
  payouts: Payout[],
  balances: { pool: string; type: string; balance: number; parent?: boolean; reserve?: number }[] = [],
): PoolSummary[] {
  const by = new Map<string, PoolSummary & { who: Set<string> }>()
  const entry = (pool: string, type: string) => {
    let e = by.get(pool)
    if (!e) {
      e = {
        pool,
        type,
        out: 0,
        byKind: emptyKinds(),
        intoEscrow: 0,
        payouts: 0,
        players: 0,
        biggest: 0,
        who: new Set(),
      }
      by.set(pool, e)
    }
    return e
  }

  for (const p of payouts) {
    if (HIDDEN_POOLS.has(poolOf(p))) continue
    const e = entry(poolOf(p), p.type)
    if (leftPool(p)) {
      e.out += p.amount
      e.byKind[p.kind ?? 'mine'] += p.amount
    } else {
      e.intoEscrow += p.amount
    }
    if (reachedPlayer(p)) {
      e.payouts += p.count ?? 1
      e.biggest = Math.max(e.biggest, p.max ?? p.amount)
      e.who.add(p.player)
    }
  }
  for (const b of balances) {
    if (HIDDEN_POOLS.has(b.pool)) continue
    const e = entry(b.pool, b.type)
    e.balance = b.balance
    if (b.parent) e.parent = true
    if (b.reserve !== undefined) e.reserve = b.reserve
  }

  return [...by.values()]
    .map(({ who, ...rest }) => ({ ...rest, players: who.size }))
    /* The source first: it is where the money arrives, and the pools under it
       are ordered by what they paid. */
    .sort(
      (a, b) =>
        Number(!!b.parent) - Number(!!a.parent) ||
        b.out - a.out ||
        b.intoEscrow - a.intoEscrow ||
        a.pool.localeCompare(b.pool),
    )
}

export interface PlayerShare {
  player: string
  total: number
  payouts: number
  /** Of everything this pool's recipients received in the window. */
  share: number
  last: number
  kinds: PayoutKind[]
}

/** Who received money from one pool, biggest first. Escrow is not receipt. */
export function playersOf(payouts: Payout[], pool: string): PlayerShare[] {
  const rows = new Map<string, PlayerShare & { k: Set<PayoutKind> }>()
  let sum = 0
  for (const p of payouts) {
    if (poolOf(p) !== pool || !reachedPlayer(p)) continue
    sum += p.amount
    const r =
      rows.get(p.player) ??
      { player: p.player, total: 0, payouts: 0, share: 0, last: 0, kinds: [], k: new Set<PayoutKind>() }
    r.total += p.amount
    r.payouts += p.count ?? 1
    r.last = Math.max(r.last, p.time)
    r.k.add(p.kind ?? 'mine')
    rows.set(p.player, r)
  }
  return [...rows.values()]
    .map(({ k, ...r }) => ({ ...r, kinds: [...k], share: sum > 0 ? r.total / sum : 0 }))
    .sort((a, b) => b.total - a.total || a.player.localeCompare(b.player))
}

/** Totals across pools, per currency: what left the pools. */
export function totalsOf(summaries: PoolSummary[]): {
  tlm: number
  shards: number
  payouts: number
  landowner: { tlm: number; shards: number }
} {
  const t = { tlm: 0, shards: 0, payouts: 0, landowner: { tlm: 0, shards: 0 } }
  for (const s of summaries) {
    const key = s.type === 'shards' ? 'shards' : 'tlm'
    t[key] += s.out
    t.landowner[key] += s.byKind.landowner
    t.payouts += s.payouts
  }
  return t
}

/** What left one pool, in buckets of `bucket` ms (an hour for a day, a day for longer). */
export function bucketOut(
  payouts: Payout[],
  pool: string,
  since: number,
  until: number,
  bucket = 3_600_000,
): number[] {
  const n = Math.max(1, Math.ceil((until - since) / bucket))
  const out = new Array<number>(n).fill(0)
  for (const p of payouts) {
    if (poolOf(p) !== pool || !leftPool(p)) continue
    const i = Math.floor((p.time - since) / bucket)
    if (i >= 0 && i < n) out[i] += p.amount
  }
  return out
}

/** What left one pool, bucketed by hour, for the bars under its chart. */
export function hourlyOut(payouts: Payout[], pool: string, since: number, until: number): number[] {
  return bucketOut(payouts, pool, since, until, 3_600_000)
}

/* ---------- everyone paid ---------- */

export interface Recipient {
  player: string
  /** Whole tokens received in the window. */
  tlm: number
  shards: number
  payments: number
  /** Of which as a landowner, per currency. */
  landownerTlm: number
  landownerShards: number
  /** How many different pools paid them. */
  pools: number
  kinds: PayoutKind[]
  last: number
}

/**
 * Every wallet that received TLM or Shards, with what and how.
 *
 * "Received" means it reached the wallet: quest escrow is not counted (the
 * quest claim that pays it out is), and hidden pools are left out as they
 * are everywhere else on the page.
 */
export function recipientsOf(payouts: Payout[]): Recipient[] {
  const by = new Map<string, Recipient & { poolSet: Set<string>; kindSet: Set<PayoutKind> }>()
  for (const p of payouts) {
    if (!reachedPlayer(p) || HIDDEN_POOLS.has(poolOf(p))) continue
    const r =
      by.get(p.player) ??
      {
        player: p.player,
        tlm: 0,
        shards: 0,
        payments: 0,
        landownerTlm: 0,
        landownerShards: 0,
        pools: 0,
        kinds: [],
        last: 0,
        poolSet: new Set<string>(),
        kindSet: new Set<PayoutKind>(),
      }
    const shards = p.type === 'shards'
    if (shards) r.shards += p.amount
    else r.tlm += p.amount
    if (p.kind === 'landowner') {
      if (shards) r.landownerShards += p.amount
      else r.landownerTlm += p.amount
    }
    r.payments += p.count ?? 1
    r.last = Math.max(r.last, p.time)
    r.poolSet.add(poolOf(p))
    r.kindSet.add(p.kind ?? 'mine')
    by.set(p.player, r)
  }
  return [...by.values()]
    .map(({ poolSet, kindSet, ...r }) => ({ ...r, pools: poolSet.size, kinds: [...kindSet] }))
    .sort((a, b) => b.tlm - a.tlm || b.shards - a.shards || a.player.localeCompare(b.player))
}

/* ---------- collected days ---------- */

/**
 * One day of pool activity as the collector keeps it: a row per pool (the
 * pool the money really left), player, kind, payer and currency, with how
 * many payments it folds together. A day of about 20,000 history rows comes
 * down to a few hundred of these, and every summary on the page still works
 * on them.
 */
export type PoolRow = [
  pool: string,
  player: string,
  kind: PayoutKind,
  payer: string,
  type: string,
  amount: number,
  count: number,
  max: number,
  last: number,
]

export interface PoolDay {
  date: string
  rows: PoolRow[]
  /** Each pool's balance at the end of the day, in whole tokens. */
  close: Record<string, number>
  /**
   * The parent pool's reserve at the end of the day, in whole TLM. Only the
   * parent: its reserve is the one worth a line — it is where everything
   * else is released from — and the sub-pools' would be a read each a day
   * for numbers nobody has asked to see.
   */
  reserve?: Record<string, number>
}

export interface PoolDailyFile {
  generatedAt: string
  days: PoolDay[]
}

export function compressDay(payouts: Payout[]): PoolRow[] {
  const by = new Map<string, PoolRow>()
  for (const p of payouts) {
    const kind = p.kind ?? 'mine'
    const pool = poolOf(p)
    const key = [pool, p.player, kind, p.payer, p.type].join('|')
    const row = by.get(key)
    if (row) {
      row[5] += p.amount
      row[6] += p.count ?? 1
      row[7] = Math.max(row[7], p.max ?? p.amount)
      row[8] = Math.max(row[8], p.time)
    } else {
      by.set(key, [pool, p.player, kind, p.payer, p.type, p.amount, p.count ?? 1, p.max ?? p.amount, p.time])
    }
  }
  /* Four places is all TLM has; rounding keeps the file from carrying float noise. */
  return [...by.values()].map((r) => {
    r[5] = Math.round(r[5] * 10_000) / 10_000
    return r
  })
}

/** Collected rows back into payouts the page's summaries understand. */
export function expandDays(days: PoolDay[]): Payout[] {
  const out: Payout[] = []
  let seq = 0
  for (const d of days) {
    for (const [pool, player, kind, payer, type, amount, count, max, last] of d.rows) {
      out.push(classify({
        seq: ++seq,
        trx: '',
        time: last,
        payer,
        player,
        type,
        pool,
        amount,
        kind,
        count,
        max,
      }))
    }
  }
  return out
}
