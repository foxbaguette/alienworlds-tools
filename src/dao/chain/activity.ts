import { historyGet, iso } from '../../chain/history'
import { nameToUint64 } from '../../chain/rpc'
import { getRows } from './nodes'
import { decayedPower, rawPower } from '../format'
import { STAKE_CONTRACT } from './stake'
import type { Dao } from './daos'

/**
 * Everything happening around the governance tokens, in one stream.
 *
 * Three sources, because the three things a token holder does live on three
 * contracts:
 *
 *   token.worlds::transfer   the token changing hands
 *   dao.worlds::votecust     a slate being cast or re-cast
 *   token.worlds::staketime  the unstake delay, which is a vote MULTIPLIER
 *   dao.worlds::newperiod    the election those votes were building towards
 *
 * That last one is why they belong together. Vote power is not the stake: it is
 * the stake times a multiplier that runs from 1 at the minimum delay to
 * 1 + `time_multiplier` at the maximum — nine times on every DAC today. So
 * somebody lengthening their delay can move a council without buying a single
 * token, and a feed of transfers alone would never show it.
 *
 * Most of the transfer volume is not an exchange at all. Over a two-day sample
 * of a thousand, 786 were mining rewards dripping out of `theminergame` and
 * another 22 were other payouts. They are classified and hidden by default
 * rather than dropped — they are real, they are just not what this is for.
 */
export const TOKEN_CONTRACT = 'token.worlds'
export const DAO_CONTRACT = 'dao.worlds'
/* Where a council's proposals live — the same contract the proposals page
   reads, so the feed and that page are talking about the same rows. */
export const MSIG_CONTRACT = 'msig.worlds'
export const STAKEVOTE_CONTRACT = 'stkvt.worlds'

/** Where the reward drip comes from. */
const PAYERS = new Set(['theminergame', 'rewards.mc', 'rewards.ale'])

/** Alcor and Taco both name themselves, and every swap carries a `swap…` memo. */
const isDex = (account: string) => /alcor|taco|swap/i.test(account)

export type ActivityKind =
  | 'bought'
  | 'sold'
  | 'swapped'
  | 'sent'
  | 'payout'
  | 'vote'
  | 'staketime'
  | 'election'
  | 'periodlen'
  | 'pending'
  | 'proposed'
  | 'approved'
  | 'executed'

export const KIND_LABEL: Record<ActivityKind, string> = {
  bought: 'bought with TLM',
  sold: 'sold for TLM',
  swapped: 'swapped on a DEX',
  sent: 'sent',
  payout: 'reward payout',
  vote: 'voted',
  staketime: 'changed their unstake delay',
  election: 'held an election',
  periodlen: 'changed the election period',
  pending: 'is due an election',
  proposed: 'raised a proposal',
  approved: 'signed a proposal',
  executed: 'ran a proposal',
}

export const KIND_TONE: Record<ActivityKind, string> = {
  bought: 'go',
  sold: 'bad',
  swapped: 'work',
  sent: 'wait',
  payout: 'done',
  vote: 'go',
  staketime: 'work',
  /* Its own colour. Everything else on this feed is somebody moving towards a
     council; this is the council actually changing. */
  election: 'gold',
  /* Both belong to the election: one moves the date, the other is the date
     having arrived. */
  periodlen: 'gold',
  pending: 'wait',
  /* A proposal's three ages: asked, agreed, done. */
  proposed: 'work',
  approved: 'go',
  executed: 'done',
}

/** The three groups the filter offers, and which kinds are in each. */
export const GROUPS = {
  exchanges: ['bought', 'sold', 'swapped', 'sent'] as ActivityKind[],
  votes: ['vote'] as ActivityKind[],
  delays: ['staketime'] as ActivityKind[],
  elections: ['election', 'periodlen', 'pending'] as ActivityKind[],
  payouts: ['payout'] as ActivityKind[],
  proposals: ['proposed', 'approved', 'executed'] as ActivityKind[],
}

export interface Activity {
  /**
   * What makes this event distinct.
   *
   * For a transfer this is NOT the action ordinal: a transfer notifies both
   * parties and an indexer reports each notification separately, so a DEX swap
   * arrives two or three times over, identically.
   */
  key: string
  at: number
  kind: ActivityKind
  /** Whose action it is. */
  actor: string
  /** The other side, where there is one. */
  other?: string
  /** The token code — EYE, KAVUNN, NAR. Known for every kind. */
  symbol: string
  /** The DAC this is about, where it is knowable. */
  dacId?: string
  /** Tokens moved, for a transfer. */
  amount?: number
  /** Seconds, for a staketime change, or the new length of an election period. */
  delay?: number
  /**
   * What the unstake delay was before this change, once it has been read.
   *
   * Null where there was none to find — a first choice, or a row the history
   * servers would not give up. See `resolveDelays`.
   */
  wasDelay?: number | null
  /** The length an election period was before it was changed, where it is known. */
  wasPeriod?: number
  /** How long an election has been due but unheld, for a pending row. */
  overdue?: number
  /** A council proposal's own name, for the rows about one. */
  proposal?: string
  /** What that proposal was called, where the title is known. */
  title?: string
  /** The contract actions a proposal would run, as `account::name`. */
  does?: string[]
  /**
   * The election period a proposal would set, in seconds.
   *
   * Only for a proposal carrying `dao.worlds::setperiodlen`. A title like
   * "new 10" says nothing on its own — this is what it would actually do.
   */
  setsPeriod?: number
  /** The transaction, kept so an election can be looked up. */
  trx?: string
  /** Who was voted for. */
  votes?: string[]
  /**
   * The council an election seated, once it has been looked up.
   *
   * `newperiod` carries only a message and a dac_id — who won is not in it.
   * But the same transaction rewrites the DAO's own permissions with exactly
   * the new custodian set, so the answer is one `get_transaction` away. See
   * `resolveElections`.
   */
  council?: string[]
  memo?: string
}

interface RawAction {
  trx_id: string
  action_ordinal: number
  timestamp: string
  act: {
    account: string
    name: string
    data: Record<string, unknown>
    authorization?: { actor?: string; permission?: string }[]
  }
}

function classifyTransfer(from: string, to: string, memo: string): ActivityKind {
  if (from === STAKE_CONTRACT) return 'bought'
  if (to === STAKE_CONTRACT) return 'sold'
  if (isDex(from) || isDex(to) || /^swapexact/i.test(memo)) return 'swapped'
  /* A payout is who sent it, not what the memo says. */
  if (PAYERS.has(from)) return 'payout'
  return 'sent'
}

/** `4,NARUNN` — the symbol as `staketime` carries it. */
const codeOfSymbol = (s: unknown) => String(s ?? '').split(',')[1] ?? ''

/**
 * The transfer stream, paged.
 *
 * It is the only busy one — about five hundred a day against a handful of
 * votes — so a week of it does not fit in the thousand rows an indexer hands
 * over at once. The others never need a second page.
 *
 * Capped rather than crawled: past about ten thousand rows `skip` stops
 * working on these servers, and a feed that takes a minute to open is not one
 * anybody waits for.
 */
async function transferPages(after: string, limit: number, pages: number): Promise<RawAction[]> {
  const out: RawAction[] = []
  for (let page = 0; page < pages; page++) {
    const res = await historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
      'act.account': TOKEN_CONTRACT,
      'act.name': 'transfer',
      after,
      limit,
      skip: page * limit,
      sort: 'desc',
    }).catch(() => ({ actions: [] as RawAction[] }))
    const got = res.actions ?? []
    out.push(...got)
    if (got.length < limit) break
  }
  return out
}

/**
 * The things this feed reads, and how often each is worth reading.
 *
 * Transfers and votes are the live part — hundreds a day, and the reason
 * anyone watches. The rest move at a different pace entirely: two unstake
 * delays in a good week, an election every few days, a period change rarer
 * still. Asking all six every eight seconds was six requests to answer two
 * questions.
 */
export type Source = 'transfers' | 'votes' | 'delays' | 'elections' | 'periods' | 'proposals'

/** Read every sweep. */
export const BUSY_SOURCES: Source[] = ['transfers', 'votes']
/** Read on the opening sweep, then now and again, over the whole window. */
export const RARE_SOURCES: Source[] = ['delays', 'elections', 'periods', 'proposals']
export const ALL_SOURCES: Source[] = [...BUSY_SOURCES, ...RARE_SOURCES]

const NOTHING = { actions: [] as RawAction[] }

/**
 * One sweep.
 *
 * The chosen sources are fired together rather than in turn — they are
 * independent and the indexers are the slow part — but the pool's own queue
 * decides how many are actually in the air at once. See useHistoryConcurrency.
 */
export async function fetchActivity(
  since: number,
  limit = 400,
  pages = 1,
  sources: Source[] = ALL_SOURCES,
): Promise<Activity[]> {
  const after = iso(since)
  const want = new Set(sources)
  const only = <T>(source: Source, read: () => Promise<T>) =>
    want.has(source) ? read() : Promise.resolve(NOTHING as T)
  const [transfers, votes, delays, elections, periods, msigs] = await Promise.all([
    only('transfers', () => transferPages(after, limit, pages).then((actions) => ({ actions }))),
    only('votes', () =>
      historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
        'act.account': DAO_CONTRACT,
        'act.name': 'votecust',
        after,
        limit: 200,
        sort: 'desc',
      }).catch(() => ({ actions: [] })),
    ),
    only('delays', () =>
      historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
        'act.account': TOKEN_CONTRACT,
        'act.name': 'staketime',
        after,
        limit: 200,
        sort: 'desc',
      }).catch(() => ({ actions: [] })),
    ),
    /* An election is rare and it is the point of everything else on the feed,
       so it gets its own read rather than being hunted for in the noise. */
    only('elections', () =>
      historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
        'act.account': DAO_CONTRACT,
        'act.name': 'newperiod',
        after,
        limit: 200,
        sort: 'desc',
      }).catch(() => ({ actions: [] })),
    ),
    /* Changing the period moves every election after it, which is why it
       belongs beside them rather than filed under settings. */
    only('periods', () =>
      historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
        'act.account': DAO_CONTRACT,
        'act.name': 'setperiodlen',
        after,
        limit: 200,
        sort: 'desc',
      }).catch(() => ({ actions: [] })),
    ),
    /* The whole contract in one read rather than three. A council's proposals
       run to a few hundred a week across every DAC, so asking for propose,
       approve and exec separately would be three reads for the same rows. */
    only('proposals', () =>
      historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
        'act.account': MSIG_CONTRACT,
        after,
        limit: 400,
        sort: 'desc',
      }).catch(() => ({ actions: [] })),
    ),
  ])

  const out: Activity[] = []

  for (const a of transfers.actions ?? []) {
    const d = a.act.data as { from?: string; to?: string; quantity?: string; symbol?: string; amount?: number; memo?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    const from = String(d.from ?? '')
    const to = String(d.to ?? '')
    const symbol = String(d.symbol ?? String(d.quantity ?? '').split(' ')[1] ?? '')
    if (!Number.isFinite(at) || !from || !to || !symbol) continue
    const memo = String(d.memo ?? '')
    const kind = classifyTransfer(from, to, memo)
    out.push({
      key: `${a.trx_id}:${from}:${to}:${d.quantity ?? ''}`,
      at,
      kind,
      /* On a buy or a payout the receiver is the one it happened to. */
      actor: kind === 'bought' || kind === 'payout' ? to : from,
      other: kind === 'bought' || kind === 'payout' ? from : to,
      symbol,
      amount: Number(d.amount) || 0,
      memo,
    })
  }

  for (const a of votes.actions ?? []) {
    const d = a.act.data as { voter?: string; newvotes?: string[]; dac_id?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at) || !d.voter || !d.dac_id) continue
    out.push({
      key: `${a.trx_id}:vote:${d.dac_id}:${d.voter}`,
      at,
      kind: 'vote',
      actor: String(d.voter),
      symbol: '',
      dacId: String(d.dac_id),
      votes: (d.newvotes ?? []).map(String),
    })
  }

  for (const a of delays.actions ?? []) {
    const d = a.act.data as { account?: string; unstake_time?: number; token_symbol?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at) || !d.account) continue
    out.push({
      key: `${a.trx_id}:delay:${d.account}:${d.token_symbol ?? ''}`,
      at,
      kind: 'staketime',
      actor: String(d.account),
      symbol: codeOfSymbol(d.token_symbol),
      delay: Number(d.unstake_time) || 0,
    })
  }

  /*
    A proposal raised, signed or run.

    Only `propose` carries the title, so the titles found in this sweep are
    lent to the approvals and executions naming the same proposal. Where the
    proposal was raised before the window, the row falls back to its on-chain
    name — twelve characters of nothing much, but honest.
  */
  const titles = new Map<string, string>()
  /* What each proposal would do, lent to the rows that only name it. */
  const periodOf = new Map<string, number>()
  for (const a of msigs.actions ?? []) {
    if (a.act.name !== 'propose') continue
    const d = a.act.data as { proposal_name?: string; metadata?: { key?: string; value?: string }[] }
    const name = d.proposal_name ? String(d.proposal_name) : ''
    if (!name) continue
    const title = (d.metadata ?? []).find((m) => m.key === 'title')?.value
    if (title) titles.set(name, String(title))
    const period = innerActions(a.act.data).period
    if (period) periodOf.set(name, period)
  }

  const MSIG_KIND: Record<string, ActivityKind> = {
    propose: 'proposed',
    approve: 'approved',
    exec: 'executed',
  }
  for (const a of msigs.actions ?? []) {
    const kind = MSIG_KIND[a.act.name]
    if (!kind) continue
    const d = a.act.data as {
      dac_id?: string
      proposal_name?: string
      proposer?: string
      executer?: string
      level?: { actor?: string }
    }
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at) || !d.dac_id || !d.proposal_name) continue
    /* Whose act it is differs by action: the proposer, the signer, the runner. */
    const actor = String(d.proposer ?? d.level?.actor ?? d.executer ?? '')
    if (!actor) continue
    /*
      Signing and running a proposal say only its name, so what it does is
      taken from the `propose` found in the same sweep — the same lending
      that turns a name into a title. "Signed new 10" is a sentence about
      nothing; "Signed election period → 10 days" is the thing that happened.
    */
    const inner = kind === 'proposed' ? innerActions(a.act.data) : undefined
    out.push({
      key: `${a.trx_id}:${a.action_ordinal}:${a.act.name}`,
      at,
      kind,
      actor,
      symbol: '',
      dacId: String(d.dac_id),
      proposal: String(d.proposal_name),
      title: titles.get(String(d.proposal_name)),
      does: inner?.names,
      setsPeriod: inner?.period ?? periodOf.get(String(d.proposal_name)),
      trx: a.trx_id,
    })
  }

  /*
    Period changes, oldest first so each can be told what it replaced.

    The previous length is only known where the change before it is also in
    the window; further back the row says the new length alone rather than
    inventing the old one.
  */
  const lastLength = new Map<string, number>()
  for (const a of [...(periods.actions ?? [])].reverse()) {
    const d = a.act.data as { dac_id?: string; periodlength?: number | string }
    const at = Date.parse(`${a.timestamp}Z`)
    const length = Number(d.periodlength) || 0
    if (!Number.isFinite(at) || !d.dac_id || !length) continue
    const dac = String(d.dac_id)
    out.push({
      key: `${a.trx_id}:periodlen:${dac}`,
      at,
      kind: 'periodlen',
      /* Signed by the council's own multisig, which is who to name. */
      actor: String(a.act.authorization?.[0]?.actor ?? DAO_CONTRACT),
      symbol: '',
      dacId: dac,
      delay: length,
      wasPeriod: lastLength.get(dac),
      trx: a.trx_id,
    })
    lastLength.set(dac, length)
  }

  for (const a of elections.actions ?? []) {
    const d = a.act.data as { dac_id?: string; message?: string }
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at) || !d.dac_id) continue
    out.push({
      key: `${a.trx_id}:period:${d.dac_id}`,
      at,
      kind: 'election',
      /* The scheduler runs it; nobody in particular held it. */
      actor: 'newperiodctl',
      symbol: '',
      dacId: String(d.dac_id),
      council: councils.get(a.trx_id),
      memo: String(d.message ?? ''),
      trx: a.trx_id,
    })
  }

  return out.sort((x, y) => y.at - x.at)
}

interface ProposedAction {
  account?: string
  name?: string
  data?: string | Record<string, unknown>
}

/**
 * What a proposal would actually run.
 *
 * The proposed transaction rides inside the `propose` action, and its actions
 * name their contract and method in the clear — only the arguments are packed.
 * So what a proposal DOES costs no decoding at all, and the one argument worth
 * reading is the period length, which is the first four bytes of a
 * `setperiodlen`: a uint32, little-endian.
 *
 * This matters because a council names its own proposals. "new 10" is a real
 * title, and it means nothing until you know it sets the election period to
 * ten days.
 */
function innerActions(data: unknown): { names: string[]; period?: number } {
  const acts = ((data as { trx?: { actions?: ProposedAction[] } })?.trx?.actions ?? []) as ProposedAction[]
  const names = [...new Set(acts.map((x) => `${x.account ?? '?'}::${x.name ?? '?'}`))]

  const setter = acts.find((x) => x.account === DAO_CONTRACT && x.name === 'setperiodlen')
  let period: number | undefined
  if (setter) {
    if (typeof setter.data === 'string') {
      /* periodlength:uint32 first, so the first four bytes reversed. */
      const hex = setter.data.slice(0, 8).match(/../g)
      if (hex?.length === 4) {
        const secs = parseInt(hex.reverse().join(''), 16)
        if (Number.isFinite(secs) && secs > 0) period = secs
      }
    } else if (setter.data && typeof setter.data === 'object') {
      /* Some indexers hand it back already unpacked. */
      const secs = Number((setter.data as { periodlength?: number | string }).periodlength)
      if (Number.isFinite(secs) && secs > 0) period = secs
    }
  }
  return { names, period }
}

/**
 * An election that has fallen due and not yet been held.
 *
 * Nothing on chain marks this moment — it is simply `lastperiodtime` plus the
 * period, arriving. So it is worked out from the directory rather than read,
 * and only for a council waiting right now: once the election runs, the time
 * it was due is no longer derivable from anything the chain still holds.
 *
 * The row sits at the moment it fell due, which is where a reader looking for
 * "when did this start" would go for it.
 */
export function pendingElections(
  daos: { id: string; nextElection: number | null }[],
  since: number,
  now = Date.now(),
): Activity[] {
  const out: Activity[] = []
  for (const dao of daos) {
    const due = dao.nextElection
    if (!due || due > now) continue
    out.push({
      key: `pending:${dao.id}:${due}`,
      /*
        Pinned to the edge of the window when it fell due before it.

        A council a month overdue is the one most worth knowing about, and
        dropping it for being older than the feed's week would have hidden
        exactly that. The row still says how long it has really been waiting.
      */
      at: Math.max(due, since),
      kind: 'pending',
      actor: 'newperiodctl',
      symbol: '',
      dacId: dao.id,
      overdue: now - due,
    })
  }
  return out
}

/* ---------- which way an unstake delay moved ---------- */

/**
 * What an account's unstake delay was before it changed it.
 *
 * The action says what the delay became and nothing about what it was, so
 * raising a delay and lowering one read identically — and they mean opposite
 * things. Vote power is stake times a delay multiplier, so a longer delay is
 * somebody committing harder and a shorter one is somebody stepping back.
 *
 * Read from the row's own history: `stake.worlds/staketime` as it stood the
 * instant before. One read per change, and there are two in a good week.
 *
 * Cached by row key like the councils are, so the feed's eight-second poll
 * asks once rather than every time.
 */
const delayBefore = new Map<string, number | null>()

interface DelayDelta {
  deltas?: { present?: number; data?: { delay?: number | string } }[]
}

export async function resolveDelays(
  rows: Activity[],
  /* The council a symbol belongs to, and the token contract holding its
     stakes — which is the DAO's own, not a constant. */
  dacOf: (symbol: string) => { id: string; tokenContract?: string | null } | undefined,
): Promise<boolean> {
  const wanted = rows.filter((r) => r.kind === 'staketime' && !delayBefore.has(r.key))
  if (!wanted.length) return false

  await Promise.all(
    wanted.map(async (r) => {
      /*
        The table is token.worlds/staketime, scope the dac_id — the same rows
        a DAO's own position is read from, not stake.worlds, which has no
        such table at all.
      */
      const dac = dacOf(r.symbol)
      const code = dac?.tokenContract ?? TOKEN_CONTRACT
      if (!dac?.id) {
        delayBefore.set(r.key, null)
        return
      }
      try {
        const page = await historyGet<DelayDelta>('/v2/history/get_deltas', {
          code,
          scope: dac.id,
          table: 'staketime',
          primary_key: nameToUint64(r.actor).toString(),
          /* The instant before, or the change itself answers its own question. */
          before: iso(r.at - 1),
          limit: 1,
          sort: 'desc',
        })
        const row = page.deltas?.[0]
        /* No row, or one that had been deleted, means no delay was set before
           this — a first choice rather than a change. */
        delayBefore.set(r.key, !row || row.present === 0 ? null : Number(row.data?.delay) || 0)
      } catch (err) {
        console.error(`delay before ${r.key}:`, err)
        delayBefore.set(r.key, null)
      }
    }),
  )
  return true
}

/** The delay before a change, for rows read before it was looked up. */
export const delayWas = (key: string): number | null | undefined => delayBefore.get(key)

/* ---------- who an election seated ---------- */

/**
 * The council a `newperiod` produced.
 *
 * The action itself says only which DAC and a greeting. But seating a council
 * means rewriting the DAO account's own permissions, and those `updateauth`
 * actions ride in the SAME transaction carrying the new custodians by name —
 * so one read of the transaction answers it exactly, with no guessing from
 * what the candidate table happens to say now.
 *
 * Cached by transaction, because an election never changes after the fact and
 * the feed re-reads its window every eight seconds.
 */
const councils = new Map<string, string[]>()

interface TrxReply {
  actions?: { act: { account: string; name: string; data: Record<string, unknown> } }[]
}

export async function resolveElections(rows: Activity[]): Promise<boolean> {
  const wanted = [...new Set(rows.filter((r) => r.kind === 'election' && r.trx && !councils.has(r.trx)).map((r) => r.trx!))]
  if (!wanted.length) return false

  await Promise.all(
    wanted.map(async (id) => {
      try {
        const trx = await historyGet<TrxReply>('/v2/history/get_transaction', { id })
        /* `high` is the council permission proper — the other three are the
           same people at lower thresholds, so any of them would do. */
        const auth = (trx.actions ?? []).find(
          (a) => a.act.account === 'eosio' && a.act.name === 'updateauth' && a.act.data.permission === 'high',
        )
        const accounts = (auth?.act.data.auth as { accounts?: { permission?: { actor?: string } }[] })?.accounts
        const names = (accounts ?? [])
          .map((x) => String(x.permission?.actor ?? ''))
          /* The permission also carries msig.worlds, which is how the council's
             own multisig acts as the DAO. It is not a custodian. */
          .filter((n) => n && !n.endsWith('.worlds'))
        councils.set(id, names)
      } catch (err) {
        console.error(`council for ${id}:`, err)
        /* Remembered as unknown, so the feed stops asking. */
        councils.set(id, [])
      }
    }),
  )
  return true
}

/** Fills in the councils already looked up, for rows read before they were. */
export const councilOf = (trx: string | undefined) => (trx ? councils.get(trx) : undefined)

/* ---------- vote power ---------- */

/**
 * What each voter's vote is worth, per DAC — `stkvt.worlds/weights`.
 *
 * Read rather than derived. The weight IS stake times a delay multiplier, and
 * the formula is confirmed —
 *
 *     weight = stake * (1 + time_multiplier * delay / max_stake_time)
 *
 * with `time_multiplier` 8 on every DAC today, so nine times at the maximum
 * delay — but the contract keeps the answer, and a figure read from the table
 * cannot drift from what the chain will count.
 */
const weightCache = new Map<string, Map<string, number>>()
const weightLoading = new Map<string, Promise<void>>()

export function weightsReady(dacId: string) {
  return weightCache.has(dacId)
}

export function ensureWeights(dacId: string): Promise<void> {
  if (weightCache.has(dacId)) return Promise.resolve()
  const live = weightLoading.get(dacId)
  if (live) return live

  const job = getRows<{ voter: string; weight: string | number }>({
    code: STAKEVOTE_CONTRACT,
    scope: dacId,
    table: 'weights',
    limit: 1000,
  })
    .then((rows) => {
      weightCache.set(dacId, new Map(rows.map((r) => [r.voter, Number(r.weight) || 0])))
    })
    .catch((err: unknown) => {
      console.error(`vote weights for ${dacId}:`, err)
      weightCache.set(dacId, new Map())
    })
    .finally(() => weightLoading.delete(dacId))

  weightLoading.set(dacId, job)
  return job
}

/** One voter's power in a DAC, in whole tokens, or null if not read yet. */
export function weightOf(dacId: string, voter: string, precision: number): number | null {
  const held = weightCache.get(dacId)
  if (!held) return null
  return rawPower(held.get(voter) ?? 0, precision)
}

/* ---------- would this change the council? ---------- */

export interface Flip {
  /** Who would lose their place if this vote were not there. */
  out: string
  /** Who would take it. */
  in: string
}

/**
 * Whether one voter's weight is what is holding the council in its current
 * shape.
 *
 * The counterfactual is "take this voter's weight back off the candidates they
 * voted for, and see whether the seats change". The chain seats on the DECAYED
 * figure, so the decayed one is what is compared — scaled by the change in raw
 * power, since removing a vote also changes the average age it is weighted by
 * and no table records what that average was before.
 *
 * So this is an estimate, and the UI says so. It is the right estimate though:
 * a vote big enough to flip a seat under it is a vote worth looking at.
 */
export function wouldFlip(dao: Dao, votedFor: string[], weight: number): Flip | null {
  const seats = dao.council.length
  if (!seats || !weight || !votedFor.length) return null

  const standing = dao.candidates.filter((c) => c.is_active)
  if (standing.length <= seats) return null

  const now = Date.now()
  const voted = new Set(votedFor)
  const scored = standing.map((c) => {
    const raw = rawPower(c.total_vote_power, dao.precision)
    const decayed = decayedPower(c.rank, dao.precision, now)
    const without = voted.has(c.candidate_name) ? Math.max(0, raw - weight) : raw
    return {
      name: c.candidate_name,
      now: decayed,
      /* Scaled rather than recomputed: the rank encodes power AND vote age
         together, and the age this vote contributed is not recorded. */
      without: raw > 0 ? decayed * (without / raw) : 0,
    }
  })

  const top = (key: 'now' | 'without') =>
    [...scored].sort((a, b) => b[key] - a[key]).slice(0, seats).map((c) => c.name)

  const before = top('now')
  const after = top('without')
  const lost = before.find((n) => !after.includes(n))
  const gained = after.find((n) => !before.includes(n))
  return lost && gained ? { out: lost, in: gained } : null
}

/* ---------- thresholds and formatting ---------- */

/** A transfer worth noticing. */
export const BIG_AMOUNT = 10_000
/** A vote worth noticing. */
export const BIG_POWER = 100_000

export const fmtTokens = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 4 })

/** An unstake delay as people talk about it. */
export function fmtDelay(seconds: number): string {
  const days = seconds / 86_400
  const shown = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10
  return `${shown} day${shown === 1 ? '' : 's'}`
}
