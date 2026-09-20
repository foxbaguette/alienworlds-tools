/**
 * What each lifetime stat is called, and where it belongs.
 *
 * The contract names them in snake_case and adds new ones as features ship,
 * so anything not listed here still shows — under "Other", with its key
 * turned into words — rather than going missing.
 */

export interface StatInfo {
  label: string
  group: StatGroup
  /** What one unit is, where it isn't just a count. */
  unit?: string
}

export const STAT_GROUPS = ['Play', 'Fighters', 'Combat', 'Earnings', 'Spending', 'Building', 'Other'] as const
export type StatGroup = (typeof STAT_GROUPS)[number]

const INFO: Record<string, StatInfo> = {
  dungeons_played: { label: 'Dungeons played', group: 'Play' },
  dungeons_won: { label: 'Dungeons won', group: 'Play' },
  total_dungeon_difficulty: { label: 'Dungeon difficulty, total', group: 'Play' },
  dungeon_leaderboard_claims: { label: 'Dungeon leaderboard claims', group: 'Play' },
  arenas_played: { label: 'Arena fights', group: 'Play' },
  arenas_won: { label: 'Arena fights won', group: 'Play' },
  quests_completed: { label: 'Quests completed', group: 'Play' },
  quests_rerolled: { label: 'Quests rerolled', group: 'Play' },
  portals_used: { label: 'Portals used', group: 'Play' },
  total_travel_distance: { label: 'Distance travelled', group: 'Play', unit: 'tiles' },

  recruits: { label: 'Fighters recruited', group: 'Fighters' },
  level_ups: { label: 'Level-ups', group: 'Fighters' },
  ascensions_completed: { label: 'Ascensions', group: 'Fighters' },
  fighters_sold: { label: 'Fighters sold', group: 'Fighters' },
  energy_saved_recruiting: { label: 'Energy saved recruiting', group: 'Fighters', unit: 'energy' },

  damage_dealt: { label: 'Damage dealt', group: 'Combat' },
  damage_taken: { label: 'Damage taken', group: 'Combat' },
  damage_blocked: { label: 'Damage blocked', group: 'Combat' },
  damage_blocked_by_enemy: { label: 'Damage blocked by enemies', group: 'Combat' },
  knockouts: { label: 'Knockouts', group: 'Combat' },

  tlm_earned: { label: 'TLM earned', group: 'Earnings', unit: 'TLM' },
  shards_earned: { label: 'Shards earned', group: 'Earnings', unit: 'Shards' },
  wax_earned: { label: 'WAX earned', group: 'Earnings', unit: 'WAX' },
  credits_gained: { label: 'Credits gained', group: 'Earnings', unit: 'credits' },
  gems_gained: { label: 'Gems gained', group: 'Earnings', unit: 'gems' },
  energy_gained: { label: 'Energy gained', group: 'Earnings', unit: 'energy' },
  alf_credits_claimed: { label: 'Farming credits claimed', group: 'Earnings', unit: 'credits' },
  market_earned: { label: 'Market sales', group: 'Earnings', unit: 'gems' },

  market_spent: { label: 'Market purchases', group: 'Spending', unit: 'gems' },
  gems_in_candle: { label: 'Gems put into the Candle', group: 'Spending', unit: 'gems' },
  boosting_applied: { label: 'Building boost applied', group: 'Spending' },
  premium_account_months: { label: 'Legend months bought', group: 'Spending', unit: 'months' },

  buildings_constructed: { label: 'Buildings built', group: 'Building' },
  dungeons_constructed: { label: 'Dungeons built', group: 'Building' },
  arenas_constructed: { label: 'Arenas built', group: 'Building' },
  taverns_constructed: { label: 'Taverns built', group: 'Building' },
  nfts_staked: { label: 'NFTs staked', group: 'Building' },
}

export function statInfo(key: string): StatInfo {
  return (
    INFO[key] ?? {
      label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      group: 'Other',
    }
  )
}
