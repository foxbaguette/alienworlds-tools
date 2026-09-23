import { useEffect, useState } from 'react'
import { fetchAwDaily, type AwDailyFile } from '@/aw/queries'
import { Block, ReportPage, recordsFrom, running, useMonthView, whole } from '@/report/parts'

/**
 * The gHubs report for Alien Worlds itself.
 *
 * What it can say is set by the chain's scale: about 3.4 million mines a day
 * can be COUNTED but not read one by one, so the players are the wallets that
 * claim their mined TLM — a few thousand a day, read in full. See aw/queries.
 *
 * Its records begin on the earliest day every history server still holds, so
 * totals say "since" that day rather than "all time".
 */


type Day = AwDailyFile['days'][number]

export default function AwReport() {
  const [file, setFile] = useState<AwDailyFile | null>(null)

  useEffect(() => {
    void fetchAwDaily().then(setFile)
  }, [])

  const v = useMonthView(file?.days ?? null)
  const { upTo, inMonth, dates, monthDates, name, within, picked } = v
  const sumOf = (list: Day[], pick: (d: Day) => number) => list.reduce((n, d) => n + pick(d), 0)
  const seen = running(upTo.map((d) => d.firstSeen))
  const { label: SINCE, short: sinceTitle } = recordsFrom(dates)

  const flow = (
    title: string,
    group: 'players' | 'rewards' | 'game' | 'nfts',
    pick: (d: Day) => number,
    how: string,
    unit?: string,
    head?: boolean,
  ) => (
    <Block
      key={title}
      head={head}
      group={group}
      title={title}
      how={how}
      figures={[
        { label: SINCE, value: whole(sumOf(upTo, pick)), sub: unit },
        { label: within, value: whole(sumOf(inMonth, pick)), sub: unit },
      ]}
      charts={[
        { title: `Per day, ${sinceTitle}`, dates, values: upTo.map(pick) },
        { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map(pick) },
        { title: `Running total, ${sinceTitle}`, dates, values: running(upTo.map(pick)) },
      ]}
    />
  )

  return (
    <ReportPage title="Alien Worlds - gHubs report" view={v} loading={!file} empty={!file?.days.length}>
      <Block
        head
        group="players"
        title="Miners"
        figures={[
          { label: SINCE, value: whole(seen[seen.length - 1] ?? 0), sub: 'wallets that claimed mined TLM' },
          {
            label: within,
            value: whole(file?.months[picked] ?? 0),
            sub: `wallets that claimed · ${whole(sumOf(inMonth, (d) => d.firstSeen))} new`,
          },
        ]}
        charts={[
          { title: `Per day, ${sinceTitle}`, dates, values: upTo.map((d) => d.miners) },
          { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map((d) => d.miners) },
          { title: `Seen so far, ${sinceTitle}`, dates, values: seen },
        ]}
        how="Wallets receiving a Mined Trilium transfer from m.federation."
      />
      {flow('New players', 'players', (d) => d.newPlayers, 'Count of federation agreeterms actions.', 'accounts accepting the terms of use')}

      {flow('TLM mined and claimed', 'rewards', (d) => d.tlm, 'Sum of Mined Trilium transfers from m.federation.', 'TLM', true)}
      {flow(
        'Shards mined',
        'rewards',
        (d) => d.shards ?? 0,
        'Sum of uspts.worlds addpoints less ptpxy.worlds addpoints (project Shards), ÷10.',
        'Shards',
      )}

      {flow('Mines', 'game', (d) => d.mines, 'Count of m.federation mine actions.', 'mining actions', true)}
      {flow('Claims of mined TLM', 'game', (d) => d.claims, 'Count of Mined Trilium transfers from m.federation.', 'claims')}
      {flow(
        'Shards spent in the Outpost',
        'game',
        (d) => d.shardsSpent ?? 0,
        'uspts.worlds redeempntnft actions, each priced at its offer\'s required points, ÷10.',
        'Shards',
      )}

      {flow(
        'NFTs bought in the Outpost',
        'nfts',
        (d) => d.outpostNfts ?? 0,
        'Count of uspts.worlds redeempntnft actions; each mints one NFT.',
        'alien.worlds NFTs, paid for in Shards',
        true,
      )}
    </ReportPage>
  )
}
