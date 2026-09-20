/**
 * Cross-check shards_earned for the last collected days against sources that
 * do not depend on the stat log.
 *
 *   A  daily.json            what the collector saved (players.ale stat log)
 *   A' stat log, re-read     the same log crawled again now
 *   B  shards.mc::sendpoints the shards actually sent to players
 *   C  rwrdlog addhistory    the payment records (type shrds)
 *
 *   npx vite build --ssr scripts/verify-shards.ts --outDir .ssr --logLevel error && node .ssr/verify-shards.js 7
 */
import { readFileSync } from 'node:fs'
import { historySliced, historyTime } from '../src/chain/history'
import { fetchStatChanges } from '../src/activity/queries'
import { dayStart, DAY_MS, isGameContract, type DailyFile } from '../src/activity/rules'

interface Act<D> {
  global_sequence: number
  '@timestamp': string
  trx_id: string
  act: { account: string; name: string; data: D }
}

function crawl<D>(params: Record<string, string>, from: number, until: number) {
  return historySliced<Act<D>>(
    '/v2/history/get_actions',
    params,
    from,
    until,
    (p) => ((p as { actions?: Act<D>[] }).actions ?? []),
    (a) => historyTime(a['@timestamp']),
    (a) => a.global_sequence,
  )
}

const n = (v: number) => Math.round(v).toLocaleString('en-US').padStart(10)
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(2) + '%' : '—').padStart(8)

void (async () => {
  const count = Number(process.argv[2]) || 7
  const file = JSON.parse(readFileSync('public/data/daily.json', 'utf8')) as DailyFile
  const days = file.days.slice(-count)

  console.log('date        A saved   A\' re-read  B sendpoints  C records   A/B      A/C')
  const tot = { a: 0, a2: 0, b: 0, c: 0 }
  const dupNotes: string[] = []

  for (const d of days) {
    const from = dayStart(d.date)
    const until = from + DAY_MS
    const a = (d.stats.shards_earned ?? 0) / 10

    const [changes, sends, records] = await Promise.all([
      fetchStatChanges(from, until),
      crawl<{ wallet: string; user: string; points: number | string }>(
        { account: 'shards.mc', filter: 'shards.mc:sendpoints' },
        from,
        until,
      ),
      crawl<{ wallet: string; player: string; type: string; reward: string }>(
        { account: 'rwrdlog.ale', filter: 'rwrdlog.ale:addhistory' },
        from,
        until,
      ),
    ])

    const a2 =
      changes.filter((c) => c.stat === 'shards_earned' && !isGameContract(c.player)).reduce((s, c) => s + c.value, 0) / 10

    const inDay = <T extends { '@timestamp': string }>(x: T) => {
      const t = historyTime(x['@timestamp'])
      return t >= from && t < until
    }
    const toPlayers = sends.filter((s) => inDay(s) && !isGameContract(String(s.act.data.user)))
    const b = toPlayers.reduce((s, x) => s + Number(x.act.data.points), 0) / 10

    const c =
      records
        .filter((r) => inDay(r) && r.act.data.type === 'shrds' && !isGameContract(String(r.act.data.player)))
        .reduce((s, r) => s + Number(String(r.act.data.reward).split(' ')[0]), 0)

    /* Identical sends in one transaction are the case the history servers can merge. */
    const perTrx = new Map<string, number>()
    for (const s of toPlayers) {
      const k = `${s.trx_id}|${s.act.data.user}|${s.act.data.points}`
      perTrx.set(k, (perTrx.get(k) ?? 0) + 1)
    }
    const dup = [...perTrx.values()].filter((v) => v > 1).length
    if (dup) dupNotes.push(`${d.date}: ${dup} identical sends shared a transaction`)

    tot.a += a
    tot.a2 += a2
    tot.b += b
    tot.c += c
    console.log(`${d.date} ${n(a)} ${n(a2)}   ${n(b)}   ${n(c)}  ${pct(a, b)} ${pct(a, c)}`)
  }
  console.log(`total      ${n(tot.a)} ${n(tot.a2)}   ${n(tot.b)}   ${n(tot.c)}  ${pct(tot.a, tot.b)} ${pct(tot.a, tot.c)}`)
  console.log(dupNotes.length ? dupNotes.join('\n') : 'No identical sends shared a transaction.')
})()
