import { useEffect, useMemo, useState } from 'react'
import { fetchDailyFile, fetchPlayers, type PlayersSnapshot } from '@/activity/queries'
import { dayStart, statValue, summariseRange, type DaySummary } from '@/activity/rules'
import { FARM, fetchFarmDaily, type FarmDay } from '@/farm/queries'
import { fetchGemsDaily, type GemsDay } from '@/gems/queries'
import { NFTS, fetchNftsDaily, type NftsDay } from '@/nfts/queries'
import { fetchShopDaily, type ShopDay } from '@/shop/queries'
import {
  Block,
  ReportPage,
  onDay,
  running,
  shortDay,
  stockFigures,
  stockOf,
  useMonthView,
  whole,
  type Group,
} from '@/report/parts'

/**
 * The gHubs report for Alien Legends, by the month, laid out to be printed.
 *
 * Built only from finished days (`data/daily.json`) and the player table's
 * signup dates, so the current month is marked "so far". Alien Legends'
 * records begin on its launch day, so "all time" here really is.
 */

interface Metric {
  key: string
  title: string
  stat: string
  unit?: string
  group: Group
  how: string
}

const METRICS: Metric[] = [
  { key: 'tlm', title: 'TLM paid out to players', stat: 'tlm_earned', unit: 'TLM', group: 'rewards', how: 'Sum of tlm_earned stat changes on players.ale.' },
  { key: 'shards', title: 'Shards paid out to players', stat: 'shards_earned', unit: 'Shards', group: 'rewards', how: 'Sum of shards_earned stat changes on players.ale.' },
  { key: 'wax', title: 'WAX paid out to players', stat: 'wax_earned', unit: 'WAX', group: 'rewards', how: 'Sum of wax_earned stat changes on players.ale.' },
  { key: 'dungeons', title: 'Dungeons played', stat: 'dungeons_played', group: 'game', how: 'Sum of dungeons_played stat changes on players.ale.' },
  { key: 'arenas', title: 'Arenas played', stat: 'arenas_played', group: 'game', how: 'Sum of arenas_played stat changes on players.ale.' },
  { key: 'quests', title: 'Quests completed', stat: 'quests_completed', group: 'game', how: 'Sum of quests_completed stat changes on players.ale.' },
  { key: 'recruits', title: 'Fighters recruited', stat: 'recruits', group: 'game', how: 'Sum of recruits stat changes on players.ale.' },
]

export default function Ghubs() {
  const [days, setDays] = useState<DaySummary[] | null>(null)
  const [snap, setSnap] = useState<PlayersSnapshot | null>(null)
  const [farm, setFarm] = useState<FarmDay[]>([])
  const [gemDays, setGemDays] = useState<GemsDay[]>([])
  const [nftDays, setNftDays] = useState<NftsDay[]>([])
  const [shop, setShop] = useState<ShopDay[]>([])

  useEffect(() => {
    fetchDailyFile().then((f) => setDays(f.days))
    fetchFarmDaily().then((f) => setFarm(f.days))
    fetchGemsDaily().then((f) => setGemDays(f.days))
    fetchNftsDaily().then((f) => setNftDays(f.days))
    fetchShopDaily().then((f) => setShop(f.days))
    fetchPlayers()
      .then(setSnap)
      .catch(() => {})
  }, [])

  const v = useMonthView(days)
  const { upTo, inMonth, dates, monthDates, lastDay, name, within } = v
  const sum = (list: DaySummary[], stat: string) => list.reduce((n, d) => n + statValue(d.stats, stat), 0)

  /* Players as of the report's last day: everybody signed up before it ended. */
  const cutoff = lastDay ? dayStart(lastDay) + 86_400_000 : 0
  const playersAllTime = snap ? snap.players.filter((p) => p.signup < cutoff).length : null
  const signedUp = snap ? snap.players.filter((p) => p.signup < cutoff && p.signup >= dayStart(`${v.picked}-01`)).length : null
  /* Accounts that existed by the end of each day. Not a running sum of the
     daily actives — that would count the same players again every day. */
  const accounts = useMemo(
    () =>
      snap ? dates.map((d) => snap.players.filter((p) => p.signup < dayStart(d) + 86_400_000).length) : dates.map(() => 0),
    [snap, dates.join()],
  )

  const farmBy = useMemo(() => new Map(farm.map((d) => [d.date, Object.values(d.nfts).reduce((n, x) => n + x, 0)])), [farm])
  const nftsBy = useMemo(() => new Map(nftDays.map((d) => [d.date, d.rows])), [nftDays])
  const gemsBy = useMemo(() => new Map(gemDays.map((d) => [d.date, d.gems])), [gemDays])
  const gemHolders = useMemo(() => new Map(gemDays.map((d) => [d.date, d.players])), [gemDays])
  /*
    A balance stands at a level, so a day the collector missed takes the day
    before's figure — right for a gap of one, badly wrong past the end of what
    has been read. Carried forward blindly, a balance last read on 4 May was
    labelled "Held on Mon 28 Sep": five months of flat line, and a figure five
    months stale presented as today's. The series stops where the reading does.
  */
  const gemsThrough = gemDays.length ? gemDays[gemDays.length - 1].date : null
  const gemDates = useMemo(() => dates.filter((d) => gemsThrough !== null && d <= gemsThrough), [dates.join(), gemsThrough])
  const gemMonth = useMemo(
    () => monthDates.filter((d) => gemsThrough !== null && d <= gemsThrough),
    [monthDates.join(), gemsThrough],
  )
  const gemsHeld = stockOf(gemsBy, gemDates, gemMonth.length)
  const holders = stockOf(gemHolders, gemDates, gemMonth.length)
  /* Said plainly rather than drawn, for as long as the backfill is behind. */
  const gemsBehind =
    gemsThrough && lastDay && gemsThrough < lastDay
      ? ` Collected to ${shortDay(gemsThrough)} so far; later days are not in this yet.`
      : ''

  const staked = stockOf(farmBy, dates, monthDates.length)
  const nftRows = stockOf(nftsBy, dates, monthDates.length)

  /* The shop, lined up with the report's days. */
  const shopBy = useMemo(() => new Map(shop.map((d) => [d.date, d])), [shop])
  const shopOn = (list: string[]) => list.map((d) => shopBy.get(d))
  const monthDays = inMonth.map((d) => d.date)
  const wax = (list: string[]) => shopOn(list).map((d) => d?.spent.WAX ?? 0)
  const ITEMS = [
    { key: 'gem.small', label: 'Small gems' },
    { key: 'gem.medium', label: 'Medium gems' },
    { key: 'gem.large', label: 'Large gems' },
    { key: 'gem.giant', label: 'Giant gems' },
  ]
  const itemLines = (list: string[], acc: (v: number[]) => number[] = (x) => x) =>
    ITEMS.map((it) => ({ label: it.label, values: acc(shopOn(list).map((d) => d?.items[it.key]?.amount ?? 0)) }))
  const shopSub = (list: string[]) => {
    const got = shopOn(list)
    const buys = got.reduce((n, d) => n + (d?.purchases ?? 0), 0)
    const buyers = new Set(got.flatMap((d) => d?.buyers ?? [])).size
    return `WAX · ${whole(buys)} purchases by ${whole(buyers)} players`
  }
  const total = (v: number[]) => v.reduce((n, x) => n + x, 0)

  const metricBlock = (m: Metric, i: number, list: Metric[]) => (
    <Block
      key={m.key}
      head={i === 0 || list[i - 1].group !== m.group}
      group={m.group}
      title={m.title}
      figures={[
        { label: 'All time', value: whole(sum(upTo, m.stat)), sub: m.unit },
        { label: within, value: whole(sum(inMonth, m.stat)), sub: m.unit },
      ]}
      charts={[
        { title: 'Per day, since launch', dates, values: upTo.map((d) => statValue(d.stats, m.stat)) },
        { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map((d) => statValue(d.stats, m.stat)) },
        { title: 'Running total, since launch', dates, values: running(upTo.map((d) => statValue(d.stats, m.stat))) },
      ]}
      how={m.how}
    />
  )
  const rewards = METRICS.filter((m) => m.group !== 'game')
  const game = METRICS.filter((m) => m.group === 'game')

  return (
    <ReportPage title="Alien Legends - gHubs report" view={v} loading={!days} empty={!days?.length}>
      <Block
        head
        group="players"
        title="Accounts and activity"
        figures={[
          { label: 'All time', value: playersAllTime === null ? '…' : whole(playersAllTime), sub: 'accounts signed up' },
          {
            label: within,
            value: whole(summariseRange(inMonth).uniqueActive),
            sub: `active players${signedUp !== null ? ` · ${whole(signedUp)} signed up` : ''}`,
          },
        ]}
        charts={[
          { title: 'Active players per day, since launch', dates, values: upTo.map((d) => d.active) },
          { title: `Active players per day, ${name}`, dates: monthDates, values: inMonth.map((d) => d.active) },
          { title: 'Accounts signed up, running total', dates, values: accounts },
        ]}
        how="Accounts: signup dates in the players.ale player table. Active: wallets whose stats changed through their own play."
      />

      {rewards.map(metricBlock)}

      {shop.length ? (
        <Block
          head
          group="incoming"
          title="WAX spent in the shop"
          figures={[
            { label: 'All time', value: whole(total(wax(dates))), sub: shopSub(dates) },
            { label: within, value: whole(total(wax(monthDays))), sub: shopSub(monthDays) },
          ]}
          charts={[
            { title: 'Per day, since launch', dates, lines: itemLines(dates) },
            { title: `Per day, ${name}`, dates: monthDates, lines: itemLines(monthDays) },
            { title: 'Running total, since launch', dates, lines: itemLines(dates, running) },
          ]}
          how="WAX transfers from players to shop.ale with memo purchase,<item>."
        />
      ) : null}

      {gemDates.length ? (
        <Block
          group="incoming"
          title="Gems held by players"
          figures={
            /* A month with nothing read has no change to report. Passing it
               through anyway gave "Change in September: 0", which reads as a
               month in which nothing moved rather than one nobody has looked
               at. */
            gemMonth.length
              ? stockFigures(
                  gemsHeld,
                  onDay('Held on', gemsThrough, 'Held'),
                  `gems · ${whole(holders.end)} players holding`,
                  within,
                )
              : [
                  {
                    label: onDay('Held on', gemsThrough, 'Held'),
                    value: whole(gemsHeld.end),
                    sub: `gems · ${whole(holders.end)} players holding`,
                  },
                  { label: within, value: '—', sub: 'not collected yet' },
                ]
          }
          charts={[
            { title: 'End of each day, since launch', dates: gemDates, values: gemsHeld.values },
            ...(gemMonth.length
              ? [{ title: `End of each day, ${name}`, dates: gemMonth, values: gemsHeld.inMonth }]
              : []),
          ]}
          how={`Sum of activestats gems and unclaimed_gems across every players.ale row, at the end of each UTC day.${gemsBehind}`}
        />
      ) : null}

      {game.map(metricBlock)}

      {farm.length ? (
        <Block
          head
          group="nfts"
          title="NFTs staked on the farm"
          figures={stockFigures(staked, onDay('Staked on', lastDay, 'Staked'), FARM, within)}
          charts={[
            { title: 'End of each day, since launch', dates, values: staked.values },
            { title: `End of each day, ${name}`, dates: monthDates, values: staked.inMonth },
          ]}
          how="alien.worlds NFTs held by farm.ale at the end of each UTC day."
        />
      ) : null}

      {nftDays.length ? (
        <Block
          head={!farm.length}
          group="nfts"
          title="Unique NFTs used for other purposes per day"
          figures={stockFigures(nftRows, onDay('On', lastDay, 'Last day'), `unique NFTs, ${NFTS}`, within)}
          charts={[
            { title: 'Per day, since launch', dates, values: nftRows.values },
            { title: `Per day, ${name}`, dates: monthDates, values: nftRows.inMonth },
          ]}
          how="Distinct alien.worlds NFTs in nfts.ale usenfts actions per UTC day."
        />
      ) : null}
    </ReportPage>
  )
}
