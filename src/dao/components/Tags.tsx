import { isMissionControl } from '../chain/daos'

/**
 * Marks an account as belonging to the Mission Control team.
 *
 * A tag rather than the colouring used elsewhere: on a list where everybody is
 * a candidate, "who is on which team" is the question being asked, and a shade
 * of blue does not answer it for anyone who has not been told what it means.
 *
 * The team, not the product — see isMissionControl. The `.mc` accounts are
 * Mission Control's beyond doubt and are still NOT tagged.
 */
export function McTag({ name }: { name: string }) {
  if (!isMissionControl(name)) return null
  return (
    <span className="tag tag--mc" title="Flagged as part of the Mission Control team">
      Mission Control
    </span>
  )
}
