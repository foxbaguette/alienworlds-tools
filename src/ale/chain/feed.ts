import { historyGet, iso } from '../../chain/history'

/**
 * What is happening in Alien Legends, right now.
 *
 * Read from the history indexers rather than from tables: this is a stream of
 * things that HAPPENED, and a table only ever holds what is true at this
 * instant.
 *
 * Only the actions a player would recognise are kept. The contracts also emit a
 * great deal of bookkeeping — `updpermstat`, `setbattlevar`, `deloldfights`,
 * `rndweather` — which is most of the volume and none of the interest, so the
 * allowlist below is the filter rather than a blocklist that would need
 * extending every time a contract gains an internal action.
 */
export interface FeedEvent {
  /** `<trx>:<ordinal>`, which is unique and stable across polls. */
  key: string
  at: number
  kind: string
  /** The player it happened to, which is not always the signer. */
  player: string
  contract: string
  action: string
  data: Record<string, unknown>
}

interface RawAction {
  trx_id: string
  action_ordinal: number
  timestamp: string
  act: { account: string; name: string; data: Record<string, unknown> }
}

const CONTRACTS = [
  'players.ale',
  'dungeons.ale',
  'arena.ale',
  'battle.ale',
  'fighters.ale',
  'ascend.ale',
  'quests.ale',
  'lands.ale',
  'shop.ale',
  'market.ale',
]

/**
 * The actions worth showing, and what to call them.
 *
 * `player` says which field names the person it happened to. Many of these are
 * signed by a CONTRACT on a player's behalf — a dungeon fight is signed by
 * dungeons.ale — so `wallet` is often the caller and `player` the human. Where
 * both exist, `player` is the one that matters.
 */
interface Rule {
  kind: string
  player: 'player' | 'wallet' | 'owner'
}

const INTERESTING: Record<string, Rule> = {
  'dungeons.ale::playdungeon': { kind: 'dungeon', player: 'wallet' },
  'dungeons.ale::adddunglbscr': { kind: 'dungeon-won', player: 'player' },
  'arena.ale::playarena': { kind: 'arena', player: 'wallet' },
  'arena.ale::fighterchg': { kind: 'arena-team', player: 'wallet' },
  'battle.ale::fight': { kind: 'fight', player: 'player' },
  'players.ale::travel': { kind: 'travel', player: 'wallet' },
  'players.ale::hire': { kind: 'hire', player: 'wallet' },
  'players.ale::dungeonplay': { kind: 'dungeon-done', player: 'player' },
  'fighters.ale::levelup': { kind: 'levelup', player: 'wallet' },
  'fighters.ale::gainxp': { kind: 'xp', player: 'wallet' },
  'fighters.ale::crtfighter': { kind: 'new-fighter', player: 'player' },
  'ascend.ale::ascend': { kind: 'ascend', player: 'wallet' },
  'ascend.ale::upgrade': { kind: 'ascend', player: 'wallet' },
  'quests.ale::claimquest': { kind: 'quest', player: 'wallet' },
  'quests.ale::completequest': { kind: 'quest', player: 'wallet' },
  'lands.ale::build': { kind: 'build', player: 'wallet' },
  'shop.ale::buyitem': { kind: 'shop', player: 'wallet' },
  'market.ale::buy': { kind: 'market', player: 'wallet' },
}

/** A contract signing on a player's behalf is not the player. */
const NOT_PLAYERS = new Set([...CONTRACTS, 'nfts.ale', 'admin.ale', 'pools.ale', 'rwrdlog.ale', 'taskmngr.ale'])

function playerOf(rule: Rule, data: Record<string, unknown>): string {
  const first = String(data[rule.player] ?? '')
  if (first && !NOT_PLAYERS.has(first)) return first
  /* Fall back to the other field: `wallet` is the contract on a delegated
     action, and `player` is the contract on a self-signed one. */
  for (const k of ['player', 'wallet', 'owner']) {
    const v = String(data[k] ?? '')
    if (v && !NOT_PLAYERS.has(v)) return v
  }
  return first
}

/**
 * Everything interesting since `since`.
 *
 * One request for all ten contracts — Hyperion takes a comma-separated
 * `act.account` — rather than ten, which at a fifteen-second poll would be
 * forty requests a minute against indexers that rate-limit.
 */
export async function fetchFeed(since: number, limit = 250): Promise<FeedEvent[]> {
  const res = await historyGet<{ actions?: RawAction[] }>('/v2/history/get_actions', {
    'act.account': CONTRACTS.join(','),
    after: iso(since),
    limit,
    sort: 'desc',
  })

  const out: FeedEvent[] = []
  for (const a of res.actions ?? []) {
    const rule = INTERESTING[`${a.act.account}::${a.act.name}`]
    if (!rule) continue
    const at = Date.parse(`${a.timestamp}Z`)
    if (!Number.isFinite(at)) continue

    /*
     * Some actions name no player at all. `fighters.ale::gainxp` carries only
     * `wallet`, and battle.ale signs it, so the best playerOf can do is return
     * the contract - and "battle.ale gained XP on 5 fighters" is not an event
     * anyone wants to read. Dropping them loses nothing: every one of these
     * accompanies a fight that is already in the feed under the player's own
     * name.
     */
    const player = playerOf(rule, a.act.data)
    if (!player || NOT_PLAYERS.has(player)) continue

    out.push({
      key: `${a.trx_id}:${a.action_ordinal}`,
      at,
      kind: rule.kind,
      player,
      contract: a.act.account,
      action: a.act.name,
      data: a.act.data,
    })
  }
  return out.sort((x, y) => y.at - x.at)
}

/** A plain sentence for one event. */
export function describe(e: FeedEvent): string {
  const d = e.data
  switch (e.kind) {
    case 'dungeon':
      return `entered a difficulty ${d.difficulty ?? '?'} dungeon on ${d.planet ?? 'a planet'}`
    case 'dungeon-won':
      return `cleared a dungeon · +${d.scoreincrease ?? 0} score`
    case 'dungeon-done':
      return `finished a dungeon on ${d.planet ?? 'a planet'}`
    case 'arena':
      return `entered the arena on ${d.planet ?? 'a planet'}`
    case 'arena-team':
      return 'changed their arena team'
    case 'fight': {
      const type = String(d.fight_type ?? 'battle')
      const diff = d.dungeon_difficulty ? ` at difficulty ${d.dungeon_difficulty}` : ''
      return `fought a ${type}${diff}`
    }
    case 'travel':
      return `travelled to ${d.x ?? '?'}, ${d.y ?? '?'}`
    case 'hire': {
      const n = Array.isArray(d.asset_ids) ? d.asset_ids.length : 0
      return `hired ${n} fighter${n === 1 ? '' : 's'}`
    }
    case 'levelup': {
      const n = Array.isArray(d.fighter_ids) ? d.fighter_ids.length : 0
      const cost = Number(d.cost_credits ?? 0)
      return `levelled up ${n} fighter${n === 1 ? '' : 's'}${cost ? ` for ${cost} credits` : ''}`
    }
    case 'xp': {
      const n = Array.isArray(d.fighter_ids) ? d.fighter_ids.length : 0
      return `gained XP on ${n || 'their'} fighter${n === 1 ? '' : 's'}`
    }
    case 'new-fighter':
      return 'recruited a new fighter'
    case 'ascend':
      return 'ascended a fighter'
    case 'quest':
      return 'completed a quest'
    case 'build':
      return 'built on their land'
    case 'shop':
      return 'bought from the shop'
    case 'market':
      return 'bought on the market'
    default:
      return `${e.contract}::${e.action}`
  }
}

/** Which tone the row takes. Wins are the only thing coloured. */
export function toneOf(kind: string): string {
  if (kind === 'dungeon-won') return 'go'
  if (kind === 'dungeon' || kind === 'arena' || kind === 'fight') return 'work'
  if (kind === 'levelup' || kind === 'ascend' || kind === 'new-fighter') return 'done'
  return 'wait'
}
