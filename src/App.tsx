import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Overview from './routes/Overview'
import PoolStats from './routes/PoolStats'
import ProjectOverview from './routes/ProjectOverview'
import Stats from './routes/Stats'
import { ThemeSwitch } from './components/ThemeSwitch'
import { SectionSwitcher } from './components/SectionSwitcher'
import { WalletButton } from './wallet/WalletButton'
import { PROJECTS } from './projects/defs'
import { sectionFor } from './sections'
import { useDaoNav } from './dao/useDaoNav'
import Councils from './dao/routes/Councils'
import DaoDetails from './dao/routes/DaoDetails'
import AllProposals from './dao/routes/AllProposals'
import MsigGroups, { MsigGroupDetails } from './dao/routes/MsigGroups'
import Competitions, { CompetitionDetails } from './comps/routes/Competitions'
import AleAdmin from './ale/routes/AleAdmin'
import { LiveFeedPage } from './ale/routes/LiveFeed'
import { WeatherAdmin } from './ale/routes/WeatherAdmin'
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
  /* The DAO menu is built from the directory rather than written out, so when
     it has something to say it REPLACES the section's static groups instead of
     being appended beside a second copy of them. sections.ts still declares
     those, because that is what decides which section owns a route. */
  const context = useDaoNav(pathname)
  const groups = context.length ? context : section.groups

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
                <div key={t.to} className="nav__item">
                  <NavLink to={t.to} end>
                    {t.label}
                    {t.badge ? <span className="nav__badge">{t.badge}</span> : null}
                  </NavLink>
                  {t.children?.length ? (
                    <div className="nav__children">
                      {t.children.map((c) => (
                        <NavLink key={c.to} to={c.to}>
                          {c.label}
                          {c.badge ? <span className="nav__badge">{c.badge}</span> : null}
                        </NavLink>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </nav>

        <div className="side__foot">
          <WalletButton />
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
          <Route path="/comps" element={<Competitions />} />
          <Route path="/comps/:id" element={<CompetitionDetails />} />
          <Route path="/ale" element={<AleAdmin />} />
          <Route path="/ale/live" element={<LiveFeedPage />} />
          <Route path="/ale/weather" element={<WeatherAdmin />} />
          <Route path="/ale/:contract" element={<AleAdmin />} />
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
