import { useEffect, useMemo, useState } from 'react'
import {
  CLASSES,
  PLANETS,
  STAT_NAMES,
  blankWeather,
  delWeatherAction,
  fetchWeather,
  newWeatherId,
  setWeatherAction,
  summarise,
  type Weather,
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
