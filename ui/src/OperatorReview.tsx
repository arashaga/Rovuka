import type { OperationKind, Task } from './taskTypes.ts'
import './OperatorReview.css'

const actionLabels: Record<OperationKind, string> = {
  fill: 'Fill search field', select: 'Select filter', click: 'Open control or link',
  scroll: 'Scroll page', submitSearch: 'Open public GET search',
  hotelSearch: 'Open your exact hotel search',
}

export function OperationApproval({ task, busy, onApprove }: {
  task: Task; busy: boolean; onApprove: (allow: boolean, approveAll?: boolean) => void
}) {
  const preview = task.pending?.operation
  if (!preview) return null
  const parameters = new Map(preview.fields.map(field => [field.name, field.value]))
  return <div className="operator-review">
    <span className="local-eyebrow">One action. Your decision.</span>
    <h3>{actionLabels[preview.kind]}?</h3>
    <p>{task.pending?.reason}</p>
    {preview.kind === 'hotelSearch' && <p className="operator-shortcut">Destination, dates and guests go straight into a verified public search URL. No calendar or guest-picker clicks, no booking.</p>}
    {preview.kind === 'hotelSearch' && <dl className="operator-hotel-summary">
      <div><dt>Destination</dt><dd>{parameters.get('destination')}</dd></div>
      <div><dt>Check-in</dt><dd>{parameters.get('startDate')}</dd></div>
      <div><dt>Check-out</dt><dd>{parameters.get('endDate')}</dd></div>
      <div><dt>Party</dt><dd>{parameters.get('adults')} adults · {parameters.get('rooms')} room</dd></div>
    </dl>}
    <dl className="operator-exact-action">
      <div><dt>Website</dt><dd><code>{task.pending?.url}</code></dd></div>
      <div><dt>Exact control</dt><dd>{preview.target}</dd></div>
      {preview.value !== null && <div><dt>Exact value</dt><dd><code>{preview.value}</code></dd></div>}
      {preview.destination && <div><dt>GET destination</dt><dd><code>{preview.destination}</code></dd></div>}
    </dl>
    {preview.fields.length > 0 && <details open={preview.kind !== 'hotelSearch'} className="operator-search-fields">
      <summary>All search parameters sent to the website</summary>
      <dl>{preview.fields.map((field, index) => <div key={index}>
        <dt>{field.name}</dt><dd>{field.value || '(empty)'}</dd>
      </div>)}</dl>
    </details>}
    <p className="operator-caution">The exact control is rechecked. Website scripts may immediately send this data using signed-in cookies. Approve only what you intend to share.</p>
    <div className="task-approval-actions approval-choices">
      <button className="assistant-secondary" disabled={busy} onClick={() => onApprove(false)}>Decline & stop</button>
      <button className="assistant-primary approval-allow" disabled={busy} onClick={() => onApprove(true)}>Approve this action only</button>
      <button className="assistant-primary approval-allow-all" disabled={busy} onClick={() => onApprove(true, true)}>Approve all for this task</button>
    </div>
    <p className="approval-scope">Approve all covers supported public search actions and GET navigation in this task and tab, not bookings, payments, messages, uploads or account changes. Each action still gets a fresh, audited, single-use native permit and revalidation. Revoke or Stop at any time; the grant expires when this run ends.</p>
  </div>
}

export function OperationTrail({ task }: { task: Task }) {
  if (task.mode !== 'prepare') return null
  const executed = task.actions.filter(action => action.status === 'executed').length
  return <section className="operator-trail" aria-label="Page action trail">
    <h3>{task.status === 'completed' ? 'Prepared for your review' : 'Page actions'} <span>{executed}/12 approved actions executed</span></h3>
    {task.status === 'completed' && <p>{task.answer}</p>}
    {task.actions.length === 0 && <p>No page action has been executed.</p>}
    <ol>{task.actions.map(action => <li key={action.id} data-status={action.status}>
      <span className="operator-action-state">{action.status === 'awaitingApproval' ? 'Waiting for you'
        : action.status === 'stale' ? 'Page changed - not executed' : action.status}</span>
      <strong>{actionLabels[action.kind]}: {action.target}</strong>
      {action.value !== null && <code>{action.value}</code>}
    </li>)}</ol>
    <p className="privacy-note">These values stay in the session action trail, not the durable audit. Stop prevents further actions; an already executing approved action may finish and is not undone.</p>
  </section>
}
