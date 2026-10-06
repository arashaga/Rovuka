import { useEffect, useRef, useState } from 'react'
import { apiRequest } from './modelApi.ts'
import { host } from './ipc.ts'
import ComparisonResults from './ComparisonResults.tsx'
import type { Task } from './taskTypes.ts'
import type { MemoryArchive, MemoryItem, MemoryOverview, MemoryPreview, PersonalPreferences, SharedMemoryContext } from './memoryTypes.ts'
import './Memory.css'

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const time = (value: string) => new Date(value).toLocaleString()

export function MemoryContextPreview({ context }: { context: SharedMemoryContext }) {
  return <details className="memory-preview" open>
    <summary>Exact saved context to share</summary>
    <p>Historical notes, not fresh evidence or action permission. Only this selection is shared; the rest of your memory stays local.</p>
    <textarea readOnly rows={8} aria-label="Exact memory context for the model" value={JSON.stringify(context, null, 2)} />
  </details>
}

export function SaveResearch({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  if (task.mode !== 'research' || !['completed', 'noEvidence'].includes(task.status)
    || (!task.answer && !task.comparison && !task.report)) return null
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/memory/research', { method: 'POST', body: JSON.stringify({ taskId: task.id }) })
      setSaved(true)
    } catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }
  return <div className="memory-save" aria-label="Save research locally">
    <button className="assistant-secondary" disabled={busy || saved} onClick={() => void save()}>
      {busy ? 'Saving locally...' : saved ? 'Saved in Memory' : 'Save research to Memory'}
    </button>
    {saved && <button className="assistant-secondary" onClick={() => host.send({ type: 'openAssistant', panel: 'memory' })}>Open Memory</button>}
    {error && <p className="task-error" role="alert">{error}</p>}
  </div>
}

function SavedResearch({ archive }: { archive: MemoryArchive }) {
  return <div className="memory-archive">
    <p className="memory-stale" role="note">Saved snapshot from {time(archive.capturedAt)}. Prices, availability and facts may be stale.
      This is not a live task, new verification or permission to prepare or book anything.</p>
    <h3>{archive.report?.title || archive.goal}</h3>
    <p className="memory-prose">{archive.report?.summary || archive.answer || archive.message}</p>
    {archive.comparison && <ComparisonResults task={archive} archived />}
    {archive.report?.options.map((option, index) => <article className="memory-option" key={index}>
      <h4>{index + 1}. {option.name}</h4><p>{option.fit}</p><p>{option.details}</p>
      {option.offer && <p><strong>Historical subtotal: {new Intl.NumberFormat(undefined, { style: 'currency', currency: option.offer.currency }).format(option.offer.totalMinor / 100)}</strong>
        {' '}{option.offer.scope}<br />{option.offer.exclusions}</p>}
      <p>{option.tradeoffs}</p>
      {option.links.map((link, n) => <button className="assistant-secondary" key={n}
        onClick={() => host.send({ type: 'newTab', url: link.url })}>Revisit {link.label}</button>)}
    </article>)}
    {archive.report?.findings.map((finding, index) => <article className="memory-option" key={index}>
      <h4>{finding.title}</h4><p>{finding.detail}</p>
    </article>)}
    {!!archive.report?.gaps.length && <><h4>Recorded gaps</h4><ul>{archive.report.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></>}
    {archive.answer && archive.report && <details><summary>Saved explanation</summary><p className="memory-prose">{archive.answer}</p></details>}
    <h4>Original source links</h4>
    {archive.sources.map(source => <button className="task-source" key={source.id}
      onClick={() => host.send({ type: 'newTab', url: source.url })}>
      <strong>[{source.id}] {source.title}</strong><span>{source.url}</span>
    </button>)}
  </div>
}

export default function Memory({ onResearch }: { onResearch: (preview: MemoryPreview) => void }) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [preferences, setPreferences] = useState<PersonalPreferences>({ travel: '', shopping: '', research: '' })
  const [sites, setSites] = useState('')
  const [retention, setRetention] = useState(30)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [detail, setDetail] = useState<MemoryItem | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [after, setAfter] = useState('')
  const [offset, setOffset] = useState(0)
  const [more, setMore] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [includePreferences, setIncludePreferences] = useState(false)
  const [preview, setPreview] = useState<MemoryPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<'all' | number | null>(null)
  const [activeTab, setActiveTab] = useState<number | null>(null)
  const alive = useRef(true)
  const detailRequest = useRef(0)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    Promise.all([
      apiRequest<MemoryOverview>('/api/memory', { signal: controller.signal }),
      apiRequest<PersonalPreferences>('/api/memory/preferences', { signal: controller.signal }),
      apiRequest<{ items: MemoryItem[]; more: boolean }>('/api/memory/search', { signal: controller.signal }),
    ]).then(([overview, preferences, search]) => {
      if (!alive.current) return
      setOverview(overview)
      setSites(overview.config.excludedSites.join('\n'))
      setRetention(overview.config.retentionDays)
      setPreferences(preferences)
      setItems(search.items)
      setMore(search.more)
      setReady(true)
    }).catch(reason => { if (alive.current) setError(message(reason)) })
    const unsubscribe = host.subscribe(event => { if (event.type === 'tabs') setActiveTab(event.active) })
    return () => { alive.current = false; controller.abort(); unsubscribe() }
  }, [])

  const run = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try { await operation() }
    catch (reason) { if (alive.current) setError(message(reason)) }
    finally { if (alive.current) setBusy(false) }
  }
  const refresh = async (nextOffset = 0) => {
    const params = new URLSearchParams({ q: query, kind, after, offset: String(nextOffset) })
    const [overview, result] = await Promise.all([
      apiRequest<MemoryOverview>('/api/memory'),
      apiRequest<{ items: MemoryItem[]; more: boolean }>(`/api/memory/search?${params}`),
    ])
    if (!alive.current) return
    detailRequest.current++
    setOverview(overview)
    setItems(result.items)
    setMore(result.more)
    setOffset(nextOffset)
    setDetail(null)
    setPreview(null)
    setSelected([])
    setReady(true)
  }
  const show = async (id: number) => {
    const version = ++detailRequest.current
    setDetail(null)
    const item = await apiRequest<MemoryItem>(`/api/memory/item?id=${id}`)
    if (alive.current && detailRequest.current === version) setDetail(item)
  }
  const configure = async (enabled: boolean) => {
    await apiRequest('/api/memory/config', { method: 'PUT', body: JSON.stringify({
      captureEnabled: enabled, retentionDays: retention,
      excludedSites: sites.split(/\n/).map(site => site.trim()).filter(Boolean),
    }) })
    setPreview(null)
    await refresh()
    setNotice(enabled ? 'Capture enabled for future public page loads. Existing tabs are not read retroactively; reload or navigate to remember a page.'
      : 'Automatic capture paused. Existing saved items are retained; any excluded-site items were removed.')
  }
  const forget = async () => {
    if (confirm === null) return
    await apiRequest(confirm === 'all' ? '/api/memory/clear' : '/api/memory/forget', {
      method: 'POST', body: JSON.stringify(confirm === 'all' ? { confirm: true } : { id: confirm, confirm: true }),
    })
    if (confirm === 'all') {
      setPreferences({ travel: '', shopping: '', research: '' })
      setIncludePreferences(false)
    }
    setConfirm(null)
    await refresh()
    setNotice('Selected memory deleted. Clear all also removes preferences and pauses capture. Browser cookies, downloads, task audits and already-shared model context are not deleted.')
  }

  return <section className="memory-panel" aria-label="Browser memory">
    <header className="memory-heading"><span className="local-eyebrow">Remember locally. Share deliberately.</span>
      <h2>Your web, worth keeping.</h2>
      <p>Find pages by words or date. Save research for later. No model is needed to search, and nothing is uploaded automatically.</p>
    </header>
    {error && <p className="task-error" role="alert">{error}</p>}
    {notice && <p className="safety-feedback" role="status">{notice}</p>}
    {!ready && !error && <p role="status">Loading local memory...</p>}
    <div className="memory-actions">
      <button className="assistant-secondary" disabled={busy} onClick={() => void run(() => refresh())}>Refresh memory</button>
      <button className="assistant-secondary" disabled={busy || activeTab === null || !ready} onClick={() => void run(async () => {
        await apiRequest('/api/memory/page', { method: 'POST', body: JSON.stringify({ tabId: activeTab }) })
        await refresh()
        setNotice('A bounded, form-free page snapshot was saved locally. No model was called.')
      })}>Save current page locally</button>
    </div>
    {overview && <section className="memory-card" aria-label="Memory privacy settings">
      <div className="memory-card-heading"><h3>Capture & privacy</h3><span className="memory-badge">{overview.config.captureEnabled ? 'Capture on' : 'Capture paused'}</span></div>
      <p>Off by default. Public-page text only, up to 12,000 characters. Form values and recognizable secrets are excluded; detection is not exhaustive.</p>
      <button className="assistant-secondary" disabled={busy} onClick={() => void run(() => configure(!overview.config.captureEnabled))}>
        {overview.config.captureEnabled ? 'Pause automatic capture' : 'Enable automatic capture'}
      </button>
      <details className="memory-settings"><summary>Site exclusions, retention & storage</summary>
        <label htmlFor="memory-sites">Never remember these sites (one hostname per line)</label>
        <textarea id="memory-sites" rows={3} value={sites} disabled={busy} placeholder="example.com" onChange={event => setSites(event.target.value)} />
        <label htmlFor="memory-retention">Keep saved pages and research for this many days</label>
        <input id="memory-retention" type="number" min={1} max={365} value={retention} disabled={busy} onChange={event => setRetention(Number(event.target.value))} />
        <button className="assistant-secondary" disabled={busy} onClick={() => void run(() => configure(overview.config.captureEnabled))}>Apply memory settings</button>
        <p>Applying exclusions deletes matching pages and saved research containing those sources. Subdomains are included. Retention applies to both pages and research; preferences remain until edited or cleared. Keeps at most {overview.maxItems} items.</p>
        <p>Local SQLite, not encrypted by Rovuka: {overview.directory}. Your OS account protects this file. Account, payment and recognizable message pages are blocked, but signed-in cookies are still shared with ordinary browsing.</p>
      </details>
      {overview.lastError && <p className="task-error" role="alert">A page could not be remembered: {overview.lastError}</p>}
    </section>}
    <form className="memory-search" onSubmit={event => { event.preventDefault(); void run(() => refresh()) }}>
      <label htmlFor="memory-query">Search your local memory</label>
      <input id="memory-query" maxLength={200} value={query} disabled={busy} placeholder="Rust, hotels, headphones..." onChange={event => { setQuery(event.target.value); setPreview(null) }} />
      <div className="memory-filters"><label>Category<select value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setPreview(null) }}>
        <option value="all">Everything</option><option value="page">Saved pages</option><option value="research">Saved research</option>
      </select></label><label>Saved on or after<input type="date" value={after} disabled={busy} onChange={event => { setAfter(event.target.value); setPreview(null) }} /></label></div>
      <button className="assistant-primary" disabled={busy || !ready} type="submit">Search locally</button>
    </form>
    {ready && <><p className="memory-count">{overview?.pages ?? 0} pages · {overview?.research ?? 0} research snapshots</p>
      {!items.length && <div className="safety-empty"><strong>No matching memories yet.</strong><p>Save a page manually, enable capture and browse, or save a completed comparison.</p></div>}
      <div className="memory-list">{items.map(item => <article className="memory-item" key={item.id} data-memory-id={item.id}>
        <label className="memory-select"><input type="checkbox" checked={selected.includes(item.id)}
          disabled={busy || (!selected.includes(item.id) && selected.length >= 5)}
          onChange={event => { setSelected(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id)); setPreview(null) }} />
          Select for model context</label>
        <button className="memory-item-title" disabled={busy} onClick={() => void run(() => show(item.id))}>{item.title || 'Saved page'}</button>
        <small>{item.kind === 'research' ? 'Research snapshot' : 'Page snapshot'} · {time(item.capturedAt)}</small>
        <p>{item.excerpt}</p>
        <button className="assistant-secondary" disabled={busy} onClick={() => setConfirm(item.id)}>Forget this item</button>
      </article>)}</div>
      <div className="memory-actions">
        <button className="assistant-secondary" disabled={busy || offset === 0} onClick={() => void run(() => refresh(Math.max(0, offset - 50)))}>Previous memories</button>
        <button className="assistant-secondary" disabled={busy || !more} onClick={() => void run(() => refresh(offset + 50))}>More memories</button>
      </div>
    </>}
    {detail && <section className="memory-card memory-detail" aria-label="Saved memory details">
      <div className="memory-card-heading"><h3>{detail.title}</h3><button className="assistant-secondary" onClick={() => setDetail(null)}>Close details</button></div>
      <time dateTime={detail.capturedAt}>Saved: {time(detail.capturedAt)}</time>
      {detail.research ? <SavedResearch archive={detail.research} /> : <><p className="memory-stale">Historical, bounded page snapshot. Revisit to verify facts.</p>
        <p className="memory-prose">{detail.excerpt}</p><button className="assistant-secondary" onClick={() => host.send({ type: 'newTab', url: detail.url })}>Revisit page in a new tab</button></>}
    </section>}
    <section className="memory-card" aria-label="Personal preferences">
      <h3>Personal context</h3><p>Optional travel, shopping and research notes. Not a password, payment or identity vault. Preferences never fill forms or grant approvals automatically.</p>
      <form className="memory-settings" onSubmit={event => { event.preventDefault(); void run(async () => {
        await apiRequest('/api/memory/preferences', { method: 'PUT', body: JSON.stringify(preferences) })
        setPreview(null)
        setNotice('Preferences saved locally. Select them and preview before sharing with a new research task.')
      }) }}>
        {(['travel', 'shopping', 'research'] as const).map(category => <label key={category} htmlFor={`memory-${category}`}>
          {category[0].toUpperCase() + category.slice(1)} notes
          <textarea id={`memory-${category}`} rows={2} maxLength={500} disabled={busy} value={preferences[category]}
            placeholder={category === 'travel' ? 'Prefer nonstop flights and aisle seats.' : category === 'shopping' ? 'Prefer repairable products and a two-year warranty.' : 'Prefer official sources and concise comparisons.'}
            onChange={event => { setPreferences(previous => ({ ...previous, [category]: event.target.value })); setPreview(null) }} />
        </label>)}
        <button className="assistant-secondary" type="submit" disabled={busy || !ready}>Save preferences locally</button>
      </form>
    </section>
    <section className="memory-card" aria-label="Explicit memory sharing">
      <h3>Choose what the model sees</h3><p>Select up to five saved items. Nothing is preselected or shared by opening this panel.</p>
      <label className="check-label"><input id="memory-include-preferences" type="checkbox" checked={includePreferences} disabled={busy}
        onChange={event => { setIncludePreferences(event.target.checked); setPreview(null) }} />Include my saved preferences</label>
      <button className="assistant-secondary" disabled={busy || (!selected.length && !includePreferences) || !ready}
        onClick={() => void run(async () => setPreview(await apiRequest<MemoryPreview>('/api/memory/preview', {
          method: 'POST', body: JSON.stringify({ ids: selected, includePreferences }),
        })))}>Preview selected context</button>
      {preview && <><MemoryContextPreview context={preview.context} /><p>Preview expires in five minutes. Continue to a fresh research draft, then give separate sharing consent.</p>
        <button className="assistant-primary memory-context-start" disabled={busy} onClick={() => onResearch(preview)}>Use in a new research draft</button></>}
    </section>
    <section className="memory-card"><h3>Start fresh</h3><p>Clear saved pages, research and preferences, and pause capture. This does not erase browser history, cookies, downloads, audit logs or context already sent to a model.</p>
      <button className="assistant-secondary" disabled={busy || !ready} onClick={() => setConfirm('all')}>Clear all local memory</button>
    </section>
    {confirm !== null && <div className="memory-confirm" role="alertdialog" aria-label="Confirm memory deletion">
      <strong>{confirm === 'all' ? 'Delete all local memory and pause capture?' : 'Forget this saved item?'}</strong>
      <p>This removes the saved content and its search-index entries. OS backups and previously shared model context are not erased.</p>
      <div className="memory-actions"><button className="assistant-primary" disabled={busy} onClick={() => void run(forget)}>Confirm deletion</button>
        <button className="assistant-secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel deletion</button></div>
    </div>}
  </section>
}
