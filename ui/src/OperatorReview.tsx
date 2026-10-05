import type { OperationKind, Task } from './taskTypes.ts'
import './OperatorReview.css'

const actionLabels: Record<OperationKind, string> = {
  fill: 'Fill search field', select: 'Select filter', click: 'Open control or link',
  scroll: 'Scroll page', submitSearch: 'Open public GET search',
}

export function OperationApproval({ task, busy, onApprove }: {
  task: Task; busy: boolean; onApprove: (allow: boolean) => void
}) {
  const preview = task.pending?.operation
  if (!preview) return null
  return <div className="operator-review">
    <span className="local-eyebrow">One action. Your decision.</span>
    <h3>{actionLabels[preview.kind]}?</h3>
    <p>{task.pending?.reason}</p>
    <dl className="operator-exact-action">
      <div><dt>Website</dt><dd><code>{task.pending?.url}</code></dd></div>
      <div><dt>Exact control</dt><dd>{preview.target}</dd></div>
      {preview.value !== null && <div><dt>Exact value</dt><dd><code>{preview.value}</code></dd></div>}
      {preview.destination && <div><dt>GET destination</dt><dd><code>{preview.destination}</code></dd></div>}
    </dl>
    {preview.fields.length > 0 && <details open className="operator-search-fields">
      <summary>All search parameters sent to the website</summary>
      <dl>{preview.fields.map((field, index) => <div key={index}>
        <dt>{field.name}</dt><dd>{field.value || '(empty)'}</dd>
      </div>)}</dl>
    </details>}
    <p className="operator-caution">The exact control is rechecked. Website scripts may immediately send this data using signed-in cookies. Approve only what you intend to share.</p>
    <div className="task-approval-actions approval-choices">
      <button className="assistant-secondary" disabled={busy} onClick={() => onApprove(false)}>Decline & stop</button>
      <button className="assistant-primary approval-allow" disabled={busy} onClick={() => onApprove(true)}>Approve this action only</button>
    </div>
    <p className="approval-scope">This approval expires after two minutes and can be used once. Allow all research never applies. No booking, payment, messages, uploads or non-search submissions.</p>
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
