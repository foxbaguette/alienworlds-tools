import { PROJECTS } from './projects/defs'

/** Projects with a monthly report of their own, at /<key>/ghubs. */
const REPORTS = new Set(['mc', 'pd', 'naron', 'arkhive'])

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
  /** Indented beneath this one. Built from chain data, not written out here. */
  children?: NavItem[]
  /**
   * How many things are waiting on the connected account here. Absent means
   * nothing is, NOT that nothing was checked — so a badge never has to be read
   * as "zero" and the menu stays quiet when there is nothing to say.
   */
  badge?: number
  /**
   * What the badge is made of, one line each, shown on hover. A number nobody
   * can account for is worse than no number: the council's own proposals can
   * all be settled while three worker proposals wait on a vote.
   */
  badgeWhy?: string[]
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
          { to: '/ghubs', label: 'gHubs report' },
        ],
      },
      /* Alien Worlds itself has no overview page — only its report. */
      { label: 'Alien Worlds', tools: [{ to: '/aw/ghubs', label: 'gHubs report' }] },
      ...PROJECTS.map((p) => ({
        label: p.name,
        tools: [
          { to: `/${p.key}`, label: 'Overview' },
          ...(REPORTS.has(p.key) ? [{ to: `/${p.key}/ghubs`, label: 'gHubs report' }] : []),
        ],
      })),
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
      {
        label: 'Across all councils',
        tools: [
          { to: '/daos/proposals', label: 'All proposals' },
          { to: '/daos/candidates', label: 'Candidates' },
          { to: '/daos/activity', label: 'Live activity' },
        ],
      },
    ],
  },
  {
    /*
     * The Alien Legends contracts' own settings. Not a DAO and not a game
     * either — this is the dials behind one, kept apart because everything on
     * it writes rather than reads.
     */
    key: 'ale',
    label: 'ALE Admin',
    blurb: 'Contract settings for Alien Legends',
    home: '/ale',
    owns: ['/ale'],
    groups: [
      {
        label: 'Contracts',
        tools: [
          { to: '/ale', label: 'All configs' },
          { to: '/ale/weather', label: 'Weather' },
          { to: '/ale/abilities', label: 'Abilities' },
        ],
      },
      {
        label: 'The game right now',
        tools: [
          { to: '/ale/live', label: 'Live activity' },
          { to: '/ale/buildings', label: 'Buildings' },
        ],
      },
      {
        label: 'Money and machines',
        tools: [
          { to: '/ale/collect', label: 'Income & payouts' },
          { to: '/ale/resources', label: 'Resources' },
        ],
      },
    ],
  },
  {
    /*
     * Games running prize competitions on comp.worlds. Nothing here belongs to
     * a DAO — the admin is whatever account runs the game — so it stands beside
     * them rather than inside.
     */
    key: 'comps',
    label: 'Competitions',
    blurb: 'Prize pools, players and standings',
    home: '/comps',
    owns: ['/comps'],
    groups: [
      {
        label: 'Competitions',
        tools: [{ to: '/comps', label: 'All competitions' }],
      },
    ],
  },
  {
    /*
     * Not a DAO tool. Point allocators are multisig accounts on ptpxy.worlds
     * handing out daily allowances — no elections, no councils, no proposals.
     * They sat under the DAO tabs because that is where they were first built,
     * not because they belong there.
     */
    key: 'msig',
    label: 'MSIG Groups',
    blurb: 'Point allocators and their budgets',
    home: '/msig',
    owns: ['/msig'],
    groups: [
      {
        label: 'Allocators',
        tools: [{ to: '/msig', label: 'All groups' }],
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
