import { useEffect, useRef, useState } from 'react'
import { apiRequest } from './modelApi.ts'
import { host } from './ipc.ts'

type TaskStatus = 'running' | 'awaitingApproval' | 'completed' | 'stopped' | 'failed' | 'needsInput' | 'noEvidence'
interface Task {
  id: string
  goal: string
  model: string
  status: TaskStatus
  steps: string[]
  sources: { id: number; url: string; title: string }[]
  pending: { id: string; url: string; reason: string; kind: 'search' | 'link' } | null
  answer: string | null
  error: string | null
  maxSteps: number
  pagesRead: number
  startMode: 'webSearch' | 'currentPage'
  message: string | null
  conversation: { role: 'user' | 'assistant'; content: string }[]
  questionId: string | null
  protocolIssue: string | null
}

const labels: Record<TaskStatus, string> = {
  running: 'Working', awaitingApproval: 'Your decision', completed: 'Research brief ready', stopped: 'Stopped', failed: 'Could not finish',
  needsInput: 'More details needed', noEvidence: 'No verified result',
}
const active = (task: Task | null) => task?.status === 'running' || task?.status === 'awaitingApproval' || task?.status === 'needsInput'

export default function TaskMode({ onActive }: { onActive: (active: boolean) => void }) {
  const [goal, setGoal] = useState('')
  const [sharePage, setSharePage] = useState(false)
  const [startMode, setStartMode] = useState<'webSearch' | 'currentPage'>('webSearch')
  const [task, setTask] = useState<Task | null>(null)
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [pageTitle, setPageTitle] = useState('')
  const [reply, setReply] = useState('')
  const [showSetup, setShowSetup] = useState(true)
  const replyBox = useRef<HTMLTextAreaElement>(null)
  const confirmation = useRef<HTMLDivElement>(null)
  const resultCard = useRef<HTMLElement>(null)
  const generation = useRef(0)
  const commandBusy = useRef(false)
  const loaded = useRef(false)

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
          if (!loaded.current) {
            loaded.current = true
            if (next) setShowSetup(false)
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
    if (task?.pending) {
      confirmation.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      confirmation.current?.focus()
    }
  }, [task?.pending?.id])
  useEffect(() => {
    if (task?.answer || (task?.message && task.status !== 'needsInput') || task?.error) {
      resultCard.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      resultCard.current?.focus({ preventScroll: true })
    }
  }, [task?.answer, task?.message, task?.error])
  useEffect(() => {
    if (task?.questionId) {
      setReply('')
      replyBox.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      replyBox.current?.focus({ preventScroll: true })
    }
  }, [task?.questionId])

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

  return (
    <section className="task-mode" aria-label="Browser task mode">
      {showSetup && <div className="task-intro">
        <span className="local-eyebrow">Intent → evidence → decision</span>
        <h2>Give the web a goal.</h2>
        <p>Search the web or research this page. Review every navigation, then see which pages were read and what was actually verified.</p>
        <span className="local-badge">6 pages max · Every navigation approved</span>
        <p className="privacy-note">Reader preview: no flight/hotel form filling or booking. Dates and travelers are needed for availability research. Prices on search pages are not confirmed quotes.</p>
      </div>}
      {showSetup && <form className="task-form" onSubmit={event => {
        event.preventDefault()
        void send('/api/agent', { goal, sharePage, startMode }).then(ok => { if (ok) setShowSetup(false) })
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
      {task && (
        <div className="task-run">
          <div className={`task-run-heading${active(task) ? ' is-active' : ''}`}>
            <div>
              <span className={`task-status ${task.status}`} role="status">{labels[task.status]}</span>
              {!active(task) && <h3>Research conversation</h3>}
              <p>{task.model} · {task.pagesRead}/{task.maxSteps} pages</p>
            </div>
            {active(task) && <button className="assistant-secondary" disabled={busy}
              onClick={() => void send('/api/agent/stop', { taskId: task.id })}>Stop / take over</button>}
          </div>
          <div className="task-conversation" aria-label="Task conversation">
            {task.conversation.map((message, index) => <article key={index} className={`task-message ${message.role}`}>
              <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
              <div className="chat-text">{message.content}</div>
            </article>)}
          </div>
          <details className="task-activity">
            <summary>Activity · {task.steps.length} steps</summary>
            <ol className="task-timeline" aria-label="Task activity">
            {task.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          </details>
          {task.status === 'running' && <p className="task-progress" role="status">{task.steps.at(-1)}</p>}
          <p className="privacy-note">Starting point: {task.startMode === 'webSearch' ? 'Web search (starting tab not read)' : 'Current page'}. {task.pagesRead} page(s) read. No forms filled and no bookings made.</p>
          {task.pending && (
            <div className="task-approval" ref={confirmation} tabIndex={-1} role="region" aria-label="Navigation approval">
              <span className="local-eyebrow">Your approval is required</span>
              <h3>{task.pending.kind === 'search' ? 'Run this web search?' : 'Follow this link?'}</h3>
              <p>{task.pending.reason}</p>
              <code>{task.pending.url}</code>
              <p className="privacy-note">This replaces the page in this tab and shares its content with your model. Unapproved main-frame navigation, redirects, popups and downloads are blocked. Normal site scripts, their network requests and signed-in cookies still apply; this is not an isolated browsing profile.</p>
              <div className="task-approval-actions">
                <button className="assistant-secondary" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: false })}>Decline & stop</button>
                <button className="assistant-primary" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: true })}>Approve navigation</button>
              </div>
            </div>
          )}
          {task.error && <article className="task-error" ref={resultCard} tabIndex={-1} aria-label="Task failure" role="alert">
            <strong>No verified result</strong><p>{task.error}</p><p>No booking was made. Check the pages observed below, adjust your goal, or try another model.</p>
          </article>}
          {task.status === 'needsInput' && task.questionId && <form className="task-reply" aria-label="Reply to assistant" onSubmit={event => {
            event.preventDefault()
            void send('/api/agent/reply', { taskId: task.id, questionId: task.questionId, message: reply })
          }}>
            <label htmlFor="task-reply">Your reply</label>
            <textarea id="task-reply" ref={replyBox} rows={3} value={reply} maxLength={5000}
              disabled={busy} placeholder="Add the details here. I’ll continue this task."
              onChange={event => setReply(event.target.value)} />
            <button className="assistant-primary" disabled={busy || !reply.trim()} type="submit">Send reply & continue</button>
            <p className="privacy-note">Your reply goes to the same model. Evidence and previous replies are kept; the six-page and ten-minute limits still apply.</p>
          </form>}
          {task.message && task.status !== 'needsInput' && <article className="task-result" ref={resultCard} tabIndex={-1} aria-label="Task guidance">
            <h3>I could not verify this</h3>
            <div className="chat-text">{task.message}</div>
            <p className="privacy-note">This is not a completed research result. No booking was made.</p>
          </article>}
          {task.protocolIssue && <details className="task-protocol">
            <summary>Model protocol diagnostic</summary>
            <p>{task.protocolIssue}</p>
            <p>Only visited sources are accepted. A correction can fix formatting, not establish live availability.</p>
          </details>}
          {task.answer && <article className="task-result" ref={resultCard} tabIndex={-1} aria-label="Research brief">
            <span className="local-eyebrow">Your research brief</span>
            <h3>Here’s what I found</h3>
            <div className="chat-text">{task.answer}</div>
          </article>}
          {task.sources.length > 0 && <div className="task-sources">
            <h3>{task.answer ? 'Answer sources' : 'Pages observed'}</h3>
            {task.sources.map(source => <button key={source.id} className="task-source"
              disabled={active(task) || busy}
              title={active(task) ? 'Stop the task before opening a source' : source.url}
              onClick={() => host.send({ type: 'navigate', input: source.url })}>
              <strong>[{source.id}] {source.title || source.url}</strong><span>{source.url}</span>
            </button>)}
          </div>}
          {!active(task) && <>
            <button className="assistant-secondary" onClick={() => {
              setShowSetup(true)
              window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('#task-goal')?.focus(), 0)
            }}>Start a new task</button>
            <p className="privacy-note">Tasks and conversation stay in memory for this browser session only. A new task replaces this run. This is a reader agent, not a form-filling or purchasing agent.</p>
          </>}
        </div>
      )}
    </section>
  )
}
