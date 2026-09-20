import { useEffect, useState } from 'react'
import type { NavGroup } from '../sections'
import { hasWorkerProposals } from './chain/worker'
import { subscribeDaos, peekDaos } from './useDaos'

/**
 * The menu entries for wherever you are inside the DAO Manager.
 *
 * Opening one DAO puts its own pages in the sidebar — council, proposals,
 * worker proposals — so they are reachable, linkable and visible as a place in
 * the site rather than only as tabs buried in the page.
 *
 * Deliberately PASSIVE about loading. It subscribes to the DAO list but never
 * asks for it, because this hook runs on every page including the stats ones,
 * and a sidebar should not be what starts a dozen chain reads. Until the list
 * arrives it labels the group with the id from the URL, which is the only thing
 * it can honestly say at that point.
 */
export function useDaoNav(pathname: string): NavGroup[] {
  const [, bump] = useState(0)

  useEffect(() => subscribeDaos(() => bump((n) => n + 1)), [])

  const m = /^\/daos\/([^/]+)/.exec(pathname)
  const id = m?.[1]
  /* Not a DAO id: these are the section's own pages, already in the menu. */
  if (!id || id === 'syndicates' || id === 'unions' || id === 'proposals') return []

  const dao = peekDaos().find((d) => d.id === id)

  return [
    {
      label: dao?.title ?? id,
      tools: [
        { to: `/daos/${id}/proposals`, label: 'Proposals' },
        ...(dao && hasWorkerProposals(dao) ? [{ to: `/daos/${id}/worker`, label: 'Worker proposals' }] : []),
        { to: `/daos/${id}/council`, label: 'Council & candidates' },
      ],
    },
  ]
}
