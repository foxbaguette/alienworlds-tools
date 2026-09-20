/**
 * Who credits players' tlm_earned, per sending contract, for one day — to
 * see which routes TLM reaches players by.
 *
 *   npx vite build --ssr scripts/tlm-senders.ts --outDir .ssr --logLevel error && node .ssr/tlm-senders.js 2026-09-17
 */
import { readFileSync } from 'node:fs'
import { historySliced, historyTime } from '../src/chain/history'
import { dayStart, DAY_MS, isGameContract } from '../src/activity/rules'
import { expandDays, leftPool, type PoolDailyFile } from '../src/poolstats/rules'

interface Act<D> {
  global_sequence: number
  '@timestamp': string
  trx_id: string
  act: { account: string; name: string; data: D }
}

void (async () => {
  const date = process.argv[2] ?? '2026-09-17'
  const from = dayStart(date)
  const rows = await historySliced<Act<{ wallet: string; player: string; statname: string; statvalue: string }>>(
    '/v2/history/get_actions',
    { account: 'players.ale', filter: 'players.ale:updpermstat' },
    from,
    from + DAY_MS,
    (p) => ((p as { actions?: Act<{ wallet: string; player: string; statname: string; statvalue: string }>[] }).actions ?? []),
    (a) => historyTime(a['@timestamp']),
    (a) => a.global_sequence,
  )
  const by: Record<string, number> = {}
  for (const a of rows) {
    const d = a.act.data
    if (d.statname !== 'tlm_earned' || isGameContract(d.player)) continue
    by[d.wallet] = (by[d.wallet] ?? 0) + Number(d.statvalue) / 10_000
  }
  console.log(`${date}: tlm_earned credited, by sending contract`)
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${Math.round(v).toLocaleString('en-US').padStart(9)}`)

  const pools = JSON.parse(readFileSync('public/data/pools-daily.json', 'utf8')) as PoolDailyFile
  const day = pools.days.filter((d) => d.date === date)
  const page: Record<string, number> = {}
  for (const p of expandDays(day)) {
    if (p.type !== 'tlm' || !leftPool(p) || isGameContract(p.player)) continue
    page[p.payer] = (page[p.payer] ?? 0) + p.amount
  }
  console.log(`${date}: pool page paid out, by payer`)
  for (const [k, v] of Object.entries(page).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${Math.round(v).toLocaleString('en-US').padStart(9)}`)
})()
