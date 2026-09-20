import { useEffect, useMemo, useState } from 'react'
import {
  PERCENT_FLAT,
  STATS,
  TARGETS,
  TRIGGERS,
  blankAbility,
  blankEffect,
  clearScopeAction,
  fetchAbilities,
  fetchAbilityClasses,
  newAbilityId,
  setAbilityAction,
  summarise,
  type AbilityClass,
  type AbilityTemplate,
  type SpecialAbility,
} from '../chain/abilities'
import { isCancel, readableError, type ChainAction } from '../../dao/chain/act'
import { useSession } from '../../wallet/session'

/**
 * The ability catalogue on `creation.ale`.
 *
 * Built like the weather page, because it is the same job: a few thousand rows
 * spread over pools, searched rather than scrolled, with copying an existing
 * one as the normal way to make a new one. Every ability here is a variation
 * on another, and starting from blank means retyping an effect list that
 * already exists.
 *
 * The one real difference is deletion. `setability` writes into a list of
 * pools at a weight each, but the contract has nothing that removes a single
 * ability — only `clearability`, which empties an entire pool. So retiring one
 * is writing it back at weight 0, and the pool wipe is kept well away from it.
 */
export function AbilityAdmin() {
  const { session } = useSession()
  const [classes, setClasses] = useState<AbilityClass[] | null>(null)
  const [scope, setScope] = useState<string | null>(null)
  const [all, setAll] = useState<AbilityTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ ability: SpecialAbility; weight: number } | null>(null)
  const [targets, setTargets] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  useEffect(() => {
    void fetchAbilityClasses()
      .then((cs) => {
        setClasses(cs)
        const first = cs[0]?.scopes[0]
        if (first) {
          setScope(first)
          setTargets(new Set([first]))
        }
      })
      .catch((err: unknown) => {
        console.error('ability classes:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  const read = () => {
    if (!scope) return
    setAll(null)
    setError(null)
    setSelected(null)
    fetchAbilities(scope)
      .then(setAll)
      .catch((err: unknown) => {
        console.error(`abilities in ${scope}:`, err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [scope])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = [...(all ?? [])].sort((a, b) => b.weight - a.weight)
    if (!q) return rows.slice(0, 200)
    return rows
      .filter(
        (t) =>
          t.ability_id.includes(q) ||
          t.ability.displayname.toLowerCase().includes(q) ||
          t.ability.description.toLowerCase().includes(q) ||
          t.ability.bf_effects.some((e) => e.stat_name.includes(q)),
      )
      .slice(0, 200)
  }, [all, query])

  const chosen = all?.find((t) => t.ability_id === selected) ?? null

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
        console.error('ability write failed:', err)
        setNote({ text: readableError(err), bad: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!draft) return
    if (!draft.ability.displayname.trim()) return setNote({ text: 'Give it a display name.', bad: true })
    if (!targets.size) return setNote({ text: 'Pick at least one pool.', bad: true })
    const pools = [...targets]
    void sign(
      [setAbilityAction(level(), pools, pools.map(() => Math.max(0, Math.round(draft.weight))), draft.ability)],
      `Writing ${draft.ability.ability} to ${pools.length} pool${pools.length === 1 ? '' : 's'}`,
    )
  }

  /* "Delete" is a weight of zero in the pools it is in — see the module note. */
  const retire = () => {
    if (!chosen) return
    const pools = [...targets]
    if (!pools.length) return setNote({ text: 'Pick the pools to retire it from.', bad: true })
    void sign(
      [setAbilityAction(level(), pools, pools.map(() => 0), chosen.ability)],
      `Retiring ${chosen.ability_id} in ${pools.length} pool${pools.length === 1 ? '' : 's'}`,
    )
  }

  const wipe = () => {
    if (!scope) return
    if (!window.confirm(`Delete EVERY ability in ${scope}? There is no undo, and no way to remove just one.`)) return
    void sign([clearScopeAction(level(), scope)], `Clearing ${scope}`)
  }

  const toggle = (s: string) =>
    setTargets((prev) => {
      const next = new Set(prev)
      if (!next.delete(s)) next.add(s)
      return next
    })

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Abilities</h1>
          <p className="page__lead">
            The ability pools on <code>creation.ale</code> that <code>rndfighter</code> rolls from. Each class
            draws on its own pools, weighted — a higher weight means it comes up more often, and a weight of 0
            means never.
          </p>
        </div>
        <div className="page__actions">
          <button className="btn" type="button" onClick={read} disabled={busy || !scope}>
            Re-read
          </button>
        </div>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}
      {note ? <p className={`dao-note${note.bad ? ' dao-note--bad' : ''}`}>{note.text}</p> : null}

      <section className="section">
        <h2 className="dao-h2">
          Pools{' '}
          <span className="dao-dim">
            browsing {scope ?? '…'} · writing to {targets.size}
          </span>
        </h2>
        {(classes ?? []).map((c) => (
          <div key={c.classname} className="abil-class">
            <span className="ale-field__name">{c.classname}</span>
            <div className="pause-grid">
              {c.scopes.map((s) => (
                <span key={s} className={`pause-chip${targets.has(s) ? ' is-target' : ''}`}>
                  <input type="checkbox" checked={targets.has(s)} onChange={() => toggle(s)} />
                  <button
                    type="button"
                    className={`abil-scope${s === scope ? ' is-open' : ''}`}
                    onClick={() => setScope(s)}
                  >
                    {s}
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
        <p className="dao-dim">
          The tick decides where a write lands; the name opens that pool below. They are separate on purpose —
          you read one pool and usually write to several.
        </p>
      </section>

      <section className="section">
        <div className="page__actions">
          <h2 className="dao-h2">
            {scope ?? 'No pool'}{' '}
            <span className="dao-dim">{all ? `${shown.length} shown of ${all.length}` : 'reading…'}</span>
          </h2>
          <input
            className="wx-search"
            type="search"
            value={query}
            placeholder="Search name, text or stat"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="btn"
            type="button"
            disabled={!chosen}
            onClick={() =>
              chosen &&
              setDraft({
                ability: { ...structuredClone(chosen.ability), ability: newAbilityId() },
                weight: chosen.weight,
              })
            }
          >
            Copy as template
          </button>
          <button
            className="btn"
            type="button"
            disabled={!chosen}
            onClick={() => chosen && setDraft({ ability: structuredClone(chosen.ability), weight: chosen.weight })}
          >
            Edit selected
          </button>
          <button className="btn" type="button" onClick={() => setDraft({ ability: blankAbility(), weight: 100 })}>
            New ability
          </button>
          <button className="btn btn--warn" type="button" disabled={!chosen || !session || busy} onClick={retire}>
            Retire selected
          </button>
        </div>

        <div className="dao-tablewrap wx-list">
          <table className="dao-table">
            <thead>
              <tr>
                <th className="tick" />
                <th>Ability</th>
                <th>What it does</th>
                <th className="num">Weight</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr
                  key={t.ability_id}
                  className={selected === t.ability_id ? 'is-picked' : undefined}
                  onClick={() => setSelected(t.ability_id)}
                >
                  <td className="tick">
                    <input
                      type="radio"
                      checked={selected === t.ability_id}
                      onChange={() => setSelected(t.ability_id)}
                    />
                  </td>
                  <td>
                    <b className="dao-rowtitle">{t.ability.displayname || t.ability_id}</b>
                    <span className="dao-rowmeta">
                      <span className="dao-rowid">{t.ability_id}</span>
                      {t.ability.locked ? <span>locked</span> : null}
                    </span>
                  </td>
                  <td className="dao-dim">{summarise(t.ability)}</td>
                  <td className="num">
                    <b className={t.weight ? undefined : 'dao-dim'}>{t.weight}</b>
                  </td>
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

        <p className="page__actions">
          <button className="btn btn--warn" type="button" disabled={!session || busy || !scope} onClick={wipe}>
            Clear the whole {scope ?? 'pool'}
          </button>
          <span className="dao-dim">
            The contract has no way to delete one ability. Retiring sets its weight to 0, which takes it out of
            the roll; this button empties the pool.
          </span>
        </p>
      </section>

      {draft ? (
        <AbilityForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
          busy={busy}
          canSign={!!session}
          pools={targets.size}
        />
      ) : null}
    </div>
  )
}

function AbilityForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
  canSign,
  pools,
}: {
  draft: { ability: SpecialAbility; weight: number }
  setDraft: (d: { ability: SpecialAbility; weight: number }) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
  canSign: boolean
  pools: number
}) {
  const a = draft.ability
  const set = (patch: Partial<SpecialAbility>) => setDraft({ ...draft, ability: { ...a, ...patch } })

  const setEffect = (i: number, patch: Partial<SpecialAbility['bf_effects'][number]>) =>
    set({ bf_effects: a.bf_effects.map((e, n) => (n === i ? { ...e, ...patch } : e)) })

  return (
    <section className="section wx-form">
      <h2 className="dao-h2">
        {a.displayname || 'New ability'} <span className="dao-dim">{a.ability}</span>
      </h2>

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Display name<i>what players see</i>
          </span>
          <input type="text" value={a.displayname} onChange={(e) => set({ displayname: e.target.value })} />
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Weight<i>how often it is rolled; 0 is never</i>
          </span>
          <input
            type="number"
            min={0}
            value={draft.weight}
            onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <label className="ale-field">
        <span className="ale-field__name">
          Description<i>[bf:0:value] is replaced by the first effect&rsquo;s value</i>
        </span>
        <textarea rows={2} value={a.description} onChange={(e) => set({ description: e.target.value })} />
      </label>

      <h3 className="ale-field__name">When it fires</h3>
      <div className="pause-grid">
        {TRIGGERS.map((t) => (
          <label key={t.key} className={`pause-chip${Number(a[t.key]) ? ' is-target' : ''}`}>
            <input
              type="checkbox"
              checked={!!Number(a[t.key])}
              onChange={() => set({ [t.key]: Number(a[t.key]) ? 0 : 1 } as Partial<SpecialAbility>)}
            />
            <span>{t.label}</span>
          </label>
        ))}
      </div>

      <div className="ale-form">
        <label className="ale-field">
          <span className="ale-field__name">
            Applies to<i>who the effects land on</i>
          </span>
          <select value={a.bf_target} onChange={(e) => set({ bf_target: e.target.value })}>
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {t || '(nobody)'}
              </option>
            ))}
          </select>
        </label>
        <label className="ale-field">
          <span className="ale-field__name">
            Retargets<i>changes who this fighter attacks</i>
          </span>
          <select value={a.target_change} onChange={(e) => set({ target_change: e.target.value })}>
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {t || '(no change)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="ale-field__name">
        Effects<i>min and max are what the roll picks between</i>
      </h3>
      <div className="wx-effects">
        {a.bf_effects.map((e, i) => (
          <div key={i} className="wx-effect">
            <select value={e.stat_name} onChange={(ev) => setEffect(i, { stat_name: ev.target.value })}>
              {STATS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select value={e.percentflat} onChange={(ev) => setEffect(i, { percentflat: ev.target.value })}>
              {PERCENT_FLAT.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label>
              <span>min</span>
              <input
                type="number"
                value={e.value_min}
                onChange={(ev) => setEffect(i, { value_min: Number(ev.target.value) || 0 })}
              />
            </label>
            <label>
              <span>max</span>
              <input
                type="number"
                value={e.value_max}
                onChange={(ev) => setEffect(i, { value_max: Number(ev.target.value) || 0 })}
              />
            </label>
            <button
              className="btn"
              type="button"
              disabled={a.bf_effects.length === 1}
              onClick={() => set({ bf_effects: a.bf_effects.filter((_, n) => n !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="btn"
          type="button"
          onClick={() => set({ bf_effects: [...a.bf_effects, blankEffect()] })}
        >
          Add an effect
        </button>
      </div>

      {a.if_effects.length || a.eof_effects.length ? (
        <p className="dao-note">
          This ability also carries {a.if_effects.length} conditional and {a.eof_effects.length} end-of-fight
          effect{a.if_effects.length + a.eof_effects.length === 1 ? '' : 's'}. They are kept exactly as they are
          — they are not editable here, and a copy keeps them.
        </p>
      ) : null}

      <div className="page__actions">
        <button className="btn btn--go" type="button" disabled={!canSign || busy || !pools} onClick={onSave}>
          {busy ? 'Signing…' : `Write to ${pools} pool${pools === 1 ? '' : 's'}`}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {!canSign ? <span className="dao-dim">Connect a wallet to save.</span> : null}
        {!pools ? <span className="dao-dim">Tick at least one pool above.</span> : null}
      </div>
    </section>
  )
}
