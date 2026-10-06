import { useState } from 'react'
import type { Task } from './taskTypes.ts'

/** Plain-text report of everything Rovuka knows about a task, for sharing or bug reports. */
export function diagnosticReport(task: Task): string {
  const diagnostic = task.protocolDiagnostic
  const lines: (string | null | undefined)[] = [
    'Rovuka diagnostic report',
    `Build: ${task.build || 'unknown'}`,
    `Log file: ${task.logFile ?? 'unavailable'}`,
    `Status: ${task.status}`,
    `Model: ${task.model}`,
    `Goal: ${task.goal}`,
    task.error && `Error: ${task.error}`,
    task.issue && `Failure category: ${task.issue.category}\nRecovery: ${task.issue.recovery}`,
    `Task permission: ${task.taskPermission}`,
    task.startMode === 'selectedTabs' ? `Selected read-only tabs: ${task.selectedTabs.length}; comparison sources: ${task.comparison?.rows.length ?? 0}; unknown cells: ${task.comparison?.unknownCells ?? 0}` : null,
    task.preserveTabs ? `Original tabs preserved; dedicated research tab: ${task.workspaceTab ?? 'not created'}` : null,
    `Independent verification: ${task.verification.verified ? 'passed' : 'not complete'}, ${task.verification.checks} checks. ${task.verification.detail}`,
    `Model requests: ${task.modelUsage.requests}; quarantined-reader requests: ${task.modelUsage.readerRequests}; latency: ${task.modelUsage.elapsedMs}ms; repairs: ${task.modelUsage.repairs}`,
    task.message && `Message: ${task.message}`,
    diagnostic && `Model response check: ${diagnostic.stage}, attempt ${diagnostic.attempt} of 2, ${diagnostic.resolved ? 'repaired' : 'not repaired'}: ${diagnostic.message}`,
    diagnostic && `Rejected model response:\n${diagnostic.response}`,
    '',
    'Activity:',
    ...task.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Permissions:',
    ...task.permissionEvents.map(event =>
      `${new Date(Number(event.at)).toISOString()} ${event.decision}${event.url ? ` ${event.url}` : ''}`),
    '',
    'Searches:',
    ...task.searches.map(search => `- [${search.vertical}] ${search.query} (${search.url})`),
    '',
    'Pages read:',
    ...task.sources.map(source => `[${source.id}] ${source.kind} ${source.title} ${source.url}`),
  ]
  return lines.filter((line): line is string => typeof line === 'string').join('\n')
}

export function DiagnosticActions({ task }: { task: Task }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticReport(task))
      setState('copied')
    } catch {
      setState('manual')
    }
  }
  return <div className="task-diagnostic-actions">
    <button className="assistant-secondary" onClick={() => void copy()}>
      {state === 'copied' ? 'Diagnostic report copied' : 'Copy diagnostic report'}
    </button>
    <small>Build {task.build || 'unknown'}{task.logFile ? ` · Full log: ${task.logFile}` : ''}</small>
    {state === 'manual' && <textarea readOnly rows={8} aria-label="Diagnostic report" value={diagnosticReport(task)}
      onFocus={event => event.currentTarget.select()} />}
  </div>
}

export default function TaskDiagnostic({ task }: { task: Task }) {
  const diagnostic = task.protocolDiagnostic
  if (!diagnostic && !task.protocolIssue) return null
  const resolved = diagnostic?.resolved === true
  const fatal = task.status === 'failed' && diagnostic?.attempt === 2 && !resolved
  return <details className="task-diagnostic" open={fatal} key={`${task.id}-${diagnostic?.attempt}-${resolved}`}>
    <summary>{resolved ? 'Earlier model response repaired successfully' : fatal ? 'Model response could not be repaired' : 'Model response diagnostic'}</summary>
    {diagnostic && <strong>{diagnostic.stage} · Attempt {diagnostic.attempt} of 2</strong>}
    <p>{diagnostic?.message || task.protocolIssue}</p>
    {diagnostic && <details className="task-raw-response">
      <summary>Inspect rejected model response</summary>
      <p>Session-only diagnostic. May contain your task or page content; review before sharing. This response was not executed.</p>
      <pre>{diagnostic.response}</pre>
    </details>}
  </details>
}
