import { useState } from 'react'
import { host } from './ipc.ts'
import type { Task } from './taskTypes.ts'
import './Comparison.css'

type ComparisonContent = Pick<Task, 'goal' | 'sources' | 'answer' | 'message' | 'comparison'>

export default function ComparisonResults({ task, archived = false }: { task: ComparisonContent; archived?: boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const comparison = task.comparison
  if (!comparison) return null
  const sourceFor = (id: number) => task.sources.find(source => source.id === id)
  const openSource = (id: number) => {
    const source = sourceFor(id)
    if (source) host.send({ type: 'newTab', url: source.url })
  }
  const plain = (value: string) => value.replace(/[\t\r\n]+/g, ' ')
  const copiedText = [
    archived ? 'Rovuka saved selected-page comparison (historical)' : 'Rovuka selected-page comparison',
    task.goal,
    task.answer || task.message || '',
    `Snapshots: ${comparison.capturedAt}`,
    ['Page', ...comparison.columns].join('\t'),
    ...comparison.rows.map(row => [sourceFor(row.sourceId)?.title || `Source [${row.sourceId}]`,
      ...row.quotes.map(quote => quote === null ? 'Unknown' : `${plain(quote)} [${row.sourceId}]`)].map(plain).join('\t')),
    '',
    ...task.sources.map(source => `[${source.id}] ${source.title} (${source.kind === 'search' ? 'Search lead' : 'Captured page'}) ${source.url}`),
    '',
    'Source membership is checked; criterion selection and quote placement are model judgments. Search snippets are leads, not provider-confirmed facts. Unknown is not zero, free or unavailable. Live prices and availability still need checking.',
  ].join('\n')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copiedText)
      setCopyState('copied')
    } catch {
      setCopyState('manual')
    }
  }
  return <section className="findings-section comparison-results" aria-label="Selected-tab comparison">
    <div className="findings-section-heading"><h2>{archived ? 'Saved selected-page comparison' : 'Compare your selected pages'}</h2>
      <button className="assistant-secondary" onClick={() => void copy()}>
        {copyState === 'copied' ? 'Comparison copied' : 'Copy comparison with sources'}
      </button>
    </div>
    <p>{task.answer || task.message}</p>
    <div className="comparison-metadata">
      <span>{comparison.rows.length} distinct sources</span><span>{comparison.columns.length} criteria</span>
      <span>{comparison.unknownCells} unknown cells</span>
      <time dateTime={comparison.capturedAt}>Snapshot run: {new Date(comparison.capturedAt).toLocaleString()}</time>
    </div>
    {comparison.duplicateTabs > 0 && <p>{comparison.duplicateTabs} duplicate tab copies excluded. Each page is counted only once.</p>}
    <div className="comparison-scroll" role="region" aria-label="Scrollable page comparison table" tabIndex={0}>
      <table className="comparison-table">
        <caption>{archived ? 'Historical source-checked quotes, not reverified today.' : 'Exact source-checked quotes, not estimates.'} Scroll sideways to see all criteria.</caption>
        <thead><tr><th scope="col">Selected page</th>{comparison.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
        <tbody>{comparison.rows.map(row => <tr key={row.sourceId}>
          <th scope="row"><button className="comparison-source" title="Open source in a new tab"
            onClick={() => openSource(row.sourceId)}>{sourceFor(row.sourceId)?.title || 'Untitled page'} [{row.sourceId}]</button>
            {sourceFor(row.sourceId)?.kind === 'search' && <span className="comparison-unknown">Search lead, not provider-confirmed evidence</span>}</th>
          {row.quotes.map((quote, index) => <td key={index}>{quote === null
            ? <span className="comparison-unknown">Unknown<span>Not established by this source</span></span>
            : <><q>{quote}</q><button className="comparison-citation" title="Open supporting source in a new tab"
              onClick={() => openSource(row.sourceId)}>Source [{row.sourceId}]</button></>}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <aside className="comparison-caveat">{archived ? 'These quotes were checked against their protected page snapshots and quarantined evidence when captured; they have not been reverified.' : "Rovuka checks each quote against both its protected page snapshot and that page's quarantined evidence."}
      Criterion selection and quote placement are model judgments, not independently verified.
      Search snippets remain leads, not provider-confirmed facts.
      Unknown does not mean zero, free or unavailable. Dates, totals, fees and live availability still need checking.
      No original tab was navigated and no transaction was authorized.</aside>
    {copyState === 'manual' && <div className="comparison-copy">
      <p role="alert">Clipboard access is unavailable. Select and copy the comparison below.</p>
      <textarea readOnly rows={8} aria-label="Comparison text with sources" value={copiedText}
        onFocus={event => event.currentTarget.select()} />
    </div>}
  </section>
}
