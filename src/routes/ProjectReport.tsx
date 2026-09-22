import { useEffect, useMemo, useState } from 'react'
import { fetchProjectFile } from '@/projects/queries'
import { firstSeenByDay, metricOf, summariseProjectRange, type ProjectDay } from '@/projects/rules'
import { projectByKey } from '@/projects/defs'
import { Block, ReportPage, running, shortDay, useMonthView, whole, type Group } from '@/report/parts'

/**
 * The gHubs report for a project collected by the generic project collector
 * (`projects/<key>.json`): Planetary Defense and Naron Rewards.
 *
 * Their records begin when collecting did — the history servers keep only a
 * few months — so totals say "since" that day, and the player count is the
 * distinct wallets seen since then rather than a sign-up table neither has.
 */

interface Subject {
  title: string
  group: Group
  pick: (d: ProjectDay) => number
  unit?: string
  how: string
  /** Drawn as one line each, and split out in the figures' small print. */
  parts?: { label: string; pick: (d: ProjectDay) => number }[]
}

interface ReportDef {
  title: string
  /**
   * The records hold the project's whole life — it began after the earliest
   * day the history servers keep — so its totals really are all time.
   */
  allTime?: boolean
  /** Who counts as a player, in the figures' small print. */
  players: string
  /** How a player was counted, under the charts. */
  playersHow: string
  subjects: Subject[]
}

/** Everything paid out to players in a token. */
const net = (sym: string) => (d: ProjectDay) => d.paid[sym] ?? 0
/** What players paid in, in one token, for some kinds (or all). */
const inOf = (sym: string, keys?: string[]) => (d: ProjectDay) =>
  Object.entries(d.incoming ?? {}).reduce(
    (n, [k, v]) => (k.endsWith(`|${sym}`) && (!keys || keys.includes(k.split('|')[0])) ? n + v.amount : n),
    0,
  )
const kind = (key: string, sym: string) => (d: ProjectDay) => d.categories[`${key}|${sym}`]?.count ?? 0

const REPORTS: Record<string, ReportDef> = {
  pd: {
    title: 'Planetary Defense - gHubs report',
    players: 'players',
    playersHow: 'Wallets signing an action on magordefense or miss.pdef.',
    subjects: [
      { title: 'TLM paid out to players', group: 'rewards', pick: net('TLM'), unit: 'TLM', how: 'TLM reward transfers from magordefense and miss.pdef.' },
      { title: 'Shards paid out to players', group: 'rewards', pick: net('Shards'), unit: 'Shards', how: 'Sum of ptpxy.worlds addpoints issued by magordefense and miss.pdef, ÷10.' },
      { title: 'DEF paid out to players', group: 'rewards', pick: net('DEF'), unit: 'DEF', how: 'DEF reward transfers from magordefense and miss.pdef.' },
      {
        title: 'TLM paid in by players',
        group: 'incoming',
        pick: inOf('TLM'),
        unit: 'TLM',
        how: 'TLM transfers from players to miss.pdef (entry:), magordefense (Buy forge, land_id:, Fee inscription) and forge.pdef (forge:).',
        parts: [
          { label: 'Mission entries', pick: inOf('TLM', ['missions']) },
          { label: 'Forge', pick: inOf('TLM', ['forgebuy', 'forge']) },
          { label: 'Land and sign-up fees', pick: inOf('TLM', ['land', 'signup']) },
        ],
      },
      {
        title: 'DEF paid in by players',
        group: 'incoming',
        pick: inOf('DEF'),
        unit: 'DEF',
        how: 'DEF transfers from players to miss.pdef (entry:) and forge.pdef (shop:).',
        parts: [
          { label: 'Mission entries', pick: inOf('DEF', ['missions']) },
          { label: 'Forge shop', pick: inOf('DEF', ['shop']) },
        ],
      },
      { title: 'Missions joined', group: 'game', pick: (d) => metricOf(d, ['miss.pdef::join']), how: 'Count of miss.pdef join actions.' },
      { title: 'Mission rewards claimed', group: 'game', pick: (d) => metricOf(d, ['miss.pdef::claim']), how: 'Count of miss.pdef claim actions.' },
      { title: 'Attacks sent', group: 'game', pick: (d) => metricOf(d, ['magordefense::sendattack']), how: 'Count of magordefense sendattack actions.' },
      {
        title: 'PvP actions',
        group: 'game',
        pick: (d) => metricOf(d, ['magordefense::adddefense', 'magordefense::addattack']),
        how: 'Count of magordefense adddefense and addattack actions.',
        parts: [
          { label: 'Defense', pick: (d) => metricOf(d, ['magordefense::adddefense']) },
          { label: 'Attack', pick: (d) => metricOf(d, ['magordefense::addattack']) },
        ],
      },
    ],
  },
  naron: {
    title: 'Naron Rewards - gHubs report',
    players: 'players rewarded',
    playersHow: 'Wallets receiving a reward from theminergame.',
    subjects: [
      { title: 'NAR paid out to players', group: 'rewards', pick: net('NAR'), unit: 'NAR', how: 'NAR reward transfers from theminergame.' },
      { title: 'Shards paid out to players', group: 'rewards', pick: net('Shards'), unit: 'Shards', how: 'Sum of ptpxy.worlds addpoints issued by theminergame, ÷10.' },
      /* theminergame has no actions of its own for players to sign; what it
         pays for IS the activity, each payment one reward earned. */
      { title: 'Mining rewards paid', group: 'game', pick: kind('mining', 'NAR'), unit: 'payments', how: 'Count of theminergame NAR transfers with memo "Mining Reward".' },
      { title: 'Number Game wins', group: 'game', pick: kind('number', 'NAR'), unit: 'payments', how: 'Count of theminergame NAR transfers with memo "Number Game".' },
      { title: 'Accumulator Game rounds', group: 'game', pick: kind('accumulator', 'NAR'), unit: 'payments', how: 'Count of theminergame NAR transfers with memo "Accumulator Game".' },
      { title: 'Achievements earned', group: 'game', pick: kind('achievement', 'NAR'), unit: 'payments', how: 'Count of theminergame NAR transfers with memo "Achievement".' },
      { title: 'NFTs sent as rewards', group: 'nfts', pick: (d) => d.nfts, unit: 'NFTs', how: 'alien.worlds NFTs transferred by theminergame with a reward memo.' },
    ],
  },
  th: {
    title: 'Treasure Hunt - gHubs report',
    players: 'winners',
    playersHow: 'Wallets receiving a Treasure reward from planetaworld.',
    subjects: [
      { title: 'TLM paid out to winners', group: 'rewards', pick: net('TLM'), unit: 'TLM', how: 'TLM transfers from planetaworld with memo "Treasure reward".' },
      { title: 'Shards paid out to winners', group: 'rewards', pick: net('Shards'), unit: 'Shards', how: 'Sum of ptpxy.worlds addpoints issued by planetaworld, ÷10.' },
      /* A hunt is rewarded once, when its treasure is found. */
      { title: 'Treasure hunts rewarded', group: 'game', pick: (d) => metricOf(d, ['planetaworld::distributere']), how: 'Count of planetaworld distributere actions.' },
      { title: 'Rewards won', group: 'game', pick: kind('treasure', 'TLM'), unit: 'winning places', how: 'Count of planetaworld TLM transfers with memo "Treasure reward".' },
    ],
  },
  arkhive: {
    title: 'Arkhive - gHubs report',
    allTime: true,
    players: 'players',
    playersHow: 'Wallets receiving a TLM reward from arkhive.lore.',
    subjects: [
      { title: 'TLM rewarded for adventures', group: 'rewards', pick: net('TLM'), unit: 'TLM', how: 'TLM transfers from arkhive.lore with memo "Rewards for completing adventure".' },
      /* A reward like the TLM, so shown with it rather than as an NFT section. */
      { title: 'NFTs rewarded for adventures', group: 'rewards', pick: (d) => d.nfts, unit: 'NFTs', how: 'alien.worlds NFTs transferred by arkhive.lore with memo "Rewards for completing adventure".' },
      /* Every adventure is paid for before it is played. */
      { title: 'Adventures played', group: 'game', pick: (d) => metricOf(d, ['arkhive.lore::payadventure']), how: 'Count of arkhive.lore payadventure actions.' },
    ],
  },
}

export default function ProjectReport({ projectKey }: { projectKey: string }) {
  const def = projectByKey(projectKey)!
  const report = REPORTS[projectKey]
  const [days, setDays] = useState<ProjectDay[] | null>(null)

  useEffect(() => {
    setDays(null)
    void fetchProjectFile(projectKey).then((f) => setDays(f.days))
  }, [projectKey])

  const v = useMonthView(days)
  const { upTo, inMonth, dates, monthDates, name, within } = v

  const recordsFrom = `${shortDay(def.since)} ${def.since.slice(0, 4)}`
  const SINCE = report.allTime ? 'All time' : `Since ${recordsFrom}`
  const sinceTitle = report.allTime ? 'since launch' : `since ${shortDay(def.since)}`
  const sumOf = (list: ProjectDay[], pick: (d: ProjectDay) => number) => list.reduce((n, d) => n + pick(d), 0)

  /* Wallets seen for the first time each day, and so every wallet seen by then. */
  /* An NFT section with nothing in it is left out: only Alien Worlds NFTs are
     counted, and a project sending other collections' NFTs has none. */
  const subjects = report.subjects.filter((s) => s.group !== 'nfts' || sumOf(days ?? [], s.pick) > 0)

  /* A split subject's small print names its parts; a plain one its unit. */
  const small = (s: Subject, list: ProjectDay[]) =>
    s.parts
      ? [s.unit, s.parts.map((p) => `${whole(sumOf(list, p.pick))} ${p.label.toLowerCase()}`).join(' · ')]
          .filter(Boolean)
          .join(': ')
      : s.unit
  const partLines = (s: Subject, list: ProjectDay[], acc: (v: number[]) => number[] = (x) => x) =>
    (s.parts ?? []).map((p) => ({ label: p.label, values: acc(list.map(p.pick)) }))

  const firstSeen = useMemo(() => firstSeenByDay(days ?? []), [days])
  const seen = running(dates.map((d) => firstSeen[d] ?? 0))
  const newInMonth = sumOf(inMonth, (d) => firstSeen[d.date] ?? 0)

  return (
    <ReportPage title={report.title} view={v} loading={!days} empty={!days?.length}>
      <Block
        head
        group="players"
        title="Activity"
        figures={[
          { label: SINCE, value: whole(seen[seen.length - 1] ?? 0), sub: `${report.players}, each counted once` },
          {
            label: within,
            value: whole(summariseProjectRange(inMonth).uniqueActive),
            sub: `${report.players} · ${whole(newInMonth)} new`,
          },
        ]}
        charts={[
          { title: `Per day, ${sinceTitle}`, dates, values: upTo.map((d) => d.active) },
          { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map((d) => d.active) },
          { title: report.allTime ? 'Seen so far' : `Seen so far, ${sinceTitle}`, dates, values: seen },
        ]}
        how={report.playersHow}
      />

      {subjects.map((s, i) => (
        <Block
          key={s.title}
          head={i === 0 || subjects[i - 1].group !== s.group}
          group={s.group}
          title={s.title}
          figures={[
            { label: SINCE, value: whole(sumOf(upTo, s.pick)), sub: small(s, upTo) },
            { label: within, value: whole(sumOf(inMonth, s.pick)), sub: small(s, inMonth) },
          ]}
          charts={
            s.parts
              ? [
                  { title: `Per day, ${sinceTitle}`, dates, lines: partLines(s, upTo) },
                  { title: `Per day, ${name}`, dates: monthDates, lines: partLines(s, inMonth) },
                  { title: `Running total, ${sinceTitle}`, dates, lines: partLines(s, upTo, running) },
                ]
              : [
                  { title: `Per day, ${sinceTitle}`, dates, values: upTo.map(s.pick) },
                  { title: `Per day, ${name}`, dates: monthDates, values: inMonth.map(s.pick) },
                  { title: `Running total, ${sinceTitle}`, dates, values: running(upTo.map(s.pick)) },
                ]
          }
          how={s.how}
        />
      ))}
    </ReportPage>
  )
}
