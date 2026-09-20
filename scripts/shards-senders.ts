/**
 * Which contracts send shards, and how much of each is logged as shards_earned
 * in the same transaction. Finds shards that reach players without the stat.
 *
 *   npx vite build --ssr scripts/shards-senders.ts --outDir .ssr --logLevel error && node .ssr/shards-senders.js 2026-09-16
 */
import { historySliced, historyTime } from '../src/chain/history'
import { dayStart, DAY_MS, isGameContract } from '../src/activity/rules'

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

void (async () => {
  const date = process.argv[2] ?? '2026-09-16'
  const from = dayStart(date)
  const until = from + DAY_MS
  const [sends, stats] = await Promise.all([
    crawl<{ wallet: string; user: string; points: number | string }>({ account: 'shards.mc', filter: 'shards.mc:sendpoints' }, from, until),
    crawl<{ wallet: string; player: string; statname: string; statvalue: string }>(
      { account: 'players.ale', filter: 'players.ale:updpermstat' },
      from,
      until,
    ),
  ])
  const statTrx = new Set(stats.filter((s) => s.act.data.statname === 'shards_earned').map((s) => s.trx_id))

  const by: Record<string, { sent: number; count: number; unlogged: number; unloggedCount: number; sample?: string }> = {}
  for (const s of sends) {
    if (isGameContract(String(s.act.data.user))) continue
    const k = s.act.data.wallet
    const e = (by[k] ??= { sent: 0, count: 0, unlogged: 0, unloggedCount: 0 })
    const pts = Number(s.act.data.points) / 10
    e.sent += pts
    e.count++
    if (!statTrx.has(s.trx_id)) {
      e.unlogged += pts
      e.unloggedCount++
      e.sample ??= s.trx_id
    }
  }
  console.log(`${date}: shards sent by contract, and how much had no shards_earned in its transaction`)
  for (const [k, e] of Object.entries(by).sort((a, b) => b[1].sent - a[1].sent)) {
    console.log(
      `  ${k.padEnd(14)} sent ${Math.round(e.sent).toLocaleString('en-US').padStart(9)} in ${String(e.count).padStart(5)}` +
        `   unlogged ${Math.round(e.unlogged).toLocaleString('en-US').padStart(8)} in ${String(e.unloggedCount).padStart(4)}` +
        (e.sample ? `   e.g. ${e.sample.slice(0, 16)}` : ''),
    )
  }
})()
