/**
 * The other projects this site reports on, beside Alien Legends.
 *
 * Each is described the same way — which accounts are the project, what its
 * players do there, and what it pays them — so one collector and one page
 * serve all of them. Only the overview is built for these; Alien Legends has
 * the deeper reports.
 */

export interface Metric {
  key: string
  label: string
  /** `contract::action` names that count towards it. */
  actions: string[]
}

export interface RewardCategory {
  key: string
  label: string
  /** Matched against a payout's memo. */
  memo: RegExp
}

export interface ProjectDef {
  key: string
  name: string
  /** One line under the title. */
  lead: string
  /** The project's own contracts — their actions are its activity. */
  contracts: string[]
  /** Accounts whose token transfers out to players are its rewards. */
  payers: string[]
  /**
   * Who counts as active on a day: those who signed one of the project's
   * actions, or — for a project players never sign anything on — those it
   * rewarded.
   */
  activeFrom: 'signers' | 'recipients'
  /** With activeFrom 'recipients': only rewards in these tokens make a wallet active. */
  activeSymbols?: string[]
  /** The headline activity figures, in order. */
  metrics: Metric[]
  /** Kinds of reward, told apart by memo, where the project labels them. */
  categories?: RewardCategory[]
  /**
   * Token transfers that are rewards, by memo. Without it every transfer to a
   * player counts; with it only these do — a project that also lends and
   * returns things, or pays its developers, would otherwise count those.
   * Shards are always rewards.
   */
  rewardMemos?: RegExp[]
  /**
   * Transfers players make to the project that fund its rewards — entry fees
   * into a prize pool. They are subtracted from what it paid out, which
   * would otherwise count the players' own tokens coming back as rewards.
   */
  entryMemos?: RegExp[]
  /**
   * What players pay in, for the report's "Incoming tokens": token transfers
   * to `account` whose memo matches, from a player's wallet. Funding from
   * planets, DAOs and the project's own accounts matches none of them.
   */
  incoming?: { account: string; key: string; label: string; memo: RegExp }[]
  /** Whether NFTs it sends are rewards (not loans or returns). */
  nftRewards?: boolean
  /** Actions signed on a player's behalf: `contract::action` → the data field naming the player. */
  actorFields?: Record<string, string>
  /** Under the Economy heading: what counts as paid out. */
  paidNote: string
  /** The date the collected history starts from. */
  since: string
}

/**
 * The earliest day every history indexer in use still has. Some keep less
 * than others, and one that has already dropped a day answers with nothing
 * rather than an error — so nothing earlier is collected.
 */
export const HISTORY_FLOOR = '2026-06-29'

export const PROJECTS: ProjectDef[] = [
  {
    key: 'mc',
    name: 'Mission Control',
    lead: 'The Mission Control smart contracts (*.mc) that power waxmissioncontrol.io.',
    contracts: [
      'members.mc',
      'game.mc',
      'adventure.mc',
      'emporium.mc',
      'tools.mc',
      'missions.mc',
      'voting.mc',
      'shards.mc',
      'cpu.mc',
      'notify.mc',
      'admin.mc',
    ],
    paidNote: 'Paid out is what reached players: weekly mission claims, tool loaning earnings and Shards. Tools lent or returned are left out.',
    payers: ['tools.mc', 'game.mc', 'adventure.mc', 'emporium.mc', 'missions.mc', 'members.mc', 'voting.mc', 'admin.mc'],
    activeFrom: 'signers',
    /*
       Checked against a day of its transfers: weekly mission claims and tool
       owners' loaning earnings are rewards; tools lent out or returned, NFTs
       returned from adventures, CPU powerup fees and developer payments are
       not.
    */
    rewardMemos: [/Week .* claimed/i, /Tool Loaning Earnings/i],
    nftRewards: false,
    /* A mine through Mission Control is logged by m.federation, naming the miner. */
    actorFields: { 'notify.mc::logmine': 'miner' },
    categories: [
      { key: 'weekly', label: 'Weekly mission claims', memo: /Week .* claimed/i },
      { key: 'loaning', label: 'Tool loaning earnings', memo: /Tool Loaning Earnings/i },
    ],
    metrics: [
      { key: 'mines', label: 'Mines through Mission Control', actions: ['notify.mc::logmine'] },
      { key: 'rent', label: 'Tools rented', actions: ['tools.mc::renttools'] },
      { key: 'adv-join', label: 'Adventures joined', actions: ['adventure.mc::joinadv'] },
      { key: 'adv-claim', label: 'Adventures claimed', actions: ['adventure.mc::claimadv'] },
      { key: 'build', label: 'Outpost upgrades', actions: ['game.mc::upgbuilding'] },
      { key: 'faucet', label: 'Faucet claims', actions: ['game.mc::faucet'] },
      { key: 'tasks', label: "Zapp's tasks finished", actions: ['emporium.mc::finishtask'] },
      { key: 'daily', label: 'Daily rewards claimed', actions: ['members.mc::dailyrewards'] },
      { key: 'votes', label: 'Votes cast', actions: ['voting.mc::castvote'] },
      { key: 'cpu', label: 'Transactions paid for (CPU)', actions: ['cpu.mc::paycpu'] },
    ],
    since: '2026-08-20',
  },
  {
    key: 'pd',
    name: 'Planetary Defense',
    lead: 'Planetary Defense on Magor (magordefense, and its missions at miss.pdef) — planetarydefense.io.',
    contracts: ['magordefense', 'miss.pdef'],
    payers: ['magordefense', 'miss.pdef'],
    paidNote:
      "Paid out is what players gained: defense, land, mission and PVP rewards and Shards, less the entry fees they paid to join missions.",
    activeFrom: 'signers',
    nftRewards: true,
    /*
       Checked against a month of its transfers: land payouts, defense, PVP and
       mission division rewards go to players. magordefense also funds
       miss.pdef and stakes its own CPU; neither is a reward.
    */
    rewardMemos: [/Land TLM payout/i, /Reward planetary defense/i, /PVP reward/i, /Mission division reward/i],
    /* Players pay TLM or DEF to join a mission (memo `entry:<mission>`); rewards come partly out of those. */
    entryMemos: [/^entry:/i],
    incoming: [
      { account: 'miss.pdef', key: 'missions', label: 'Mission entries', memo: /^entry:/i },
      { account: 'magordefense', key: 'forgebuy', label: 'Forge purchases', memo: /^Buy forge/i },
      { account: 'forge.pdef', key: 'forge', label: 'Forge upgrades', memo: /^forge:/i },
      { account: 'forge.pdef', key: 'shop', label: 'Forge shop', memo: /^shop:/i },
      { account: 'magordefense', key: 'land', label: 'Land fees', memo: /^land_id:/i },
      { account: 'magordefense', key: 'signup', label: 'Sign-up fees', memo: /^Fee inscription/i },
    ],
    categories: [
      { key: 'defense', label: 'Defense rewards', memo: /Reward planetary defense/i },
      { key: 'land', label: 'Land payouts', memo: /Land TLM payout/i },
      { key: 'missions', label: 'Mission division rewards', memo: /Mission division reward/i },
      { key: 'pvp', label: 'PVP rewards', memo: /PVP reward/i },
    ],
    metrics: [
      { key: 'mission-join', label: 'Missions joined', actions: ['miss.pdef::join'] },
      { key: 'mission-claim', label: 'Mission rewards claimed', actions: ['miss.pdef::claim'] },
      { key: 'attacks', label: 'Attacks sent', actions: ['magordefense::sendattack'] },
      { key: 'defense', label: 'Defense added', actions: ['magordefense::adddefense'] },
      { key: 'armies', label: 'Attack armies added', actions: ['magordefense::addattack'] },
      { key: 'requests', label: 'Support requests sent', actions: ['magordefense::sendreq'] },
      { key: 'answers', label: 'Requests answered', actions: ['magordefense::respondreq'] },
      { key: 'wins', label: 'Wins declared', actions: ['magordefense::declarewin'] },
      { key: 'distributed', label: 'Rewards distributed', actions: ['magordefense::distributere'] },
    ],
    since: HISTORY_FLOOR,
  },
  {
    key: 'naron',
    name: 'Naron Rewards',
    lead: 'Rewards paid by theminergame — NAR and NFTs for mining on Naron and Mission Control lands, its games and achievements.',
    contracts: ['theminergame'],
    payers: ['theminergame'],
    paidNote: 'Paid out is what reached players: mining rewards, the Number and Accumulator games, achievements, and Shards.',
    activeFrom: 'recipients',
    nftRewards: true,
    /*
       Every reward says what it is for. The account also moves TLM from its
       planet's DTAP on to another wallet, in round sums with no memo — that is
       not a reward.
    */
    rewardMemos: [/Mining Reward/i, /Number Game/i, /Accumulator Game/i, /Achievement/i],
    metrics: [],
    categories: [
      { key: 'mining', label: 'Mining rewards', memo: /Mining Reward/i },
      { key: 'number', label: 'Number Game wins', memo: /Number Game/i },
      { key: 'accumulator', label: 'Accumulator Game rounds', memo: /Accumulator Game/i },
      { key: 'achievement', label: 'Achievements', memo: /Achievement/i },
    ],
    since: HISTORY_FLOOR,
  },
  {
    key: 'arkhive',
    name: 'Arkhive',
    lead: 'The Arkhive.Lore adventures (arkhive.lore): players deposit TLM, pay for adventures from it, and are rewarded for completing them.',
    contracts: ['arkhive.lore'],
    payers: ['arkhive.lore'],
    paidNote: 'Paid out is the TLM and NFTs rewarded for completing adventures. Deposits players withdraw again are left out.',
    /* A player is someone rewarded in TLM for an adventure. */
    activeFrom: 'recipients',
    activeSymbols: ['TLM'],
    /*
       Checked against a day of its transfers: everything it sends a player is
       a reward ("Rewards for completing adventure …") or a withdrawal of
       their own deposit, which is not. Deposits are balances a player can
       take back, not fees, so they are not netted off the rewards.
    */
    rewardMemos: [/Rewards for completing adventure/i],
    /* Adventures also pay out NFTs, sent with the same memo as the TLM. */
    nftRewards: true,
    /* The contract signs payadventure itself, naming the player. */
    actorFields: { 'arkhive.lore::payadventure': 'account' },
    categories: [{ key: 'adventure', label: 'Adventure rewards', memo: /Rewards for completing adventure/i }],
    metrics: [
      { key: 'adventures', label: 'Adventures paid for', actions: ['arkhive.lore::payadventure'] },
      { key: 'withdraw', label: 'Withdrawals', actions: ['arkhive.lore::withdraw'] },
    ],
    /* The contract's first day: everything it has ever done is in its records. */
    since: '2026-07-14',
  },
  {
    key: 'th',
    name: 'Treasure Hunt',
    lead: 'The Treasure Hunt (planetaworld): treasures hidden on lands, their rewards shared among the players who find them.',
    contracts: ['planetaworld'],
    payers: ['planetaworld'],
    paidNote: 'Paid out is the TLM and Shards shared among each treasure hunt\u2019s winners.',
    /* Winners are named by the hunt's operators; players sign nothing here. */
    activeFrom: 'recipients',
    /*
       Checked against its distributions: each winner gets "Treasure reward:
       <hunt>" in TLM and the same hunt's Shards through ptpxy.worlds. Funds it
       is sent to hold rewards come in, and are not rewards.
    */
    rewardMemos: [/Treasure reward/i],
    categories: [{ key: 'treasure', label: 'Treasure rewards', memo: /Treasure reward/i }],
    metrics: [
      { key: 'hunts', label: 'Treasure hunts rewarded', actions: ['planetaworld::distributere'] },
    ],
    since: HISTORY_FLOOR,
  },
]

export function projectByKey(key: string): ProjectDef | undefined {
  return PROJECTS.find((p) => p.key === key)
}
