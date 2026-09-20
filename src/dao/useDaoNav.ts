import { useEffect, useState } from 'react'
import type { NavGroup } from '../sections'
import { hasWorkerProposals } from './chain/worker'
import { peekDaos, subscribeDaos } from './useDaos'

/**
 * The DAO Manager's menu, built from the directory rather than written out.
 *
 * Every council is reachable from the sidebar as an indented entry under its
 * group, so getting to Neri is one click from anywhere rather than a trip
 * through the grid. Open one and its own pages appear below, as a group named
 * after it.
 *
 * Deliberately PASSIVE about loading: it subscribes to the DAO list but never
 * asks for it. This hook runs on every page, and a sidebar should not be what
 * starts a dozen chain reads. Until the list arrives the parents simply have no
 * children, which is the honest thing to show.
 */
export function useDaoNav(pathname: string): NavGroup[] {
  const [, bump] = useState(0)
  useEffect(() => subscribeDaos(() => bump((n) => n + 1)), [])

  /* Only the DAO section's menu is built here. */
  if (!pathname.startsWith('/daos')) return []

  const daos = peekDaos()
  const groups: NavGroup[] = [
    {
      label: 'Councils',
      tools: [
        {
          to: '/daos/syndicates',
          label: 'Syndicates',
          children: daos
            .filter((d) => d.group === 'syndicate')
            .map((d) => ({ to: `/daos/${d.id}`, label: d.title })),
        },
        {
          to: '/daos/unions',
          label: 'Unions',
          children: daos.filter((d) => d.group === 'union').map((d) => ({ to: `/daos/${d.id}`, label: d.title })),
        },
      ],
    },
    { label: 'Across all councils', tools: [{ to: '/daos/proposals', label: 'All proposals' }] },
  ]

  /* Whichever DAO is open gets its own pages below. The id in the path is the
     only thing this can go on before the directory lands, so the group is
     labelled with it until the title is known. */
  const m = /^\/daos\/([^/]+)/.exec(pathname)
  const id = m?.[1]
  if (id && !['syndicates', 'unions', 'proposals'].includes(id)) {
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
