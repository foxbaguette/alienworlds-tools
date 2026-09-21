import { useEffect, useState } from 'react'
import { HISTORY_FLOOR } from '@/projects/defs'
import { fetchAwDaily, type AwDailyFile } from '@/aw/queries'
import { Block, ReportPage, running, shortDay, useMonthView, whole } from '@/report/parts'

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

const SINCE = `Since ${shortDay(HISTORY_FLOOR)} ${HISTORY_FLOOR.slice(0, 4)}`
const sinceTitle = `since ${shortDay(HISTORY_FLOOR)}`

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

  const flow = (title: string, group: 'players' | 'rewards' | 'game', pick: (d: Day) => number, unit?: string, head?: boolean) => (
    <Block
      key={title}
      head={head}
      group={group}
      title={title}
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
      />
      {flow('New players', 'players', (d) => d.newPlayers, 'accounts accepting the terms of use')}

      {flow('TLM mined and claimed', 'rewards', (d) => d.tlm, 'TLM', true)}
      {flow('Shards mined', 'rewards', (d) => d.shards ?? 0, 'Shards')}

      {flow('Mines', 'game', (d) => d.mines, 'mining actions', true)}
      {flow('Claims of mined TLM', 'game', (d) => d.claims, 'claims')}
    </ReportPage>
  )
}
