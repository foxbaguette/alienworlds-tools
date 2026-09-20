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
