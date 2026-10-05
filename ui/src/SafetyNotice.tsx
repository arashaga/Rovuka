import type { Task } from './taskTypes.ts'

export default function SafetyNotice({ task }: { task: Task }) {
  return <details className={`safety-notice${task.auditError ? ' safety-warning' : ''}`} open={task.auditError ? true : undefined}>
    <summary>Privacy shield · {task.privacy.redactions} masked · {task.privacy.blockedLinks} links excluded</summary>
    <p>Recognizable passwords, API tokens, one-time codes and valid card numbers are masked before model calls. Sensitive links are withheld. Detection is not exhaustive; only share pages you intend your model to read.</p>
    <p>{task.auditEnabled ? 'A redacted local audit records status, counts, site origins and permissions—not goals, page text, answers or full URLs.' : 'Persistent auditing is unavailable.'}</p>
    <p>{task.mode === 'prepare' ? 'Preparation can enter approved public search values and open reviewed GET searches. No buying, booking, messages or non-search submissions.' : 'No buying, booking, messages or form submissions.'} Signed-in cookies and website scripts still run; this is not an isolated profile.</p>
    {task.auditError && <p role="alert">{task.auditError}</p>}
  </details>
}
