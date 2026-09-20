import { getRows } from '../../dao/chain/nodes'
import type { ChainAction } from '../../dao/chain/act'

/**
 * The ability catalogue — `creation.ale/abilitytemps`, scoped by ability pool.
 *
 * When `rndfighter` rolls a new fighter it picks abilities out of the pools its
 * class is pointed at, weighted. A class has three or four pools, roughly one
 * per tier, and each holds a few hundred rows — nine thousand in all — so one
 * pool is loaded at a time and searched rather than scrolled. Exactly like the
 * weather catalogue, and for the same reason.
 *
 * `setability` takes a LIST of scopes with a weight for each, so writing one
 * ability into every pool of a class is a single action.
 *
 * There is NO per-ability delete. `clearability` wipes a whole scope, which is
 * not a thing to reach for by accident, so the way to retire one ability is to
 * write it back at weight 0: the roll is weighted, and a weight of zero is
 * never picked.
 */
export const CREATION = 'creation.ale'

export interface BfEffect {
  percentflat: string
  stat_name: string
  value: number
  value_min: number
  value_max: number
}

export interface IfEffect extends BfEffect {
  execute_target: string
}

export interface EofEffect {
  effect_type: string
  percentflat: string
  value: number
  value_min: number
  value_max: number
}

export interface SpecialAbility {
  ability: string
  displayname: string
  description: string
  on_creation: number
  on_fight_start: number
  on_attack: number
  on_defense: number
  on_battle_end: number
  target_change: string
  bf_target: string
  bf_effects: BfEffect[]
  check_condition: number
  condition_target: string
  condition_group: string
  condition_name: string
  condition_minmax: string
  condition_value: number
  effect_on_condition_count: number
  if_effects: IfEffect[]
  ignore_res_percent: number
  eof_effects: EofEffect[]
  locked: number
}

export interface AbilityTemplate {
  ability_id: string
  weight: number
  ability: SpecialAbility
}

/** A class and the pools its fighters roll abilities from. */
export interface AbilityClass {
  classname: string
  scopes: string[]
}

/**
 * Which pools exist, read from the class templates rather than from a scope
 * listing: `get_table_by_scope` is the least dependable call these nodes
 * offer, and the classes carry the same answer as ordinary rows.
 */
export async function fetchAbilityClasses(): Promise<AbilityClass[]> {
  const rows = await getRows<{ classname: string; ability_scopes?: string[] }>({
    code: CREATION,
    scope: CREATION,
    table: 'classtemps',
    limit: 100,
  })
  return rows
    .map((r) => ({ classname: r.classname, scopes: r.ability_scopes ?? [] }))
    .filter((c) => c.scopes.length)
    .sort((a, b) => a.classname.localeCompare(b.classname))
}

export const fetchAbilities = (scope: string) =>
  getRows<AbilityTemplate>({ code: CREATION, scope, table: 'abilitytemps', limit: 1000 })

/** When each effect list is applied, in the words the contract uses. */
export const TRIGGERS = [
  { key: 'on_creation', label: 'on creation' },
  { key: 'on_fight_start', label: 'on fight start' },
  { key: 'on_attack', label: 'on attack' },
  { key: 'on_defense', label: 'on defense' },
  { key: 'on_battle_end', label: 'on battle end' },
] as const

/** Stats an effect can move, taken from what is in use on chain. */
export const STATS = [
  'health',
  'damage',
  'taunt',
  'initiative',
  'attackspeed',
  'windup',
  'res_gem',
  'res_metal',
  'res_air',
  'res_fire',
  'res_nature',
  'res_neutral',
] as const

/** Who an effect lands on. */
export const TARGETS = [
  '',
  'self',
  'ally_group',
  'ally_single',
  'enemy_group',
  'enemy_single',
  'enemy_taunt_max',
  'enemy_health_max',
  'enemy_health_min',
] as const

export const PERCENT_FLAT = ['flat', 'percent'] as const

export const setAbilityAction = (
  level: ChainAction['authorization'][number],
  scopes: string[],
  weights: number[],
  ability: SpecialAbility,
): ChainAction => ({
  account: CREATION,
  name: 'setability',
  authorization: [level],
  data: { wallet: level.actor, scope: scopes, weight: weights, ability },
})

/** Wipes an ENTIRE pool. The contract offers nothing narrower. */
export const clearScopeAction = (
  level: ChainAction['authorization'][number],
  scope: string,
): ChainAction => ({
  account: CREATION,
  name: 'clearability',
  authorization: [level],
  data: { wallet: level.actor, scope },
})

/** One line saying what an ability does. */
export function summarise(a: SpecialAbility): string {
  const when = TRIGGERS.filter((t) => Number(a[t.key])).map((t) => t.label)
  const effects = a.bf_effects.map((e) => {
    const lo = Number(e.value_min)
    const hi = Number(e.value_max)
    const span = lo === hi ? `${lo}` : `${lo} to ${hi}`
    return `${e.stat_name} ${span}${e.percentflat === 'percent' ? '%' : ''}`
  })
  const bits = [
    when.length ? when.join(', ') : 'never triggers',
    a.bf_target ? `on ${a.bf_target}` : '',
    effects.join(', '),
    a.target_change ? `retargets ${a.target_change}` : '',
    a.if_effects.length ? `${a.if_effects.length} conditional` : '',
    a.eof_effects.length ? `${a.eof_effects.length} end-of-fight` : '',
  ].filter(Boolean)
  return bits.join(' · ')
}

/**
 * A fresh ability id.
 *
 * `ability_id` is the table's primary key and `setability` OVERWRITES a row
 * with the same one, so a copy must never keep the id it was copied from —
 * that would silently replace the original. Same reasoning as the weather
 * catalogue; same alphabet.
 */
export function newAbilityId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz12345'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export const blankEffect = (): BfEffect => ({
  percentflat: 'flat',
  stat_name: 'damage',
  value: 0,
  value_min: 0,
  value_max: 0,
})

export const blankAbility = (): SpecialAbility => ({
  ability: newAbilityId(),
  displayname: '',
  description: '',
  on_creation: 1,
  on_fight_start: 0,
  on_attack: 0,
  on_defense: 0,
  on_battle_end: 0,
  target_change: '',
  bf_target: 'self',
  bf_effects: [blankEffect()],
  check_condition: 0,
  condition_target: '',
  condition_group: '',
  condition_name: '',
  condition_minmax: '',
  condition_value: 0,
  effect_on_condition_count: 0,
  if_effects: [],
  ignore_res_percent: 0,
  eof_effects: [],
  locked: 0,
})
