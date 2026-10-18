import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useHistoryConcurrency } from './chain/history'
import './styles/base.css'
import './styles/app.css'
import './styles/overview.css'
import './styles/poolstats.css'
import './styles/report.css'

/*
 * How many history reads the browser may have in the air at once.
 *
 * The pool hands each request to the next server in turn, so a burst does
 * spread — but it arrives as a burst all the same, and the activity feed
 * alone would fire six every eight seconds on top of whatever the page it is
 * on is doing. Three at a time is enough to keep the feed prompt and leaves
 * the servers something in reserve; without it the limit is no limit.
 *
 * The collector sets its own, far higher, through --inflight: it is one
 * process reading months and has the servers to itself.
 */
useHistoryConcurrency(3)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
