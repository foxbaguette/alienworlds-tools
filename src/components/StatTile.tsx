/**
 * One headline number: what it is, the figure, and what to compare it with.
 *
 * The change against the previous period carries an arrow and words as well
 * as colour, so it reads the same without the green and red.
 */
export function StatTile({
  label,
  value,
  sub,
  change,
  action,
}: {
  label: string
  value: string
  sub?: string
  /** Fractional change against the previous period, e.g. 0.12 for +12%. */
  change?: { ratio: number; against: string } | null
  /** Makes the tile a button that opens more detail, e.g. who was paid. */
  action?: { label: string; open: boolean; onClick: () => void }
}) {
  const up = change && change.ratio > 0.0005
  const down = change && change.ratio < -0.0005
  const Tag = action ? 'button' : 'div'
  return (
    <Tag
      className={`tile card${action ? ' tile--action' : ''}`}
      {...(action ? { type: 'button' as const, onClick: action.onClick, 'aria-expanded': action.open } : {})}
    >
      <span className="tile__label">{label}</span>
      <strong className="tile__value num">{value}</strong>
      {change && Number.isFinite(change.ratio) && (
        <span className={`tile__change${up ? ' is-up' : down ? ' is-down' : ''}`}>
          <span aria-hidden="true">{up ? '▲' : down ? '▼' : '■'}</span> {up ? '+' : ''}
          {(change.ratio * 100).toFixed(Math.abs(change.ratio) < 0.1 ? 1 : 0)}%{' '}
          <span className="tile__against">vs {change.against}</span>
        </span>
      )}
      {sub && <span className="tile__sub">{sub}</span>}
      {action && (
        <span className="tile__action">
          {action.open ? 'Hide' : action.label} <span aria-hidden="true">{action.open ? '▴' : '▾'}</span>
        </span>
      )}
    </Tag>
  )
}

/** Change from `before` to `now`, or null when there is nothing to compare. */
export function changeOf(now: number, before: number | undefined): number | null {
  if (before === undefined || before <= 0) return null
  return (now - before) / before
}
