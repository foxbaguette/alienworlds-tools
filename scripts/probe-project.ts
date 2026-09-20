/** Summarise one day of a project and print it — a quick check before collecting. */
import { fetchProjectDay } from '../src/projects/queries'
import { projectByKey } from '../src/projects/defs'

void (async () => {
  const def = projectByKey(process.argv[2] ?? 'pd')!
  const date = process.argv[3] ?? '2026-09-18'
  const t0 = Date.now()
  const day = await fetchProjectDay(def, date)
  console.log(`${def.name} ${date} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(JSON.stringify({ ...day, wallets: `${day.wallets.length} wallets` }, null, 1))
})()
