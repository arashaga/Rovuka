import { useEffect, useRef, useState, type FormEvent } from 'react'
import { apiHeaders, apiUrl, host, type HostEvent, type PageTextEvent, type TabInfo, type TaskDraftStart } from './ipc.ts'
import { apiRequest, readEvents, type ModelSettings, type Provider } from './modelApi.ts'
import LocalModels from './LocalModels.tsx'
import TaskMode from './TaskMode.tsx'
import SafetyCenter from './SafetyCenter.tsx'
import Reliability from './Reliability.tsx'
import Memory from './Memory.tsx'
import type { MemoryPreview } from './memoryTypes.ts'
import { BrandMark, Icon } from './Icons.tsx'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  pageTitle?: string
  failure?: string
  researchGoal?: string
  redactions?: number
}

const defaults: Record<Provider, Pick<ModelSettings, 'baseUrl' | 'model' | 'apiVersion'>> = {
  openAiCompatible: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiVersion: '2024-10-21',
  },
  azureOpenAi: {
    baseUrl: '',
    model: '',
    apiVersion: '2024-10-21',
  },
  anthropic: {
    baseUrl: '',
    model: 'claude-3-7-sonnet-latest',
    apiVersion: '',
  },
  gemini: {
    baseUrl: '',
    model: 'gemini-2.5-flash',
    apiVersion: '',
  },
}

export default function Assistant() {
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panel, setPanel] = useState<'chat' | 'local' | 'task' | 'safety' | 'reliability' | 'memory'>('chat')
  const [taskActive, setTaskActive] = useState(false)
  const [taskGoal, setTaskGoal] = useState('')
  const [taskPrepare, setTaskPrepare] = useState(false)
  const [taskStartMode, setTaskStartMode] = useState<TaskDraftStart>('webSearch')
  const [taskCompareOptions, setTaskCompareOptions] = useState(true)
  const [taskDraftKey, setTaskDraftKey] = useState('')
  const [taskMemory, setTaskMemory] = useState<MemoryPreview | null>(null)
  const [workspaceRequest, setWorkspaceRequest] = useState<Extract<HostEvent, { type: 'assistantWorkspace' }> | null>(null)
  const lastWorkspaceRequest = useRef('')
  const [expanded, setExpanded] = useState(false)
  const [provider, setProvider] = useState<Provider>('openAiCompatible')
  const [baseUrl, setBaseUrl] = useState(defaults.openAiCompatible.baseUrl)
  const [model, setModel] = useState(defaults.openAiCompatible.model)
  const [apiVersion, setApiVersion] = useState(defaults.openAiCompatible.apiVersion)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [question, setQuestion] = useState('')
  const [includePage, setIncludePage] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [activePage, setActivePage] = useState<TabInfo | null>(null)
  const waitingForPage = useRef(new Map<string, (event: PageTextEvent) => void>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    apiRequest<ModelSettings>('/api/settings')
      .then((saved) => {
        if (cancelled) return
        setSettings(saved)
        setProvider(saved.provider)
        setBaseUrl(saved.baseUrl)
        setModel(saved.model)
        setApiVersion(saved.apiVersion)
        if (!saved.configured) setSettingsOpen(true)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    const unsubscribe = host.subscribe((event: HostEvent) => {
      if (event.type === 'assistantWorkspace') {
        if (lastWorkspaceRequest.current !== event.requestId) {
          lastWorkspaceRequest.current = event.requestId
          setWorkspaceRequest(event)
        }
        return
      }
      if (event.type === 'assistantLayout') {
        setExpanded(event.expanded)
        return
      }
      if (event.type === 'tabs') {
        setActivePage(event.tabs.find(tab => tab.id === event.active) || null)
        return
      }
      if (event.type !== 'pageText') return
      const complete = waitingForPage.current.get(event.requestId)
      if (complete) {
        waitingForPage.current.delete(event.requestId)
        complete(event)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
      waitingForPage.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!workspaceRequest || busy) return
    setSettingsOpen(workspaceRequest.panel === 'settings')
    setPanel(workspaceRequest.panel === 'settings' ? 'chat' : workspaceRequest.panel)
    setTaskActive(false)
    setError('')
    if (workspaceRequest.panel === 'task') {
      setTaskMemory(null)
      setTaskGoal(workspaceRequest.goal?.trim() || '')
      setTaskPrepare(workspaceRequest.prepare === true)
      setTaskStartMode(workspaceRequest.taskStartMode || 'webSearch')
      setTaskCompareOptions(workspaceRequest.compareOptions ?? true)
      setTaskDraftKey(workspaceRequest.requestId)
    }
    setWorkspaceRequest(null)
  }, [workspaceRequest, busy])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  const getPageText = () =>
    new Promise<PageTextEvent>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const timer = window.setTimeout(() => {
        waitingForPage.current.delete(requestId)
        reject(new Error('Timed out while reading the current page'))
      }, 12_000)
      waitingForPage.current.set(requestId, (event) => {
        window.clearTimeout(timer)
        if (event.error) reject(new Error(event.error))
        else resolve(event)
      })
      host.send({ type: 'getPageText', requestId })
    })

  const updateMessage = (id: string, update: (message: ChatMessage) => ChatMessage) =>
    setMessages((previous) => previous.map((message) => (message.id === id ? update(message) : message)))

  const researchWeb = (goal: string) => {
    if (busy || taskActive) return
    setTaskGoal(goal.trim())
    setTaskPrepare(false)
    setTaskStartMode('webSearch')
    setTaskCompareOptions(true)
    setTaskMemory(null)
    setTaskDraftKey(crypto.randomUUID())
    setSettingsOpen(false)
    host.send({ type: 'setAssistantExpanded', expanded: false })
    setPanel('task')
  }

  const submit = async () => {
    const prompt = question.trim()
    if (!prompt || busy) return
    setError('')
    setQuestion('')
    setBusy(true)
    const userId = crypto.randomUUID()
    const answerId = crypto.randomUUID()
    setMessages((previous) => [
      ...previous,
      { id: userId, role: 'user', text: prompt },
      { id: answerId, role: 'assistant', text: '' },
    ])
    try {
      let pageText: PageTextEvent | null = null
      if (includePage) {
        pageText = await getPageText()
        if (!pageText.text.trim()) throw new Error('No readable text was found on the current page.')
        updateMessage(answerId, (message) => ({
          ...message,
          pageTitle: `${pageText?.title || pageText?.url}${pageText?.truncated ? ' (first 80,000 characters)' : ''}`,
        }))
      }
      const response = await fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          question: prompt,
          pageText: pageText
            ? `Page title: ${pageText.title}\nPage URL: ${pageText.url}\n\n${pageText.text}`
            : null,
        }),
      })
      await readEvents(response, (eventType, data) => {
        const value = JSON.parse(data) as { delta?: string; message?: string; redactions?: number }
        if (eventType === 'error') throw new Error(value.message ?? 'The model stream failed.')
        if (eventType === 'privacy') updateMessage(answerId, message => ({ ...message, redactions: value.redactions ?? 0 }))
        if (value.delta) updateMessage(answerId, (message) => ({ ...message, text: message.text + value.delta }))
      })
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : String(reason)
      updateMessage(answerId, (message) => ({ ...message, failure, researchGoal: prompt }))
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const chooseProvider = (next: Provider) => {
    setProvider(next)
    setBaseUrl(defaults[next].baseUrl)
    setModel(defaults[next].model)
    setApiVersion(defaults[next].apiVersion)
    setApiKey('')
    setClearApiKey(false)
  }

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    try {
      const saved = await apiRequest<ModelSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          settings: { provider, baseUrl, model, apiVersion },
          apiKey: apiKey || null,
          clearApiKey,
        }),
      })
      setSettings(saved)
      setApiKey('')
      setClearApiKey(false)
      setSettingsOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <main className="assistant">
      <header className="assistant-header">
        <div className="assistant-brand">
          <BrandMark /><div><strong>Rovuka <span>Assistant</span></strong>
            <span>Your model. Your control.</span></div>
        </div>
        <div className="assistant-header-actions">
          <button className="assistant-icon-button" title="Model settings" aria-label="Model settings" disabled={busy || taskActive} onClick={() => { host.send({ type: 'setAssistantExpanded', expanded: false }); setPanel('chat'); setSettingsOpen((open) => !open) }}>
            <Icon name="settings" />
          </button>
          <button className="assistant-icon-button" title={expanded ? 'Show browser' : 'Expand workspace'}
            aria-label={expanded ? 'Show browser' : 'Expand workspace'}
            onClick={() => host.send({ type: 'setAssistantExpanded', expanded: !expanded })}>
            <Icon name={expanded ? 'collapse' : 'expand'} />
          </button>
          <button
            className="assistant-icon-button"
            title="Close Ask AI"
            aria-label="Close Ask AI"
            onClick={() => host.send({ type: 'toggleAssistant' })}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>

      {!expanded && <nav className="assistant-tabs" aria-label="Assistant workspace">
        <div className="assistant-primary-tabs">
          <button aria-pressed={panel === 'chat' && !settingsOpen} disabled={busy || taskActive} onClick={() => { setPanel('chat'); setSettingsOpen(false) }}>Ask this page</button>
          <button aria-pressed={panel === 'task'} disabled={busy || taskActive} onClick={() => { setTaskGoal(''); setTaskPrepare(false); setTaskStartMode('webSearch'); setTaskCompareOptions(true); setTaskMemory(null); setTaskDraftKey(''); setPanel('task'); setSettingsOpen(false) }}>Task mode</button>
          <button aria-pressed={panel === 'memory'} disabled={busy || taskActive} onClick={() => { setPanel('memory'); setSettingsOpen(false) }}>Memory</button>
        </div>
        <div className="assistant-secondary-tabs">
          <button aria-pressed={panel === 'local'} disabled={busy || taskActive} onClick={() => { setPanel('local'); setSettingsOpen(false) }}>Local models</button>
          <button aria-pressed={panel === 'safety'} disabled={busy || taskActive} onClick={() => { setPanel('safety'); setSettingsOpen(false) }}>Safety</button>
          <button aria-pressed={panel === 'reliability'} disabled={busy || taskActive} onClick={() => { setPanel('reliability'); setSettingsOpen(false) }}>Reliability</button>
        </div>
      </nav>}

      {workspaceRequest && busy && <p className="assistant-shortcut-notice" role="status">Your start-page shortcut will open when this response finishes.</p>}
      {panel === 'task' ? (
        <TaskMode key={taskDraftKey} onActive={setTaskActive} expanded={expanded} initialGoal={taskGoal} initialPrepare={taskPrepare}
          initialStartMode={taskStartMode} initialCompareOptions={taskCompareOptions} initialMemory={taskMemory} startFresh={!!taskDraftKey} />
      ) : panel === 'memory' ? (
        <Memory onResearch={preview => {
          setTaskMemory(preview)
          setTaskGoal('Use the selected historical context as background. Research current facts with fresh sources and clearly mark uncertainty. Verify remembered prices; do not book or buy anything.')
          setTaskPrepare(false)
          setTaskStartMode('webSearch')
          setTaskCompareOptions(true)
          setTaskDraftKey(crypto.randomUUID())
          setPanel('task')
        }} />
      ) : panel === 'local' ? (
        <LocalModels settings={settings} onActivate={(saved) => {
          setSettings(saved)
          setProvider(saved.provider)
          setBaseUrl(saved.baseUrl)
          setModel(saved.model)
          setApiVersion(saved.apiVersion)
          setSettingsOpen(false)
          setPanel('chat')
          setError('')
        }} />
      ) : panel === 'safety' ? (
        <SafetyCenter />
      ) : panel === 'reliability' ? (
        <Reliability onActive={setTaskActive} />
      ) : settingsOpen ? (
        <form className="model-settings" onSubmit={saveSettings}>
          <div className="model-settings-title">
            <div>
              <h2>Connect a model</h2>
              <p>Keys are saved to your system credential store; they are never written to settings files.</p>
            </div>
            <button type="button" className="assistant-icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
              <Icon name="close" />
            </button>
          </div>
          <label>
            Provider
            <select value={provider} onChange={(event) => chooseProvider(event.target.value as Provider)}>
              <option value="openAiCompatible">OpenAI-compatible (OpenAI, Foundry v1, Ollama, LM Studio, OpenRouter…)</option>
              <option value="azureOpenAi">Azure OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </label>
          <label>
            {provider === 'azureOpenAi'
              ? 'Azure resource endpoint'
              : provider === 'openAiCompatible'
                ? 'API base URL or endpoint'
                : 'API base URL'}
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={provider === 'openAiCompatible' ? 'https://api.openai.com/v1 or …/openai/v1/responses' : 'https://…'}
              autoComplete="url"
              spellCheck={false}
            />
          </label>
          <label>
            {provider === 'azureOpenAi' ? 'Deployment name' : 'Model / deployment'}
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model or deployment name" required />
          </label>
          {provider === 'azureOpenAi' && (
            <label>
              API version
              <input value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} required />
            </label>
          )}
          <label>
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={settings?.provider === provider && settings.apiKeyConfigured ? 'Saved — enter a new key to replace it' : 'Paste your API key'}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
          <p className="local-model-note">Leave the key blank for local Ollama or LM Studio endpoints that do not require one.</p>
          {settings?.provider === provider && settings.apiKeyConfigured && (
            <label className="check-label">
              <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />
              Remove saved API key
            </label>
          )}
          <p className="privacy-note">
            When “Use current page” is on, page text is sent to your chosen model. Ask this page is read-only;
            research and public-search preparation use separate Task mode sharing and approvals.
          </p>
          <button className="assistant-primary" type="submit">Save model settings</button>
        </form>
      ) : (
        <>
          <div className="assistant-context-note">
            <div className="assistant-context-heading"><Icon name="page" /><strong>Current page context</strong><span>{includePage ? 'Read on send' : 'Not sharing'}</span></div>
            <button className="assistant-context-page" title={activePage?.url || 'Open a webpage to ask about it'}
              onClick={() => host.send({ type: activePage?.url ? 'focusContent' : 'focusOmnibox' })}>
              <span>{activePage?.url ? activePage.title || activePage.url : 'Open a webpage to get started'}</span><Icon name="arrow" />
            </button>
            <p>Ask this page answers questions; it does not search websites. For flights, shopping or sourced comparisons, choose Research the web.
              {' '}Page text is shared only when “Use current page” is checked.</p>
            <label className="check-label page-context-toggle">
              <input type="checkbox" checked={includePage} onChange={(event) => setIncludePage(event.target.checked)} />
              Use current page
            </label>
          </div>
          <div className="assistant-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="assistant-empty">
                <section className="assistant-suggestions" aria-labelledby="assistant-suggestions-title">
                  <h2 id="assistant-suggestions-title"><Icon name="spark" />Suggested actions</h2>
                  <button type="button" onClick={() => {
                    setQuestion('Summarize the key takeaways from this page, including important caveats.')
                    inputRef.current?.focus()
                  }}>Summarize the key takeaways<Icon name="arrow" /></button>
                  <button type="button" onClick={() => host.send({ type: 'openAssistant', panel: 'task',
                    taskStartMode: 'selectedTabs', goal: 'Compare the tabs I select. Show the important differences, sources and any unknown details.' })}>
                    Compare selected tabs<Icon name="matrix" /></button>
                  <button type="button" onClick={() => {
                    setQuestion('Explain the main claims on this page and identify unsupported assumptions or possible bias. Distinguish observations from interpretation.')
                    inputRef.current?.focus()
                  }}>Examine claims and possible bias<Icon name="arrow" /></button>
                </section>
                <section className="assistant-capabilities" aria-label="Task capabilities and limits">
                  <h2><Icon name="shield" />Task capability limits</h2>
                  <p>Research is read-only. Public-search preparation needs your approval. Approve one change or all supported actions for that task; booking, payment and signing in stay manual.</p>
                  <button className="assistant-capability-button" type="button" onClick={() => researchWeb(question)}>Review a research draft<Icon name="arrow" /></button>
                </section>
                {!settings?.configured && (
                  <button className="assistant-secondary" onClick={() => setSettingsOpen(true)}>Set up a model</button>
                )}
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`chat-message ${message.role}`}>
                <div className="chat-role">{message.role === 'user' ? 'You' : 'Rovuka'}</div>
                {message.pageTitle && <div className="chat-source">From page: {message.pageTitle}</div>}
                {message.redactions !== undefined && message.redactions > 0 && <div className="chat-source chat-privacy" role="status">
                  Privacy shield masked {message.redactions} recognizable secrets before sharing with your model.
                </div>}
                {(!message.failure || message.text) && <div className="chat-text">{message.text || (busy && message.role === 'assistant' ? 'Thinking…' : '')}</div>}
                {message.failure && <div className="chat-recovery">
                  <div role="alert">{message.failure}</div>
                  <p>For web searches and comparisons, continue in Task mode. To ask without page context, turn off “Use current page” and retry.</p>
                  <button className="assistant-primary" disabled={busy || taskActive}
                    onClick={() => researchWeb(message.researchGoal || '')}>Research this request</button>
                  <button className="assistant-secondary" disabled={busy}
                    onClick={() => { setQuestion(message.researchGoal || ''); inputRef.current?.focus() }}>Edit and retry</button>
                </div>}
              </article>
            ))}
          </div>
          {error && <div className="assistant-error" role="alert">{error}</div>}
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <textarea
              ref={inputRef}
              value={question}
              placeholder="Ask a question…"
              aria-label="Ask a question"
              rows={3}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="composer-footer">
              <button className="composer-model" type="button" title={settings?.configured ? `Configured model: ${settings.model}. Open model settings.` : 'Open model settings'}
                disabled={busy || taskActive} onClick={() => setSettingsOpen(true)}>
                <Icon name="model" /><span>{settings?.configured ? settings.model : 'Connect a model'}</span><Icon name="down" />
              </button>
              <button className="assistant-secondary research-shortcut" type="button" disabled={!question.trim() || busy || taskActive}
                onClick={() => researchWeb(question)}>Research the web</button>
              <button className="assistant-primary" type="submit" disabled={!question.trim() || busy}>
                <Icon name="send" />{busy ? 'Working…' : 'Ask'}
              </button>
            </div>
          </form>
        </>
      )}
    </main>
  )
}
