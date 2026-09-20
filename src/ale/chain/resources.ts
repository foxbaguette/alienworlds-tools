import { call } from '../../dao/chain/nodes'

/**
 * What the Alien Legends accounts are running on.
 *
 * RAM is the one that bites: it is bought, not rented, and a contract that
 * fills its quota stops being able to write — no warning, just a failing
 * action. CPU and NET are staked and refill, so a high reading there is a busy
 * hour rather than a problem.
 *
 * The list is wider than ALE_CONTRACTS on purpose. Accounts like `cpu.ale`,
 * `ram.ale` and `collect.ale` hold no game settings, so they have nothing to
 * configure — but they are exactly the ones whose resources matter, because
 * they are what everyone else's transactions are billed to.
 */
export const RESOURCE_ACCOUNTS = [
  'admin.ale',
  'arena.ale',
  'ascend.ale',
  'battle.ale',
  'collect.ale',
  'cpu.ale',
  'creation.ale',
  'dungeons.ale',
  'farm.ale',
  'fighters.ale',
  'lands.ale',
  'market.ale',
  'nfts.ale',
  'players.ale',
  'pools.ale',
  'quests.ale',
  'ram.ale',
  'recovery.ale',
  'rewards.ale',
  'rwrdlog.ale',
  'shop.ale',
  'taskmngr.ale',
  'tavern.ale',
] as const

interface Limit {
  used: number
  available: number
  max: number
}

interface AccountReply {
  account_name: string
  ram_usage: number
  ram_quota: number
  cpu_limit: Limit
  net_limit: Limit
  cpu_weight: number | string
  net_weight: number | string
  core_liquid_balance?: string
}

export interface Resources {
  account: string
  ram: { used: number; quota: number; share: number }
  cpu: { used: number; max: number; share: number }
  net: { used: number; max: number; share: number }
  /** Staked WAX behind the CPU and NET limits, in WAX. */
  cpuStaked: number
  netStaked: number
  wax: number | null
  error?: string
}

const share = (used: number, of: number) => (of > 0 ? (used / of) * 100 : 0)

/** Stake weights come back as 8-decimal integers on WAX. */
const weight = (w: number | string) => Number(w) / 1e8

export async function fetchResources(account: string): Promise<Resources> {
  try {
    const a: AccountReply = await call({ account_name: account }, 'get_account')
    return {
      account,
      ram: { used: a.ram_usage, quota: a.ram_quota, share: share(a.ram_usage, a.ram_quota) },
      cpu: { used: a.cpu_limit.used, max: a.cpu_limit.max, share: share(a.cpu_limit.used, a.cpu_limit.max) },
      net: { used: a.net_limit.used, max: a.net_limit.max, share: share(a.net_limit.used, a.net_limit.max) },
      cpuStaked: weight(a.cpu_weight),
      netStaked: weight(a.net_weight),
      /* The field is simply absent on an account holding nothing, which is
         zero rather than unknown. Only a failed read gives null. */
      wax: a.core_liquid_balance ? Number(String(a.core_liquid_balance).split(' ')[0]) : 0,
    }
  } catch (err) {
    return {
      account,
      ram: { used: 0, quota: 0, share: 0 },
      cpu: { used: 0, max: 0, share: 0 },
      net: { used: 0, max: 0, share: 0 },
      cpuStaked: 0,
      netStaked: 0,
      wax: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export const fetchAllResources = () => Promise.all(RESOURCE_ACCOUNTS.map(fetchResources))

/**
 * When a reading is worth acting on.
 *
 * RAM is judged harder than CPU because running out of it is permanent until
 * someone buys more, while CPU refills every day by itself.
 */
export function tone(kind: 'ram' | 'cpu' | 'net', pct: number): 'ok' | 'warn' | 'bad' {
  const [warn, bad] = kind === 'ram' ? [75, 90] : [70, 90]
  if (pct >= bad) return 'bad'
  if (pct >= warn) return 'warn'
  return 'ok'
}

/** Bytes as people read them, which on these accounts means MB. */
export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`
  return `${n} B`
}

/** CPU limits are microseconds. */
export function fmtMicros(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} s`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} ms`
  return `${n} µs`
}
