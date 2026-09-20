import { call, getPage } from '../../dao/chain/nodes'

/**
 * The Alien Legends contracts' own settings.
 *
 * Every `.ale` contract follows the same shape, which is what makes one generic
 * page possible rather than seventeen hand-written ones:
 *
 *   * a `config` table holding exactly one row, and
 *   * a `setconfig` action whose parameters mirror that row's fields.
 *
 * So the form is built from the ABI — one field per `setconfig` parameter,
 * typed by what the ABI says it is — and filled from the row. Nothing about any
 * particular contract is written down here, which means a contract that gains a
 * setting gains a field without this file changing.
 *
 * `farm.ale` calls it `updconfig` instead, so the action is looked up by either
 * name rather than assumed.
 */
export const ALE_CONTRACTS = [
  'admin.ale',
  'arena.ale',
  'ascend.ale',
  'battle.ale',
  'creation.ale',
  'dungeons.ale',
  'farm.ale',
  'fighters.ale',
  'lands.ale',
  'market.ale',
  'nfts.ale',
  'players.ale',
  'pools.ale',
  'quests.ale',
  'recovery.ale',
  'rwrdlog.ale',
  'taskmngr.ale',
] as const

const SETTER_NAMES = ['setconfig', 'updconfig']

/** Parameters the form neither shows nor lets anyone type. See fetchConfig. */
const HIDDEN_PARAMS = new Set(['wallet', 'delete_config'])

/** What those hidden ones are sent as, every time. */
export const SAFE_DEFAULTS: Record<string, unknown> = { delete_config: false }

export interface AbiField {
  name: string
  type: string
}

export interface ConfigForm {
  contract: string
  /** The action that writes it — setconfig on all but farm.ale. */
  action: string
  /** One per parameter of that action, in the order the ABI declares them. */
  fields: AbiField[]
  /** The row as it stands, keyed by field name. */
  current: Record<string, unknown>
  /** Present but unwritable: the row's own key, which setconfig does not take. */
  readOnly: AbiField[]
}

interface Abi {
  tables: { name: string; type: string }[]
  actions: { name: string; type: string }[]
  structs: { name: string; base: string; fields: AbiField[] }[]
}

const abiCache = new Map<string, Abi>()

async function abiOf(contract: string): Promise<Abi> {
  const hit = abiCache.get(contract)
  if (hit) return hit
  const data = await call({ account_name: contract }, 'get_abi')
  if (!data?.abi) throw new Error(`${contract} has no ABI`)
  abiCache.set(contract, data.abi)
  return data.abi
}

/** Every field of a struct, following `base` so inherited ones are not lost. */
function fieldsOf(abi: Abi, type: string): AbiField[] {
  const st = abi.structs.find((s) => s.name === type)
  if (!st) return []
  return [...(st.base ? fieldsOf(abi, st.base) : []), ...st.fields]
}

export async function fetchConfig(contract: string): Promise<ConfigForm> {
  const abi = await abiOf(contract)

  const table = abi.tables.find((t) => t.name === 'config')
  if (!table) throw new Error(`${contract} has no config table`)

  const setter = abi.actions.find((a) => SETTER_NAMES.includes(a.name))
  if (!setter) throw new Error(`${contract} has no setconfig action`)

  const params = fieldsOf(abi, setter.type)
  const rowFields = fieldsOf(abi, table.type)

  /* The singleton. `config` holds one row on every one of these contracts, so
     there is no key to look it up by. */
  const rows = await getPage<Record<string, unknown>>({
    code: contract,
    scope: contract,
    table: 'config',
    limit: 1,
  })
  const current = rows[0] ?? {}

  /*
   * Two parameters are not settings and are not offered.
   *
   * `wallet` is the authorising account; the form fills it from the session.
   *
   * `delete_config` WIPES the whole config rather than writing one, so it has
   * no business sitting in a grid of numbers where a stray click reaches it.
   * It is always sent false — see SAFE_DEFAULTS, which the form spreads in.
   */
  const writable = params.filter((p) => !HIDDEN_PARAMS.has(p.name))
  const writableNames = new Set(writable.map((p) => p.name))
  const readOnly = rowFields.filter((f) => !writableNames.has(f.name))

  return { contract, action: setter.name, fields: writable, current, readOnly }
}

/* ---------- turning ABI types into form fields ---------- */

export type FieldKind = 'bool' | 'number' | 'text' | 'json'

/**
 * Which input a type deserves.
 *
 * Anything with a list, an optional or a struct behind it becomes JSON: those
 * are `pair_name_uint64[]` and friends, and inventing a bespoke editor for each
 * would be a lot of surface for settings that are changed once a year. The raw
 * value round-trips exactly, which matters more here than convenience.
 */
export function kindOf(type: string): FieldKind {
  if (type.endsWith('[]') || type.endsWith('?') || type.endsWith('$')) return 'json'
  if (type === 'bool') return 'bool'
  if (/^(u?int\d+|float\d+|varuint\d+|varint\d+)$/.test(type)) return 'number'
  if (/^(name|string|asset|symbol|symbol_code|checksum256|public_key|time_point_sec|extended_asset)$/.test(type)) {
    /* extended_asset is an object, so it still needs JSON. */
    return type === 'extended_asset' ? 'json' : 'text'
  }
  return 'json'
}

/** The current value, as the form should show it. */
export function toInput(value: unknown, kind: FieldKind): string {
  if (value === undefined || value === null) return kind === 'json' ? '[]' : ''
  if (kind === 'json') return JSON.stringify(value, null, 2)
  return String(value)
}

/**
 * The form value, as the action should receive it.
 *
 * Numbers go back as numbers and JSON is parsed, because an ABI-typed field
 * sent as a string is a serialization error rather than a value error — it
 * fails at the wallet with something unreadable instead of here with something
 * plain.
 */
export function fromInput(raw: string, kind: FieldKind, field: string): unknown {
  if (kind === 'bool') return raw === 'true'
  if (kind === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${field}: "${raw}" is not a number`)
    return n
  }
  if (kind === 'json') {
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new Error(`${field}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return raw
}
