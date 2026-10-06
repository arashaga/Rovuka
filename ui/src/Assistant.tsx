import { useEffect, useRef, useState, type FormEvent } from 'react'
import { apiHeaders, apiUrl, host, type HostEvent, type PageTextEvent } from './ipc.ts'
import { apiRequest, readEvents, type ModelSettings, type Provider } from './modelApi.ts'
import LocalModels from './LocalModels.tsx'
import TaskMode from './TaskMode.tsx'
import SafetyCenter from './SafetyCenter.tsx'
import Reliability from './Reliability.tsx'

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
  const [panel, setPanel] = useState<'chat' | 'local' | 'task' | 'safety' | 'reliability'>('chat')
  const [taskActive, setTaskActive] = useState(false)
  const [taskGoal, setTaskGoal] = useState('')
  const [taskPrepare, setTaskPrepare] = useState(false)
  const [taskDraftKey, setTaskDraftKey] = useState('')
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
      setTaskGoal(workspaceRequest.goal?.trim() || '')
      setTaskPrepare(workspaceRequest.prepare === true)
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
        <div>
          <strong>✦ Rovuka</strong>
          <span>Your web. Your model. Your choice.</span>
        </div>
        <div className="assistant-header-actions">
          <button className="assistant-icon-button" title="Model settings" aria-label="Model settings" disabled={busy || taskActive} onClick={() => { host.send({ type: 'setAssistantExpanded', expanded: false }); setPanel('chat'); setSettingsOpen((open) => !open) }}>
            ⚙
          </button>
          <button
            className="assistant-icon-button"
            title="Close Ask AI"
            onClick={() => host.send({ type: 'toggleAssistant' })}
          >
            ×
          </button>
        </div>
      </header>

      {!expanded && <nav className="assistant-tabs" aria-label="Assistant workspace">
        <button aria-pressed={panel === 'chat'} disabled={busy || taskActive} onClick={() => setPanel('chat')}>Ask this page</button>
        <button aria-pressed={panel === 'task'} disabled={busy || taskActive} onClick={() => { setTaskGoal(''); setTaskPrepare(false); setTaskDraftKey(''); setPanel('task'); setSettingsOpen(false) }}>Task mode</button>
        <button aria-pressed={panel === 'local'} disabled={busy || taskActive} onClick={() => setPanel('local')}>Local models</button>
        <button aria-pressed={panel === 'safety'} disabled={busy || taskActive} onClick={() => { setPanel('safety'); setSettingsOpen(false) }}>Safety</button>
        <button aria-pressed={panel === 'reliability'} disabled={busy || taskActive} onClick={() => { setPanel('reliability'); setSettingsOpen(false) }}>Reliability</button>
      </nav>}

      {workspaceRequest && busy && <p className="assistant-shortcut-notice" role="status">Your start-page shortcut will open when this response finishes.</p>}
      {panel === 'task' ? (
        <TaskMode key={taskDraftKey} onActive={setTaskActive} expanded={expanded} initialGoal={taskGoal} initialPrepare={taskPrepare} startFresh={!!taskDraftKey} />
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
              ×
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
            When “Use current page” is on, page text is sent to the selected provider. Page text is treated as untrusted input;
            the assistant cannot click, submit forms, or take actions in this phase.
          </p>
          <button className="assistant-primary" type="submit">Save model settings</button>
        </form>
      ) : (
        <>
          <div className="assistant-context-note">
            Ask this page answers questions; it does not search websites. For flights, shopping or sourced comparisons, choose Research the web.
            {' '}Page text is shared only when “Use current page” is checked.
          </div>
          <div className="assistant-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="assistant-empty">
                <div className="assistant-spark">✦</div>
                <h2>Understand this page</h2>
                <p>Ask for a summary, explanation, translation, or help finding a detail.</p>
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
            <label className="check-label page-context-toggle">
              <input type="checkbox" checked={includePage} onChange={(event) => setIncludePage(event.target.checked)} />
              Use current page
            </label>
            <textarea
              ref={inputRef}
              value={question}
              placeholder="Ask a question…"
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
              <span>{settings?.model ?? 'Configure a model in settings'}</span>
              <button className="assistant-primary" type="submit" disabled={!question.trim() || busy}>
                {busy ? 'Working…' : 'Ask'}
              </button>
            </div>
            <button className="assistant-secondary" type="button" disabled={!question.trim() || busy || taskActive}
              onClick={() => researchWeb(question)}>Research the web</button>
          </form>
        </>
      )}
    </main>
  )
}
