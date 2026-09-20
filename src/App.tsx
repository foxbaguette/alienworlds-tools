import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Overview from './routes/Overview'
import PoolStats from './routes/PoolStats'
import ProjectOverview from './routes/ProjectOverview'
import Stats from './routes/Stats'
import { ThemeSwitch } from './components/ThemeSwitch'
import { SectionSwitcher } from './components/SectionSwitcher'
import { PROJECTS } from './projects/defs'
import { sectionFor } from './sections'
import { useDaoNav } from './dao/useDaoNav'
import Councils from './dao/routes/Councils'
import DaoDetails from './dao/routes/DaoDetails'
import AllProposals from './dao/routes/AllProposals'
import MsigGroups, { MsigGroupDetails } from './dao/routes/MsigGroups'
import './dao/dao.css'

/**
 * Alien Worlds Tools — the stats for Alien Legends and the projects around it,
 * and the tools for running the Alien Worlds DAOs, under one roof.
 *
 * Everything is read straight from the WAX chain and its history indexers.
 * There is no backend. The stats routes never sign anything; the DAO routes ask
 * for a wallet only when you act, and read fine without one.
 *
 * Two products, one site. They do NOT share a menu — see sections.ts — because
 * a single list mixing reward pools with council elections read as a pile of
 * unrelated reports. The sidebar switches instead.
 */
export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}

/**
 * Inside the router, because the sidebar has to know which section the current
 * route belongs to — including routes that have no menu entry of their own.
 */
function Shell() {
  const { pathname } = useLocation()
  const section = sectionFor(pathname)
  /* Called unconditionally and on every page: a hook cannot be reached for only
     when the route happens to be a DAO. It returns nothing off those routes. */
  const context = useDaoNav(pathname)
  const groups = [...section.groups, ...context]

  return (
    <div className="shell">
      <aside className="side">
        {/* The brand and the top-level switch are one control: it says which
            tool you are in, and opens the list of the others. */}
        <SectionSwitcher section={section} />

        <nav className="nav" aria-label={section.label}>
          {groups.map((g) => (
            <div key={g.label} className="nav__group">
              <span className="nav__label">{g.label}</span>
              {g.tools.map((t) => (
                <NavLink key={t.to} to={t.to}>
                  {t.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="side__foot">
          <ThemeSwitch />
          <span className="side__source">Read live from the WAX chain. Times in UTC.</span>
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/overview" element={<Overview />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/pools" element={<PoolStats />} />
          <Route path="/daos/syndicates" element={<Councils group="syndicate" />} />
          <Route path="/daos/unions" element={<Councils group="union" />} />
          <Route path="/daos/proposals" element={<AllProposals />} />
          <Route path="/daos/:id" element={<DaoDetails />} />
          <Route path="/daos/:id/:tab" element={<DaoDetails />} />
          <Route path="/msig" element={<MsigGroups />} />
          <Route path="/msig/:name" element={<MsigGroupDetails />} />
          {PROJECTS.map((p) => (
            <Route key={p.key} path={`/${p.key}`} element={<ProjectOverview key={p.key} projectKey={p.key} />} />
          ))}
          {/* An unknown path lands on the home of the section it belongs to,
              not on the site's. A mistyped /daos/... URL should leave you in
              the DAO Manager rather than throwing you into the stats. */}
          <Route path="*" element={<Navigate to={section.home} replace />} />
        </Routes>
      </main>
    </div>
  )
}
