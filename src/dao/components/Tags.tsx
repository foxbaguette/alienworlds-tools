import { isMissionControl } from '../chain/daos'

/**
 * Marks an account as Mission Control's.
 *
 * A tag rather than the colouring used elsewhere: on a list where everybody is
 * a candidate, "who is on which team" is the question being asked, and a shade
 * of blue does not answer it for anyone who has not been told what it means.
 */
export function McTag({ name }: { name: string }) {
  if (!isMissionControl(name)) return null
  return (
    <span
      className="tag tag--mc"
      title={
        /\.mc$/.test(name)
          ? 'A Mission Control account — the .mc suffix can only be created by Mission Control'
          : 'Flagged as part of the Mission Control team'
      }
    >
      Mission Control
    </span>
  )
}
