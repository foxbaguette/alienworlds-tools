import { describe, expect, it } from 'vitest'
import { pendingElections } from '@/dao/chain/activity'

/*
 * A council waiting on an election.
 *
 * Nothing on chain marks the moment a period runs out, so this row is worked
 * out from the directory. These pin down when it should appear, and where.
 */
const NOW = Date.parse('2026-10-18T12:00:00Z')
const WEEK = 7 * 86_400_000
const SINCE = NOW - WEEK
const hours = (n: number) => n * 3_600_000

describe('an election that has fallen due', () => {
  it('is a row at the moment it fell due', () => {
    const due = NOW - hours(5)
    const [row] = pendingElections([{ id: 'nerix', nextElection: due }], SINCE, NOW)
    expect(row.kind).toBe('pending')
    expect(row.dacId).toBe('nerix')
    expect(row.at).toBe(due)
    expect(row.overdue).toBe(hours(5))
  })

  it('is not there while the period is still running', () => {
    expect(pendingElections([{ id: 'nerix', nextElection: NOW + hours(1) }], SINCE, NOW)).toEqual([])
  })

  it('is not there for a council with no period at all', () => {
    expect(pendingElections([{ id: 'testa', nextElection: null }], SINCE, NOW)).toEqual([])
  })

  /*
    The case that nearly got dropped: a council overdue by longer than the
    feed's window is the one most worth seeing, so it is pinned to the edge
    rather than filtered out for being too old.
  */
  it('is pinned to the edge of the window when it is older than it', () => {
    const due = NOW - 30 * 86_400_000
    const [row] = pendingElections([{ id: 'naronunn', nextElection: due }], SINCE, NOW)
    expect(row.at).toBe(SINCE)
    expect(row.overdue).toBe(30 * 86_400_000)
  })

  it('gives one row per waiting council and none for the rest', () => {
    const rows = pendingElections(
      [
        { id: 'nerix', nextElection: NOW - hours(2) },
        { id: 'eyeke', nextElection: NOW + hours(2) },
        { id: 'veles', nextElection: NOW - hours(9) },
      ],
      SINCE,
      NOW,
    )
    expect(rows.map((r) => r.dacId)).toEqual(['nerix', 'veles'])
  })

  it('keeps a key that does not change while it waits', () => {
    const due = NOW - hours(3)
    const first = pendingElections([{ id: 'nerix', nextElection: due }], SINCE, NOW)[0]
    /* Ten minutes later it is the same event, so the feed must not treat it
       as a new arrival. */
    const later = pendingElections([{ id: 'nerix', nextElection: due }], SINCE, NOW + hours(0.17))[0]
    expect(later.key).toBe(first.key)
    expect(later.overdue).toBeGreaterThan(first.overdue!)
  })
})
