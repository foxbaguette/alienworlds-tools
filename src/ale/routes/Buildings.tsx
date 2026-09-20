import { useEffect, useMemo, useState } from 'react'
import {
  KIND_LABEL,
  fetchBuildings,
  fetchOwners,
  ratingNow,
  type Building,
  type BuildingKind,
} from '../chain/buildings'
import { PLANETS } from '../chain/weather'

const KINDS: BuildingKind[] = ['arena', 'dungeon', 'tavern']

/** Every column is sortable; these are what each one sorts on. */
type SortKey = 'land' | 'kind' | 'rating' | 'defenders' | 'owner' | 'tlm' | 'shards'

/**
 * Every arena, dungeon and tavern in the game.
 *
 * Every column sorts, and it opens on what is claimable: that is the number
 * that grows on its own and the one nobody can see from inside the game.
 *
 * Owners arrive a moment after the rest — they come from AtomicAssets, not from
 * the chain — so the column fills in rather than holding the whole list up, and
 * sorting on it before then puts the unknown ones last either way.
 */
export function Buildings() {
  const [rows, setRows] = useState<Building[] | null>(null)
  const [decay, setDecay] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<BuildingKind | 'all'>('all')
  const [planet, setPlanet] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('tlm')
  const [desc, setDesc] = useState(true)

  const read = () => {
    setRows(null)
    setError(null)
    void fetchBuildings()
      .then((data) => {
        setRows(data.buildings)
        setDecay(data.decayPerHour)
        /* Second pass, off chain and allowed to fail. */
        void fetchOwners(data.buildings.map((b) => b.assetId)).then((owners) => {
          if (!owners.size) return
          setRows(data.buildings.map((b) => ({ ...b, owner: owners.get(b.assetId) ?? null })))
        })
      })
      .catch((err: unknown) => {
        console.error('buildings:', err)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(read, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter(
      (b) =>
        (kind === 'all' || b.kind === kind) &&
        (planet === 'all' || b.planet === planet) &&
        (!q ||
          b.land_id.includes(q) ||
          b.planet.includes(q) ||
          (b.owner ?? '').includes(q) ||
          b.defenders.some((d) => d.gamertag.toLowerCase().includes(q) || d.owner.includes(q))),
    )
  }, [rows, kind, planet, query])

  /*
   * Sorting is over the FILTERED list rather than the whole one, so a planet
   * tab and a sort compose instead of fighting. The rating is decayed first —
   * sorting on the stored score would order buildings by when they were last
   * touched as much as by how good they are.
   */
  const sorted = useMemo(() => {
    const value = (b: Building): number | string => {
      switch (sort) {
        case 'land':
          return `${b.planet} ${String(b.x).padStart(3, '0')} ${String(b.y).padStart(3, '0')}`
        case 'kind':
          return `${b.kind} ${String(b.level).padStart(3, '0')}`
        case 'rating':
          return ratingNow(b, decay)
        case 'defenders':
          return b.kind === 'tavern' ? -1 : b.defenders.length
        /* Owners arrive after the rest; an unknown one sorts last either way
           rather than jumping to the top when the column is reversed. */
        case 'owner':
          return b.owner ?? '\uffff'
        case 'shards':
          return b.shards
        default:
          return b.tlm
      }
    }
    return [...shown].sort((a, b) => {
      const x = value(a)
      const y = value(b)
      const cmp = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)
      return desc ? -cmp : cmp
    })
  }, [shown, sort, desc, decay])

  const head = (key: SortKey, label: string, numeric = true) => (
    <th
      className={`${numeric ? 'num ' : ''}cand-th${sort === key ? ' is-sorted' : ''}`}
      onClick={() => {
        if (sort === key) setDesc(!desc)
        else {
          setSort(key)
          /* Numbers read best largest-first, names A to Z. */
          setDesc(numeric)
        }
      }}
      title={`Sort by ${label}`}
    >
      {label}
      {sort === key ? <i>{desc ? '▾' : '▴'}</i> : null}
    </th>
  )

  const totals = useMemo(() => {
    const tlm = shown.reduce((n, b) => n + b.tlm, 0)
    const shards = shown.reduce((n, b) => n + b.shards, 0)
    return { tlm, shards }
  }, [shown])

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Buildings</h1>
          <p className="page__lead">
            Every arena, dungeon and tavern on the six planets, with what its owner can claim right now. Buildings
            live inside their land&rsquo;s row on <code>lands.ale</code>; the defenders come from{' '}
            <code>arena.ale</code> and <code>dungeons.ale</code>, and the owner from the land NFT.
          </p>
        </div>
        <div className="page__actions">
          <button className="btn" type="button" onClick={read} disabled={!rows && !error}>
            Re-read
          </button>
        </div>
      </header>

      {error ? <p className="dao-note dao-note--bad">{error}</p> : null}

      <section className="section">
        <div className="page__actions">
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={kind === 'all'} onClick={() => setKind('all')}>
              All
            </button>
            {KINDS.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}s
              </button>
            ))}
          </div>
          <div className="sections" role="tablist">
            <button type="button" role="tab" aria-selected={planet === 'all'} onClick={() => setPlanet('all')}>
              Every planet
            </button>
            {PLANETS.map((p) => (
              <button key={p} type="button" role="tab" aria-selected={planet === p} onClick={() => setPlanet(p)}>
                {p}
              </button>
            ))}
          </div>
          <input
            className="wx-search"
            type="search"
            value={query}
            placeholder="Search land, owner or defender"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <h2 className="dao-h2">
          {rows ? `${shown.length} building${shown.length === 1 ? '' : 's'}` : 'Reading six planets…'}{' '}
          <span className="dao-dim">
            {rows
              ? `${totals.tlm.toLocaleString('en-US', { maximumFractionDigits: 0 })} TLM and ` +
                `${totals.shards.toLocaleString('en-US', { maximumFractionDigits: 0 })} shards unclaimed`
              : ''}
          </span>
        </h2>

        <div className="dao-tablewrap">
          <table className="dao-table">
            <thead>
              <tr>
                {head('land', 'Land', false)}
                {head('kind', 'Building', false)}
                {head('rating', 'Rating')}
                {head('defenders', 'Defenders')}
                {head('owner', 'Owner', false)}
                {head('tlm', 'Claimable TLM')}
                {head('shards', 'Shards')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => {
                const id = `${b.planet}:${b.land_id}:${b.kind}`
                const rating = ratingNow(b, decay)
                return (
                  <BuildingRow
                    key={id}
                    b={b}
                    rating={rating}
                    open={open === id}
                    onToggle={() => setOpen(open === id ? null : id)}
                  />
                )
              })}
              {rows && !shown.length ? (
                <tr>
                  <td colSpan={7} className="dao-dim">
                    Nothing matches.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function BuildingRow({
  b,
  rating,
  open,
  onToggle,
}: {
  b: Building
  rating: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr className={b.defenders.length ? 'is-clickable' : undefined} onClick={b.defenders.length ? onToggle : undefined}>
        <td>
          <b className="dao-rowtitle">
            {b.planet} {b.x},{b.y}
          </b>
          <span className="dao-rowmeta">
            <span className="dao-rowid">{b.land_id}</span>
            {b.landType ? <span>{b.landType}</span> : null}
            {b.rarity ? <span>{b.rarity}</span> : null}
          </span>
        </td>
        <td>
          <span className={`wp-chip is-${b.kind === 'arena' ? 'go' : b.kind === 'dungeon' ? 'work' : 'wait'}`}>
            {KIND_LABEL[b.kind]}
          </span>
          <span className="dao-dim"> lvl {b.level}</span>
        </td>
        <td className="num" title={`${b.boostScore.toLocaleString('en-US')} stored, decayed to now`}>
          {Math.round(rating).toLocaleString('en-US')}
        </td>
        <td className="num">
          {b.kind === 'tavern' ? <span className="dao-dim">—</span> : b.defenders.length}
        </td>
        <td>{b.owner ? <span className="dao-rowtitle">{b.owner}</span> : <span className="dao-dim">…</span>}</td>
        <td className="num">
          <b>{b.tlm.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>
        </td>
        <td className="num">{b.shards.toLocaleString('en-US', { maximumFractionDigits: 1 })}</td>
      </tr>
      {open ? (
        <tr className="bld-team">
          <td colSpan={7}>
            <div className="bld-team__list">
              {b.defenders.map((d) => (
                <span key={d.fighter_id} className="bld-fighter">
                  <b>{d.gamertag || d.owner}</b>
                  <i>
                    {d.classname} · {d.racename} · {d.element}
                  </i>
                  <span className="dao-dim">
                    {d.health} hp · {d.damage} dmg · {d.owner}
                  </span>
                </span>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}
