import { useEffect, useMemo, useState } from 'react'
import { dayStart } from '@/activity/rules'
import { fetchMcMembers, fetchProjectFile, type McMember } from '@/projects/queries'
import { metricOf, summariseProjectRange, type ProjectDay } from '@/projects/rules'
import { MC_MODES, MC_STAKING, fetchMcReportFile, type McMode, type McReportDay } from '@/projects/mcReport'
import { PROJECTS } from '@/projects/defs'
import { Block, ReportPage, onDay, running, shortDay, stockFigures, stockOf, useMonthView, whole } from '@/report/parts'

/**
 * The gHubs report for Mission Control — the same report as Alien Legends',
 * with Mission Control's own game.
 *
 * One difference is stated rather than hidden: Mission Control has run since
 * 2023, but the history servers keep only a few months, so its records begin
 * on the day collecting started. Totals say "since" that day instead of "all
 * time". The player count is the exception — it comes from the member table,
 * which is all time.
 */

const DEF = PROJECTS.find((p) => p.key === 'mc')!
/** "20 Aug 2026": the first day Mission Control's records hold. */
const RECORDS_FROM = `${shortDay(DEF.since)} ${DEF.since.slice(0, 4)}`
const SINCE = `Since ${RECORDS_FROM}`

interface Day extends ProjectDay {
  report?: McReportDay
}

export default function McReport() {
  const [days, setDays] = useState<Day[] | null>(null)
  const [members, setMembers] = useState<McMember[] | null>(null)

  useEffect(() => {
    void Promise.all([fetchProjectFile('mc'), fetchMcReportFile()]).then(([f, r]) => {
      const by = new Map(r.days.map((d) => [d.date, d]))
      setDays(f.days.map((d) => ({ ...d, report: by.get(d.date) })))
    })
    fetchMcMembers()
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [])

  const v = useMonthView(days)
  const { upTo, inMonth, dates, monthDates, lastDay, name, within } = v

  const sumOf = (list: Day[], pick: (d: Day) => number) => list.reduce((n, d) => n + pick(d), 0)

  /* Members as of the report's last day, and each day since records began. */
  const cutoff = lastDay ? dayStart(lastDay) + 86_400_000 : 0
  const membersAllTime = members ? members.filter((m) => m.joined && m.joined < cutoff).length : null
  const joinedInMonth = members
    ? members.filter((m) => m.joined < cutoff && m.joined >= dayStart(`${v.picked}-01`)).length
    : null
  const memberLine = useMemo(
    () =>
      members ? dates.map((d) => members.filter((m) => m.joined && m.joined < dayStart(d) + 86_400_000).length) : [],
    [members, dates.join()],
  )

  const paid = (d: Day, sym: string) => d.paid[sym] ?? 0
  const builds = (d: Day) => metricOf(d, ['game.mc::upgbuilding'])
  const advStarts = (d: Day) => metricOf(d, ['adventure.mc::joinadv']) + (d.report?.flows.adventure.joins ?? 0)
  const mines = (d: Day, m: McMode) => d.report?.mines[m] ?? 0
  const minesAll = (d: Day) => MC_MODES.reduce((n, m) => n + mines(d, m.key), 0)

  const modeSplit = (list: Day[]) =>
    MC_MODES.map((m) => `${whole(sumOf(list, (d) => mines(d, m.key)))} ${m.label.toLowerCase()}`).join(' · ')
  const modeLines = (list: Day[], acc: (v: number[]) => number[] = (x) => x) =>
    MC_MODES.map((m) => ({ label: m.label, values: acc(list.map((d) => mines(d, m.key))) }))

  const stakedBy = (key: 'game' | 'adventure') =>
    new Map((days ?? []).filter((d) => d.report).map((d) => [d.date, d.report!.staked[key]]))
  const gameStake = stockOf(stakedBy('game'), dates, monthDates.length)
  const advStake = stockOf(stakedBy('adventure'), dates, monthDates.length)

  const sinceTitle = `since ${shortDay(DEF.since)}`
  const flow = (
    title: string,
    group: 'rewards' | 'game',
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
    <ReportPage title="Mission Control - gHubs report" view={v} loading={!days} empty={!days?.length}>
      <Block
        head
        group="players"
        title="Members and activity"
        figures={[
          { label: 'All time', value: membersAllTime === null ? '…' : whole(membersAllTime), sub: 'members' },
          {
            label: within,
            value: whole(summariseProjectRange(inMonth).uniqueActive),
            sub: `active players${joinedInMonth !== null ? ` · ${whole(joinedInMonth)} joined` : ''}`,
          },
        ]}
        charts={[
          { title: `Active players per day, ${sinceTitle}`, dates, values: upTo.map((d) => d.active) },
          { title: `Active players per day, ${name}`, dates: monthDates, values: inMonth.map((d) => d.active) },
          { title: 'Members, running total', dates, values: memberLine },
        ]}
        how="Members: join dates in the members.mc table. Active: wallets signing an action on a *.mc contract."
      />

      {flow(
        'TLM paid out to players',
        'rewards',
        (d) => paid(d, 'TLM'),
        'TLM transfers from the *.mc contracts with weekly-claim or Tool Loaning memos.',
        'TLM',
        true,
      )}
      {flow('Shards paid out to players', 'rewards', (d) => paid(d, 'Shards'), 'Sum of shards.mc sendpoints, ÷10.', 'Shards')}

      {flow('Buildings constructed', 'game', builds, 'Count of game.mc upgbuilding actions.', 'in game.mc', true)}
      {flow(
        'Adventures started',
        'game',
        advStarts,
        'Count of adventure.mc joinadv actions plus NFT transfers to adventure.mc with memo mcadventure.',
      )}

      <Block
        group="game"
        title="Mining actions"
        figures={[
          { label: SINCE, value: whole(sumOf(upTo, minesAll)), sub: modeSplit(upTo) },
          { label: within, value: whole(sumOf(inMonth, minesAll)), sub: modeSplit(inMonth) },
        ]}
        charts={[
          { title: `Per day, ${sinceTitle}`, dates, lines: modeLines(upTo) },
          { title: `Per day, ${name}`, dates: monthDates, lines: modeLines(inMonth) },
          { title: `Running total, ${sinceTitle}`, dates, lines: modeLines(upTo, running) },
        ]}
        how="Count of cpu.mc paycpu actions by type: 0 same land, 1 land change, 2 Tool Loaning."
      />

      <Block
        head
        group="nfts"
        title="NFTs staked in buildings"
        figures={stockFigures(gameStake, onDay('Staked on', lastDay, 'Staked'), MC_STAKING[0].account, within)}
        charts={[
          { title: `End of each day, ${sinceTitle}`, dates, values: gameStake.values },
          { title: `End of each day, ${name}`, dates: monthDates, values: gameStake.inMonth },
        ]}
        how="alien.worlds NFTs held by game.mc at each UTC day's end: current holdings less later transfers."
      />
      <Block
        group="nfts"
        title="NFTs staked on adventures"
        figures={stockFigures(advStake, onDay('Staked on', lastDay, 'Staked'), MC_STAKING[1].account, within)}
        charts={[
          { title: `End of each day, ${sinceTitle}`, dates, values: advStake.values },
          { title: `End of each day, ${name}`, dates: monthDates, values: advStake.inMonth },
        ]}
        how="alien.worlds NFTs held by adventure.mc at each UTC day's end: current holdings less later transfers."
      />
    </ReportPage>
  )
}
