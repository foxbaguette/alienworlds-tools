import { historySliced, historyTime } from '@/chain/history'
import { cached, getAllRows } from '@/chain/rpc'
import type { ProjectDef } from './defs'
import {
  summariseProjectDay,
  type ActionSeen,
  type PayoutSeen,
  type ProjectDay,
  type ProjectFile,
  type StakeSeen,
} from './rules'

interface Act<D> {
  global_sequence: number
  '@timestamp': string
  act: { account: string; name: string; data: D; authorization?: { actor: string }[] }
}

function crawl<D>(params: Record<string, string>, from: number, until: number, slices: number) {
  return historySliced<Act<D>>(
    '/v2/history/get_actions',
    params,
    from,
    until,
    (p) => (p as { actions?: Act<D>[] }).actions ?? [],
    (a) => historyTime(a['@timestamp']),
    (a) => a.global_sequence,
    slices,
  )
}

/*
   Everything a project can pay a player with: tokens, NFTs, and Shards.
   Shards reach players through ptpxy.worlds::addpoints, called by whoever
   manages the points — a project directly, or shards.mc on behalf of
   Mission Control and Alien Legends (`sendpoints`). Both count points in
   tenths of a Shard.
*/
const PAYOUT_FILTER = [
  'alien.worlds:transfer',
  'eosio.token:transfer',
  'token.worlds:transfer',
  'defensetoken:transfer',
  'atomicassets:transfer',
  'shards.mc:sendpoints',
  'ptpxy.worlds:addpoints',
].join(',')

interface PayData {
  from?: string
  to?: string
  amount?: number
  symbol?: string
  quantity?: string
  memo?: string
  asset_ids?: unknown[]
  /* shards.mc::sendpoints, ptpxy.worlds::addpoints */
  wallet?: string
  points_manager?: string
  user?: string
  points?: number | string
}

/**
 * One UTC day of a project, read from history and summarised.
 *
 * Its own actions come in one crawl filtered to its contracts; what it paid
 * comes from each paying account's token, NFT and shard transfers.
 */
export async function fetchProjectDay(def: ProjectDef, date: string): Promise<ProjectDay> {
  const from = Date.parse(date + 'T00:00:00Z')
  const until = from + 86_400_000
  const inDay = (a: { '@timestamp': string }) => {
    const t = historyTime(a['@timestamp'])
    return t >= from && t < until
  }

  const [own, ...paid] = await Promise.all([
    crawl<unknown>(
      { filter: def.contracts.map((c) => `${c}:*`).join(',') },
      from,
      until,
      def.contracts.length > 3 ? 6 : 2,
    ),
    ...def.payers.map((payer) => crawl<PayData>({ account: payer, filter: PAYOUT_FILTER }, from, until, 2)),
  ])

  const actions: ActionSeen[] = own
    .filter(inDay)
    .filter((a) => def.contracts.includes(a.act.account))
    .map((a) => {
      const name = `${a.act.account}::${a.act.name}`
      const signers = (a.act.authorization ?? []).map((x) => x.actor)
      const field = def.actorFields?.[name]
      if (field) signers.push(String((a.act.data as Record<string, unknown>)?.[field] ?? ''))
      return { name, signers }
    })

  const seen = new Set<number>()
  const payouts: PayoutSeen[] = []
  const stakes: StakeSeen[] = []
  def.payers.forEach((payer, i) => {
    for (const a of paid[i]) {
      if (!inDay(a) || seen.has(a.global_sequence)) continue
      const d = a.act.data
      if (a.act.name === 'sendpoints' || a.act.name === 'addpoints') {
        if ((a.act.name === 'sendpoints' ? d.wallet : d.points_manager) !== payer) continue
        seen.add(a.global_sequence)
        payouts.push({ to: String(d.user), symbol: 'Shards', amount: Number(d.points) / 10, memo: '' })
      } else if (a.act.account === 'atomicassets') {
        if (d.from !== payer) continue
        seen.add(a.global_sequence)
        payouts.push({
          to: String(d.to),
          symbol: 'NFT',
          amount: 0,
          memo: String(d.memo ?? ''),
          nfts: (d.asset_ids ?? []).length,
        })
      } else {
        const symbol = d.symbol ?? String(d.quantity ?? '').split(' ')[1] ?? '?'
        const amount = Number(d.amount ?? String(d.quantity ?? '0').split(' ')[0]) || 0
        if (d.to === payer) {
          /* Paid in by a player — an entry fee, if the project takes them. */
          seen.add(a.global_sequence)
          stakes.push({ from: String(d.from), symbol, amount, memo: String(d.memo ?? '') })
          continue
        }
        if (d.from !== payer) continue
        seen.add(a.global_sequence)
        payouts.push({ to: String(d.to), symbol, amount, memo: String(d.memo ?? '') })
      }
    }
  })

  return summariseProjectDay(def, date, actions, payouts, stakes)
}

export function fetchProjectFile(key: string): Promise<ProjectFile> {
  return cached(`project:${key}`, 5 * 60_000, async () => {
    try {
      const res = await fetch(`data/projects/${key}.json`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as ProjectFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}

/* ---------- live snapshots ---------- */

export interface McMember {
  wallet: string
  /** The gamertag, where one is set. */
  tag?: string
  joined: number
  lastActivity: number
  trial: boolean
  level: number
}

const ts = (s: string) => Date.parse(s.endsWith('Z') ? s : s + 'Z')

/** Every Mission Control member. */
export function fetchMcMembers(): Promise<McMember[]> {
  return cached('mc:members', 10 * 60_000, async () => {
    const rows = await getAllRows<{
      wallet: string
      playertag?: string
      joined: string
      last_activity: string
      trial: number | boolean
      level: number
    }>({
      code: 'members.mc',
      scope: 'members.mc',
      table: 'mcmembers',
    })
    return rows.map((r) => ({
      wallet: String(r.wallet),
      tag: r.playertag ? String(r.playertag) : undefined,
      joined: ts(r.joined),
      lastActivity: ts(r.last_activity),
      trial: !!Number(r.trial),
      level: Number(r.level) || 0,
    }))
  })
}

export interface PdMission {
  id: number
  title: string
  planet: string
  start: number
  end: number
  divisions: number
  attack: number
}

export interface PdSnapshot {
  players: number
  warlords: number
  members: number
  missions: PdMission[]
}

/** Planetary Defense as it stands: its players and warlords, and the missions at miss.pdef. */
export function fetchPdSnapshot(): Promise<PdSnapshot> {
  return cached('pd:snapshot', 10 * 60_000, async () => {
    const q = <T>(code: string, table: string) => getAllRows<T>({ code, scope: code, table })
    const [players, owners, members, missions] = await Promise.all([
      q<unknown>('magordefense', 'players'),
      q<unknown>('magordefense', 'owners'),
      q<unknown>('magordefense', 'members'),
      q<{
        mission_id: number
        start: string
        end_base: string
        divisions_joined: number
        total_attack: number
        meta: string
      }>('miss.pdef', 'missions'),
    ])
    const meta = (s: string): { title?: string; planet?: string } => {
      try {
        return JSON.parse(s) ?? {}
      } catch {
        return {}
      }
    }
    return {
      players: players.length,
      warlords: owners.length,
      members: members.length,
      missions: missions.map((m) => ({
        id: Number(m.mission_id),
        title: meta(m.meta).title ?? `Mission ${m.mission_id}`,
        planet: meta(m.meta).planet ?? '',
        start: ts(m.start),
        end: ts(m.end_base),
        divisions: Number(m.divisions_joined) || 0,
        attack: Number(m.total_attack) || 0,
      })),
    }
  })
}
