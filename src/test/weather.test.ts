import { describe, expect, it } from 'vitest'
import {
  CPU_LIMIT_US,
  estimateCpu,
  groupByFirst,
  scopeProblem,
  setWeatherAction,
  type Weather,
} from '@/ale/chain/weather'

/*
 * Copying a weather catalogue into another scope.
 *
 * The first character of a weather id is not decoration. The thousand rows on
 * each planet were minted in batches and that character says what the weather
 * targets — on magor today every one of the 264 ids beginning `c` targets a
 * class, all 276 beginning `e` an element, all 322 beginning `r` a race, the
 * 138 beginning `a` nothing, and `s` is the lone "No Weather Effect".
 */
const weather = (weather_id: string, over: Partial<Weather> = {}): Weather => ({
  weather_id,
  affected_class: [],
  affected_element: [],
  affected_race: [],
  weather_effects: [{ statname: 'damage', percent_change: 0, flat_change: 0 }],
  displayname: '',
  title: weather_id,
  ...over,
})

const level = { actor: 'admin.wam', permission: 'active' }

describe('grouping a catalogue by id', () => {
  it('splits on the first character and sorts the groups', () => {
    const got = groupByFirst([weather('rbbb'), weather('aaaa'), weather('raaa'), weather('caaa')])
    expect(got.map((g) => `${g.char}:${g.rows.length}`)).toEqual(['a:1', 'c:1', 'r:2'])
  })

  /* Worked out from the rows, not from the letter — the letters are a
     convention of whoever minted the ids, and conventions lapse. */
  it('says what a group targets, read off its rows', () => {
    const got = groupByFirst([
      weather('caaa', { affected_class: ['hunter'] }),
      weather('cbbb', { affected_class: ['mystic'] }),
      weather('eaaa', { affected_element: ['air'] }),
      weather('raaa', { affected_race: ['altan'] }),
      weather('aaaa'),
    ])
    expect(Object.fromEntries(got.map((g) => [g.char, g.targets]))).toEqual({
      a: 'untargeted',
      c: 'class weathers',
      e: 'element weathers',
      r: 'race weathers',
    })
  })

  /* A group is only that kind if ALL of it is: one stray untargeted row makes
     the label a lie, and the label is what the chip is chosen from. */
  it('calls a mixed group untargeted rather than guessing', () => {
    const got = groupByFirst([weather('caaa', { affected_class: ['hunter'] }), weather('cbbb')])
    expect(got[0].targets).toBe('untargeted')
  })

  it('keeps every row, in the order given', () => {
    const rows = [weather('r1'), weather('r2'), weather('r3')]
    expect(groupByFirst(rows)[0].rows.map((w) => w.weather_id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('has nothing to group when the catalogue is unread', () => {
    expect(groupByFirst([])).toEqual([])
  })
})

describe('a scope name', () => {
  it('takes a name the chain would', () => {
    for (const ok of ['eyeke', 'test.scope', 'a', 'abc12345xyz5']) expect(scopeProblem(ok)).toBeNull()
  })

  /* A name is not a string. Caught here because a name the wallet cannot
     serialise fails before signing, with an error about encoding rather than
     about what was typed. */
  it('refuses what is not a name', () => {
    expect(scopeProblem('')).toMatch(/Name the scope/)
    expect(scopeProblem('toolongascope1')).toMatch(/12 characters/)
    expect(scopeProblem('Eyeke')).toMatch(/a–z/)
    expect(scopeProblem('eyeke-two')).toMatch(/a–z/)
    expect(scopeProblem('eyeke6')).toMatch(/a–z/)
    expect(scopeProblem('.eyeke')).toMatch(/dot/)
    expect(scopeProblem('eyeke.')).toMatch(/dot/)
  })
})

describe('what a copy costs', () => {
  /*
     Measured, not guessed: the live writes billed between 114 and 330µs each
     onto six planets, and max_transaction_cpu_usage is 150,000. So the biggest
     group on a planet fits in one transaction and the whole catalogue does not
     — which is the reason the groups are what gets copied.
  */
  it('fits the largest real group inside a transaction', () => {
    expect(estimateCpu(322)).toBeLessThan(CPU_LIMIT_US)
  })

  it('does not pretend the whole catalogue fits', () => {
    expect(estimateCpu(1_001)).toBeGreaterThan(CPU_LIMIT_US)
  })
})

describe('the copy itself', () => {
  /* One action per weather, carrying the one scope — setweather takes a list,
     so copying into one place is not six actions. */
  it('writes a weather into exactly the scope named', () => {
    const w = weather('raaa', { affected_race: ['altan'], title: 'Altan air resistance' })
    expect(setWeatherAction(level, ['sandbox'], w)).toEqual({
      account: 'battle.ale',
      name: 'setweather',
      authorization: [level],
      data: {
        wallet: 'admin.wam',
        planets: ['sandbox'],
        weather_id: 'raaa',
        affected_class: [],
        affected_element: [],
        affected_race: ['altan'],
        weather_effects: [{ statname: 'damage', percent_change: 0, flat_change: 0 }],
        displayname: '',
        title: 'Altan air resistance',
      },
    })
  })
})
