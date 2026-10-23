import { useEffect, useMemo, useState } from 'react'
import {
  CLASSES,
  COPY_PER_TRANSACTION,
  CPU_LIMIT_US,
  PLANETS,
  STAT_NAMES,
  blankWeather,
  delWeatherAction,
  estimateCpu,
  fetchPlanets,
  inChunks,
  fetchWeather,
  groupByFirst,
  newWeatherId,
  scopeProblem,
  setWeatherAction,
  summarise,
  type PlanetScope,
  type Weather,
  type WeatherGroup,
} from '../chain/weather'
import { isCancel, readableError, type ChainAction } from '../../dao/chain/act'
import { useSession } from '../../wallet/session'

/**
 * The battle weather catalogue.
 *
 * Every planet holds its own copy of about a thousand weathers, so one planet
 * is loaded at a time and the list is searched rather than scrolled. `setweather`
 * takes a list of planets, so writing one to all six is a single action;
 * `delweather` takes exactly one, so removing it everywhere is six.
 *
 * Copying an existing weather is the normal way to make a new one — these are
 * variations on a theme, and starting from a blank form means retyping an
 * effect list that already exists. A copy takes everything but the id, which is
 * regenerated: `setweather` OVERWRITES a row with the same id rather than
 * refusing it, so reusing one would quietly replace the weather being copied.
 */
export function WeatherAdmin() {
  const { session } = useSession()
  const [planet, setPlanet] = useState<string>(PLANETS[2])
  const [all, setAll] = useState<Weather[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Weather | null>(null)
  const [targets, setTargets] = useState<Set<string>>(new Set(PLANETS))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  /* The copy: which group of the catalogue, and where it is going. */
  const [picked, setPicked] = useState<string | null>(null)
  const [scope, setScope] = useState('')
  /* Every scope battle.ale keeps weather for, from its own registry. */
  const [known, setKnown] = useState<PlanetScope[] | null>(null)

  const read = () => {
    setAll(null)
    setError(null)
    setSelected(null)
    fetchWeather(planet)
      .then(setAll)
      .catch((err: unknown) => {
        console.error(`weather for ${planet}:`, err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [planet])

  const readPlanets = () => {
    fetchPlanets()
      .then(setKnown)
      .catch((err: unknown) => {
        console.error('planet scopes:', err)
        setKnown(null)
      })
  }

  useEffect(readPlanets, [])

  /*
    The scopes to show, and what each holds.

    PLANETS until the registry answers, so the tabs are not empty on the way
    in — and the six are in it either way. A copy into a new scope adds a row
    to plnttracking, which is how a tournament catalogue appears here without
    anything being changed in the code.
  */
  const planets: PlanetScope[] = known ?? PLANETS.map((planet) => ({ planet, weathers: 0 }))
  const countOf = (name: string) => known?.find((k) => k.planet === name)?.weathers ?? null

  /*
    The catalogue by the first character of its ids.

    Not a presentational grouping: the ids were minted in batches and the first
    character says what the weather targets — every id beginning c targets a
    class, every e an element, every r a race. It is also the size that can be
    acted on, which the whole thousand is not.
  */
  const groups = useMemo(() => groupByFirst(all ?? []), [all])
  const group: WeatherGroup | null = groups.find((g) => g.char === picked) ?? null
  const batch = group?.rows ?? []
  const runs = inChunks(batch, COPY_PER_TRANSACTION)

  /**
   * Why the copy cannot be signed, or null.
   *
   * Every button on this page that writes is disabled without a wallet, and
   * none of them said so — a grey button with no reason is a bug report
   * waiting to happen, and it got one. The reason now sits on the button and
   * beside it.
   */
  const cannotCopy =
    !session
      ? 'Connect a wallet to write weather.'
      : !batch.length
        ? 'Choose a group above to copy.'
        : scopeProblem(scope)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = all ?? []
    if (!q) return rows.slice(0, 200)
    return rows
      .filter(
        (w) =>
          w.weather_id.includes(q) ||
          w.title.toLowerCase().includes(q) ||
          w.displayname.toLowerCase().includes(q) ||
          w.weather_effects.some((e) => e.statname.includes(q)),
      )
      .slice(0, 200)
  }, [all, query])

  const chosen = all?.find((w) => w.weather_id === selected) ?? null

  const level = (): ChainAction['authorization'][number] => ({
    actor: String(session!.actor),
    permission: session!.permissionLevel.permission ? String(session!.permissionLevel.permission) : 'active',
  })

  const sign = async (actions: ChainAction[], describe: string) => {
    if (!session || busy || !actions.length) return
    setBusy(true)
    setNote({ text: `${describe} — check your wallet…` })
    try {
      await session.transact({ actions }, { broadcast: true })
      await new Promise((r) => setTimeout(r, 2500))
      read()
      /* A write can have made a scope that was not there before. */
      readPlanets()
      setNote({ text: `${describe} done.` })
    } catch (err) {
      if (isCancel(err)) setNote({ text: 'Cancelled.' })
      else {
        console.error('weather write failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!draft) return
    if (!draft.title.trim()) return setNote({ text: 'Give it a title.', bad: true })
    if (!targets.size) return setNote({ text: 'Pick at least one planet.', bad: true })
    void sign(
      [setWeatherAction(level(), [...targets], { ...draft, displayname: draft.displayname || draft.title })],
      `Writing ${draft.weather_id} to ${targets.size} planet${targets.size === 1 ? '' : 's'}`,
    )
  }

/**
   * A group written into one scope, a hundred weathers at a time.
   *
   * setweather takes a list of scopes and writes the row into each, so a copy
   * is one action per weather rather than one per weather per scope.
   *
   * Chained, not fired together: each run is signed only once the one before
   * it landed, so a refusal stops what is left rather than leaving an unknown
   * number of transactions in flight. That does mean a copy can stop halfway,
   * which is why the note below counts what actually went in — and why it says
   * that running it again is safe. setweather writes over a row with the same
   * id, so a repeat of a part that already landed changes nothing.
   *
   * The scope does not have to exist first. battle.ale keeps a row per planet
   * in plnttracking and writes it itself — the six there to begin with were
   * all created in the same block as the very first setweather, and the
   * seventh appeared the first time a group was copied.
   */
  const copy = async () => {
    const wrong = scopeProblem(scope)
    if (wrong) return setNote({ text: wrong, bad: true })
    if (!batch.length) return setNote({ text: 'Choose a group to copy.', bad: true })
    if (!session || busy) return
    const into = scope.trim()

    setBusy(true)
    let done = 0
    try {
      for (const [i, run] of runs.entries()) {
        setNote({
          text:
            `Writing ${run.length} into ${into} — transaction ${i + 1} of ${runs.length}` +
            `${done ? `, ${done} in so far` : ''} — check your wallet…`,
        })
        await session.transact(
          { actions: run.map((w) => setWeatherAction(level(), [into], w)) },
          { broadcast: true },
        )
        done += run.length
      }
      /* A block has to land before the tables move, and a copy can have made
         a scope that was not in the registry before. */
      await new Promise((r) => setTimeout(r, 2500))
      read()
      readPlanets()
      setNote({ text: `${done} weather${done === 1 ? '' : 's'} written into ${into}.` })
    } catch (err) {
      const stopped =
        `Stopped after ${done} of ${batch.length}. The ${done} that went in are in ${into}; the rest are not. ` +
        'Saving the same group again writes the ids that landed over themselves, so it is safe to run it again.'
      if (isCancel(err)) setNote({ text: done ? stopped : 'Cancelled.', bad: !!done })
      else {
        console.error('weather copy failed:', err)
        setNote({ text: done ? `${readableError(err)} ${stopped}` : readableError(err), bad: true })
      }
      if (done) {
        read()
        readPlanets()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = () => {
    if (!chosen) return
    void sign(
      [...targets].map((p) => delWeatherAction(level(), p, chosen.weather_id)),
      `Deleting ${chosen.weather_id} from ${targets.size} planet${targets.size === 1 ? '' : 's'}`,
    )
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Weather</h1>
          <p className="page__lead">
            The battle weather catalogue on <code>battle.ale</code>. Each planet holds its own copy; a fight picks
            one at random for the land it is on.
          </p>
        </div>
        <div className="page__actions">
          <div className="sections" role="tablist">
            {planets.map((p) => (
              <button
                key={p.planet}
                type="button"
                role="tab"
                aria-selected={p.planet === planet}
                title={p.weathers ? `${p.weathers} weathers` : undefined}
                onClick={() => setPlanet(p.planet)}
              >
                {p.planet}
              </button>
            ))}
          </div>
          <button className="btn" type="button" onClick={read} disabled={busy}>
            Re-read
          </button>
        </div>
      </header>

      {!session ? (
        <p className="dao-note">
          No wallet is connected, so nothing here can be written — the catalogue still reads. Connect one from
          the sidebar to save, copy or delete a weather.
        </p>
      ) : null}
      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}
      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      {/* Which planets a write or a delete lands on. Separate from the planet
          being browsed: you look at one and act on all six. */}
      <section className="section">
        <h2 className="dao-h2">
          Write to{' '}
          <span className="dao-dim">
            {targets.size} of {planets.length} scope{planets.length === 1 ? '' : 's'}
          </span>
        </h2>
        <div className="pause-grid">
          {planets.map(({ planet: p, weathers }) => (
            <label key={p} className={`pause-chip${targets.has(p) ? ' is-target' : ''}`}>
              <input
                type="checkbox"
                checked={targets.has(p)}
                onChange={() =>
                  setTargets((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(p)) next.add(p)
                    return next
                  })
                }
              />
              <span>
                {p}
                {weathers ? <i className="wx-count">{weathers}</i> : null}
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Copying a group of the catalogue into another scope. Reads from the
          planet above; writes wherever it is told. */}
      <section className="section">
        <h2 className="dao-h2">
          Copy into a scope{' '}
          <span className="dao-dim">
            {batch.length ? `${batch.length} of ${all?.length ?? 0} on ${planet}` : `from ${planet}`}
          </span>
        </h2>

        <div className="pause-grid">
          {groups.map((g) => (
            <button
              key={g.char}
              type="button"
              className={`pause-chip wx-group${picked === g.char ? ' is-target' : ''}`}
              title={`${g.rows.length} ${g.targets}, ids beginning ${g.char} — e.g. ${g.rows[0]?.title ?? ''}`}
              onClick={() => setPicked(picked === g.char ? null : g.char)}
            >
              <b>{g.char}…</b>
              <span>
                {g.rows.length} · {g.targets}
              </span>
            </button>
          ))}
          {!groups.length ? <span className="dao-dim">reading {planet}…</span> : null}
        </div>

        <div className="ale-form">
          <label className="ale-field">
            <span className="ale-field__name">
              Scope<i>a name, not a string: a–z, 1–5 and dots, up to 12</i>
            </span>
            <input
              type="text"
              value={scope}
              placeholder="eyeke"
              onChange={(e) => setScope(e.target.value.trim().toLowerCase())}
            />
          </label>
          <div className="ale-field">
            <span className="ale-field__name">&nbsp;</span>
            <button
              className="btn btn--go"
              type="button"
              disabled={busy || !!cannotCopy}
              title={cannotCopy ?? `Write ${batch.length} weathers into ${scope}`}
              onClick={() => void copy()}
            >
              {busy ? 'Signing…' : `Save ${batch.length} in scope`}
            </button>
          </div>
        </div>

        {cannotCopy && !busy ? <p className="dao-note">{cannotCopy}</p> : null}

        {scope && known ? (
          <p className="dao-note">
            {countOf(scope) != null
              ? `${scope} already holds ${countOf(scope)} weathers. Any id written again replaces the row that is there.`
              : `${scope} is not a scope yet. setweather makes one as it writes — every scope listed above was created that way.`}
          </p>
        ) : null}

        {batch.length ? (
          <p className="dao-note">
            {runs.length} transaction{runs.length === 1 ? '' : 's'} of up to {COPY_PER_TRANSACTION}, signed one
            after the next — so {runs.length === 1 ? 'one wallet prompt' : `${runs.length} wallet prompts`}. A
            full run costs about {Math.round(estimateCpu(Math.min(batch.length, COPY_PER_TRANSACTION)) / 1000)} ms
            of the {CPU_LIMIT_US / 1000} ms a transaction may spend, measured from the live writes where each
            weather cost between 114 and 330 µs.
          </p>
        ) : null}

        {batch.length ? (
          <div className="dao-tablewrap wx-list">
            <table className="dao-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Title</th>
                  <th>Effects</th>
                  <th>Id</th>
                </tr>
              </thead>
              <tbody>
                {batch.map((w, i) => (
                  <tr key={w.weather_id}>
                    <td className="num dao-dim">{i + 1}</td>
                    <td>
                      <b className="dao-rowtitle">{w.title || w.displayname || '(untitled)'}</b>
                    </td>
                    <td className="dao-dim">{summarise(w)}</td>
                    <td className="dao-rowid">{w.weather_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="section">
        <div className="page__actions">
          <h2 className="dao-h2">
            Catalogue{' '}
            <span className="dao-dim">
              {all ? `${shown.length} shown of ${all.length} on ${planet}` : `reading ${planet}…`}
            </span>
          </h2>
          <input
            className="wx-search"
            type="search"
            value={query}
            placeholder="Search id, title or stat"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="btn"
            type="button"
            disabled={!chosen}
            onClick={() => chosen && setDraft({ ...structuredClone(chosen), weather_id: newWeatherId() })}
          >
            Copy as template
          </button>
          <button className="btn" type="button" onClick={() => setDraft(blankWeather())}>
            New weather
          </button>
          <button className="btn btn--warn" type="button" disabled={!chosen || !session || busy} onClick={remove}>
            Delete selected
          </button>
        </div>

        <div className="dao-tablewrap wx-list">
          <table className="dao-table">
            <thead>
              <tr>
                <th className="tick" />
                <th>Title</th>
                <th>Effects</th>
                <th>Id</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((w) => (
                <tr
                  key={w.weather_id}
                  className={selected === w.weather_id ? 'is-picked' : undefined}
                  onClick={() => setSelected(w.weather_id)}
                >
                  <td className="tick">
                    <input type="radio" checked={selected === w.weather_id} onChange={() => setSelected(w.weather_id)} />
                  </td>
                  <td>
                    <b className="dao-rowtitle">{w.title || w.displayname || '(untitled)'}</b>
                  </td>
                  <td className="dao-dim">{summarise(w)}</td>
                  <td className="dao-rowid">{w.weather_id}</td>
                </tr>
              ))}
              {all && !shown.length ? (
                <tr>
                  <td colSpan={4} className="dao-dim">
                    Nothing matches “{query}”.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {draft ? (
        <WeatherForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
          busy={busy}
          canSign={!!session}
          targets={targets.size}
        />
      ) : null}
    </div>
  )
}

function WeatherForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
  canSign,
  targets,
}: {
  draft: Weather
  setDraft: (w: Weather) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
  canSign: boolean
  targets: number
}) {
  const set = (patch: Partial<Weather>) => setDraft({ ...draft, ...patch })

  const setEffect = (i: number, patch: Partial<Weather['weather_effects'][number]>) =>
    set({ weather_effects: draft.weather_effects.map((e, n) => (n === i ? { ...e, ...patch } : e)) })

  return (
    <section className="section wx-form">
      <h2 className="dao-h2">
        {draft.title || 'New weather'} <span className="dao-dim">{draft.weather_id}</span>
      </h2>

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Title<i>what players see</i>
          </span>
          <input type="text" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Display name<i>defaults to the title</i>
          </span>
          <input
            type="text"
            value={draft.displayname}
            placeholder={draft.title}
            onChange={(e) => set({ displayname: e.target.value })}
          />
        </label>
      </div>

      <h3 className="ale-field__name">Effects</h3>
      <div className="wx-effects">
        {draft.weather_effects.map((e, i) => (
          <div key={i} className="wx-effect">
            <select value={e.statname} onChange={(ev) => setEffect(i, { statname: ev.target.value })}>
              {STAT_NAMES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label>
              <span>percent</span>
              <input
                type="number"
                value={e.percent_change}
                onChange={(ev) => setEffect(i, { percent_change: Number(ev.target.value) || 0 })}
              />
            </label>
            <label>
              <span>flat</span>
              <input
                type="number"
                value={e.flat_change}
                onChange={(ev) => setEffect(i, { flat_change: Number(ev.target.value) || 0 })}
              />
            </label>
            <button
              className="btn"
              type="button"
              disabled={draft.weather_effects.length === 1}
              onClick={() => set({ weather_effects: draft.weather_effects.filter((_, n) => n !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="btn"
          type="button"
          onClick={() =>
            set({ weather_effects: [...draft.weather_effects, { statname: 'damage', percent_change: 0, flat_change: 0 }] })
          }
        >
          Add an effect
        </button>
      </div>

      <h3 className="ale-field__name">
        Classes affected<i>none selected means every class</i>
      </h3>
      <div className="pause-grid">
        {CLASSES.map((c) => (
          <label key={c} className={`pause-chip${draft.affected_class.includes(c) ? ' is-target' : ''}`}>
            <input
              type="checkbox"
              checked={draft.affected_class.includes(c)}
              onChange={() =>
                set({
                  affected_class: draft.affected_class.includes(c)
                    ? draft.affected_class.filter((x) => x !== c)
                    : [...draft.affected_class, c],
                })
              }
            />
            <span>{c}</span>
          </label>
        ))}
      </div>

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!canSign || busy} onClick={onSave}>
          {busy ? 'Signing…' : `Write to ${targets} planet${targets === 1 ? '' : 's'}`}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {!canSign ? <span className="dao-dim">Connect a wallet to save.</span> : null}
      </div>
    </section>
  )
}
