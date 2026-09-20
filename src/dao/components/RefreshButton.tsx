import { useState } from 'react'
import { clearProposalCaches } from '../useProposals'
import { refreshDaos } from '../useDaos'

/**
 * Re-read everything this side of the site holds.
 *
 * Not a page reload: the point is to go back to the chain without losing where
 * you are, or a connected wallet once there is one. Every DAO cache is dropped
 * and the directory is read again; the proposal caches rebuild themselves,
 * because the components that want them re-ask whenever the cache version
 * changes.
 *
 * Only the DAO side. The stats routes read files rather than tables and have
 * their own periods and controls, so a button here claiming to refresh those
 * too would be lying about half of what it does.
 */
export function RefreshButton({ label = 'Refresh all' }: { label?: string }) {
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      clearProposalCaches()
      await refreshDaos()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button className="btn" type="button" onClick={run} disabled={busy}>
      {busy ? 'Reading…' : label}
    </button>
  )
}
