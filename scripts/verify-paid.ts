/**
 * Does the pool page's "paid out to players" agree with what players were
 * credited? Compares the collected pool days (as the page reads them) with
 * the players' own earnings log, per currency and per player.
 *
 *   npx vite build --ssr scripts/verify-paid.ts --outDir .ssr --logLevel error && node .ssr/verify-paid.js
 */
import { readFileSync } from 'node:fs'
import { expandDays, leftPool, poolOf, HIDDEN_POOLS, isGameContract, type PoolDailyFile } from '../src/poolstats/rules'
import type { PlayersDailyFile } from '../src/activity/rules'

const pools = JSON.parse(readFileSync('public/data/pools-daily.json', 'utf8')) as PoolDailyFile
const players = JSON.parse(readFileSync('public/data/players-daily.json', 'utf8')) as PlayersDailyFile

for (const [type, stat, scale] of [['tlm', 'tlm_earned', 10_000], ['shards', 'shards_earned', 10]] as const) {
  const paid: Record<string, number> = {}
  for (const p of expandDays(pools.days)) {
    if (p.type !== type || !leftPool(p) || isGameContract(p.player) || HIDDEN_POOLS.has(poolOf(p))) continue
    paid[p.player] = (paid[p.player] ?? 0) + p.amount
  }
  const earned: Record<string, number> = {}
  for (const d of players.days) for (const [w, s] of Object.entries(d.players)) earned[w] = (earned[w] ?? 0) + (s[stat] ?? 0) / scale

  const sum = (o: Record<string, number>) => Object.values(o).reduce((n, v) => n + v, 0)
  const P = sum(paid)
  const E = sum(earned)
  const off = Object.keys({ ...paid, ...earned })
    .map((w) => ({ w, d: (paid[w] ?? 0) - (earned[w] ?? 0), e: earned[w] ?? 0 }))
    .filter((x) => Math.abs(x.d) > Math.max(1, x.e * 0.01))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  console.log(
    `${type.padEnd(6)} pool page ${Math.round(P).toLocaleString('en-US').padStart(10)}   earnings log ${Math.round(E).toLocaleString('en-US').padStart(10)}   ${((P / E) * 100).toFixed(2)}%   ${off.length} players off by >1%`,
  )
  for (const x of off.slice(0, 5)) console.log(`   ${x.w.padEnd(14)} ${x.d > 0 ? '+' : ''}${Math.round(x.d)}`)
}
