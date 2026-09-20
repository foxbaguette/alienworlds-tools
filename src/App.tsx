import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import Overview from './routes/Overview'
import PoolStats from './routes/PoolStats'
import ProjectOverview from './routes/ProjectOverview'
import Stats from './routes/Stats'
import { ThemeSwitch } from './components/ThemeSwitch'
import { PROJECTS } from './projects/defs'
import Councils from './dao/routes/Councils'
import './dao/dao.css'

/**
 * Alien Worlds Tools — the stats for Alien Legends and the projects around it,
 * and the tools for running the Alien Worlds DAOs, under one menu.
 *
 * Everything is read straight from the WAX chain and its history indexers.
 * There is no backend. The stats routes never sign anything; the DAO routes ask
 * for a wallet only when you act, and read fine without one.
 *
 * One sidebar, one set of tokens, one router — the two halves were separate
 * sites and felt like it.
 */
const GROUPS = [
  {
    label: 'Alien Legends',
    tools: [
      { to: '/overview', label: 'Overview' },
      { to: '/stats', label: 'Stats' },
      { to: '/pools', label: 'Reward pools' },
    ],
  },
  {
    label: 'Alien Worlds DAOs',
    tools: [
      { to: '/daos/syndicates', label: 'Syndicates' },
      { to: '/daos/unions', label: 'Unions' },
    ],
  },
  ...PROJECTS.map((p) => ({ label: p.name, tools: [{ to: `/${p.key}`, label: 'Overview' }] })),
]

export function App() {
  return (
    <HashRouter>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              AW
            </span>
            <span className="brand__name">
              Alien Worlds
              <small>Tools</small>
            </span>
          </div>
          <nav className="nav" aria-label="Reports">
            {GROUPS.map((g) => (
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
            {PROJECTS.map((p) => (
              <Route key={p.key} path={`/${p.key}`} element={<ProjectOverview key={p.key} projectKey={p.key} />} />
            ))}
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
