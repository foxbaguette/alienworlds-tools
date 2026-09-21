import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface Series {
  key: string
  label: string
  /** A CSS colour, normally one of the --series-N tokens. */
  color: string
  values: number[]
}

/**
 * One value per day, as bars (one series) or lines (up to three). Lines can
 * be filled down to the axis, which reads as a quantity rather than a trend.
 *
 * Drawn in plain SVG at the pixel width it is given, so text stays crisp.
 * One y-axis, starting at zero. Hovering a day shows every series' value for
 * it; with two or more series a legend names them, so colour never carries
 * identity alone.
 */
export function DailyChart({
  dates,
  series,
  kind = 'bar',
  height = 220,
  format = (v: number) => Math.round(v).toLocaleString('en-US'),
  label,
  fill = false,
}: {
  dates: string[]
  series: Series[]
  kind?: 'bar' | 'line'
  height?: number
  format?: (v: number) => string
  label: string
  /** Shade under each line, fading towards the axis. Lines only. */
  fill?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  /* Gradient ids are document-wide; two charts on a page must not share one. */
  const uid = useId().replace(/:/g, '')

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const pad = { l: 52, r: 8, t: 10, b: 26 }
  const w = Math.max(0, width - pad.l - pad.r)
  const h = height - pad.t - pad.b
  const n = dates.length

  const { max, ticks } = useMemo(() => {
    let m = 0
    for (const s of series) for (const v of s.values) m = Math.max(m, v)
    return niceScale(m)
  }, [series])

  const slot = n ? w / n : 0
  const cx = (i: number) => pad.l + slot * (i + 0.5)
  const y = (v: number) => pad.t + h - (v / max) * h
  /* Enough date labels to orient, never so many they collide. */
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(w / 64))))

  const barW = Math.max(2, Math.min(28, slot - 4))

  return (
    <div className="dchart">
      {series.length > 1 && (
        <ul className="dchart__legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="dchart__swatch" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="dchart__plot" ref={box} style={{ height }}>
        {width > 0 && n > 0 && (
          <svg
            width={width}
            height={height}
            /* The same box it is drawn in, so a printed page — narrower than
               the screen, and laid out without a resize to redraw it — can
               scale the chart instead of cropping it. */
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={label}
            onPointerMove={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
              const i = Math.floor((e.clientX - r.left - pad.l) / slot)
              setHover(i >= 0 && i < n ? i : null)
            }}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((v) => (
              <g key={v}>
                <line className="dchart__grid" x1={pad.l} x2={pad.l + w} y1={y(v)} y2={y(v)} />
                <text className="dchart__tick" x={pad.l - 8} y={y(v) + 4} textAnchor="end">
                  {compact(v)}
                </text>
              </g>
            ))}
            {dates.map((d, i) =>
              i % every === 0 || i === n - 1 ? (
                <text key={d} className="dchart__tick" x={cx(i)} y={height - 7} textAnchor="middle">
                  {shortDate(d)}
                </text>
              ) : null,
            )}

            {hover !== null && (
              <rect className="dchart__hover" x={pad.l + slot * hover} y={pad.t} width={slot} height={h} />
            )}

            {kind === 'bar'
              ? series[0]?.values.map((v, i) =>
                  v > 0 ? (
                    <path key={i} d={bar(cx(i) - barW / 2, y(v), barW, pad.t + h - y(v))} fill={series[0].color} />
                  ) : null,
                )
              : series.map((s) => (
                  <g key={s.key}>
                    {fill && s.values.length > 0 && (
                      <>
                        <defs>
                          <linearGradient id={`dc-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={s.color} stopOpacity={0.3} />
                            <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <path
                          d={
                            s.values.map((v, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join('') +
                            `L${cx(s.values.length - 1).toFixed(1)},${pad.t + h}L${cx(0).toFixed(1)},${pad.t + h}Z`
                          }
                          fill={`url(#dc-${uid}-${s.key})`}
                        />
                      </>
                    )}
                    <path
                      d={s.values.map((v, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                    {hover !== null && (
                      <circle
                        cx={cx(hover)}
                        cy={y(s.values[hover] ?? 0)}
                        r={4}
                        fill={s.color}
                        stroke="var(--surface)"
                        strokeWidth={2}
                      />
                    )}
                  </g>
                ))}
          </svg>
        )}
        {hover !== null && width > 0 && (
          <div className="dchart__tip" style={{ left: Math.min(Math.max(cx(hover), 80), width - 80) }}>
            <strong>{longDate(dates[hover])}</strong>
            {series.map((s) => (
              <span key={s.key}>
                {series.length > 1 && <i style={{ background: s.color }} />}
                {series.length > 1 ? `${s.label}: ` : ''}
                <b>{format(s.values[hover] ?? 0)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** A bar with its top corners rounded and its foot square on the baseline. */
function bar(x: number, top: number, w: number, hgt: number): string {
  const r = Math.min(4, w / 2, hgt)
  return `M${x},${top + hgt}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + hgt}Z`
}

/**
 * A y-axis a person can read: about four steps of 1, 2 or 5 times a power of
 * ten, starting at zero, with the top just above the highest value.
 */
export function niceScale(v: number, steps = 4): { max: number; ticks: number[] } {
  if (v <= 0) return { max: 1, ticks: [0, 1] }
  const raw = v / steps
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p
  /* Counts never step by a fraction: a top of 2 reads 0, 1, 2 — not 0, 0.5, 1 … rounded to 0, 1, 1. */
  if (Number.isInteger(v) && step < 1) return niceScale(v, Math.max(1, Math.ceil(v)))
  const max = Math.ceil(v / step) * step
  const ticks: number[] = []
  for (let t = 0; t <= max + step / 2; t += step) ticks.push(t)
  return { max, ticks }
}

/** 1,234,567 → "1.2M", 23,400 → "23k". */
export function compact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${+(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return String(Math.round(v))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "3 Sep" — dates are UTC days, so they are formatted as such, not in local time. */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}

export function longDate(date: string): string {
  const day = new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
  return `${day} ${shortDate(date)}`
}
