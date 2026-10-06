import { describe, expect, it } from 'vitest'
import { fromInput, isTrue, kindOf, toInput } from '@/ale/chain/admin'

/*
 * The bool round trip, which is where the ALE admin form went wrong.
 *
 * get_table_rows hands a bool back as 0 or 1. Put through String() those
 * become "0" and "1", which match neither option of the dropdown, so the
 * browser showed the first one — true — for every bool on the page. Worse,
 * the value read back out is `raw === 'true'`, so saving an untouched form
 * wrote false over settings that were true.
 */
describe('a bool from the chain', () => {
  it('reads 1 and 0 the way it reads true and false', () => {
    expect(isTrue(1)).toBe(true)
    expect(isTrue(true)).toBe(true)
    expect(isTrue('1')).toBe(true)
    expect(isTrue('true')).toBe(true)

    expect(isTrue(0)).toBe(false)
    expect(isTrue(false)).toBe(false)
    expect(isTrue('0')).toBe(false)
    expect(isTrue(undefined)).toBe(false)
  })

  it('shows the words the dropdown offers, not the digits', () => {
    expect(toInput(1, 'bool')).toBe('true')
    expect(toInput(0, 'bool')).toBe('false')
    expect(toInput(true, 'bool')).toBe('true')
    expect(toInput(false, 'bool')).toBe('false')
  })

  it('survives being read and written without changing', () => {
    for (const [chain, expected] of [
      [1, true],
      [0, false],
      [true, true],
      [false, false],
    ] as const) {
      expect(fromInput(toInput(chain, 'bool'), 'bool', 'flag')).toBe(expected)
    }
  })

  it('still treats allow_player_signup as a bool', () => {
    expect(kindOf('bool')).toBe('bool')
  })
})
