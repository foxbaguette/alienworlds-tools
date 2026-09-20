import { useEffect, useState } from 'react'
import type { NavGroup } from '../sections'
import { hasWorkerProposals } from './chain/worker'
import { peekDaos, subscribeDaos } from './useDaos'
import { peekAllocators, subscribeAllocators } from './useAllocators'
import { useTodoCounts } from './useTodo'

/**
 * The DAO Manager's menu, built from the directory rather than written out.
 *
 * Every council is reachable from the sidebar as an indented entry under its
 * group, so getting to Neri is one click from anywhere. Open one and its own
 * pages appear below, as a group named after it.
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
        { to: '/daos/exchanges', label: 'Token exchanges' },
      ],
    },
  ]

  /* Whichever DAO is open gets its own pages below. The id in the path is the
     only thing this can go on before the directory lands, so the group is
     labelled with it until the title is known. */
  const m = /^\/daos\/([^/]+)/.exec(pathname)
  const id = m?.[1]
  if (id && !['syndicates', 'unions', 'proposals', 'candidates', 'exchanges'].includes(id)) {
    const dao = daos.find((d) => d.id === id)
    groups.push({
      label: dao?.title ?? id,
      tools: [
        { to: `/daos/${id}/proposals`, label: 'Proposals' },
        ...(dao && hasWorkerProposals(dao) ? [{ to: `/daos/${id}/worker`, label: 'Worker proposals' }] : []),
        { to: `/daos/${id}/council`, label: 'Council & candidates' },
      ],
    })
  }

  return groups
}
