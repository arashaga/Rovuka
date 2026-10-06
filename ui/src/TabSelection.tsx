import { useEffect, useState } from 'react'
import { apiRequest } from './modelApi.ts'
import type { ReadTab, ReadTarget } from './taskTypes.ts'
import './Comparison.css'

export default function TabSelection({ disabled, onSelect }: {
  disabled: boolean; onSelect: (tabs: ReadTarget[]) => void
}) {
  const [tabs, setTabs] = useState<ReadTab[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setSelected([])
    onSelect([])
    void apiRequest<ReadTab[]>('/api/agent/tabs', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setTabs(value)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, onSelect])

  const toggle = (id: number) => {
    const next = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]
    setSelected(next)
    onSelect(tabs.filter(tab => next.includes(tab.target.id) && !tab.unavailable).map(tab => tab.target))
  }

  return <fieldset className="tab-selection" disabled={disabled || loading} aria-label="Select pages for comparison">
    <legend>Choose 2-6 tabs to compare</legend>
    <p>Nothing is selected automatically. Only these unchanged page snapshots can be read. Signed-in cookies still apply; choose pages you intend to share.</p>
    <button className="assistant-secondary" type="button" disabled={disabled || loading}
      onClick={() => setRefresh(value => value + 1)}>Refresh tabs & clear selection</button>
    {loading && <p role="status">Listing tab titles and addresses, not reading page content...</p>}
    {error && <p className="task-error" role="alert">{error}</p>}
    {!loading && !error && tabs.length === 0 && <p>Open at least two public pages in separate tabs, then refresh this list.</p>}
    {!loading && !error && <div className="tab-selection-list">{tabs.map(tab =>
      <label className={`tab-selection-item${tab.unavailable ? ' is-unavailable' : ''}`} key={tab.target.id} data-tab-id={tab.target.id}>
        <input type="checkbox" checked={selected.includes(tab.target.id)}
          disabled={!!tab.unavailable || (!selected.includes(tab.target.id) && selected.length >= 6)}
          onChange={() => toggle(tab.target.id)} />
        <span><strong>{tab.target.title || 'Untitled page'}</strong><small>{tab.target.url || 'Start page'}</small>
          {tab.unavailable && <small>{tab.unavailable}</small>}</span>
      </label>)}</div>}
    <p className="tab-selection-count" role="status">{selected.length}/6 selected. Duplicate page URLs and fragment copies are read once.</p>
  </fieldset>
}
