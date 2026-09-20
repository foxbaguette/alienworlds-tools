import { cached, getAllRows } from '@/chain/rpc'

/**
 * Wallet → in-game name, for every player.
 *
 * `players.ale/players` rows are heavy (about 14 KB each: mine NFTs, played
 * dungeons, battle NFTs), so they are trimmed to the name the moment they
 * arrive and only that is kept.
 */
export function fetchPlayerTags(): Promise<Record<string, string>> {
  return cached('playertags', 10 * 60_000, async () => {
    const rows = await getAllRows<{ wallet: string; playertag?: string }>({
      code: 'players.ale',
      scope: 'players.ale',
      table: 'players',
      limit: 200,
    })
    const tags: Record<string, string> = {}
    for (const r of rows) if (r.playertag) tags[String(r.wallet)] = String(r.playertag)
    return tags
  })
}
