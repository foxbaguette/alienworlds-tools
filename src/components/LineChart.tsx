import { useEffect, useMemo, useRef, useState } from 'react'
import { niceScale, shortDate } from './DailyChart'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Time ticks on round UTC boundaries — midnights for a week, every six hours
 * for a day — thinned to at most `most`, so labels sit where the calendar
 * says they should rather than at arbitrary fractions of the window.
 */
export function timeTicks(from: number, to: number, unit: number, most: number): number[] {
  const first = Math.ceil(from / unit) * unit
  const all: number[] = []
  for (let t = first; t <= to; t += unit) all.push(t)
  const every = Math.max(1, Math.ceil(all.length / most))
  return all.filter((_, i) => i % every === 0)
}

/** "06:00" in UTC. */
function utcClock(t: number): string {
  return new Date(t).toISOString().slice(11, 16)
}

export interface ChartPoint {
  t: number
  v: number
}

/**
 * A line over time, in plain SVG.
 *
 * Drawn at the pixel width it is given rather than scaled from a viewBox, so
 * text and strokes stay crisp at any size. Two uses: a bare sparkline on a
 * card, and a full chart with axes and a hover readout.
 *
 * Between two points the line is straight. For a pool that is close to the
 * truth — a fill rate adds to it steadily, and a mine takes a step out — so
 * joining the recorded writes is a fair picture of what it held in between.
 */
export function LineChart({
  points,
  from,
  to,
  height = 220,
  spark = false,
  format = (v: number) => v.toLocaleString(),
  unit = '',
  color = 'var(--series-1)',
  label,
  name,
  extra,
}: {
  points: ChartPoint[]
  from: number
  to: number
  height?: number
  spark?: boolean
  format?: (v: number) => string
  unit?: string
  color?: string
  label: string
  /** What the main line is, for the legend — only needed with `extra`. */
  name?: string
  /**
   * A second series on the same axis: a dashed line with no fill, so it reads
   * as context for the main one rather than as its equal.
   */
  extra?: { points: ChartPoint[]; color: string; name: string }
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const pad = spark ? { l: 0, r: 0, t: 4, b: 2 } : { l: 64, r: 14, t: 12, b: 26 }
  const w = Math.max(0, width - pad.l - pad.r)
  const h = height - pad.t - pad.b

  const { max, min } = useMemo(() => {
    if (points.length === 0) return { max: 1, min: 0 }
    let hi = -Infinity
    let lo = Infinity
    for (const p of [...points, ...(extra?.points ?? [])]) {
      hi = Math.max(hi, p.v)
      lo = Math.min(lo, p.v)
    }
    /* From zero, so a pool that barely moved does not look like it swung. */
    lo = spark ? lo * 0.9 : 0
    if (hi === lo) hi = lo + 1
    /* The full chart steps its axis the way the overview's charts do. */
    return spark ? { max: hi * 1.06, min: lo } : { max: niceScale(hi).max, min: 0 }
  }, [points, extra, spark])

  const x = (t: number) => pad.l + ((t - from) / Math.max(1, to - from)) * w
  const y = (v: number) => pad.t + h - ((v - min) / (max - min)) * h

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const last = points[points.length - 1]
  const area = points.length
    ? `${line}L${x(last.t).toFixed(1)},${pad.t + h}L${x(points[0].t).toFixed(1)},${pad.t + h}Z`
    : ''

  const yTicks = spark ? [] : niceScale(max).ticks
  const span = to - from
  const long = span > 2 * DAY
  const xTicks = spark ? [] : timeTicks(from, to, long ? DAY : 6 * HOUR, Math.max(2, Math.floor(w / 90)))
  const timeLabel = (t: number) => (long ? shortDate(new Date(t).toISOString().slice(0, 10)) : utcClock(t))

  /* The point under the pointer, by time. */
  const hovered = hover === null ? null : nearest(points, hover)
  const hoveredExtra = hover === null || !extra ? null : nearest(extra.points, hover)
  const extraLine = (extra?.points ?? [])
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join('')

  const gid = `lc-${label.replace(/\W/g, '')}`

  return (
    <>
      <div className="lchart" ref={box} style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={label}
            onPointerMove={(e) => {
              if (spark) return
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
              const px = e.clientX - r.left
              if (px < pad.l || px > pad.l + w) return setHover(null)
              setHover(from + ((px - pad.l) / w) * span)
            }}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>

            {yTicks.map((v) => (
              <g key={v}>
                <line className="lchart__grid" x1={pad.l} x2={pad.l + w} y1={y(v)} y2={y(v)} />
                <text className="lchart__tick" x={pad.l - 8} y={y(v) + 4} textAnchor="end">
                  {compact(v)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text
                key={t}
                className="lchart__tick"
                /* Centred on its moment, but never hanging off either edge. */
                x={Math.min(Math.max(x(t), pad.l + 22), pad.l + w - 22)}
                y={height - 6}
                textAnchor="middle"
              >
                {timeLabel(t)}
              </text>
            ))}

            {points.length > 0 && (
              <>
                <path d={area} fill={`url(#${gid})`} />
                <path d={line} fill="none" stroke={color} strokeWidth={spark ? 1.5 : 2} strokeLinejoin="round" />
              </>
            )}
            {extra && extra.points.length > 0 && (
              <path
                d={extraLine}
                fill="none"
                stroke={extra.color}
                strokeWidth={spark ? 1.25 : 2}
                strokeDasharray={spark ? '3 3' : '6 4'}
                strokeLinejoin="round"
              />
            )}

            {hovered && (
              <g>
                <line className="lchart__cross" x1={x(hovered.t)} x2={x(hovered.t)} y1={pad.t} y2={pad.t + h} />
                <circle cx={x(hovered.t)} cy={y(hovered.v)} r={4} fill={color} stroke="#000" strokeWidth={1.5} />
                {hoveredExtra && (
                  <circle cx={x(hoveredExtra.t)} cy={y(hoveredExtra.v)} r={4} fill={extra!.color} stroke="#000" strokeWidth={1.5} />
                )}
              </g>
            )}
          </svg>
        )}
        {hovered && (
          <div
            className="lchart__tip"
            style={{ left: Math.min(Math.max(x(hovered.t), 90), width - 90), top: 4 }}
          >
            <strong>
              {extra && name ? `${name} ` : ''}
              {format(hovered.v)} {unit}
            </strong>
            {hoveredExtra && extra ? (
              <strong className="lchart__tip2">
                {extra.name} {format(hoveredExtra.v)} {unit}
              </strong>
            ) : null}
            <span>
              {shortDate(new Date(hovered.t).toISOString().slice(0, 10))}, {utcClock(hovered.t)} UTC
            </span>
          </div>
        )}
      </div>
      {extra && !spark ? (
        <div className="lchart__legend">
          <span>
            <i style={{ background: color }} /> {name ?? label}
          </span>
          <span>
            <i className="is-dashed" style={{ borderColor: extra.color }} /> {extra.name}
          </span>
        </div>
      ) : null}
    </>
  )
}

function nearest(points: ChartPoint[], t: number): ChartPoint | null {
  if (points.length === 0) return null
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < t) lo = mid
    else hi = mid
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? points[lo] : points[hi]
}

/** 1,234,567 → "1.2M", 23,400 → "23.4k". */
export function compact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return String(Math.round(v))
}

/** Bars, one per bucket — the hourly payouts under a pool's chart. */
export function BarStrip({
  values,
  height = 56,
  color = 'var(--series-1)',
  label,
}: {
  values: number[]
  height?: number
  color?: string
  label: string
}) {
  const max = Math.max(1, ...values)
  return (
    <div className="barstrip" style={{ height }} role="img" aria-label={label}>
      {values.map((v, i) => (
        <span
          key={i}
          className="barstrip__bar"
          style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%`, background: color }}
        />
      ))}
    </div>
  )
}
