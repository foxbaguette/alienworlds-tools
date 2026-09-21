import { useEffect, useMemo, useState } from 'react'
import { fetchDailyFile, fetchPlayers, type PlayersSnapshot } from '@/activity/queries'
import { dayStart, statValue, summariseRange, type DaySummary } from '@/activity/rules'
import { FARM, fetchFarmDaily, type FarmDay } from '@/farm/queries'
import { NFTS, fetchNftsDaily, type NftsDay } from '@/nfts/queries'
import { Block, ReportPage, onDay, running, stockFigures, stockOf, useMonthView, whole, type Group } from '@/report/parts'

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
}

const METRICS: Metric[] = [
  { key: 'tlm', title: 'TLM paid out to players', stat: 'tlm_earned', unit: 'TLM', group: 'rewards' },
  { key: 'shards', title: 'Shards paid out to players', stat: 'shards_earned', unit: 'Shards', group: 'rewards' },
  { key: 'wax', title: 'WAX paid out to players', stat: 'wax_earned', unit: 'WAX', group: 'rewards' },
  { key: 'dungeons', title: 'Dungeons played', stat: 'dungeons_played', group: 'game' },
  { key: 'arenas', title: 'Arenas played', stat: 'arenas_played', group: 'game' },
  { key: 'quests', title: 'Quests completed', stat: 'quests_completed', group: 'game' },
  { key: 'recruits', title: 'Fighters recruited', stat: 'recruits', group: 'game' },
]

export default function Ghubs() {
  const [days, setDays] = useState<DaySummary[] | null>(null)
  const [snap, setSnap] = useState<PlayersSnapshot | null>(null)
  const [farm, setFarm] = useState<FarmDay[]>([])
  const [nftDays, setNftDays] = useState<NftsDay[]>([])

  useEffect(() => {
    fetchDailyFile().then((f) => setDays(f.days))
    fetchFarmDaily().then((f) => setFarm(f.days))
    fetchNftsDaily().then((f) => setNftDays(f.days))
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
  const staked = stockOf(farmBy, dates, monthDates.length)
  const nftRows = stockOf(nftsBy, dates, monthDates.length)

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
      />

      {METRICS.map((m, i) => (
        <Block
          key={m.key}
          head={i === 0 || METRICS[i - 1].group !== m.group}
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
        />
      ))}

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
        />
      ) : null}
    </ReportPage>
  )
}
