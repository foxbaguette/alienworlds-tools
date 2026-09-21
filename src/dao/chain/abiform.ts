/**
 * A contract's ABI, turned into the shape of a form.
 *
 * Proposing an arbitrary action used to mean writing its arguments as JSON by
 * hand. The ABI already says everything a form needs — each action's struct,
 * each field's type, which types are aliases, which are nested structs — so
 * this walks it into a tree the form can render field by field.
 *
 * Anything the tree cannot sensibly be a field for (a variant, a list of
 * structs, a type the ABI does not define) comes out as `opaque`, and the form
 * gives that one field a JSON box. One awkward argument should not push the
 * whole action back to hand-written JSON.
 */

export interface AbiDef {
  types?: { new_type_name: string; type: string }[]
  structs?: { name: string; base?: string; fields: { name: string; type: string }[] }[]
  actions?: { name: string; type: string }[]
  variants?: { name: string; types: string[] }[]
}

export type Shape =
  | { kind: 'scalar'; type: string }
  | { kind: 'bool' }
  | { kind: 'struct'; name: string; fields: { name: string; shape: Shape }[] }
  | { kind: 'list'; of: Shape }
  | { kind: 'optional'; of: Shape }
  | { kind: 'opaque'; type: string }

/** The built-in types a single text box can hold. */
const SCALARS = new Set([
  'name',
  'string',
  'asset',
  'symbol',
  'symbol_code',
  'int8',
  'int16',
  'int32',
  'int64',
  'int128',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uint128',
  'varint32',
  'varuint32',
  'float32',
  'float64',
  'float128',
  'time_point',
  'time_point_sec',
  'block_timestamp_type',
  'checksum160',
  'checksum256',
  'checksum512',
  'public_key',
  'signature',
  'bytes',
])

/**
 * `extended_asset` is a built-in of the serializer rather than a struct in
 * most ABIs, but it is two fields to a person. Spelled out so it renders as
 * two boxes instead of one JSON blob.
 */
const BUILTIN_STRUCTS: Record<string, { name: string; type: string }[]> = {
  extended_asset: [
    { name: 'quantity', type: 'asset' },
    { name: 'contract', type: 'name' },
  ],
}

export function shapeOf(abi: AbiDef, type: string, depth = 0): Shape {
  if (depth > 8) return { kind: 'opaque', type }

  /* `$` is a binary extension — an argument older callers may leave off —
     which to somebody filling in a form is the same as optional. */
  if (type.endsWith('?') || type.endsWith('$')) return { kind: 'optional', of: shapeOf(abi, type.slice(0, -1), depth + 1) }
  if (type.endsWith('[]')) return { kind: 'list', of: shapeOf(abi, type.slice(0, -2), depth + 1) }

  const alias = abi.types?.find((t) => t.new_type_name === type)
  if (alias) return shapeOf(abi, alias.type, depth + 1)

  if (type === 'bool') return { kind: 'bool' }
  if (SCALARS.has(type)) return { kind: 'scalar', type }

  const struct = abi.structs?.find((s) => s.name === type)
  const fields = struct?.fields ?? BUILTIN_STRUCTS[type]
  if (fields) {
    /* A struct's base comes first on the wire, so its fields come first here. */
    const base = struct?.base ? shapeOf(abi, struct.base, depth + 1) : null
    return {
      kind: 'struct',
      name: type,
      fields: [
        ...(base?.kind === 'struct' ? base.fields : []),
        ...fields.map((f) => ({ name: f.name, shape: shapeOf(abi, f.type, depth + 1) })),
      ],
    }
  }

  return { kind: 'opaque', type }
}

/** The arguments of one action, or null if the contract has no such action. */
export function actionShape(abi: AbiDef, action: string): Shape | null {
  const a = abi.actions?.find((x) => x.name === action)
  return a ? shapeOf(abi, a.type) : null
}

/** Every action the contract offers, in the order a list reads well. */
export const actionNames = (abi: AbiDef | null | undefined) =>
  [...new Set((abi?.actions ?? []).map((a) => a.name))].sort()

/** What an untouched form holds for a shape. */
export function blankOf(shape: Shape): unknown {
  switch (shape.kind) {
    case 'scalar':
      return ''
    case 'bool':
      return false
    case 'struct':
      return Object.fromEntries(shape.fields.map((f) => [f.name, blankOf(f.shape)]))
    case 'list':
      return []
    case 'optional':
    case 'opaque':
      return null
  }
}

/** A list the form can show as one entry per line. */
export const isSimpleList = (shape: Shape) =>
  shape.kind === 'list' && (shape.of.kind === 'scalar' || (shape.of.kind === 'optional' && shape.of.of.kind === 'scalar'))

/** What to put in an empty box, so the expected format is not a guess. */
export function hintFor(type: string): string {
  if (type === 'name') return 'account name'
  if (type === 'asset') return '1.0000 TLM'
  if (type === 'symbol') return '4,TLM'
  if (type === 'symbol_code') return 'TLM'
  if (/^u?int|^varu?int/.test(type)) return '0'
  if (/^float/.test(type)) return '0.0'
  if (type === 'time_point_sec' || type === 'time_point' || type === 'block_timestamp_type') return '2026-01-01T00:00:00'
  if (/^checksum/.test(type)) return 'hex'
  if (type === 'bytes') return 'hex'
  return ''
}

/** Why a single value will not serialise, in words — or null if it will. */
export function scalarProblem(type: string, raw: unknown): string | null {
  const v = String(raw ?? '').trim()
  if (type === 'string') return null
  if (!v) return 'needed'
  if (type === 'name') return /^[a-z1-5.]{1,12}[a-j1-5.]?$/.test(v) && !v.endsWith('.') ? null : 'not a valid account name'
  if (type === 'asset') return /^-?\d+(\.\d+)? [A-Z]{1,7}$/.test(v) ? null : 'an amount and a symbol, like 1.0000 TLM'
  if (type === 'symbol') return /^\d{1,2},[A-Z]{1,7}$/.test(v) ? null : 'precision and code, like 4,TLM'
  if (type === 'symbol_code') return /^[A-Z]{1,7}$/.test(v) ? null : 'capitals only, like TLM'
  if (/^uint|^varuint/.test(type)) return /^\d+$/.test(v) ? null : 'a whole number, zero or more'
  if (/^int|^varint/.test(type)) return /^-?\d+$/.test(v) ? null : 'a whole number'
  if (/^float/.test(type)) return Number.isFinite(Number(v)) ? null : 'a number'
  if (type === 'time_point_sec' || type === 'time_point' || type === 'block_timestamp_type')
    return Number.isFinite(Date.parse(v.endsWith('Z') ? v : `${v}Z`)) ? null : 'a date and time, like 2026-01-01T00:00:00'
  if (/^checksum|^bytes$/.test(type)) return /^([0-9a-fA-F]{2})*$/.test(v) ? null : 'hex'
  return null
}

const isBlank = (v: unknown) => typeof v === 'string' && !v.trim()

/** Every value in a filled-in form that will not serialise, with where it is. */
export function problemsOf(shape: Shape, value: unknown, path = ''): { path: string; problem: string }[] {
  switch (shape.kind) {
    case 'scalar': {
      const p = scalarProblem(shape.type, value)
      return p ? [{ path, problem: p }] : []
    }
    case 'optional':
      return value == null || value === '' ? [] : problemsOf(shape.of, value, path)
    case 'struct': {
      const obj = (value ?? {}) as Record<string, unknown>
      return shape.fields.flatMap((f) => problemsOf(f.shape, obj[f.name], path ? `${path}.${f.name}` : f.name))
    }
    case 'list':
      return Array.isArray(value)
        ? value.filter((v) => !isBlank(v)).flatMap((v, i) => problemsOf(shape.of, v, `${path}[${i}]`))
        : [{ path, problem: 'a list' }]
    default:
      return []
  }
}

/**
 * The form's value, tidied for the serializer.
 *
 * An empty optional or binary extension becomes null rather than an empty
 * string — which the serializer reads as "not given", and which a form's
 * blank box would otherwise get wrong.
 */
export function tidy(shape: Shape, value: unknown): unknown {
  switch (shape.kind) {
    case 'scalar':
      return typeof value === 'string' ? value.trim() : value
    case 'optional':
      return value == null || value === '' ? null : tidy(shape.of, value)
    case 'struct': {
      const obj = (value ?? {}) as Record<string, unknown>
      return Object.fromEntries(shape.fields.map((f) => [f.name, tidy(f.shape, obj[f.name])]))
    }
    case 'list':
      /* A one-per-line list keeps its blank lines while it is being typed;
         they are not entries. */
      return Array.isArray(value) ? value.filter((v) => !isBlank(v)).map((v) => tidy(shape.of, v)) : value
    default:
      return value
  }
}
