import { useEffect, useState } from 'react'
import type { NavGroup } from '../sections'
import { peekDaos, subscribeDaos } from './useDaos'
import { peekAllocators, subscribeAllocators } from './useAllocators'
import { useTodoCounts } from './useTodo'

/**
 * The DAO Manager's menu, built from the directory rather than written out.
 *
 * Every council is reachable from the sidebar as an indented entry under its
 * group, so getting to Neri is one click from anywhere. A council's own pages
 * — proposals, worker proposals, council — are tabs on the council itself and
 * are NOT repeated here: the same three links twice on one screen is a menu
 * that grows every time you open something, for nothing it did not already do.
 *
 * Each entry carries a count of what is waiting on the connected account — and
 * only when there is something, so an absent badge means "nothing to do" rather
 * than "not checked". See useTodo for what counts.
 *
 * Deliberately PASSIVE about the directory: it subscribes but never asks for
 * it. This hook runs on every page, and a sidebar should not be what starts a
 * dozen chain reads.
 */
export function useDaoNav(pathname: string): NavGroup[] {
  const [, bump] = useState(0)
  useEffect(() => subscribeDaos(() => bump((n) => n + 1)), [])
  useEffect(() => subscribeAllocators(() => bump((n) => n + 1)), [])
  /* Before any early return: a hook cannot be reached for only on some routes. */
  const todo = useTodoCounts()

  /* The MSIG groups are the same idea over a different list: each allocator is
     an indented entry, so one is a click away from anywhere in that section. */
  if (pathname.startsWith('/msig')) {
    return [
      {
        label: 'Allocators',
        tools: [
          {
            to: '/msig',
            label: 'All groups',
            children: peekAllocators().map((a) => ({ to: `/msig/${a.allocator}`, label: a.allocator })),
          },
        ],
      },
    ]
  }

  if (!pathname.startsWith('/daos')) return []

  const daos = peekDaos()
  const child = (id: string, label: string) => ({
    to: `/daos/${id}`,
    label,
    badge: todo.get(id)?.n,
    badgeWhy: todo.get(id)?.why,
  })
  /* One number for the whole group, since that page spans every council. */
  const across = [...todo.values()].reduce((a, t) => a + t.n, 0)
  const acrossWhy = [...todo.entries()].flatMap(([id, t]) => {
    const name = daos.find((d) => d.id === id)?.title ?? id
    return t.why.map((line) => `${name}: ${line}`)
  })

  const groups: NavGroup[] = [
    {
      label: 'Councils',
      tools: [
        {
          to: '/daos/syndicates',
          label: 'Syndicates',
          children: daos.filter((d) => d.group === 'syndicate').map((d) => child(d.id, d.title)),
        },
        {
          to: '/daos/unions',
          label: 'Unions',
          children: daos.filter((d) => d.group === 'union').map((d) => child(d.id, d.title)),
        },
      ],
    },
    {
      label: 'Across all councils',
      tools: [
        {
          to: '/daos/proposals',
          label: 'All proposals',
          badge: across || undefined,
          badgeWhy: across ? acrossWhy : undefined,
        },
        { to: '/daos/candidates', label: 'Candidates' },
        { to: '/daos/activity', label: 'Live activity' },
      ],
    },
  ]

  return groups
}
