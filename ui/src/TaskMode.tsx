import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest } from './modelApi.ts'
import { host, type TaskDraftStart } from './ipc.ts'
import { taskActive as active, type ReadTarget, type Task, type TaskStatus } from './taskTypes.ts'
import TabSelection from './TabSelection.tsx'
import ComparisonResults from './ComparisonResults.tsx'
import ResearchResults, { SearchTrail } from './ResearchResults.tsx'
import SafetyNotice from './SafetyNotice.tsx'
import TaskDiagnostic, { DiagnosticActions } from './TaskDiagnostic.tsx'
import { OperationApproval, OperationTrail } from './OperatorReview.tsx'
import { MemoryContextPreview, SaveResearch } from './Memory.tsx'
import type { MemoryPreview } from './memoryTypes.ts'

const labels: Record<TaskStatus, string> = {
  running: 'Working', awaitingApproval: 'Your decision', completed: 'Your results are ready', stopped: 'Stopped', failed: 'Could not finish',
  needsInput: 'More details needed', noEvidence: 'No verified result',
}

export default function TaskMode({ onActive, expanded, initialGoal = '', initialPrepare = false, initialMemory = null, initialStartMode = 'webSearch', initialCompareOptions = true, startFresh = false }: { onActive: (active: boolean) => void; expanded: boolean; initialGoal?: string; initialPrepare?: boolean; initialMemory?: MemoryPreview | null; initialStartMode?: TaskDraftStart; initialCompareOptions?: boolean; startFresh?: boolean }) {
  const [goal, setGoal] = useState(initialGoal)
  const [sharePage, setSharePage] = useState(false)
  const [memoryPreview, setMemoryPreview] = useState<MemoryPreview | null>(initialMemory)
  const [shareMemory, setShareMemory] = useState(false)
  const [mode, setMode] = useState<'research' | 'prepare'>(initialPrepare ? 'prepare' : 'research')
  const [startMode, setStartMode] = useState<'webSearch' | 'currentPage' | 'selectedTabs' | 'newResearchTab'>(initialPrepare ? 'currentPage' : initialStartMode)
  const [selectedTabs, setSelectedTabs] = useState<ReadTarget[]>([])
  const selectTabs = useCallback((tabs: ReadTarget[]) => {
    setSelectedTabs(tabs)
    setSharePage(false)
    setShareMemory(false)
  }, [])
  const [compareOptions, setCompareOptions] = useState(initialCompareOptions)
  const [task, setTask] = useState<Task | null>(null)
  const [savedFindings, setSavedFindings] = useState<Task | null>(null)
  const [showSavedFindings, setShowSavedFindings] = useState(false)
  const findingsFor = useRef('')
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
    if (startFresh) document.querySelector<HTMLTextAreaElement>('#task-goal')?.focus()
  }, [startFresh])

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
            if (next && !initialGoal && !startFresh) setShowSetup(false)
          }
          setReady(true)
          setConnectionError('')
          if (next?.mode === 'prepare' && findingsFor.current !== next.id) {
            const findings = await apiRequest<Task | null>('/api/agent/findings', { signal: controller.signal })
            if (!cancelled && version === generation.current) {
              findingsFor.current = next.id
              setSavedFindings(findings)
            }
          }
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
    if (!showSetup && task && task.mode !== 'prepare' && (task.status === 'completed' || task.status === 'failed' || task.status === 'noEvidence') && presented.current !== task.id) {
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
    setShowSavedFindings(false)
    setSharePage(false)
    setSelectedTabs([])
    setMemoryPreview(null)
    setShareMemory(false)
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('#task-goal')?.focus(), 0)
  }
  const retryTask = () => {
    setGoal(task?.conversation.filter(message => message.role === 'user').map(message => message.content).join('\n') || '')
    setSharePage(false)
    setMode(task?.mode || 'research')
    setStartMode(task?.preserveTabs ? 'newResearchTab' : task?.startMode || 'webSearch')
    newTask()
  }
  if (expanded && showSavedFindings && savedFindings) {
    return <ResearchResults task={savedFindings} onBack={() => { setShowSavedFindings(false); host.send({ type: 'setAssistantExpanded', expanded: false }) }} onNew={newTask} onRetry={newTask} />
  }
  if (expanded && task && task.mode !== 'prepare' && !active(task) && !showSetup) {
    return <ResearchResults task={task} onBack={() => host.send({ type: 'setAssistantExpanded', expanded: false })} onNew={newTask} onRetry={retryTask} />
  }

  return (
    <section className={`task-mode${expanded ? ' task-expanded' : ''}`} aria-label="Browser task mode"
      onWheel={event => { if (event.deltaY < 0 && working) setFollowActivity(false) }}>
      <div className="task-workspace-bar">
        <span className="local-eyebrow">Find your next step</span>
        <button className="assistant-secondary" onClick={() => host.send({ type: 'setAssistantExpanded', expanded: !expanded })}>
          {expanded ? 'Show browser' : task && !active(task) && !showSetup
            ? task.mode === 'prepare' ? 'View preparation' : task.answer ? 'View findings' : 'View research trail'
            : 'Expand task'}
        </button>
      </div>
      {savedFindings && !active(task) && <button className="assistant-secondary operator-return-findings" onClick={() => {
        setShowSavedFindings(true)
        host.send({ type: 'setAssistantExpanded', expanded: true })
      }}>Return to previous research findings</button>}
      {showSetup && <div className="task-intro">
        <span className="local-eyebrow">Intent → evidence → decision</span>
        <h2>Give the web a goal.</h2>
        <p>Compare selected tabs with source-checked quotes, or research concrete options with direct links. Use a new research tab to preserve your original pages.</p>
        <span className="local-badge">6 pages max · You control research permissions</span>
        <p className="privacy-note">Research stays read-only. Optional preparation can fill public search fields and filters. Approve each action or approve all supported actions for this task. No bookings or payments. Unsupported website widgets require manual use.</p>
      </div>}
      {showSetup && <form className="task-form" onSubmit={event => {
        event.preventDefault()
        void send('/api/agent', { goal, sharePage, startMode: startMode === 'newResearchTab' ? 'webSearch' : startMode,
          selectedTabs: startMode === 'selectedTabs' ? selectedTabs : [], preserveTabs: startMode === 'newResearchTab',
          memoryPreviewId: shareMemory ? memoryPreview?.id : undefined, shareMemory,
          compareOptions: mode === 'research' && startMode !== 'selectedTabs' && compareOptions, mode }).then(ok => {
          if (ok) { setShowSetup(false); if (mode === 'prepare') host.send({ type: 'setAssistantExpanded', expanded: false }) }
          else setShareMemory(false)
        })
      }}>
        <label htmlFor="task-mode">Task capability</label>
        <select id="task-mode" value={mode} disabled={active(task) || busy} onChange={event => {
          const next = event.target.value === 'prepare' ? 'prepare' : 'research'
          setMode(next)
          setStartMode(next === 'prepare' ? 'currentPage' : 'webSearch')
          setSharePage(false)
          setSelectedTabs([])
          setMemoryPreview(null)
          setShareMemory(false)
        }}>
          <option value="research">Research only (default)</option>
          <option value="prepare">Prepare public search fields - choose your approval scope</option>
        </select>
        <label htmlFor="task-goal">{mode === 'prepare' ? 'What should I prepare on this page?' : 'What do you want to find out?'}</label>
        <textarea id="task-goal" rows={3} value={goal} disabled={active(task) || busy}
          maxLength={5000} placeholder={mode === 'prepare' ? 'Prepare public search fields with exact dates and guest/filter values, then stop before booking.' : 'Find the key details, follow useful links, and explain the options with sources.'}
          onChange={event => { setGoal(event.target.value); setShareMemory(false) }} />
        <label htmlFor="task-start">Starting point</label>
        <select id="task-start" value={startMode} disabled={mode === 'prepare' || active(task) || busy}
          onChange={event => {
            const value = event.target.value
            setStartMode(value === 'selectedTabs' || value === 'newResearchTab' || value === 'currentPage' ? value : 'webSearch')
            setSharePage(false)
            setSelectedTabs([])
            setShareMemory(false)
          }}>
          <option value="webSearch">Search the web in this tab</option>
          <option value="newResearchTab">Search the web in a new research tab</option>
          <option value="currentPage">{mode === 'prepare' ? 'Prepare the current public page' : 'Research the current page'}</option>
          <option value="selectedTabs">Compare selected tabs (read-only)</option>
        </select>
        {mode === 'research' && startMode === 'selectedTabs' && <TabSelection disabled={active(task) || busy} onSelect={selectTabs} />}
        {mode === 'research' && startMode !== 'selectedTabs' && <><label htmlFor="task-format">Result format</label>
        <select id="task-format" value={compareOptions ? 'options' : 'brief'} disabled={active(task) || busy}
          onChange={event => setCompareOptions(event.target.value === 'options')}>
          <option value="options">Actionable options · prices & direct links</option>
          <option value="brief">Research brief / explanation</option>
        </select></>}
        {mode === 'prepare' && <p className="operator-caution">Opt-in operator preview: up to 12 exact actions on this public page and its approved links. Supply literal dates and filter values, for example 2026-11-20 and 2 adults. Hotels.com searches for adults in one room use a reviewed GET shortcut after destination selection, without calendar or guest-picker clicks. Choose individual or task-wide approval; every action is revalidated. Page clicks, typing and scrolling take over and stop preparation. Existing form values are not shared with the model; website scripts can still send entered data. No POST or non-search submissions.</p>}
        <p className="privacy-note">{startMode === 'selectedTabs'
          ? 'Only explicitly selected page snapshots are shared after approval. No tabs are navigated or changed. Reloaded, closed, sensitive and failed pages are rejected. Missing facts stay Unknown.'
          : startMode === 'newResearchTab'
          ? 'Creates one new research tab. The original tabs are neither read nor replaced. Approve searches and observed links; the run is bounded to six page reads. Stop leaves the new tab for review.'
          : startMode === 'webSearch'
          ? 'Plans a search without reading or sharing the starting tab. You approve its query and URL before opening Google; this replaces the page in your active tab.'
          : `Reads ${pageTitle || 'your active webpage'}, not the whole web. Choose Search the web if this page is unrelated.`}
          {' '}Pages read by the task are shared with your selected model. Do not use sensitive pages unless you intend to share them.</p>
        <p className="task-privacy-note">Privacy shield is always on. Recognizable secrets are masked, but detection is not exhaustive. A local audit keeps status, site origins and permissions—not your goal, pages or answers.</p>
        {memoryPreview && mode === 'research' && <div className="memory-task-context">
          <MemoryContextPreview context={memoryPreview.context} />
          <label className="check-label"><input type="checkbox" checked={shareMemory} disabled={active(task) || busy}
            onChange={event => setShareMemory(event.target.checked)} />Allow sharing this exact saved context for this research task</label>
          <p className="privacy-note">This single-use preview expires after five minutes. Memory is not fresh evidence or action authority. Editing your goal, mode or tab selection resets consent.</p>
          <button className="assistant-secondary" type="button" onClick={() => { setMemoryPreview(null); setShareMemory(false) }}>Remove saved context</button>
          <button className="assistant-secondary" type="button" onClick={() => host.send({ type: 'openAssistant', panel: 'memory' })}>Return to Memory to preview again</button>
        </div>}
        <label className="check-label">
          <input type="checkbox" checked={sharePage} disabled={active(task) || busy} onChange={event => setSharePage(event.target.checked)} />
          {startMode === 'selectedTabs' ? 'Allow sharing only my selected pages with my selected model' : 'Allow sharing task pages with my selected model'}
        </label>
        <button className="assistant-primary" type="submit" disabled={!ready || !goal.trim() || !sharePage || active(task) || busy
          || (!!memoryPreview && !shareMemory)
          || (startMode === 'selectedTabs' && selectedTabs.length < 2)}>
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
              {!active(task) && <h3>{task.mode === 'prepare' ? 'Preparation conversation' : 'Research conversation'}</h3>}
              <p>{task.model} · {task.pagesRead}/{task.maxSteps} pages{task.mode === 'prepare' ? ' · Preparation preview' : ''}
                {task.modelUsage.requests > 0 && ` · ${task.modelUsage.requests} model requests`}</p>
              {task.status === 'running' && <div className="task-live-step">
                <strong aria-live="polite">{connectionError ? 'Status updates are unavailable; reconnecting.' : latestStep}</strong>
                {!connectionError && <small>{stepSeconds}s on this step · {stepSeconds >= 20 ? 'Still waiting; Stop remains available.' : 'Updates appear as each step completes.'}</small>}
              </div>}
              {task.pending && <span className="approval-attention" role="status">Waiting for you — choose an approval below</span>}
            </div>
            {active(task) && (task.taskPermission === 'allSupported' || task.researchPermission === 'allResearch') && <aside className="research-grant" aria-label="Automatic task permission">
              <strong>Automatic {task.startMode === 'selectedTabs' ? 'selected-page reads' : task.mode === 'prepare' ? 'preparation' : 'research'} · This task only</strong>
              <button className="assistant-secondary" disabled={busy}
                onClick={() => void send('/api/agent/revoke', { taskId: task.id })}>{task.startMode === 'selectedTabs' ? 'Ask before each page read' : task.mode === 'prepare' ? 'Ask before each action' : 'Ask before each navigation'}</button>
              <details><summary>Permission scope</summary>
                <p>{task.startMode === 'selectedTabs' ? 'Read-only snapshots of the explicitly selected, unchanged tabs only. No other tabs or navigation.' : task.mode === 'prepare' ? 'Validated public search fields, filters, widgets and GET searches only.' : 'Searches, observed links and their redirects only.'} No purchases, bookings, messages, uploads, account changes or non-search submissions. Expires when this run ends.</p>
                <small>Revoking affects subsequent proposals. Use Stop to interrupt the current action.</small>
              </details>
            </aside>}
            {active(task) && <button className="assistant-secondary" disabled={busy}
              onClick={() => void send('/api/agent/stop', { taskId: task.id })}>Stop / take over</button>}
          </div>
          <SafetyNotice task={task} />
          <SaveResearch key={task.id} task={task} />
          {task.startMode === 'selectedTabs' && <details className="selected-scope" aria-label="Selected sharing scope">
            <summary>{task.selectedTabs.length} explicitly selected tabs · Read-only scope</summary>
            <ul>{task.selectedTabs.map(tab => <li key={tab.id}>{tab.title} · {tab.url}</li>)}</ul>
            <p>Only these unchanged documents can be read. Switching, navigating or closing a tab stops the task. Original pages are not replaced.</p>
          </details>}
          {active(task) && task.mode === 'prepare' && <p className="privacy-note">Preparation is controlling this webpage. Clicking, typing or scrolling on the page stops the task; assistant approvals and activity controls do not.</p>}
          {task.requirements && <aside className="task-requirements" aria-label="Interpreted search requirements">
            <strong>Exact search I understood</strong>
            <p>{task.requirements.destination} · {task.requirements.checkIn} to {task.requirements.checkOut}
              {' · '}{task.requirements.adults} adults · {task.requirements.rooms} room</p>
            <small>Only your messages supply these values. Provider destination IDs come from the website, not the model.</small>
          </aside>}
          {task.issue && <aside className="task-recovery" aria-label="Task recovery">
            <strong>{task.issue.category}</strong><p>{task.issue.recovery}</p>
          </aside>}
          {task.verification.verified && <aside className="task-verification" aria-label="Independent outcome verification">
            <strong>Independently checked · {task.verification.checks} checks</strong>
            <p>{task.verification.detail}</p>
          </aside>}
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
            <div className="task-approval" ref={confirmation} tabIndex={-1} role="region" aria-label={task.pending.kind === 'readTab' ? 'Selected page sharing approval' : task.pending.kind === 'operation' ? 'Exact page action approval' : 'Navigation approval'}>
              {task.pending.operation ? <OperationApproval task={task} busy={busy} onApprove={(allow, approveAll = false) => void send('/api/agent/approve', {
                taskId: task.id, approvalId: task.pending?.id, allow, approveAll,
              })} /> : <>
              <span className="local-eyebrow">Your approval is required</span>
              <h3>{task.pending.kind === 'readTab' ? 'Read this selected page?' : task.pending.kind === 'search' ? 'Run this web search?' : task.pending.kind === 'redirect' ? 'Follow this redirect to another website?' : 'Follow this link?'}</h3>
              <p>{task.pending.reason}</p>
              <code>{task.pending.url}</code>
              <div className="task-approval-actions approval-choices">
                <button className="assistant-secondary" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: false })}>Decline & stop</button>
                <button className="assistant-primary approval-allow" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: true })}>{task.pending.kind === 'readTab' ? 'Approve this page read' : 'Approve navigation'}</button>
                <button className="assistant-primary approval-allow-all" disabled={busy}
                  onClick={() => void send('/api/agent/approve', { taskId: task.id, approvalId: task.pending?.id, allow: true, approveAll: true })}>Approve all for this task</button>
              </div>
              <p className="approval-scope">{task.pending.kind === 'readTab'
                ? 'Approve all covers only the explicitly selected, unchanged pages for this comparison task. Each read is audited. No other tabs, navigation or page changes. Revoke affects unread pages; Stop cancels local work, but cannot undo content already shared or remote model charges.'
                : task.mode === 'prepare'
                ? 'Approve all covers supported public search actions and GET navigation in this task only. Each action is audited and revalidated. No booking, payment, messages, uploads or non-search submissions. Revoke or Stop at any time.'
                : 'Allow all covers up to six page reads across websites in this run, including sharing their content with your model. It never authorizes bookings, buying, form submissions, uploads or downloads. You can revoke it or stop at any time.'}</p>
              <details><summary>{task.pending.kind === 'readTab' ? 'Read-only sharing & privacy details' : 'Navigation & privacy details'}</summary>
                <p className="privacy-note">{task.pending.kind === 'readTab'
                  ? 'Snapshots do not activate, navigate or change original tabs. Native URL and document identity are checked before and after reading, and before publishing. Existing website scripts and signed-in cookies still run; this is not an isolated profile. Two concurrent no-tools readers may send approved page text to your selected model.'
                  : `This replaces the page in ${task.preserveTabs ? 'the dedicated research tab, not your original tabs' : 'this tab'} and shares its content with your model. Same-site redirects are followed; redirects to another website pause for approval (or your research permission). Checkout/account pages, form submissions, popups and downloads are blocked. Normal site scripts, their network requests and signed-in cookies still apply; this is not an isolated browsing profile.`}</p>
              </details>
              </>}
            </div>
          )}
          <OperationTrail task={task} />
          {(task.status === 'completed' || task.status === 'noEvidence') && task.comparison && <ComparisonResults task={task} />}
          {task.error && <article className="task-error" ref={resultCard} tabIndex={-1} aria-label="Task failure" role="alert">
            <strong>Task failed without a final answer</strong><p>{task.error}</p>
            <TaskDiagnostic task={task} />
            <p>{task.mode === 'prepare' ? 'No booking or payment was authorized. Already executed actions are not undone.' : 'No booking was made.'} Start a new task to retry; your earlier conversation is shown above.</p>
            <DiagnosticActions task={task} />
          </article>}
          {task.message && task.status !== 'needsInput' && <article className="task-result" ref={resultCard} tabIndex={-1} aria-label="Task guidance">
            <h3>{task.status === 'stopped' ? 'Why the task stopped' : task.mode === 'prepare' ? 'Preparation requires manual handling' : 'I could not verify this'}</h3>
            <div className="chat-text">{task.message}</div>
            <p className="privacy-note">{task.status === 'stopped' ? 'No further task actions will run. Retry with my details preserves your request as an editable draft and requires fresh consent and approval.' : task.mode === 'prepare' ? 'Unsupported actions require manual use. No booking or payment was authorized; any already executed actions remain on the page.' : 'This is not a completed research result. No booking was made.'}</p>
          </article>}
          {task.answer && task.mode !== 'prepare' && <article className="task-result" ref={resultCard} tabIndex={-1} aria-label="Research brief">
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
                {task.mode === 'prepare' ? 'View preparation' : task.answer ? 'View findings' : 'View research trail'}
              </button>
              <button className="assistant-secondary" onClick={newTask}>Start a new task</button>
              {(task.error || task.status === 'stopped') && <button className="assistant-secondary" onClick={retryTask}>Retry with my details</button>}
            </div>
            <p className="privacy-note">Tasks and conversation stay in memory for this browser session only. Preparation retains your previous research findings. Research permissions never authorize page actions; purchases and bookings are not automated.</p>
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
              <p className="privacy-note">Starting point: {task.startMode === 'webSearch' ? 'Web search (starting tab not read)' : 'Current page'}. {task.mode === 'prepare' ? 'Only exact approved public search actions; no transactions authorized.' : 'No forms filled or bookings made.'} Six-page and ten-minute limits include replies.</p>
            </details>
            <SearchTrail task={task} />
            {!task.error && <TaskDiagnostic task={task} />}
          </div>
        </div>
      )}
    </section>
  )
}
