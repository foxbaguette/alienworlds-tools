import { getRows } from '../../dao/chain/nodes'
import type { ChainAction } from '../../dao/chain/act'

/**
 * Battle weather — `battle.ale/weather`, scoped by planet.
 *
 * A weather is a named bundle of stat modifiers that a land can be under, and
 * `rndweather` picks one at random when a fight starts. Each planet holds its
 * own copy of the catalogue — a thousand rows each — and `setweather` takes a
 * LIST of planets, so the same weather is normally written to all six at once.
 */
export const BATTLE = 'battle.ale'

/**
 * The game's own six planets.
 *
 * Still worth naming, but no longer the whole list: a scope is whatever
 * `plnttracking` holds a row for, and `setweather` adds one as it writes. The
 * first copy made for a tournament put a seventh there. See fetchPlanets.
 *
 * These six stay the default for a write, because they are the planets a
 * fight actually happens on — a weather edited here should not quietly land
 * in somebody's tournament scope as well.
 */
export const PLANETS = ['eyeke', 'kavian', 'magor', 'naron', 'neri', 'veles'] as const

export interface WeatherEffect {
  statname: string
  percent_change: number
  flat_change: number
}

export interface Weather {
  weather_id: string
  affected_class: string[]
  affected_element: string[]
  affected_race: string[]
  weather_effects: WeatherEffect[]
  displayname: string
  title: string
}

/**
 * The stats a weather may modify.
 *
 * Taken from the names actually in use on chain rather than from Fighterstats,
 * which carries the min/max pairs a fighter is rolled from plus things no
 * weather touches — `classname`, `level`, `credits`. Offering those would be
 * offering settings that do nothing.
 */
export const STAT_NAMES = [
  'health',
  'damage',
  'taunt',
  'initiative',
  'attackspeed',
  'res_gem',
  'res_metal',
  'res_air',
  'res_fire',
  'res_nature',
  'res_neutral',
] as const

/** Classes a weather can be narrowed to. Empty means every class. */
export const CLASSES = [
  'arcanist',
  'astralknight',
  'desperado',
  'explosioneer',
  'hunter',
  'juggernaut',
  'lunatic',
  'mindblade',
  'mystic',
  'tactician',
  'voidcaller',
  'voidwarden',
] as const

export function fetchWeather(planet: string): Promise<Weather[]> {
  return getRows<Weather>({ code: BATTLE, scope: planet, table: 'weather', limit: 1000 })
}

export const setWeatherAction = (
  level: ChainAction['authorization'][number],
  planets: string[],
  w: Weather,
): ChainAction => ({
  account: BATTLE,
  name: 'setweather',
  authorization: [level],
  data: {
    wallet: level.actor,
    planets,
    weather_id: w.weather_id,
    affected_class: w.affected_class,
    affected_element: w.affected_element,
    affected_race: w.affected_race,
    weather_effects: w.weather_effects,
    displayname: w.displayname,
    title: w.title,
  },
})

/** `delweather` takes ONE planet, so removing everywhere is six actions. */
export const delWeatherAction = (
  level: ChainAction['authorization'][number],
  planet: string,
  weather_id: string,
): ChainAction => ({
  account: BATTLE,
  name: 'delweather',
  authorization: [level],
  data: { wallet: level.actor, planet, weather_id },
})

/** One line saying what a weather does. */
export function summarise(w: Weather): string {
  const parts = w.weather_effects.map((e) => {
    const pct = Number(e.percent_change)
    const flat = Number(e.flat_change)
    const bits: string[] = []
    if (pct) bits.push(`${pct > 0 ? '+' : ''}${pct}%`)
    if (flat) bits.push(`${flat > 0 ? '+' : ''}${flat}`)
    return `${e.statname} ${bits.join(' ') || 'unchanged'}`
  })
  const who = w.affected_class.length ? ` · ${w.affected_class.join(', ')} only` : ''
  return (parts.join(', ') || 'no effects') + who
}

/**
 * A fresh id, since `weather_id` is an eosio name the caller has to invent.
 *
 * Twelve characters from the name alphabet. Random rather than derived from the
 * title: two weathers can reasonably share a name, and a collision would
 * silently overwrite the older one — `setweather` writes over an existing id
 * rather than refusing it.
 */
export function newWeatherId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz12345'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export const blankWeather = (): Weather => ({
  weather_id: newWeatherId(),
  affected_class: [],
  affected_element: [],
  affected_race: [],
  weather_effects: [{ statname: 'damage', percent_change: 0, flat_change: 0 }],
  displayname: '',
  title: '',
})

/* ---------- copying a catalogue into another scope ---------- */

/**
 * The catalogue, grouped by the first character of the weather id.
 *
 * That character is not decoration: the ids were minted in batches and the
 * first one says what the weather targets. On magor today, all 264 ids
 * beginning `c` target a class, all 276 beginning `e` an element, all 322
 * beginning `r` a race, the 138 beginning `a` nothing at all, and `s` is the
 * single "No Weather Effect". So grouping by it is grouping by kind.
 *
 * It is also the right size to act on. `setweather` costs about 220µs of CPU
 * writing to six planets and a transaction may use 150,000µs, so the largest
 * of these groups fits with room to spare where the whole thousand would not.
 */
export interface WeatherGroup {
  /** The first character of every id in it. */
  char: string
  rows: Weather[]
  /** What they target, worked out from the rows rather than from the letter. */
  targets: string
}

export function groupByFirst(rows: Weather[]): WeatherGroup[] {
  const by = new Map<string, Weather[]>()
  for (const w of rows) {
    const c = String(w.weather_id)[0] ?? '?'
    const got = by.get(c)
    if (got) got.push(w)
    else by.set(c, [w])
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([char, group]) => ({ char, rows: group, targets: targetsOf(group) }))
}

function targetsOf(rows: Weather[]): string {
  const has = (pick: (w: Weather) => string[]) => rows.filter((w) => pick(w).length).length
  const kinds: string[] = []
  if (has((w) => w.affected_class) === rows.length) kinds.push('class')
  if (has((w) => w.affected_element) === rows.length) kinds.push('element')
  if (has((w) => w.affected_race) === rows.length) kinds.push('race')
  return kinds.length ? `${kinds.join(' and ')} weathers` : 'untargeted'
}

/**
 * Whether a name can be a scope at all.
 *
 * An eosio name, which is not a string: twelve characters from `.12345a-z`,
 * and a leading or trailing dot is not one the chain will take. Checked here
 * because a name the wallet cannot even serialise fails before signing, with
 * an error about encoding rather than about what was typed.
 */
export function scopeProblem(name: string): string | null {
  const s = name.trim()
  if (!s) return 'Name the scope to write into.'
  if (s.length > 12) return 'A scope name is at most 12 characters.'
  if (!/^[a-z1-5.]+$/.test(s)) return 'Only a–z, 1–5 and dots are allowed in a name.'
  if (s.startsWith('.') || s.endsWith('.')) return 'A name cannot begin or end with a dot.'
  return null
}

/**
 * What a batch of writes will cost, against what a transaction may spend.
 *
 * Measured from the live writes rather than guessed: each `setweather` onto
 * six planets billed between 114 and 330µs, median about 180, so 220 is a fair
 * upper hand for one scope — and `max_transaction_cpu_usage` is 150,000.
 *
 * It is an estimate and says so. CPU billing varies with what else the node is
 * doing, and the account's own staked CPU can bite long before the chain's
 * ceiling does.
 */
export const CPU_PER_WRITE_US = 220
export const CPU_LIMIT_US = 150_000

export const estimateCpu = (writes: number) => writes * CPU_PER_WRITE_US

export interface PlanetScope {
  planet: string
  /** The contract's own count of what that scope holds. */
  weathers: number
}

/**
 * Every scope the contract keeps weather for, from its own registry.
 *
 * `plnttracking` is what `setweather` checks and what it writes — the six
 * planet rows all appeared in the same block as the very first weather, and a
 * seventh appeared the moment a group was copied into a new scope. So this is
 * the list, and the six names above are only the ones the game was shipped
 * with.
 *
 * Read rather than assumed because assuming is what hid the new scope: the
 * page offered six tabs, the catalogue it had just written was in a seventh,
 * and there was no way to open it.
 */
export async function fetchPlanets(): Promise<PlanetScope[]> {
  const rows = await getRows<{ planet: string; weather_count: number | string }>({
    code: BATTLE,
    scope: BATTLE,
    table: 'plnttracking',
    limit: 200,
  })
  return rows
    .map((r) => ({ planet: String(r.planet), weathers: Number(r.weather_count) || 0 }))
    .sort((a, b) => a.planet.localeCompare(b.planet))
}

/**
 * How many weathers go into one transaction.
 *
 * A hundred, which is well inside what a transaction may spend: each
 * `setweather` billed between 114 and 330µs on the live writes, so a hundred
 * is about 22ms of the 150ms ceiling even at the worst of those. The limit is
 * not the reason for the number — 322 would fit too — the reason is that a
 * transaction either happens or does not, and a round hundred makes "stopped
 * after two hundred" a sentence somebody can act on.
 *
 * Chained rather than fired together: each is signed after the one before it
 * landed, so a refusal stops the rest instead of leaving an unknown number of
 * them in flight.
 */
export const COPY_PER_TRANSACTION = 100

/** A list in runs of `size`, the last one short. */
export function inChunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
