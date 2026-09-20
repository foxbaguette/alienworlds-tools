import { getRows } from './nodes'
import { TLM_CONTRACT, TLM_SYMBOL, assetAmount } from './stake'

/**
 * What one account holds, across Trilium and every planetary token.
 *
 * Two reads per account, not two per account per DAO: `accounts` is scoped by
 * the HOLDER, so one read of `token.worlds` comes back with every planetary
 * token that account has — all twelve, syndicate and union alike — and one read
 * of `alien.worlds` gives the Trilium.
 *
 * `balance` is the TOTAL held, staked included. That is the right figure here:
 * the question a candidate list answers is how much of a DAO's token stands
 * behind the person, and tokens they have staked are still theirs.
 */
export interface Holdings {
  account: string
  tlm: number
  /** Symbol code to amount — EYE, EYEUNN, KAV and so on. */
  tokens: Map<string, number>
}

const codeOf = (a: string) => String(a ?? '').split(' ')[1] ?? ''

async function one(account: string, tokenContracts: string[]): Promise<Holdings> {
  const [tlmRows, ...tokenRows] = await Promise.all([
    getRows<{ balance: string }>({ code: TLM_CONTRACT, scope: account, table: 'accounts', limit: 50 }).catch(
      () => [],
    ),
    ...tokenContracts.map((c) =>
      getRows<{ balance: string }>({ code: c, scope: account, table: 'accounts', limit: 100 }).catch(() => []),
    ),
  ])

  const tokens = new Map<string, number>()
  for (const rows of tokenRows) {
    for (const r of rows) {
      const code = codeOf(r.balance)
      if (code) tokens.set(code, assetAmount(r.balance))
    }
  }

  return {
    account,
    tlm: assetAmount(tlmRows.find((r) => codeOf(r.balance) === TLM_SYMBOL)?.balance ?? null),
    tokens,
  }
}

/**
 * Holdings for a list of accounts.
 *
 * Fired off together and left to the node pool to pace — it already limits
 * concurrency and spreads across endpoints, so a second limiter here would only
 * make it slower.
 */
export async function fetchHoldings(
  accounts: string[],
  tokenContracts: string[],
): Promise<Map<string, Holdings>> {
  const unique = [...new Set(accounts)].filter(Boolean)
  const contracts = [...new Set(tokenContracts)].filter(Boolean)
  const all = await Promise.all(unique.map((a) => one(a, contracts)))
  return new Map(all.map((h) => [h.account, h]))
}
