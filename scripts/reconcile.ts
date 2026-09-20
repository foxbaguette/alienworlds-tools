/**
 * Check the collected days against the chain: for every player, the lifetime
 * counter on their row should equal everything logged since launch plus
 * today so far. Prints the players whose figures still differ.
 *
 *   npx vite build --ssr scripts/reconcile.ts --outDir .ssr --logLevel error && node .ssr/reconcile.js tlm_earned
 */
import { readFileSync } from 'node:fs'
import { fetchStatChanges, fetchPlayers } from '../src/activity/queries'
import { dayStart, dayOf, isGameContract, statValue, type PlayersDailyFile } from '../src/activity/rules'

void (async () => {
  const stat = process.argv[2] ?? 'tlm_earned'
  const file = JSON.parse(readFileSync('public/data/players-daily.json', 'utf8')) as PlayersDailyFile
  const today = dayStart(dayOf(Date.now()))

  const [snap, changes] = await Promise.all([fetchPlayers(), fetchStatChanges(today, Date.now())])

  const logged: Record<string, number> = {}
  for (const d of file.days) for (const [w, s] of Object.entries(d.players)) logged[w] = (logged[w] ?? 0) + (s[stat] ?? 0)
  const todays: Record<string, number> = {}
  for (const c of changes) if (c.stat === stat && !isGameContract(c.player)) todays[c.player] = (todays[c.player] ?? 0) + c.value

  let life = 0
  let seen = 0
  const off: string[] = []
  for (const p of snap.players) {
    const l = statValue(p.stats ?? {}, stat)
    const g = statValue({ [stat]: (logged[p.wallet] ?? 0) + (todays[p.wallet] ?? 0) }, stat)
    life += l
    seen += g
    if (Math.abs(l - g) > Math.max(1, l * 0.001)) off.push(`${(p.tag ?? p.wallet).padEnd(16)} lifetime ${l.toFixed(0).padStart(9)}  logged+today ${g.toFixed(0).padStart(9)}  gap ${(l - g).toFixed(0)}`)
  }
  console.log(`${stat}: lifetime ${life.toFixed(0)}, logged since launch + today ${seen.toFixed(0)} (${((seen / life) * 100).toFixed(2)}%)`)
  console.log(`${off.length} of ${snap.players.length} players differ by more than 0.1%${off.length ? ':' : ''}`)
  for (const line of off.slice(0, 15)) console.log('  ' + line)
})()
