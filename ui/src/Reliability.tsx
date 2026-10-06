import { useEffect, useState } from 'react'
import { apiRequest, type Provider } from './modelApi.ts'
import './Reliability.css'

interface Check {
  id: string
  iteration: number
  status: 'passed' | 'failed' | 'notRun'
  latencyMs: number
  modelRequests: number
  approvals: number
  actions: number
  failureCategory: string | null
}
interface Report {
  id: string
  suiteVersion: number
  scope: 'modelProtocol' | 'nativeEndToEnd'
  provenance: 'fixtureMock' | 'selectedModel'
  provider: Provider
  model: string
  build: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'completed' | 'stopped' | 'failed'
  cases: Check[]
}
interface View { directory: string; running: Report | null; reports: Report[]; error: string | null }

const names: Record<string, string> = {
  'hotel-requirements': 'Natural hotel requirements',
  'missing-requirements': 'Ask for missing dates, not defaults',
  'quarantined-reader': 'Source-grounded, no-tools page reader',
  'public-field': 'Exact public field proposal',
  'injection-refusal': 'Refuse injected instructions / sensitive control',
  'observed-link': 'Choose only an observed research link',
  'hotel-natural': 'Natural hotel task → exact results',
  'hotel-structured': 'Structured hotel task → exact results',
  'search-form': 'Public form → exact loaded GET search',
  shopping: 'Shopping → grounded, sorted options',
  quarantine: 'Page instructions stay out of the actor',
  revocation: 'Revoke / Stop invalidates task grants',
  'outcome-mismatch': 'Wrong result cannot become success',
  'task-grant': 'Approve-all keeps native permit checks',
}

function Run({ report }: { report: Report }) {
  const passed = report.cases.filter(check => check.status === 'passed').length
  const measured = report.cases.filter(check => check.status !== 'notRun')
  const latencies = measured.map(check => check.latencyMs).sort((a, b) => a - b)
  const median = latencies.length
    ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2
    : null
  const success = Math.round(passed * 100 / report.cases.length)
  return <article className="capability-report" data-scope={report.scope}>
    <header><strong>{report.model}</strong><span className="local-badge">
      {report.provenance === 'fixtureMock' ? 'Fixture / mock · Not a real-model rating' : 'Selected model'}
    </span></header>
    <p>{report.scope === 'modelProtocol' ? 'Synthetic model protocol checks · No website tasks'
      : 'Native fixture tasks · Local imported report, not signed certification'}</p>
    <div className="capability-metrics">
      <div><strong>{success}%</strong><span>Passed · {passed}/{report.cases.length}</span></div>
      <div><strong>{median === null ? '—' : `${(median / 1000).toFixed(2)}s`}</strong><span>Median measured latency</span></div>
      <div><strong>{measured.length}</strong><span>Checks run · {report.status}</span></div>
    </div>
    <small>{report.provider} · Build {report.build} · Suite {report.suiteVersion}
      {' · '}{new Date(report.startedAt).toLocaleString()}</small>
    <details open={report.status === 'running' || passed < report.cases.length}>
      <summary>Check outcomes and latency</summary>
      <ul>{report.cases.map(check => <li key={`${check.id}-${check.iteration}`} data-status={check.status}>
        <strong>{names[check.id]}{check.iteration > 1 ? ` · Repeat ${check.iteration}` : ''}</strong>
        <span>{check.status === 'notRun' ? 'Not run' : `${check.status} · ${(check.latencyMs / 1000).toFixed(2)}s`}
          {check.failureCategory && ` · ${check.failureCategory}`}</span>
        {report.scope === 'nativeEndToEnd' && <small>{check.approvals} approvals · {check.actions} executed actions · {check.modelRequests} model requests</small>}
      </li>)}</ul>
    </details>
  </article>
}

export default function Reliability({ onActive }: { onActive: (active: boolean) => void }) {
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    const refresh = async () => {
      try {
        const result = await apiRequest<View>('/api/evaluations')
        if (live) { setView(result); setError('') }
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    onActive(!!view?.running)
    return () => onActive(false)
  }, [view?.running?.id, onActive])

  const command = async (route: string, body: unknown) => {
    setBusy(true)
    setError('')
    try {
      await apiRequest(route, { method: 'POST', body: JSON.stringify(body) })
      setView(await apiRequest<View>('/api/evaluations'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <section className="reliability-center" aria-label="Reliability and model capabilities">
    <span className="local-eyebrow">Measure, don’t guess</span>
    <h2>Model capabilities</h2>
    <p>Check the selected model against exact requirements, grounded evidence, supported controls and adversarial instructions.</p>
    <aside className="reliability-scope">
      <strong>Opt-in · Six synthetic checks</strong>
      <p>No browser pages, history, forms or files are shared. The selected model receives built-in synthetic test data.
        Cloud-provider calls may incur charges. These protocol checks are not a live website success-rate guarantee.</p>
    </aside>
    {!view?.running && <form onSubmit={event => { event.preventDefault(); void command('/api/evaluations', { consent: true }) }}>
      <label className="reliability-consent"><input type="checkbox" checked={consent} disabled={busy}
        onChange={event => setConsent(event.target.checked)} />
        I approve this selected-model evaluation and any provider charges.</label>
      <button className="assistant-primary" type="submit" disabled={!consent || busy || !view}>Run selected model checks</button>
    </form>}
    {view?.running && <div className="reliability-running" role="status">
      <p>Testing {view.running.model}. Agent tasks are paused during this evaluation; ordinary browsing is available.</p>
      <button className="assistant-secondary" disabled={busy}
        onClick={() => void command('/api/evaluations/stop', { id: view.running?.id })}>Stop evaluation</button>
      <Run report={view.running} />
    </div>}
    {error && <p className="task-error" role="alert">{error}</p>}
    {view?.error && <p className="task-error" role="alert">{view.error}</p>}
    <details className="reliability-import"><summary>Native end-to-end regression reports</summary>
      <p>The local evaluation runner checks actual hotel results, shopping options, public GET forms, grants and outcome failures.
        Import its JSON report here to keep it alongside per-model checks. Mock and real-model evidence remain separate.</p>
      <label>Import a local report <input type="file" accept=".json,application/json" disabled={busy || !!view?.running}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          if (file.size > 128 * 1024) { setError('Capability reports must be at most 128 KB.'); return }
          setBusy(true)
          void file.text().then(text => command('/api/evaluations/import', JSON.parse(text)))
            .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) })
        }} /></label>
    </details>
    <h3>Local run history</h3>
    {view && view.reports.length === 0 && <p>No capability reports yet. Running a model check is optional.</p>}
    {view?.reports.map(report => <Run key={report.id} report={report} />)}
    <small>Reports retain only model labels, provenance, outcomes, counts and timings—not prompts, page text, responses, endpoints or keys.
      Up to 50 local runs. {view?.directory}</small>
  </section>
}
