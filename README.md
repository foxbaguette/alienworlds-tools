# ALE Stats

Data analysis for [Alien Legends](https://alienlegends.io) and the projects around it, read straight from the WAX chain and its public history indexers. There's no backend and no wallet: everything runs in the browser and only ever reads.

## Tools

### Overview (`#/overview`)

Players and activity per UTC day, for the last 7 or 14 days or since launch (31 Aug 2026), each compared with the period before:

- **Players:** total players; Legend accounts running; players active in the period; average and peak daily active; new signups per day.
- **Activity:** dungeons played and won, arena fights, fighters recruited, quests completed.
- **Economy:** TLM and Shards paid out per day; WAX spent in the shop per day, with a breakdown by pack.
- **By day:** every figure in one table.

A player counts as **active** on a day if they changed a lifetime stat themselves that day. Being credited TLM or Shards as a landowner doesn't count. **Paid out** is what players were credited. The game's own contracts (`*.ale`) are left out: money passes through some of them, such as `arena.ale` and `recovery.ale`, on its way to players, and counting those hops would count it twice.

### Pool payouts (`#/pools`)

What left every reward pool in the last 24 hours, how, and to whom.

- **Each payment has a kind:** player mines, landowner cuts, quest escrow, or a payment by another contract (e.g. Candle payouts from `recovery.ale`).
- **Landowner cuts are credited to the pool they were really drawn from.** The payout record calls them `tlmlndowner`/`shrdlndowner`, but the money leaves the tavern, dungeon or arena pool of the building that was used. The `claimbreward` in the same transaction names that pool, and the `lands.ale::addbldrwrd` credit ties each payment to its land.
- **Only what reached a player counts as paid out.** Quest rewards count when players claim them from `quests.ale`; what `qpremine` moved into escrow is shown alongside. Landowner TLM counts when the land's rewards are claimed from `lands.ale`, and arena leaderboard rewards when they are claimed from `players.ale`.
- **Each pool has its own page:** a balance chart over 24 hours or 7 days (every recorded change to the pool row), outflow per hour, the players who received it with their share, and the latest payments.

### Other projects (`#/mc`, `#/pd`, `#/naron`)

An overview for each of Mission Control (the `*.mc` contracts), Planetary Defense (`magordefense` and its missions at `miss.pdef`) and Naron Rewards (`theminergame`), all from one page and one collector. Every overview, Alien Legends' included, opens with the same two sections (`src/components/Sections.tsx`) so the games compare at a glance: **Players**, then **Economy** with TLM and Shards paid out first. Each project is described in `src/projects/defs.ts`: its contracts, the accounts that pay its rewards, and the actions shown as figures.

- **Active:** wallets that signed one of the project's actions that day. A mine through Mission Control is signed by `m.federation`, so `notify.mc::logmine` counts the miner it names. Naron players never sign anything, so there a wallet is active on a day it was rewarded.
- **Paid out:** token, NFT and Shard transfers from the paying accounts to players. Mission Control also lends and returns tools, returns adventure NFTs and pays CPU fees and developers, so only its weekly mission claims and tool loaning earnings count.
- **Entry fees:** Planetary Defense players pay TLM or DEF to join a mission (memo `entry:<mission>`), and mission rewards are paid partly out of those. Paid out is rewards less those fees, so the players' own tokens coming back aren't counted as new; both are charted. Checked for 20 Aug – 18 Sep: 2,757,390 TLM in mission rewards less 1,805,050 in fees is 952,340, which with miss.pdef's balance rising 78,635 matches the 1,030,000 TLM the PD accounts (planetarydef, magordefense, forge.pdef) put in.
- **Shards:** every Shard reaches a player through `ptpxy.worlds::addpoints` — called by a project itself, or by `shards.mc` on behalf of Mission Control. Points are tenths of a Shard.
- **Players:** Mission Control's come live from `members.mc/mcmembers`, with join dates; Planetary Defense's count from `magordefense/players`. Neither PD nor Naron records when a player started, so a new player there is a wallet seen for the first time in the collected history, counted after a four-week warm-up. Naron keeps no player list at all: its players are the wallets it has rewarded.
- **Now:** Planetary Defense's running missions are read live from `miss.pdef`.

Collected into `public/data/projects/<key>.json` — Mission Control from 20 Aug 2026, the others from 29 Jun 2026. That is the earliest day every history indexer in use still has: some keep less than others, and one that has dropped a day answers with nothing rather than an error.

## Data sources

| What | Where |
| --- | --- |
| Daily activity | `players.ale::updpermstat` and `updpstatmap` (a fight's stats in one batch): every change to every lifetime counter, about 26,000 a day |
| Players, signups, Legend accounts | `players.ale/players`, live |
| Shop WAX | `eosio.token::transfer` into `shop.ale` with memo `purchase,<item>`; pack names from `shop.ale/shopitems` |

Finished days are read once by the collector and kept in `public/data/daily.json`. Today is added once the day is over.

### Reward pools

| What | Where |
| --- | --- |
| Payments | `rwrdlog.ale::addhistory`, sent by every paying contract |
| Where a payment came from | `pools.ale::claimbreward`, `lands.ale::addbldrwrd`, `pools.ale::qpremine` + `quests.ale::setquests` |
| Pool balances over time | table deltas of `pools.ale` `tlmpools` / `shardpools` |
| Pool balances now, names | `pools.ale` tables, `rwrdlog.ale/pooldesc`, `players.ale/players` |

History comes from five public Hyperion indexers, used in turn (`src/chain/history.ts`). Two things to know:

- Times are always sent in UTC with an explicit `Z`. Without it, one indexer reads the time as its own local zone.
- Long listings page by timestamp, not by offset, and a day is read in six overlapping slices at once.

## Develop

```bash
npm install
npm run dev        # http://localhost:5290
npm run build      # type-check, tests, production build into dist/
```

Collect finished days into `public/data/daily.json`. Each run only reads days it doesn't have yet; `--redo N` re-reads the last N:

```bash
npm run collect
```

A GitHub Action (`.github/workflows/collect.yml`) does this every day at 00:25 UTC: it collects the day that just ended and reads the one before again (`--redo 1`, in case an indexer was still catching up), commits `public/data/`, and publishes the site. It can also be started by hand from the Actions tab. It reads only public chain data and needs no secrets.

Only the projects, or one of them:

```bash
npm run collect -- --only projects --project mc
```

`scripts/verify-poolstats.ts` runs the same crawl from Node and reports how much was traced:

```bash
npx vite build --ssr scripts/verify-poolstats.ts --outDir .ssr --logLevel error
node .ssr/verify-poolstats.js
```
