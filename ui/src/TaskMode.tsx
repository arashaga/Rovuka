import { useEffect, useRef, useState } from 'react'
import { apiRequest } from './modelApi.ts'
import { host } from './ipc.ts'
import { taskActive as active, type Task, type TaskStatus } from './taskTypes.ts'
import ResearchResults, { SearchTrail } from './ResearchResults.tsx'
import TaskDiagnostic, { DiagnosticActions } from './TaskDiagnostic.tsx'

const labels: Record<TaskStatus, string> = {
  running: 'Working', awaitingApproval: 'Your decision', completed: 'Your results are ready', stopped: 'Stopped', failed: 'Could not finish',
  needsInput: 'More details needed', noEvidence: 'No verified result',
}

export default function TaskMode({ onActive, expanded, initialGoal = '' }: { onActive: (active: boolean) => void; expanded: boolean; initialGoal?: string }) {
  const [goal, setGoal] = useState(initialGoal)
  const [sharePage, setSharePage] = useState(false)
  const [startMode, setStartMode] = useState<'webSearch' | 'currentPage'>('webSearch')
  const [compareOptions, setCompareOptions] = useState(true)
  const [task, setTask] = useState<Task | null>(null)
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [pageTitle, setPageTitle] = useState('')
  const [reply, setReply] = useState('')
  const [showSetup, setShowSetup] = useState(true)
  const [followActivity, setFollowActivity] = useState(true)
  const [stepSeconds, setStepSeconds] = useState(0)
  const activityPanel = useRef<HTMLDetailsElement>(null)
  const activityList = useRef<HTMLOListElement>(null)
  const stepStarted = useRef(Date.now())
  const replyBox = useRef<HTMLTextAreaElement>(null)
  const confirmation = useRef<HTMLDivElement>(null)
  const resultCard = useRef<HTMLElement>(null)
  const generation = useRef(0)
  const commandBusy = useRef(false)
  const loaded = useRef(false)
  const presented = useRef<string | null>(null)
  const working = task?.status === 'running' && !connectionError
  const latestStep = task?.steps.at(-1) || 'Starting your task'

  useEffect(() => {
    stepStarted.current = Date.now()
    setStepSeconds(0)
  }, [task?.id, task?.status, latestStep])
  useEffect(() => {
    if (!working) return
    const timer = window.setInterval(() => setStepSeconds(Math.floor((Date.now() - stepStarted.current) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [working])
  useEffect(() => {
    setFollowActivity(true)
  }, [task?.id])
  useEffect(() => {
    if (task?.status !== 'running' || showSetup) {
      if (activityPanel.current) activityPanel.current.open = false
      return
    }
    if (activityPanel.current) {
      activityPanel.current.open = true
      const heading = activityPanel.current.closest('.task-run')?.querySelector<HTMLElement>('.task-run-heading')
      activityPanel.current.style.scrollMarginTop = `${(heading?.offsetHeight || 140) + 16}px`
      if (activityList.current) {
        activityList.current.style.scrollMarginTop = `${(heading?.offsetHeight || 140) + 16}px`
        activityList.current.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      }
    }
  }, [task?.status, showSetup, expanded])
  useEffect(() => {
    const list = activityList.current
    if (list && followActivity && task?.status === 'running') {
      list.scrollTop = list.scrollHeight
      list.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
  }, [task?.steps.length, followActivity, task?.status, expanded])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    const poll = async () => {
      const version = generation.current
      try {
        const next = await apiRequest<Task | null>('/api/agent', { signal: controller.signal })
        if (!cancelled && version === generation.current && !commandBusy.current) {
          setTask(next)
          if (active(next)) setShowSetup(false)
          if (!loaded.current) {
            loaded.current = true
            if (next && !initialGoal) setShowSetup(false)
          }
          setReady(true)
          setConnectionError('')
        }
      } catch (reason) {
        if (!cancelled) setConnectionError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 750)
      }
    }
    void poll()
    const unsubscribe = host.subscribe(event => {
      if (event.type === 'tabs') setPageTitle(event.tabs.find(tab => tab.id === event.active)?.title || 'Current tab')
    })
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  useEffect(() => { onActive(active(task) || busy) }, [task, busy, onActive])
  useEffect(() => {
    if (!showSetup && task && (task.status === 'completed' || task.status === 'failed' || task.status === 'noEvidence') && presented.current !== task.id) {
      presented.current = task.id
      host.send({ type: 'setAssistantExpanded', expanded: true })
    }
  }, [task?.status, task?.id, showSetup])
  useEffect(() => {
    if (task?.pending) {
      const heading = confirmation.current?.closest('.task-run')?.querySelector<HTMLElement>('.task-run-heading')
      if (confirmation.current) confirmation.current.style.scrollMarginTop = `${(heading?.offsetHeight || 140) + 16}px`
      confirmation.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      confirmation.current?.focus({ preventScroll: true })
    }
  }, [task?.pending?.id])
  useEffect(() => {
    if (task?.answer || (task?.message && task.status !== 'needsInput') || task?.error) {
      resultCard.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      resultCard.current?.focus({ preventScroll: true })
    }
  }, [task?.answer, task?.message, task?.error])
  useEffect(() => {
    if (task?.questionId) setReply('')
  }, [task?.questionId])
  useEffect(() => {
    if (task?.questionId) {
      replyBox.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      replyBox.current?.focus({ preventScroll: true })
    }
  }, [task?.questionId, expanded])

  const send = async (path: string, body: object) => {
    if (commandBusy.current) return false
    generation.current++
    commandBusy.current = true
    setBusy(true)
    setError('')
    try {
      setTask(await apiRequest<Task>(path, { method: 'POST', body: JSON.stringify(body) }))
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      generation.current++
      commandBusy.current = false
      setBusy(false)
    }
  }

  const newTask = () => {
    host.send({ type: 'setAssistantExpanded', expanded: false })
    setShowSetup(true)
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('#task-goal')?.focus(), 0)
  }
  const retryTask = () => {
    setGoal(task?.conversation.filter(message => message.role === 'user').map(message => message.content).join('\n') || '')
    setSharePage(false)
    newTask()
  }
  if (expanded && task && !active(task) && !showSetup) {
    return <ResearchResults task={task} onBack={() => host.send({ type: 'setAssistantExpanded', expanded: false })} onNew={newTask} onRetry={retryTask} />
  }

  return (
    <section className={`task-mode${expanded ? ' task-expanded' : ''}`} aria-label="Browser task mode"
      onWheel={event => { if (event.deltaY < 0 && working) setFollowActivity(false) }}>
      <div className="task-workspace-bar">
        <span className="local-eyebrow">Find your next step</span>
        <button className="assistant-secondary" onClick={() => host.send({ type: 'setAssistantExpanded', expanded: !expanded })}>
          {expanded ? 'Show browser' : task && !active(task) && !showSetup
            ? task.answer ? 'View findings' : 'View research trail'
            : 'Expand task'}
        </button>
      </div>
      {showSetup && <div className="task-intro">
        <span className="local-eyebrow">Intent → evidence → decision</span>
        <h2>Give the web a goal.</h2>
        <p>Find concrete options with direct links. Travel pairs flights and hotels; shopping compares products. Comparable observed prices sort lowest first.</p>
        <span className="local-badge">6 pages max · You control research permissions</span>
        <p className="privacy-note">Reader preview: no flight/hotel form filling or booking. Dates and travelers are needed for availability research. Prices on search pages are not confirmed quotes.</p>
      </div>}
      {showSetup && <form className="task-form" onSubmit={event => {
        event.preventDefault()
        void send('/api/agent', { goal, sharePage, startMode, compareOptions }).then(ok => { if (ok) setShowSetup(false) })
      }}>
        <label htmlFor="task-goal">What do you want to find out?</label>
        <textarea id="task-goal" rows={3} value={goal} disabled={active(task) || busy}
          maxLength={5000} placeholder="Find the key details, follow useful links, and explain the options with sources."
          onChange={event => setGoal(event.target.value)} />
        <label htmlFor="task-start">Starting point</label>
        <select id="task-start" value={startMode} disabled={active(task) || busy}
          onChange={event => setStartMode(event.target.value === 'currentPage' ? 'currentPage' : 'webSearch')}>
          <option value="webSearch">Search the web (recommended)</option>
          <option value="currentPage">Research the current page</option>
        </select>
        <label htmlFor="task-format">Result format</label>
        <select id="task-format" value={compareOptions ? 'options' : 'brief'} disabled={active(task) || busy}
          onChange={event => setCompareOptions(event.target.value === 'options')}>
          <option value="options">Actionable options · prices & direct links</option>
          <option value="brief">Research brief / explanation</option>
        </select>
        <p className="privacy-note">{startMode === 'webSearch'
          ? 'Plans a search without reading or sharing the starting tab. You approve its query and URL before opening Google; this replaces the page in your active tab.'
          : `Reads ${pageTitle || 'your active webpage'}, not the whole web. Choose Search the web if this page is unrelated.`}
          {' '}Pages read by the task are shared with your selected model. Do not use sensitive pages unless you intend to share them.</p>
        <label className="check-label">
          <input type="checkbox" checked={sharePage} disabled={active(task) || busy} onChange={event => setSharePage(event.target.checked)} />
          Allow sharing task pages with my selected model
        </label>
        <button className="assistant-primary" type="submit" disabled={!ready || !goal.trim() || !sharePage || active(task) || busy}>
          {active(task) ? 'Task in progress' : 'Start task'}
        </button>
      </form>}
      {error && <div className="task-error" role="alert">{error}</div>}
      {connectionError && <div className="task-error" role="alert">Task status could not refresh: {connectionError}</div>}
      {task && !showSetup && (
        <div className="task-run">
          <div className={`task-run-heading${active(task) ? ' is-active' : ''}`}>
            <div>
              <span className={`task-status ${task.status}`} role="status">
                {working && <span className="task-working-dots" aria-hidden="true"><i /><i /><i /></span>}
                {connectionError && active(task) ? 'Connection interrupted' : labels[task.status]}
              </span>
              {!active(task) && <h3>Research conversation</h3>}
              <p>{task.model} · {task.pagesRead}/{task.maxSteps} pages</p>
              {task.status === 'running' && <div className="task-live-step">
                <strong aria-live="polite">{connectionError ? 'Status updates are unavailable; reconnecting.' : latestStep}</strong>
                {!connectionError && <small>{stepSeconds}s on this step · {stepSeconds >= 20 ? 'Still waiting; Stop remains available.' : 'Updates appear as each step completes.'}</small>}
              </div>}
              {task.pending && <span className="approval-attention" role="status">Waiting for you — choose an approval below</span>}
            </div>
            {active(task) && task.researchPermission === 'allResearch' && <aside className="research-grant" aria-label="Automatic research permission">
              <strong>Automatic research · This task only</strong>
              <button className="assistant-secondary" disabled={busy}
                onClick={() => void send('/api/agent/revoke-research', { taskId: task.id })}>Ask before each navigation</button>
              <details><summary>Permission scope</summary>
                <p>Searches, observed links and their redirects only. No purchases, submissions or downloads. Expires when this run ends.</p>
                <small>Revoking affects subsequent proposals. Use Stop to interrupt the current action.</small>
              </details>
            </aside>}
            {active(task) && <button className="assistant-secondary" disabled={busy}
              onClick={() => void send('/api/agent/stop', { taskId: task.id })}>Stop / take over</button>}
          </div>
          <div className="task-conversation" aria-label="Task conversation">
            {task.conversation.map((message, index) => <article key={index} className={`task-message ${message.role}`}>
              <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
              <div className="chat-text">{message.content}</div>
            </article>)}
          </div>
          {task.status === 'needsInput' && task.questionId && <form className="task-reply" aria-label="Reply to assistant" onSubmit={event => {
            event.preventDefault()
            void send('/api/agent/reply', { taskId: task.id, questionId: task.questionId, message: reply })
          }}>
            <label htmlFor="task-reply">Your reply</label>
            <textarea id="task-reply" ref={replyBox} rows={3} value={reply} maxLength={5000}
              disabled={busy} placeholder="Add the details here. I’ll continue this task."
              onChange={event => setReply(event.target.value)} />
            <button className="assistant-primary" disabled={busy || !reply.trim()} type="submit">Send reply & continue</button>
            <small>Same conversation. Your earlier details and evidence are kept.</small>
          </form>}
          {task.pending && (
            <div className="task-approval" ref={confirmation} tabIndex={-1} role="region" aria-label="Navigation approval">
              <span className="local-eyebrow">Your approval is required</span>
              <h3>{task.pending.kind === 'search' ? 'Run this web search?' : task.pending.kind === 'redirect' ? 'Follow this redirect to another website?' : 'Follow this link?'}</h3>
              <p>{task.pending.reason}</p>
              <code>{task.pending.url}</code>
              <div className="task-approval-actions approval-choices">
                <button className="assistant-secondary" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: false })}>Decline & stop</button>
                <button className="assistant-primary approval-allow" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: true })}>Approve navigation</button>
                <button className="assistant-primary approval-allow-all" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: true, allowAllResearch: true })}>Allow all research for this task</button>
              </div>
              <p className="approval-scope">Allow all covers up to six page reads across websites in this run, including sharing their content with your model. It never authorizes bookings, buying, form submissions, uploads or downloads. You can revoke it or stop at any time.</p>
              <details><summary>Navigation & privacy details</summary>
                <p className="privacy-note">This replaces the page in this tab and shares its content with your model. Same-site redirects are followed; redirects to another website pause for approval (or your research permission). Checkout/account pages, form submissions, popups and downloads are blocked. Normal site scripts, their network requests and signed-in cookies still apply; this is not an isolated browsing profile.</p>
              </details>
            </div>
          )}
          {task.error && <article className="task-error" ref={resultCard} tabIndex={-1} aria-label="Task failure" role="alert">
            <strong>Task failed without a final answer</strong><p>{task.error}</p>
            <TaskDiagnostic task={task} />
            <p>No booking was made. Start a new task to retry; your earlier conversation is shown above.</p>
            <DiagnosticActions task={task} />
          </article>}
          {task.message && task.status !== 'needsInput' && <article className="task-result" ref={resultCard} tabIndex={-1} aria-label="Task guidance">
            <h3>I could not verify this</h3>
            <div className="chat-text">{task.message}</div>
            <p className="privacy-note">This is not a completed research result. No booking was made.</p>
          </article>}
          {task.answer && <article className="task-result" ref={resultCard} tabIndex={-1} aria-label="Research brief">
            <span className="local-eyebrow">Your research brief</span>
            <h3>{task.report?.title || 'Here’s what I found'}</h3>
            <div className="chat-text">{task.report?.summary || task.answer}</div>
          </article>}
          {task.sources.length > 0 && !active(task) && <div className="task-sources">
            <h3>{task.answer ? 'Answer sources' : 'Pages observed'}</h3>
            {task.sources.map(source => <button key={source.id} className="task-source"
              disabled={active(task) || busy}
              title={active(task) ? 'Stop the task before opening a source' : `Open in a new tab: ${source.url}`}
              onClick={() => host.send({ type: 'newTab', url: source.url })}>
              <strong>[{source.id}] {source.title || source.url}</strong><span>{source.url}</span>
            </button>)}
          </div>}
          {!active(task) && <>
            <div className="task-approval-actions">
              <button className="assistant-primary" onClick={() => host.send({ type: 'setAssistantExpanded', expanded: true })}>
                {task.answer ? 'View findings' : 'View research trail'}
              </button>
              <button className="assistant-secondary" onClick={newTask}>Start a new task</button>
              {task.error && <button className="assistant-secondary" onClick={retryTask}>Retry with my details</button>}
            </div>
            <p className="privacy-note">Tasks and conversation stay in memory for this browser session only. A new task replaces this run. This is a reader agent, not a form-filling or purchasing agent.</p>
          </>}
          <div className="task-research-meta">
            <details className="task-activity" ref={activityPanel}>
              <summary>{task.status === 'running' ? 'Live activity' : 'Activity'} · {task.steps.length} steps</summary>
              {task.status === 'running' && <div className="activity-follow">
                <span>{followActivity ? 'Following latest updates' : 'Reading earlier activity'}</span>
                {!followActivity && <button className="assistant-secondary" onClick={() => setFollowActivity(true)}>Jump to latest</button>}
              </div>}
              <ol className="task-timeline" ref={activityList} aria-label="Task activity"
                onScroll={event => {
                  const list = event.currentTarget
                  setFollowActivity(list.scrollHeight - list.scrollTop - list.clientHeight < 16)
                }}>
                {task.steps.map((step, index) => <li key={index} className={index === task.steps.length - 1 && working ? 'current-step' : ''}>
                  <span className="activity-index">{index + 1}</span><span>{step}</span>
                </li>)}
              </ol>
              {task.permissionEvents.length > 0 && <><h4>Permission trail</h4><ol className="task-timeline">
                {task.permissionEvents.map((event, index) => <li key={index}>
                  <time dateTime={new Date(Number(event.at)).toISOString()}>{new Date(Number(event.at)).toLocaleTimeString()}</time>
                  {' · '}{event.decision}{event.url && <small className="permission-url">{event.url}</small>}
                </li>)}
              </ol></>}
              <p className="privacy-note">Starting point: {task.startMode === 'webSearch' ? 'Web search (starting tab not read)' : 'Current page'}. No forms filled or bookings made. Six-page and ten-minute limits include replies.</p>
            </details>
            <SearchTrail task={task} />
            {!task.error && <TaskDiagnostic task={task} />}
          </div>
        </div>
      )}
    </section>
  )
}
