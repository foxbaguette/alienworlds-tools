import { useEffect, useMemo, useState } from 'react'
import {
  CLASSES,
  CPU_LIMIT_US,
  PLANETS,
  STAT_NAMES,
  blankWeather,
  delWeatherAction,
  estimateCpu,
  fetchWeather,
  fetchWeatherScopes,
  groupByFirst,
  newWeatherId,
  scopeProblem,
  setWeatherAction,
  summarise,
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
  const [scopes, setScopes] = useState<Map<string, number> | null>(null)

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

  useEffect(() => {
    fetchWeatherScopes()
      .then(setScopes)
      .catch((err: unknown) => {
        console.error('weather scopes:', err)
        setScopes(null)
      })
  }, [])

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
   * Every weather of one group written into one scope, in one transaction.
   *
   * setweather takes a list of scopes and writes the row into each, so a copy
   * is one action per weather rather than one per weather per scope. The whole
   * group goes in a single transaction because half a catalogue is worse than
   * none: a fight picks a weather at random from what the scope holds, so a
   * partial copy is a scope that quietly behaves differently.
   *
   * The scope does not have to exist first. battle.ale keeps a row per planet
   * in plnttracking and writes it itself — the six there today were all
   * created in the same block as the very first setweather, with no separate
   * registration, and no action exists that could have made them.
   */
  const copy = () => {
    const wrong = scopeProblem(scope)
    if (wrong) return setNote({ text: wrong, bad: true })
    if (!batch.length) return setNote({ text: 'Choose a group to copy.', bad: true })
    const into = scope.trim()
    void sign(
      batch.map((w) => setWeatherAction(level(), [into], w)),
      `Writing ${batch.length} weather${batch.length === 1 ? '' : 's'} into ${into}`,
    )
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
            {PLANETS.map((p) => (
              <button key={p} type="button" role="tab" aria-selected={p === planet} onClick={() => setPlanet(p)}>
                {p}
              </button>
            ))}
          </div>
          <button className="btn" type="button" onClick={read} disabled={busy}>
            Re-read
          </button>
        </div>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}
      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      {/* Which planets a write or a delete lands on. Separate from the planet
          being browsed: you look at one and act on all six. */}
      <section className="section">
        <h2 className="dao-h2">
          Write to <span className="dao-dim">{targets.size} of {PLANETS.length} planets</span>
        </h2>
        <div className="pause-grid">
          {PLANETS.map((p) => (
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
              <span>{p}</span>
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
            <button className="btn btn--go" type="button" disabled={!session || busy || !batch.length} onClick={copy}>
              {busy ? 'Signing…' : `Save ${batch.length} in scope`}
            </button>
          </div>
        </div>

        {scope && scopes ? (
          <p className="dao-note">
            {scopes.has(scope)
              ? `${scope} already holds ${scopes.get(scope)} weathers. Any id written again replaces the row that is there.`
              : `${scope} holds no weathers yet. setweather makes the scope as it writes — the six that exist were all created that way.`}
          </p>
        ) : null}

        {batch.length ? (
          <p className={`dao-note${estimateCpu(batch.length) > CPU_LIMIT_US ? ' dao-note--bad' : ''}`}>
            {batch.length} action{batch.length === 1 ? '' : 's'} in one transaction, about{' '}
            {Math.round(estimateCpu(batch.length) / 1000)} ms of the {CPU_LIMIT_US / 1000} ms a transaction may
            spend — measured from the live writes, where each cost between 114 and 330 µs.
            {estimateCpu(batch.length) > CPU_LIMIT_US
              ? ' That is over the limit, so this would be refused. Copy a smaller group.'
              : ''}
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
