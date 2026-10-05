import { useEffect, useState } from 'react'
import { apiRequest } from './modelApi.ts'
import type { TaskStatus } from './taskTypes.ts'

interface AuditRecord {
  id: string
  startedAt: string
  updatedAt: string
  status: TaskStatus
  pagesRead: number
  searches: number
  options: number
  privacy: { redactions: number; blockedLinks: number }
  origins: string[]
  events: { at: string; decision: string; origin: string | null }[]
}

interface AuditOverview {
  records: AuditRecord[]
  retainedRuns: number
  directory: string
}

const statusLabels: Record<TaskStatus, string> = {
  running: 'Last recorded: working', awaitingApproval: 'Last recorded: waiting for approval', needsInput: 'Last recorded: waiting for details',
  completed: 'Completed', stopped: 'Stopped', failed: 'Failed', noEvidence: 'Insufficient evidence',
}

export default function SafetyCenter() {
  const [overview, setOverview] = useState<AuditOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiRequest<AuditOverview>('/api/safety').then(value => {
      if (!cancelled) setOverview(value)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [])

  const refresh = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setOverview(await apiRequest<AuditOverview>('/api/safety'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  const clear = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await apiRequest<{ cleared: boolean }>('/api/safety/clear', {
        method: 'POST', body: JSON.stringify({ confirm: true }),
      })
      setConfirmClear(false)
      setOverview(await apiRequest<AuditOverview>('/api/safety'))
      setNotice('Local audit history deleted. Session findings and diagnostic logs were not deleted.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  const copy = async () => {
    if (!overview) return
    setError('')
    setNotice('')
    try {
      await navigator.clipboard.writeText(JSON.stringify({ records: overview.records }, null, 2))
      setNotice('Redacted audit copied. Site origins and timestamps can still be personal—review before sharing.')
    } catch (reason) {
      setError(`Could not copy the audit: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  return <section className="safety-center" aria-label="Safety and privacy">
    <header className="safety-heading">
      <span className="local-eyebrow">Built-in boundaries</span>
      <h2>Your web. Under your control.</h2>
      <p>Read-only research, a native privacy shield, and a record that stays on this device.</p>
    </header>
    <div className="safety-protections" aria-label="Research protections">
      <article><strong>Private values stay masked</strong><p>Recognizable passwords, API keys, one-time codes and card numbers are removed before model calls and diagnostic logging. Your saved API key is used only to authenticate your chosen model.</p></article>
      <article><strong>Research is not permission to buy</strong><p>Native checks block sensitive URLs, checkout/account changes, forms, popups and downloads during tasks. Allow all covers research only and expires with that run.</p></article>
      <article><strong>Stop means take over</strong><p>Stop, manual navigation and tab changes cancel the run and invalidate pending approvals. An already approved page load may still finish.</p></article>
    </div>
    <details className="safety-limits"><summary>Important limits</summary>
      <p>Detection is not exhaustive and does not remove all personal information. Page data remains untrusted; a separate quarantined LLM reader and critic are not implemented. Website scripts and signed-in cookies remain active. The development build is not production-sandboxed.</p>
      <p>No forms, purchases or bookings are automated. Never share a page that contains information you do not intend to send to your selected model. A local runtime may itself use the network.</p>
    </details>
    <section className="safety-audit" aria-label="Local task audit">
      <div className="safety-audit-heading"><div><span className="local-eyebrow">On this device only</span><h3>Task audit</h3></div>
        <button className="assistant-secondary" disabled={busy} onClick={() => void refresh()}>{busy ? 'Working…' : 'Refresh'}</button>
      </div>
      <p className="safety-audit-note">Status, counts, site origins and permission decisions. No goals, page snapshots, model responses, query strings or API endpoints. This is not saved findings or task replay.</p>
      {error && <p className="task-error" role="alert">{error}</p>}
      {error && <button className="assistant-secondary" disabled={busy} onClick={() => setConfirmClear(true)}>Clear unreadable history</button>}
      {notice && <p className="safety-feedback" role="status">{notice}</p>}
      {!overview && !error && <p role="status">Loading local audit…</p>}
      {overview && <><p className="safety-audit-count">{overview.records.length} runs · Keeps up to {overview.retainedRuns} recent records</p>
        {overview.records.length === 0 && <div className="safety-empty"><strong>No audited tasks yet</strong><p>Start a task to see its privacy and permission trail here.</p></div>}
        <div className="safety-audit-list">
          {overview.records.map(record => <details className="safety-run" key={record.id}>
            <summary><span className={`safety-run-status ${record.status}`}>{statusLabels[record.status]}</span>
              <time dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleString()}</time>
              <small>{record.pagesRead} pages · {record.options} options · {record.privacy.redactions} masked</small>
            </summary>
            <p>Run {record.id.slice(0, 8)} · {record.searches} searches · {record.privacy.blockedLinks} sensitive links excluded</p>
            {record.origins.length > 0 && <div className="safety-origins">{record.origins.map(origin => <span key={origin}>{origin}</span>)}</div>}
            {record.events.length === 0 ? <p>No navigation permissions were issued.</p> : <ol>
              {record.events.map((event, index) => <li key={index}>
                <time dateTime={new Date(Number(event.at)).toISOString()}>{new Date(Number(event.at)).toLocaleTimeString()}</time>
                <strong>{event.decision}</strong>{event.origin && <span>{event.origin}</span>}
              </li>)}
            </ol>}
          </details>)}
        </div>
        <details className="safety-storage"><summary>Storage and privacy</summary>
          <p>Plain JSON in your OS user-data directory, not uploaded. A record shows the last saved state, not a resumable task. Only the latest metadata is retained; diagnostic logs are separate and can contain other personal details. This does not provide tamper-proof auditing.</p>
          <code>{overview.directory}</code>
        </details>
        <div className="safety-audit-actions">
          <button className="assistant-secondary" disabled={busy || !overview.records.length} onClick={() => void copy()}>Copy redacted audit</button>
          <button className="assistant-secondary" disabled={busy || !overview.records.length} onClick={() => setConfirmClear(true)}>Clear history</button>
        </div>
      </>}
      {confirmClear && <div className="safety-clear" role="region" aria-label="Confirm audit deletion">
        <strong>Delete all local task audit history?</strong><p>This cannot be undone. Your current session findings and diagnostic logs are separate and stay intact.</p>
        <div className="safety-audit-actions"><button className="assistant-secondary" disabled={busy} onClick={() => setConfirmClear(false)}>Keep history</button>
          <button className="assistant-primary" disabled={busy} onClick={() => void clear()}>Delete local audit</button></div>
      </div>}
    </section>
  </section>
}
