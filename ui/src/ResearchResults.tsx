import { useEffect, useRef } from 'react'
import { host } from './ipc.ts'
import { taskActive, type Task, type ResearchReport } from './taskTypes.ts'
import TaskDiagnostic, { DiagnosticActions } from './TaskDiagnostic.tsx'
import SafetyNotice from './SafetyNotice.tsx'

type Offer = NonNullable<ResearchReport['options'][number]['offer']>
const bases: Record<Offer['basis'], string> = {
  tripTotal: 'Flight + hotel subtotal', itemTotal: 'Item subtotal', serviceTotal: 'Service subtotal',
  stayTotal: 'Stay subtotal', perNight: 'Per night', perPersonRoundTrip: 'Per person · round trip',
}
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100)
const priceGroup = (offer: Offer) => `${offer.currency}|${offer.basis}|${offer.scope}`

function Brief({ text }: { text: string }) {
  return <div className="findings-prose">{text.split(/\n\s*\n/).filter(Boolean).map((block, index) => {
    const heading = block.match(/^#{1,4}\s+(.+)$/)
    return heading ? <h3 key={index}>{heading[1]}</h3> : <p key={index}>{block}</p>
  })}</div>
}

const verticals = {
  web: { badge: 'Web', read: 'Search leads, not confirmed offers', revisit: 'Revisit search' },
  flights: { badge: 'Flights', read: 'Date-specific fares · confirm on the provider', revisit: 'Open flight results' },
  hotels: { badge: 'Hotels', read: 'Date-specific rates · confirm on the provider', revisit: 'Open hotel results' },
} as const

export function SearchTrail({ task }: { task: Task }) {
  if (!task.searches.length) return null
  return <section className="search-trail" aria-label="Searches performed">
    <h3>Searches performed <span>{task.searches.length}</span></h3>
    <ol>{task.searches.map((search, index) => {
      const vertical = verticals[search.vertical] ?? verticals.web
      return <li key={index} data-vertical={search.vertical}>
        <span className="search-number">{index + 1}</span>
        <div><span className="search-vertical">{vertical.badge}</span><strong>{search.query}</strong>
          <small>{search.sourceId ? `Read as source [${search.sourceId}] · ${vertical.read}`
            : taskActive(task) ? 'Opening / reading the approved search' : 'Opened · Reading not completed'}</small>
          {!taskActive(task) && <button className="search-revisit" title="Open in a new tab"
            onClick={() => host.send({ type: 'newTab', url: search.url })}>{vertical.revisit}</button>}
        </div>
      </li>
    })}</ol>
  </section>
}

export default function ResearchResults({ task, onBack, onNew, onRetry }: {
  task: Task; onBack: () => void; onNew: () => void; onRetry: () => void
}) {
  const region = useRef<HTMLElement>(null)
  useEffect(() => { region.current?.focus({ preventScroll: true }) }, [task.id])
  const report = task.report
  const complete = task.status === 'completed'
  const recommendation = report?.recommendedOption === null ? undefined : report?.recommendedOption
  const priceGroups = new Set(report?.options.flatMap(option => option.offer ? [priceGroup(option.offer)] : []))
  const hasOptions = complete && !!report?.options.length
  const openSource = (id: number) => {
    const source = task.sources.find(source => source.id === id)
    if (source) host.send({ type: 'newTab', url: source.url })
  }
  const evidence = (ids: number[]) => <div className="finding-evidence" aria-label="Supporting sources">
    {ids.map((id, index) => <button key={`${id}-${index}`} title={`${task.sources.find(source => source.id === id)?.title || `Source [${id}]`} — opens in a new tab`}
      onClick={() => openSource(id)}>Source [{id}]</button>)}
  </div>
  const context = <details className="findings-card findings-context"><summary>Research trail & your requirements</summary>
    <h3>Your conversation</h3>
    {task.conversation.map((message, index) => <p key={index}><strong>{message.role === 'user' ? 'You' : 'Assistant'}: </strong>{message.content}</p>)}
    <h3>Activity</h3><ol>{task.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
    <h3>Permission trail</h3><ol>{task.permissionEvents.map((event, index) => <li key={index}>
      <time dateTime={new Date(Number(event.at)).toISOString()}>{new Date(Number(event.at)).toLocaleString()}</time>
      {' · '}{event.decision}<small className="permission-url">{event.scope}{event.url ? ` · ${event.url}` : ''}</small>
    </li>)}</ol>
    {complete && <TaskDiagnostic task={task} />}
    <DiagnosticActions task={task} />
  </details>

  return <section className="research-results" ref={region} tabIndex={-1} aria-label="Research findings">
    <div className="findings-shell">
      <nav className="findings-nav" aria-label="Findings controls">
        <button className="assistant-secondary" onClick={onBack}>Back to conversation</button>
        <span>Your options</span>
        <button className="assistant-primary" onClick={onNew}>New task</button>
      </nav>
      <header className="findings-hero">
        <span className="local-eyebrow">{complete ? hasOptions ? 'Choose your next step' : 'What I found' : 'Research incomplete'}</span>
        <h1>{complete ? report?.title || 'Your results' : task.status === 'failed' ? 'Task failed — no options verified' : 'No completed options yet'}</h1>
        {complete && report && <p className="findings-summary">{report.summary}</p>}
        {!hasOptions && <p className="findings-goal">{task.goal}</p>}
        {!hasOptions && <div className="findings-stats">
          <span><strong>{task.pagesRead}</strong> pages read</span>
          <span><strong>{task.searches.length}</strong> searches</span>
          <span><strong>{task.sources.length}</strong> {complete ? 'cited sources' : 'observed pages'}</span>
          <span>{task.model}</span>
        </div>}
      </header>
      <SafetyNotice task={task} />
      {!complete && <article className="findings-card findings-incomplete">
        <h2>{task.error?.includes('unapproved navigation') ? 'A website navigation was blocked' : 'No accepted final recommendation'}</h2>
        <p>{task.error || task.message || 'The task stopped before a final brief was accepted.'}</p>
        {task.error?.includes('unapproved navigation') && <p>The website tried to leave the approved URL. This safety block is not a completed comparison. Open the site manually or retry; no redirect permission was assumed.</p>}
        <TaskDiagnostic task={task} />
        {task.pagesRead === 0 && <p>No pages were read, so there are no findings to display. Research stopped before any page was read.</p>}
        <p>You can inspect the search trail and pages below. Observed pages are not a completed comparison.</p>
        <button className="assistant-primary" onClick={onRetry}>Retry with my details</button>
        <DiagnosticActions task={task} />
      </article>}
      {complete && report && report.options.length > 0 && <section aria-label="Options comparison" className="findings-section">
        <div className="findings-section-heading"><h2>{report.intent === 'travel' ? 'Your travel options' : report.intent === 'shopping' ? 'Your buying options' : 'Your shortlist'}</h2>
          <p>{priceGroups.size === 1 ? 'Lowest observed subtotal first · Unpriced options last'
            : priceGroups.size > 1 ? 'Grouped by currency, cost basis & scope · Lowest subtotal within each group'
              : 'Prices unavailable · Ordered by fit, not by price'}</p></div>
        <div className="findings-options">{report.options.map((option, index) => {
          const offer = option.offer
          return <article key={index}
          className={`findings-card findings-option${recommendation === index ? ' recommended' : ''}`}>
          <div className="option-heading">
            <div className="option-identity"><span className="finding-badge">Option {index + 1}{recommendation === index ? ' · Best fit' : ''}</span>
              <h3>{option.name}</h3>{!offer && <p className="finding-fit">{option.fit}</p>}</div>
            <div className="option-price">
              <strong>{offer ? money(offer.totalMinor, offer.currency) : 'Price unavailable'}</strong>
              <small>{offer ? `${offer.currency} · ${bases[offer.basis]}` : 'Not price-ranked'}</small>
            </div>
          </div>
          {offer && <div className="option-components">
            <p className="option-scope">{offer.scope}</p>
            {offer.components.map((component, componentIndex) => <div key={componentIndex}>
              <strong>{component.kind === 'flight' ? 'Flight' : component.kind === 'hotel' ? 'Hotel' : component.kind === 'product' ? 'Product' : 'Cost'}: {component.name}
                <span className="component-cost"> · {component.quantity > 1 ? `${component.quantity} × ` : ''}{money(component.unitAmountMinor, offer.currency)}</span></strong>
              <span>{component.detail}</span>
            </div>)}
          </div>}
          <div className="option-destinations">
            {option.links.map((link, linkIndex) => <div key={linkIndex}>
              <button className="assistant-primary option-open" title={`Open in a new tab: ${link.url}`}
                aria-label={`${link.label} (opens in a new tab)`}
                onClick={() => host.send({ type: 'newTab', url: link.url })}>{link.label} <span aria-hidden="true">↗</span></button>
              <small>{new URL(link.url).host} · {link.kind === 'search' ? 'Search lead — not a direct offer' : link.visited ? 'Page read during research' : 'Link observed — destination not read'}</small>
            </div>)}
            {option.links.length === 0 && <p className="option-link-gap">No direct destination was established. Expand details to inspect sources; a search snippet is not a bookable offer.</p>}
          </div>
          <details className="option-details"><summary>Details, costs & sources</summary>
            <p>{option.fit}</p>
            <p>{option.details}</p>
            <p><strong>Limitations: </strong>{option.tradeoffs}</p>
            {offer && <><p><strong>Not included / not checked: </strong>{offer.exclusions}</p>
              {offer.components.map((component, componentIndex) => <p key={componentIndex} className="price-quote">
                {component.name}: {money(component.unitAmountMinor, offer.currency)} × {component.quantity}.
                {' '}Observed on source [{component.sourceId}]: “{component.quote}”</p>)}</>}
            {evidence(option.sources)}
          </details>
        </article>})}</div>
        <p className="option-handoff-note">Provider links open in new tabs; choose View findings in the sidebar to return here. Observed prices are not live quotes. Confirm dates, availability, taxes and final costs before booking or buying yourself.</p>
      </section>}
      {complete && <details className="findings-support" open={!hasOptions}>
        <summary>Supporting report, caveats & sources</summary>
        <aside className="findings-caution">
          <strong>Snapshot evidence, not a guarantee.</strong> Prices are checked against directly read text;
          scope and suitability remain model judgments. Search snippets are leads, not quotes. No transaction was performed.
        </aside>
      {complete && report && report.findings.length > 0 && <section className="findings-section" aria-label="Key findings">
        <h2>Key findings</h2><div className="findings-grid">{report.findings.map((finding, index) =>
          <article className="findings-card" key={index}><span className="finding-number">{String(index + 1).padStart(2, '0')}</span>
            <h3>{finding.title}</h3><p>{finding.detail}</p>{evidence(finding.sources)}</article>)}</div>
      </section>}
      {complete && <article className="findings-card findings-brief" aria-label="Research brief">
        <h2>{report ? 'Full research brief' : 'What I found'}</h2><Brief text={task.answer || ''} />
      </article>}
      {complete && <section className="findings-card findings-gaps" aria-label="Evidence gaps">
        <h2>What still needs checking</h2>
        {report && report.gaps.length > 0 ? <ul>{report.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>
          : <p>No structured gaps were provided by the model. This does not mean the research is exhaustive or independently verified.</p>}
      </section>}
      <div className="findings-grid findings-appendix">
        <SearchTrail task={task} />
        <section className="findings-card" aria-label="Research sources">
          <h2>{complete ? 'Sources behind this brief' : 'Pages observed before stopping'}</h2>
          {task.sources.length === 0 && <p>No pages were read.</p>}
          {task.sources.map(source => <button key={source.id} className="task-source" title="Open in a new tab" onClick={() => openSource(source.id)}>
            <span className="source-kind">{source.kind === 'search' ? 'Search lead' : 'Web page read'} · [{source.id}]</span>
            <strong>{source.title || source.url}</strong><span>{source.url}</span>
          </button>)}
        </section>
      </div>
      {context}
      </details>}
      {!complete && <div className="findings-grid findings-appendix">
        <SearchTrail task={task} />
        <section className="findings-card"><h2>Pages observed before stopping</h2>
          {task.sources.map(source => <button key={source.id} className="task-source" title="Open in a new tab" onClick={() => openSource(source.id)}>
            <strong>{source.title || source.url}</strong><span>{source.url}</span>
          </button>)}
        </section>
      </div>}
      {!complete && context}
      <footer className="findings-footer">Session-only research · Links open in new tabs · View findings returns here · Starting a new task replaces these findings</footer>
    </div>
  </section>
}
