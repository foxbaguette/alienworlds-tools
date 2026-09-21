import { describe, expect, it } from 'vitest'
import {
  actionNames,
  actionShape,
  blankOf,
  problemsOf,
  scalarProblem,
  shapeOf,
  tidy,
  type AbiDef,
} from '@/dao/chain/abiform'

/*
 * A small ABI with every construct the walker has to handle: an alias, a
 * struct with a base, a nested built-in (extended_asset), an optional, a
 * binary extension, a list of names, a list of structs and a variant.
 */
const ABI: AbiDef = {
  types: [{ new_type_name: 'account_name', type: 'name' }],
  structs: [
    { name: 'base_args', fields: [{ name: 'dac_id', type: 'name' }] },
    {
      name: 'doit',
      base: 'base_args',
      fields: [
        { name: 'to', type: 'account_name' },
        { name: 'pay', type: 'extended_asset' },
        { name: 'note', type: 'string?' },
        { name: 'later', type: 'uint32$' },
        { name: 'who', type: 'name[]' },
        { name: 'splits', type: 'split[]' },
        { name: 'flag', type: 'bool' },
        { name: 'any', type: 'thing' },
      ],
    },
    { name: 'split', fields: [{ name: 'to', type: 'name' }, { name: 'share', type: 'uint16' }] },
    { name: 'transfer', fields: [{ name: 'from', type: 'name' }, { name: 'to', type: 'name' }, { name: 'quantity', type: 'asset' }, { name: 'memo', type: 'string' }] },
  ],
  actions: [
    { name: 'transfer', type: 'transfer' },
    { name: 'doit', type: 'doit' },
  ],
  variants: [{ name: 'thing', types: ['name', 'uint64'] }],
}

describe('shapeOf', () => {
  const shape = actionShape(ABI, 'doit')!

  it('puts the base struct’s fields first, as they are on the wire', () => {
    expect(shape.kind).toBe('struct')
    if (shape.kind !== 'struct') return
    expect(shape.fields.map((f) => f.name)).toEqual(['dac_id', 'to', 'pay', 'note', 'later', 'who', 'splits', 'flag', 'any'])
  })

  it('resolves each kind of type', () => {
    if (shape.kind !== 'struct') return
    const of = Object.fromEntries(shape.fields.map((f) => [f.name, f.shape]))
    expect(of.to).toEqual({ kind: 'scalar', type: 'name' })
    expect(of.pay.kind).toBe('struct')
    expect(of.note).toEqual({ kind: 'optional', of: { kind: 'scalar', type: 'string' } })
    expect(of.later).toEqual({ kind: 'optional', of: { kind: 'scalar', type: 'uint32' } })
    expect(of.who).toEqual({ kind: 'list', of: { kind: 'scalar', type: 'name' } })
    expect(of.splits.kind).toBe('list')
    expect(of.flag).toEqual({ kind: 'bool' })
    expect(of.any).toEqual({ kind: 'opaque', type: 'thing' })
  })

  it('gives up on a type it does not know rather than guessing', () => {
    expect(shapeOf(ABI, 'nonsense')).toEqual({ kind: 'opaque', type: 'nonsense' })
  })

  it('knows when an action does not exist', () => {
    expect(actionShape(ABI, 'nope')).toBeNull()
    expect(actionNames(ABI)).toEqual(['doit', 'transfer'])
  })
})

describe('filling it in', () => {
  const transfer = actionShape(ABI, 'transfer')!

  it('starts blank with every field present', () => {
    expect(blankOf(transfer)).toEqual({ from: '', to: '', quantity: '', memo: '' })
  })

  it('says what is wrong, and where', () => {
    const got = problemsOf(transfer, { from: 'neri.dac', to: 'Not A Name', quantity: '75000 TLM', memo: '' })
    expect(got).toEqual([{ path: 'to', problem: 'not a valid account name' }])
  })

  it('accepts a correct transfer, with an empty memo', () => {
    expect(problemsOf(transfer, { from: 'neri.dac', to: 'tlmsplitting', quantity: '75000.0000 TLM', memo: '' })).toEqual([])
  })

  it('leaves blank lines of a one-per-line list out, and nulls empty optionals', () => {
    const shape = actionShape(ABI, 'doit')!
    const v = { ...(blankOf(shape) as object), dac_id: ' nerix ', who: ['a.wam', '', ' b.wam', ''], note: '' }
    const out = tidy(shape, v) as Record<string, unknown>
    expect(out.dac_id).toBe('nerix')
    expect(out.who).toEqual(['a.wam', 'b.wam'])
    expect(out.note).toBeNull()
    expect(problemsOf(shape, { ...v, to: 'x.wam', pay: { quantity: '1.0000 TLM', contract: 'alien.worlds' } })).toEqual([])
  })
})

describe('scalarProblem', () => {
  it.each([
    ['name', 'neri.dac', null],
    ['name', '42lra.wam', null],
    ['name', 'toolongaccountx', 'not a valid account name'],
    ['asset', '1.0000 TLM', null],
    ['asset', '1.0000', 'an amount and a symbol, like 1.0000 TLM'],
    ['uint32', '604800', null],
    ['uint32', '-1', 'a whole number, zero or more'],
    ['int64', '-1', null],
    ['symbol', '4,TLM', null],
    ['time_point_sec', '2026-09-21T00:00:00', null],
    ['string', '', null],
    ['name', '', 'needed'],
  ])('%s %j', (type, v, want) => {
    expect(scalarProblem(type, v)).toBe(want)
  })
})
