import { cached, getAllRows } from '@/chain/rpc'

/**
 * Wallet → in-game name, for every player.
 *
 * `players.ale/players` rows are heavy (about 14 KB each: mine NFTs, played
 * dungeons, battle NFTs), so they are trimmed to the name the moment they
 * arrive and only that is kept.
 */
export interface PlayerInfo {
  tag: string
  /** Where they are now, which is also where a travel just took them. */
  planet: string
}

/**
 * Wallet to name and current planet.
 *
 * The planet rides along free: this read already pulls every player row, and
 * `travel` gives only an x and a y — a grid position means nothing without
 * knowing which of the six 40x40 grids it is on.
 */
export function fetchPlayerInfo(): Promise<Record<string, PlayerInfo>> {
  return cached('playerinfo', 10 * 60_000, async () => {
    const rows = await getAllRows<{ wallet: string; playertag?: string; planet?: string }>({
      code: 'players.ale',
      scope: 'players.ale',
      table: 'players',
      limit: 200,
    })
    const out: Record<string, PlayerInfo> = {}
    for (const r of rows) {
      out[String(r.wallet)] = { tag: String(r.playertag ?? ''), planet: String(r.planet ?? '') }
    }
    return out
  })
}

export async function fetchPlayerTags(): Promise<Record<string, string>> {
  const info = await fetchPlayerInfo()
  const tags: Record<string, string> = {}
  for (const [wallet, p] of Object.entries(info)) if (p.tag) tags[wallet] = p.tag
  return tags
}
