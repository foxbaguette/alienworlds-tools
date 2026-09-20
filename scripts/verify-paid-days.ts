/** Pool page "paid out" vs players' tlm_earned, per day. */
import { readFileSync } from 'node:fs'
import { expandDays, leftPool, isGameContract, type PoolDailyFile } from '../src/poolstats/rules'
import type { DailyFile } from '../src/activity/rules'

const pools = JSON.parse(readFileSync('public/data/pools-daily.json', 'utf8')) as PoolDailyFile
const daily = JSON.parse(readFileSync('public/data/daily.json', 'utf8')) as DailyFile
for (const d of daily.days) {
  const earned = (d.stats.tlm_earned ?? 0) / 10_000
  const byPayer: Record<string, number> = {}
  for (const p of expandDays(pools.days.filter((x) => x.date === d.date))) {
    if (p.type !== 'tlm' || !leftPool(p) || isGameContract(p.player)) continue
    byPayer[p.payer] = (byPayer[p.payer] ?? 0) + p.amount
  }
  const page = Object.values(byPayer).reduce((n, v) => n + v, 0)
  console.log(
    `${d.date}  earned ${Math.round(earned).toLocaleString('en-US').padStart(8)}  page ${Math.round(page).toLocaleString('en-US').padStart(8)}  ${((page / Math.max(1, earned)) * 100).toFixed(1).padStart(6)}%  ` +
      Object.entries(byPayer).map(([k, v]) => `${k.replace('.ale', '')} ${Math.round(v)}`).join('  '),
  )
}
