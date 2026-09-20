import { fetchPoolActivity } from '../src/poolstats/queries'
import { summarisePools, totalsOf } from '../src/poolstats/rules'

void (async () => {
const t0 = Date.now()
const since = Date.now() - 24 * 3_600_000
const pays = await fetchPoolActivity(since)
const land = pays.filter((p) => p.kind === 'landowner')
const traced = land.filter((p) => p.source)
console.log('rows', pays.length, 'in', Date.now() - t0, 'ms')
console.log('kinds', JSON.stringify(pays.reduce((m, p) => ((m[p.kind!] = (m[p.kind!] ?? 0) + 1), m), {} as Record<string, number>)))
for (const p of land.filter((x) => !x.source)) console.log('untraced', new Date(p.time).toISOString(), Math.round((Date.now() - p.time) / 1000) + 's ago', p.trx.slice(0, 10))
console.log('landowner traced', traced.length, 'of', land.length)
const src: Record<string, number> = {}
for (const p of traced) src[p.source!] = (src[p.source!] ?? 0) + p.amount
console.log('landowner by source', JSON.stringify(Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Math.round(v)]))))
const s = summarisePools(pays)
for (const x of s) console.log(x.pool.padEnd(14), 'out', Math.round(x.out).toString().padStart(8), JSON.stringify(Object.fromEntries(Object.entries(x.byKind).map(([k, v]) => [k, Math.round(v)]))), 'intoEscrow', Math.round(x.intoEscrow), 'players', x.players)
console.log('totals', JSON.stringify(totalsOf(s)))
})()
