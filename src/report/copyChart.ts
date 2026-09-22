/**
 * A chart, copied to the clipboard as a picture.
 *
 * The chart on the page is an SVG that takes its colours from stylesheets and
 * CSS variables, with its legend drawn beside it in HTML. Pulled out on its
 * own it would lose both, so every element's computed styling is written onto
 * its copy, the legend is redrawn into the picture, the page's background is
 * painted behind it and the chart's title sits on top — what is copied should
 * read on its own, in a chat or a slide.
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
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
]

const SCALE = 2
const TITLE_H = 26
const LEGEND_H = 22
const PAD = 12

const escape = (t: string) =>
  t.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)

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

/** The lines' names and colours, which the page draws beside the chart, not in it. */
function legendOf(panel: HTMLElement): { label: string; color: string }[] {
  return [...panel.querySelectorAll('.dchart__legend li')].map((li) => ({
    label: (li.textContent ?? '').trim(),
    color: getComputedStyle(li.querySelector('.dchart__swatch') ?? li).backgroundColor,
  }))
}

/** One row of swatches and names, where the page puts its legend. */
function legendMarkup(legend: { label: string; color: string }[], fg: string): string {
  let x = PAD
  return legend
    .map((l) => {
      const at = x
      x += 16 + l.label.length * 7 + 14
      return (
        `<rect x="${at}" y="${TITLE_H + 3}" width="10" height="10" rx="2" fill="${l.color}"/>` +
        `<text x="${at + 15}" y="${TITLE_H + 12}" style="font:500 11px system-ui,sans-serif;fill:${fg}">${escape(l.label)}</text>`
      )
    })
    .join('')
}

/** The finished picture: background, title, legend and the chart itself. */
async function render(panel: HTMLElement, title: string): Promise<Blob> {
  const svg = panel.querySelector('svg')
  if (!svg) throw new Error('the chart has not been drawn yet')
  const legend = legendOf(panel)
  const legendH = legend.length ? LEGEND_H : 0
  const w = svg.viewBox.baseVal.width || svg.clientWidth
  const h = svg.viewBox.baseVal.height || svg.clientHeight

  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineStyles(svg, clone)
  /* A hover readout belongs to the pointer, not to the picture. */
  clone.querySelectorAll('.dchart__hover').forEach((el) => el.remove())
  clone.removeAttribute('style')
  clone.setAttribute('x', String(PAD))
  clone.setAttribute('y', String(TITLE_H + legendH))
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))

  const page = getComputedStyle(document.body)
  const bg = page.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#ffffff' : page.backgroundColor
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim() || page.color
  const width = w + PAD * 2
  const height = h + TITLE_H + legendH + PAD

  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * SCALE}" height="${height * SCALE}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${bg}"/>` +
    `<text x="${PAD}" y="18" style="font:600 13px system-ui,sans-serif;fill:${fg}">${escape(title)}</text>` +
    legendMarkup(legend, fg) +
    new XMLSerializer().serializeToString(clone) +
    '</svg>'

  const url = URL.createObjectURL(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok()
      img.onerror = () => fail(new Error('the chart could not be drawn'))
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

export async function copyChart(panel: HTMLElement, title: string): Promise<CopyResult> {
  const blob = await render(panel, title)
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
