import { getRows } from '../../dao/chain/nodes'
import { PLANETS } from './weather'

/**
 * Every arena, dungeon and tavern in the game.
 *
 * A building is not a row of its own: it lives inside its land's row on
 * `lands.ale`, and a planet holds 1600 lands of which about fifty are built on.
 * So the only way to list them is to read the six grids whole and keep what has
 * something on it.
 *
 * Three more things have to be joined on to make the list answer anything:
 *
 *   * who defends it — `arena.ale/livearena` and `dungeons.ale/dungeons`, both
 *     scoped by planet and keyed by land_id. Taverns have no defenders.
 *   * who owns it — the land is an Alien Worlds NFT, and its owner is the only
 *     account that can claim. That is not on the WAX tables at all; it comes
 *     from AtomicAssets.
 *   * what is claimable — the `tlm` and `shards` counters on the building,
 *     which are four-decimal integers (a claim of 4802591 pays 480.2591 TLM).
 */
export const LANDS = 'lands.ale'

export type BuildingKind = 'arena' | 'dungeon' | 'tavern'

export interface Defender {
  fighter_id: number
  owner: string
  gamertag: string
  classname: string
  racename: string
  element: string
  health: number
  damage: number
}

export interface Building {
  planet: string
  land_id: string
  x: number
  y: number
  landType: string
  rarity: string
  assetId: string
  kind: BuildingKind
  level: number
  /** As stored. Decays by the hour — see `ratingNow`. */
  boostScore: number
  boostUpdated: number
  lastClaim: number
  /** Claimable, already scaled out of the contract's four-decimal integers. */
  tlm: number
  shards: number
  gems: number
  credits: number
  defenders: Defender[]
  owner: string | null
}

export interface BuildingData {
  buildings: Building[]
  /** Boost score lost per hour since `boostUpdated`, from the lands config. */
  decayPerHour: number
  /** True once the AtomicAssets lookup has filled the owners in. */
  owners: boolean
}

interface RawBuilding {
  building_name: string
  level: number | string
  boost_score: number | string
  boost_score_update: string
  last_claim: string
  gems: number | string
  credits: number | string
  tlm: number | string
  shards: number | string
}

interface RawLand {
  land_id: string
  planet: string
  asset_id: string
  land_type: string
  rarity: string
  x: number | string
  y: number | string
  buildings?: RawBuilding[]
}

interface RawTeam {
  planet: string
  land_id: string
  fighters?: (Defender & Record<string, unknown>)[]
}

const stamp = (s: string) => Date.parse(`${s}Z`)

/** The contract counts TLM and shards in ten-thousandths. */
const scaled = (n: number | string) => Number(n) / 10_000

const defender = (f: Defender & Record<string, unknown>): Defender => ({
  fighter_id: Number(f.fighter_id),
  owner: String(f.owner ?? ''),
  gamertag: String(f.gamertag ?? ''),
  classname: String(f.classname ?? ''),
  racename: String(f.racename ?? ''),
  element: String(f.element ?? ''),
  health: Number(f.health ?? 0),
  damage: Number(f.damage ?? 0),
})

/**
 * Everything, read planet by planet.
 *
 * Owners are left out of this pass and filled in afterwards by `fetchOwners`,
 * because they come from a different service that is slower and allowed to
 * fail: a list without owners is still worth showing.
 */
export async function fetchBuildings(): Promise<BuildingData> {
  const [config, ...perPlanet] = await Promise.all([
    getRows<{ boost_decay_per_hour: number | string }>({
      code: LANDS,
      scope: LANDS,
      table: 'config',
      limit: 1,
    }).catch(() => []),
    ...PLANETS.map((p) => onePlanet(p)),
  ])

  return {
    buildings: perPlanet.flat().sort((a, b) => b.tlm - a.tlm),
    decayPerHour: Number(config[0]?.boost_decay_per_hour) || 0,
    owners: false,
  }
}

async function onePlanet(planet: string): Promise<Building[]> {
  const [lands, arenas, dungeons] = await Promise.all([
    getRows<RawLand>({ code: LANDS, scope: planet, table: 'lands', limit: 1000 }),
    getRows<RawTeam>({ code: 'arena.ale', scope: planet, table: 'livearena', limit: 500 }).catch(() => []),
    getRows<RawTeam>({ code: 'dungeons.ale', scope: planet, table: 'dungeons', limit: 500 }).catch(() => []),
  ])

  /* Keyed by land AND kind: a land can hold one of each, and the two tables
     use the same land_id. */
  const teams = new Map<string, Defender[]>()
  for (const t of arenas) teams.set(`${t.land_id}:arena`, (t.fighters ?? []).map(defender))
  for (const t of dungeons) teams.set(`${t.land_id}:dungeon`, (t.fighters ?? []).map(defender))

  const out: Building[] = []
  for (const land of lands) {
    for (const b of land.buildings ?? []) {
      const kind = String(b.building_name) as BuildingKind
      out.push({
        planet,
        land_id: land.land_id,
        x: Number(land.x),
        y: Number(land.y),
        landType: land.land_type ?? '',
        rarity: land.rarity ?? '',
        assetId: String(land.asset_id),
        kind,
        level: Number(b.level) || 0,
        boostScore: Number(b.boost_score) || 0,
        boostUpdated: stamp(b.boost_score_update),
        lastClaim: stamp(b.last_claim),
        tlm: scaled(b.tlm),
        shards: scaled(b.shards),
        gems: Number(b.gems) || 0,
        credits: Number(b.credits) || 0,
        defenders: teams.get(`${land.land_id}:${kind}`) ?? [],
        owner: null,
      })
    }
  }
  return out
}

/**
 * The rating as of now.
 *
 * The stored score is what it was at `boost_score_update`; it sheds
 * `decayPerHour` every hour after that and stops at zero. Showing the stored
 * number alone would overstate every building that has been idle.
 */
export function ratingNow(b: Building, decayPerHour: number, now = Date.now()): number {
  if (!Number.isFinite(b.boostUpdated)) return b.boostScore
  const hours = Math.max(0, (now - b.boostUpdated) / 3_600_000)
  return Math.max(0, b.boostScore - decayPerHour * hours)
}

/**
 * Who owns the lands, from AtomicAssets.
 *
 * The owner is a fact about an NFT, and no WAX table indexes NFTs by id — the
 * `atomicassets` assets table is scoped by owner, which is the wrong way round.
 * So this is the one read on the page that leaves the chain.
 */
export async function fetchOwners(assetIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(assetIds)].filter(Boolean)

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100)
    const url =
      `https://wax.api.atomicassets.io/atomicassets/v1/assets` +
      `?ids=${batch.join(',')}&limit=100&page=1`
    try {
      const reply = (await (await fetch(url)).json()) as { data?: { asset_id: string; owner: string }[] }
      for (const a of reply.data ?? []) if (a.owner) out.set(String(a.asset_id), a.owner)
    } catch (err) {
      console.error('land owners:', err)
    }
  }
  return out
}

export const KIND_LABEL: Record<BuildingKind, string> = {
  arena: 'Arena',
  dungeon: 'Dungeon',
  tavern: 'Tavern',
}
