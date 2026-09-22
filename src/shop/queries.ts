import { historySliced, historyTime } from '@/chain/history'
import { cached } from '@/chain/rpc'

/**
 * `shop.ale` — what players buy in the Alien Legends shop.
 *
 * A purchase is a WAX transfer to shop.ale with the memo
 * `purchase,<item>` (gem.small, gem.medium, gem.large, gem.giant).
 */
export const SHOP = 'shop.ale'

interface Transfer {
  global_sequence: number
  '@timestamp': string
  act: { account: string; data: { from?: string; to?: string; amount?: number; symbol?: string; quantity?: string; memo?: string } }
}

export interface ShopDay {
  date: string
  /** Token symbol → amount players spent. */
  spent: Record<string, number>
  purchases: number
  /** Wallets that bought something. */
  buyers: string[]
  /** Item → purchases and WAX. */
  items: Record<string, { count: number; amount: number }>
}

export interface ShopDailyFile {
  generatedAt: string
  days: ShopDay[]
}

export async function fetchShopDay(date: string): Promise<ShopDay> {
  const from = Date.parse(date + 'T00:00:00Z')
  const until = from + 86_400_000
  const rows = await historySliced<Transfer>(
    '/v2/history/get_actions',
    { account: SHOP, filter: 'eosio.token:transfer,alien.worlds:transfer', 'transfer.to': SHOP },
    from,
    until,
    (p) => (p as { actions?: Transfer[] }).actions ?? [],
    (a) => historyTime(a['@timestamp']),
    (a) => a.global_sequence,
    2,
    undefined,
    true,
  )
  const day: ShopDay = { date, spent: {}, purchases: 0, buyers: [], items: {} }
  const buyers = new Set<string>()
  const seen = new Set<number>()
  for (const a of rows) {
    const t = historyTime(a['@timestamp'])
    const d = a.act.data
    if (t < from || t >= until || seen.has(a.global_sequence) || d.to !== SHOP) continue
    const m = /^purchase,(.+)$/i.exec(String(d.memo ?? ''))
    if (!m || !d.from) continue
    seen.add(a.global_sequence)
    const symbol = d.symbol ?? String(d.quantity ?? '').split(' ')[1] ?? '?'
    const amount = Number(d.amount ?? String(d.quantity ?? '0').split(' ')[0]) || 0
    day.spent[symbol] = Math.round(((day.spent[symbol] ?? 0) + amount) * 10_000) / 10_000
    day.purchases++
    buyers.add(d.from)
    const e = (day.items[m[1]] ??= { count: 0, amount: 0 })
    e.count++
    e.amount = Math.round((e.amount + amount) * 10_000) / 10_000
  }
  day.buyers = [...buyers].sort()
  return day
}

export function fetchShopDaily(): Promise<ShopDailyFile> {
  return cached('shopdaily', 5 * 60_000, async () => {
    try {
      const res = await fetch('data/shop-daily.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as ShopDailyFile
    } catch {
      return { generatedAt: '', days: [] }
    }
  })
}
