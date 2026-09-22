/**
 * A chart, or a whole section, copied to the clipboard as a picture.
 *
 * What is on the page is an SVG that takes its colours from stylesheets and
 * CSS variables, with its title, figures and legend around it in HTML. Pulled
 * out on its own it would lose all of that, so every drawn element's computed
 * styling is written onto its copy and the words around it are redrawn into
 * the picture — what is copied should read on its own, in a chat or a slide.
 *
 * Clipboard images are PNGs, which is what every app that takes a paste
 * understands. Where the clipboard refuses images the picture is saved as a
 * file instead, so the click is never wasted.
 */

/* What a chart can be drawn with. Everything else is left to the defaults. */
const PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  /* A gradient's stops name their colour as a CSS variable, which means
     nothing once the chart is on its own: resolved here, or it comes out grey. */
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
]

const SCALE = 2
const PAD = 16
const GAP = 18
/* Quoted where a family name has a space: an unquoted one makes canvas ignore the whole string. */
const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif"

const esc = (t: string) => t.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)

/* Text is laid out by hand here, so its width is measured rather than guessed. */
const ruler = document.createElement('canvas').getContext('2d')
const widthOf = (s: string, font: string) => {
  if (!ruler) return s.length * 7
  ruler.font = font
  return ruler.measureText(s).width
}

/* The font shorthand must name a family, or the browser throws the whole rule away. */
const text = (x: number, y: number, s: string, weightSize: string, fill: string) =>
  s ? `<text x="${x}" y="${y}" style="font:${weightSize} ${FONT};fill:${fill}">${esc(s)}</text>` : ''

interface Ink {
  strong: string
  dim: string
  bg: string
}

function ink(): Ink {
  const page = getComputedStyle(document.body)
  const root = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback
  return {
    strong: pick('--text-1', page.color),
    dim: pick('--text-2', page.color),
    bg: page.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#ffffff' : page.backgroundColor,
  }
}

function inlineStyles(from: SVGSVGElement, to: SVGSVGElement) {
  const a = [from, ...from.querySelectorAll('*')]
  const b = [to, ...to.querySelectorAll('*')]
  a.forEach((el, i) => {
    const copy = b[i] as SVGElement | undefined
    if (!copy) return
    const computed = getComputedStyle(el)
    let css = ''
    for (const p of PROPS) {
      const v = computed.getPropertyValue(p)
      if (v && v !== 'none' && v !== 'normal') css += `${p}:${v};`
    }
    if (css) copy.setAttribute('style', css)
  })
}

interface Piece {
  markup: string
  width: number
  height: number
}

const LEGEND_H = 20
const HEAD_H = 18

/**
 * One chart panel — its heading, its legend and the graph itself — as markup
 * that can be dropped anywhere in a larger picture.
 */
function chartPiece(panel: HTMLElement, colour: Ink, x: number, y: number, withHeading: boolean): Piece {
  const svg = panel.querySelector('svg')
  if (!svg) throw new Error('the chart has not been drawn yet')
  const w = svg.viewBox.baseVal.width || svg.clientWidth
  const h = svg.viewBox.baseVal.height || svg.clientHeight

  const legend = [...panel.querySelectorAll('.dchart__legend li')].map((li) => ({
    label: (li.textContent ?? '').trim(),
    color: getComputedStyle(li.querySelector('.dchart__swatch') ?? li).backgroundColor,
  }))
  const heading = withHeading ? (panel.querySelector('.rpt__charttitle')?.textContent ?? '').trim() : ''
  const headH = heading ? HEAD_H : 0
  const legendH = legend.length ? LEGEND_H : 0

  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineStyles(svg, clone)
  /* A hover readout belongs to the pointer, not to the picture. */
  clone.querySelectorAll('.dchart__hover').forEach((el) => el.remove())
  clone.removeAttribute('style')
  clone.setAttribute('x', String(x))
  clone.setAttribute('y', String(y + headH + legendH))
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))

  let at = x
  const legendMarkup = legend
    .map((l) => {
      const left = at
      at += 15 + widthOf(l.label, `500 11px ${FONT}`) + 16
      return (
        `<rect x="${left}" y="${y + headH + 3}" width="10" height="10" rx="2" fill="${l.color}"/>` +
        text(left + 15, y + headH + 12, l.label, '500 11px', colour.dim)
      )
    })
    .join('')

  return {
    markup:
      text(x, y + 12, heading, '600 12px', colour.dim) +
      legendMarkup +
      new XMLSerializer().serializeToString(clone),
    width: w,
    height: h + headH + legendH,
  }
}

/** The figures across the top of a section: label, value, and its small print. */
function figuresPiece(block: HTMLElement, colour: Ink, x: number, y: number, width: number): Piece {
  const figures = [...block.querySelectorAll('.rpt__figure')]
  if (!figures.length) return { markup: '', width, height: 0 }
  const col = width / figures.length
  const markup = figures
    .map((f, i) => {
      const at = x + i * col
      const label = (f.querySelector('.tile__label')?.textContent ?? '').trim()
      const value = (f.querySelector('.tile__value')?.textContent ?? '').trim()
      const sub = (f.querySelector('.tile__sub')?.textContent ?? '').trim()
      return (
        text(at, y + 11, label, '500 11px', colour.dim) +
        text(at, y + 38, value, '700 24px', colour.strong) +
        text(at, y + 55, sub, '400 11px', colour.dim)
      )
    })
    .join('')
  return { markup, width, height: 62 }
}

/** An SVG document, drawn and handed back as a PNG. */
async function toPng(body: string, width: number, height: number, bg: string): Promise<Blob> {
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * SCALE}" height="${height * SCALE}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${bg}"/>${body}</svg>`
  const url = URL.createObjectURL(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok()
      img.onerror = () => fail(new Error('the picture could not be drawn'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width * SCALE
    canvas.height = height * SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error('the picture could not be made'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type CopyResult = 'copied' | 'saved'

async function handOver(blob: Blob, title: string): Promise<CopyResult> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('no clipboard')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return 'copied'
  } catch {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    return 'saved'
  }
}

/** One graph, titled. */
export async function copyChart(panel: HTMLElement, title: string): Promise<CopyResult> {
  const colour = ink()
  const piece = chartPiece(panel, colour, PAD, PAD + 20, false)
  const width = piece.width + PAD * 2
  const height = piece.height + PAD * 2 + 20
  const head = text(PAD, PAD + 13, title, '600 13px', colour.strong)
  return handOver(await toPng(head + piece.markup, width, height, colour.bg), title)
}

/**
 * A whole section: its heading, both figures and every graph side by side,
 * down to the line that says how it was measured — the section as it reads on
 * the page, in one picture.
 */
export async function copyBlock(block: HTMLElement, title: string): Promise<CopyResult> {
  const colour = ink()
  const panels = [...block.querySelectorAll<HTMLElement>('.rpt__chart')]
  if (!panels.length) throw new Error('nothing to copy')

  let y = PAD
  const head = text(PAD, y + 15, title, '700 17px', colour.strong)
  y += 30

  /* Laid out at the charts' own widths, as the page has them. */
  const widths = panels.map((p) => {
    const svg = p.querySelector('svg')
    return svg ? svg.viewBox.baseVal.width || svg.clientWidth : 0
  })
  const inner = widths.reduce((n, w) => n + w, 0) + GAP * (panels.length - 1)
  const width = inner + PAD * 2

  const figures = figuresPiece(block, colour, PAD, y, inner)
  y += figures.height ? figures.height + 14 : 0

  let x = PAD
  let tallest = 0
  const charts = panels
    .map((p, i) => {
      const piece = chartPiece(p, colour, x, y, true)
      x += widths[i] + GAP
      tallest = Math.max(tallest, piece.height)
      return piece.markup
    })
    .join('')
  y += tallest

  const how = (block.querySelector('.rpt__how')?.textContent ?? '').trim()
  if (how) y += 18
  const howMarkup = text(PAD, y - 4, how, '400 11px', colour.dim)

  return handOver(await toPng(head + figures.markup + charts + howMarkup, width, y + PAD, colour.bg), title)
}
