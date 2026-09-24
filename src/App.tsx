import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Overview from './routes/Overview'
import Ghubs from './routes/Ghubs'
import McReport from './routes/McReport'
import ProjectReport from './routes/ProjectReport'
import AwReport from './routes/AwReport'
import PdPayouts from './routes/PdPayouts'
import PoolStats from './routes/PoolStats'
import ProjectOverview from './routes/ProjectOverview'
import Stats from './routes/Stats'
import { ThemeButton, ThemeSwitch } from './components/ThemeSwitch'
import { SectionSwitcher } from './components/SectionSwitcher'
import { WalletButton } from './wallet/WalletButton'
import { PROJECTS } from './projects/defs'
import { sectionFor } from './sections'
import { useDaoNav } from './dao/useDaoNav'
import Councils from './dao/routes/Councils'
import DaoDetails from './dao/routes/DaoDetails'
import AllProposals from './dao/routes/AllProposals'
import Candidates from './dao/routes/Candidates'
import DaoActivity from './dao/routes/Activity'
import MsigGroups, { MsigGroupDetails } from './dao/routes/MsigGroups'
import Competitions, { CompetitionDetails } from './comps/routes/Competitions'
import AleAdmin from './ale/routes/AleAdmin'
import { LiveFeedPage } from './ale/routes/LiveFeed'
import { WeatherAdmin } from './ale/routes/WeatherAdmin'
import { AbilityAdmin } from './ale/routes/AbilityAdmin'
import { Buildings } from './ale/routes/Buildings'
import { CollectStatus } from './ale/routes/Collect'
import { ResourceStatus } from './ale/routes/Resources'
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
 *
 * On a phone that sidebar becomes a drawer behind a top bar, which is the
 * shape every app of this kind has settled on. It was a scrolling strip of
 * links across the top, and the strip could not show the two levels this menu
 * has — a section, and the councils inside it — so it flattened them into one
 * row of twenty things.
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
  const [navOpen, setNavOpen] = useState(false)

  /* Going somewhere is the end of using the menu. Without this the drawer sits
     over the page you just asked for. */
  useEffect(() => setNavOpen(false), [pathname])

  /* The page behind a drawer must not scroll under it. */
  useEffect(() => {
    if (!navOpen) return
    const held = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = held
    }
  }, [navOpen])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])
  /* Called unconditionally and on every page: a hook cannot be reached for only
     when the route happens to be a DAO. It returns nothing off those routes. */
  /* The DAO menu is built from the directory rather than written out, so when
     it has something to say it REPLACES the section's static groups instead of
     being appended beside a second copy of them. sections.ts still declares
     those, because that is what decides which section owns a route. */
  const context = useDaoNav(pathname)
  const groups = context.length ? context : section.groups

  return (
    <div className={`shell${navOpen ? ' is-navopen' : ''}`}>
      {/* Phones only — see app.css. The sidebar is off screen there, so this
          carries the one thing you always need (where am I, and how do I get
          out) plus the two controls that were eating a third of the screen. */}
      <header className="topbar">
        <button
          className="icon-btn topbar__menu"
          type="button"
          aria-label="Menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
        <span className="topbar__title">{section.label}</span>
        <div className="topbar__tools">
          <WalletButton compact />
          <ThemeButton />
        </div>
      </header>

      {/* Tapping away from an open drawer closes it, which is the gesture
          everybody tries first. */}
      <button
        className="scrim"
        type="button"
        tabIndex={navOpen ? 0 : -1}
        aria-label="Close menu"
        onClick={() => setNavOpen(false)}
      />

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
                    {t.badge ? (
                      <span className="nav__badge" title={t.badgeWhy?.join('\n')}>
                        {t.badge}
                      </span>
                    ) : null}
                  </NavLink>
                  {t.children?.length ? (
                    <div className="nav__children">
                      {t.children.map((c) => (
                        <NavLink key={c.to} to={c.to}>
                          {c.label}
                          {c.badge ? (
                            <span className="nav__badge" title={c.badgeWhy?.join('\n')}>
                              {c.badge}
                            </span>
                          ) : null}
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
          <Route path="/ghubs" element={<Ghubs />} />
          <Route path="/mc/ghubs" element={<McReport />} />
          <Route path="/pd/ghubs" element={<ProjectReport key="pd" projectKey="pd" />} />
          <Route path="/naron/ghubs" element={<ProjectReport key="naron" projectKey="naron" />} />
          <Route path="/arkhive/ghubs" element={<ProjectReport key="arkhive" projectKey="arkhive" />} />
          <Route path="/th/ghubs" element={<ProjectReport key="th" projectKey="th" />} />
          <Route path="/pd/payouts" element={<PdPayouts />} />
          <Route path="/aw" element={<Navigate to="/aw/ghubs" replace />} />
          <Route path="/aw/ghubs" element={<AwReport />} />
          <Route path="/daos/syndicates" element={<Councils group="syndicate" />} />
          <Route path="/daos/unions" element={<Councils group="union" />} />
          <Route path="/daos/proposals" element={<AllProposals />} />
          <Route path="/daos/candidates" element={<Candidates />} />
          <Route path="/daos/activity" element={<DaoActivity />} />
          <Route path="/daos/:id" element={<DaoDetails />} />
          <Route path="/daos/:id/:tab" element={<DaoDetails />} />
          <Route path="/msig" element={<MsigGroups />} />
          <Route path="/msig/:name" element={<MsigGroupDetails />} />
          <Route path="/comps" element={<Competitions />} />
          <Route path="/comps/:id" element={<CompetitionDetails />} />
          <Route path="/ale" element={<AleAdmin />} />
          <Route path="/ale/live" element={<LiveFeedPage />} />
          <Route path="/ale/weather" element={<WeatherAdmin />} />
          <Route path="/ale/abilities" element={<AbilityAdmin />} />
          <Route path="/ale/buildings" element={<Buildings />} />
          <Route path="/ale/collect" element={<CollectStatus />} />
          <Route path="/ale/resources" element={<ResourceStatus />} />
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
