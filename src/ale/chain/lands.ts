import { getRows } from '../../dao/chain/nodes'

/**
 * The land map, per planet.
 *
 * `lands.ale/lands` is scoped by planet and holds 1600 rows for each — one per
 * square of a 40x40 grid — so a planet is loaded whole, once, the first time
 * something on it needs naming, and kept. Land changes hands and gains
 * buildings, but not minute to minute.
 *
 * Rows are trimmed on arrival: the full row carries every building's boost
 * score, claim times and accrued TLM, and none of that is wanted for saying
 * where somebody just walked.
 */
export interface Land {
  land_id: string
  x: number
  y: number
  /** "Rocky Desert", "Geothermal Springs" — empty on unclaimed squares. */
  type: string
  rarity: string
  /** `arena`, `dungeon`, `tavern`. Usually none, occasionally one. */
  buildings: string[]
}

interface RawLand {
  land_id: string
  planet: string
  land_type: string
  rarity: string
  x: number | string
  y: number | string
  buildings?: { building_name: string }[]
}

/** planet -> "x,y" -> land */
const byPlanet = new Map<string, Map<string, Land>>()
const loading = new Map<string, Promise<void>>()

const key = (x: number | string, y: number | string) => `${Number(x)},${Number(y)}`

export function landsReady(planet: string): boolean {
  return byPlanet.has(planet)
}

/** Loads one planet's grid. Concurrent callers share the one request. */
export function ensureLands(planet: string): Promise<void> {
  if (byPlanet.has(planet)) return Promise.resolve()
  const live = loading.get(planet)
  if (live) return live

  const job = getRows<RawLand>({ code: 'lands.ale', scope: planet, table: 'lands', limit: 1000 })
    .then((rows) => {
      const map = new Map<string, Land>()
      for (const r of rows) {
        map.set(key(r.x, r.y), {
          land_id: r.land_id,
          x: Number(r.x),
          y: Number(r.y),
          type: r.land_type ?? '',
          rarity: r.rarity ?? '',
          buildings: (r.buildings ?? []).map((b) => String(b.building_name)).filter(Boolean),
        })
      }
      byPlanet.set(planet, map)
    })
    .catch((err: unknown) => {
      console.error(`lands for ${planet}:`, err)
      /* Not cached on failure, so the next travel there tries again. */
    })
    .finally(() => {
      loading.delete(planet)
    })

  loading.set(planet, job)
  return job
}

export function landAt(planet: string, x: number | string, y: number | string): Land | null {
  return byPlanet.get(planet)?.get(key(x, y)) ?? null
}

/** What is built there, in the words a player would use. */
export function landDescribe(land: Land | null): string {
  if (!land) return ''
  const built = land.buildings
    .map((b) => (b === 'tavern' ? 'a tavern' : b === 'dungeon' ? 'a dungeon' : b === 'arena' ? 'an arena' : b))
    .join(' and ')
  if (land.type && built) return `${land.type} · ${built}`
  if (built) return built
  /* An unclaimed square has no type either, and "empty land" says more than a
     blank does. */
  return land.type || 'empty land'
}
