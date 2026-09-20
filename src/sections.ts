import { PROJECTS } from './projects/defs'

/**
 * The site's top level.
 *
 * Two separate products live here — the Alien Legends stats and the Alien
 * Worlds DAO tools — and mixing their groups into one sidebar made the menu
 * read as a pile of unrelated reports. Instead the sidebar switches: pick a
 * section at the top, see only that section's groups below it.
 *
 * Adding a third is one entry in SECTIONS. Nothing else has to change: the
 * switcher, the ownership test and the fallback route all read from here.
 */
export interface NavItem {
  to: string
  label: string
}

export interface NavGroup {
  label: string
  tools: NavItem[]
}

export interface Section {
  key: string
  /** What the switcher calls it. */
  label: string
  /** One line under the brand, so a section says what it is for. */
  blurb: string
  /** Where switching to this section lands. */
  home: string
  /**
   * Route prefixes this section owns beyond the ones in its own nav — detail
   * pages, mostly, which have no menu entry of their own but still belong to a
   * section. `/daos/eyekeunn` is not in the menu and is plainly the DAO
   * section's.
   */
  owns?: string[]
  groups: NavGroup[]
}

export const SECTIONS: Section[] = [
  {
    key: 'stats',
    label: 'Stats',
    blurb: 'Alien Legends and the projects around it',
    home: '/overview',
    groups: [
      {
        label: 'Alien Legends',
        tools: [
          { to: '/overview', label: 'Overview' },
          { to: '/stats', label: 'Stats' },
          { to: '/pools', label: 'Reward pools' },
        ],
      },
      ...PROJECTS.map((p) => ({ label: p.name, tools: [{ to: `/${p.key}`, label: 'Overview' }] })),
    ],
  },
  {
    key: 'daos',
    label: 'DAO Manager',
    blurb: 'Councils, proposals and treasuries',
    home: '/daos/syndicates',
    owns: ['/daos'],
    groups: [
      {
        label: 'Councils',
        tools: [
          { to: '/daos/syndicates', label: 'Syndicates' },
          { to: '/daos/unions', label: 'Unions' },
        ],
      },
    ],
  },
]

const matches = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

/**
 * Which section a path belongs to.
 *
 * A section's own nav entries count automatically, so adding a route to a
 * section is enough to make that section own it — there is no second list to
 * keep in step. `owns` is only for the pages that never appear in a menu.
 */
export function sectionFor(path: string): Section {
  return (
    SECTIONS.find(
      (s) =>
        s.owns?.some((base) => matches(path, base)) ||
        s.groups.some((g) => g.tools.some((t) => matches(path, t.to))),
    ) ?? SECTIONS[0]
  )
}
