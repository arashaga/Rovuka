import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest, readEvents, type ModelSettings } from './modelApi.ts'
import { apiHeaders, apiUrl } from './ipc.ts'

type Runtime = 'ollama' | 'lmStudio'
interface InstalledModel { id: string; sizeBytes: number | null }
interface RuntimeStatus {
  runtime: Runtime
  baseUrl: string
  available: boolean
  models: InstalledModel[]
  message: string
}
interface CatalogModel {
  id: string
  name: string
  description: string
  downloadBytes: number
  recommendedMemoryBytes: number
  license: string
  sourceUrl: string
}
interface Overview {
  hardware: {
    memoryBytes: number
    availableMemoryBytes: number
    logicalCpus: number
    architecture: string
    accelerationNote: string
  }
  runtimes: RuntimeStatus[]
  catalog: CatalogModel[]
}
interface Progress { status: string; completed: number | null; total: number | null }

const runtimeName = (runtime: Runtime) => runtime === 'ollama' ? 'Ollama' : 'LM Studio'
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function LocalModels({
  settings, onActivate,
}: {
  settings: ModelSettings | null
  onActivate: (saved: ModelSettings) => void
}) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [ollamaUrl, setOllamaUrl] = useState('http://127.0.0.1:11434')
  const [lmStudioUrl, setLmStudioUrl] = useState('http://127.0.0.1:1234')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<CatalogModel | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [activating, setActivating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const discoveryAbortRef = useRef<AbortController | null>(null)
  const endpointRef = useRef({ ollamaUrl, lmStudioUrl })
  endpointRef.current = { ollamaUrl, lmStudioUrl }
  const approvalRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (signal?: AbortSignal, saveAddresses = false) => {
    discoveryAbortRef.current?.abort()
    const controller = new AbortController()
    discoveryAbortRef.current = controller
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    setLoading(true)
    setError('')
    try {
      if (saveAddresses) {
        await apiRequest('/api/local/preferences', {
          method: 'PUT', body: JSON.stringify(endpointRef.current), signal: requestSignal,
        })
      }
      const data = await apiRequest<Overview>('/api/local', { signal: requestSignal })
      const ollamaRuntime = data.runtimes.find((runtime) => runtime.runtime === 'ollama')
      const lmStudioRuntime = data.runtimes.find((runtime) => runtime.runtime === 'lmStudio')
      if (!ollamaRuntime || !lmStudioRuntime) throw new Error('The server returned an incomplete runtime overview.')
      setOverview(data)
      setOllamaUrl(ollamaRuntime.baseUrl)
      setLmStudioUrl(lmStudioRuntime.baseUrl)
    } catch (reason) {
      if (!requestSignal.aborted) setError(errorMessage(reason))
    } finally {
      if (!requestSignal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => {
      controller.abort()
      abortRef.current?.abort()
      discoveryAbortRef.current?.abort()
    }
  }, [refresh])

  useEffect(() => {
    if (confirmation) {
      approvalRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      approvalRef.current?.focus({ preventScroll: true })
    }
  }, [confirmation])

  const activate = async (runtime: RuntimeStatus, model: string) => {
    setActivating(true)
    setError('')
    try {
      const saved = await apiRequest<ModelSettings>('/api/local/activate', {
        method: 'POST', body: JSON.stringify({ runtime: runtime.runtime, baseUrl: runtime.baseUrl, model }),
      })
      onActivate(saved)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setActivating(false)
    }
  }

  const restoreCloud = async () => {
    setActivating(true)
    setError('')
    try {
      onActivate(await apiRequest<ModelSettings>('/api/local/restore-cloud', { method: 'POST' }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setActivating(false)
    }
  }

  const download = async (model: CatalogModel) => {
    const controller = new AbortController()
    abortRef.current = controller
    setConfirmation(null)
    setDownloading(model.id)
    setProgress({ status: 'Connecting to Ollama...', completed: null, total: null })
    setError('')
    setNotice('')
    let success = false
    try {
      const response = await fetch(apiUrl('/api/local/pull'), {
        method: 'POST', headers: apiHeaders(), signal: controller.signal,
        body: JSON.stringify({ runtime: 'ollama', baseUrl: ollama?.baseUrl, model: model.id }),
      })
      await readEvents(response, (type, data) => {
        if (type === 'error') throw new Error((JSON.parse(data) as { message: string }).message)
        if (type === 'progress') {
          const next = JSON.parse(data) as Progress
          success = next.status === 'success'
          setProgress(next)
        }
      })
      if (!success) throw new Error('Download ended before verification. Refresh and retry to resume.')
      setNotice(`${model.name} is ready. Choose Use model to start chatting.`)
      await refresh(controller.signal)
    } catch (reason) {
      if (controller.signal.aborted) setNotice('Stopped watching. Ollama may continue downloading; refresh to check. Retry resumes existing layers.')
      else setError(errorMessage(reason))
    } finally {
      setDownloading(null)
      abortRef.current = null
    }
  }

  const ollama = overview?.runtimes.find((runtime) => runtime.runtime === 'ollama')
  const busy = downloading !== null || activating
  const percent = progress?.total && progress.completed != null
    ? Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100))) : null

  return (
    <section className="local-models" aria-label="Local model manager">
      <div className="local-hero">
        <div className="eyebrow">YOUR PERSONAL MODEL STUDIO</div>
        <h2>Good ideas.<br />Closer to home.</h2>
        <p>Bring AI onto your computer. Connect a local runtime, choose a model, and ask this page without a cloud model API.</p>
        <span className="local-pill">Local inference · No provider API key</span>
      </div>
      {overview && (
        <div className="hardware-grid" aria-label="Your computer">
          <div><strong>{size(overview.hardware.memoryBytes)}</strong><span>System memory</span></div>
          <div><strong>{size(overview.hardware.availableMemoryBytes)}</strong><span>Available now</span></div>
          <div><strong>{overview.hardware.logicalCpus}</strong><span>CPU threads · {overview.hardware.architecture}</span></div>
        </div>
      )}
      <div className="section-heading"><div><h3>Connect your runtime</h3><p>Detection only. Nothing is installed automatically.</p></div>
        <button className="assistant-secondary" disabled={loading || busy} onClick={() => void refresh(undefined, true)}>{loading ? 'Checking...' : 'Refresh'}</button>
      </div>
      <details className="runtime-settings">
        <summary>Local server addresses</summary>
        <label>Ollama<input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} disabled={busy || loading} /></label>
        <label>LM Studio<input value={lmStudioUrl} onChange={(e) => setLmStudioUrl(e.target.value)} disabled={busy || loading} /></label>
        <p>Only localhost addresses are accepted. Select Refresh to apply.</p>
      </details>
      {overview?.runtimes.map((runtime) => (
        <article className="runtime-card" key={runtime.runtime}>
          <div className="runtime-heading"><strong>{runtimeName(runtime.runtime)}</strong>
            <span className={runtime.available ? 'status-ready' : 'status-offline'}>{runtime.available ? 'Connected' : 'Not connected'}</span>
          </div>
          <p>{runtime.message}</p>
          {!runtime.available && <a href={runtime.runtime === 'ollama' ? 'https://ollama.com/download' : 'https://lmstudio.ai/download'} target="_blank" rel="noreferrer">Get {runtimeName(runtime.runtime)} ↗</a>}
          {runtime.available && runtime.models.length === 0 && <p>No local models found. Download one below{runtime.runtime === 'lmStudio' ? ' or load a model in LM Studio' : ''}.</p>}
          {runtime.models.map((model) => {
            const active = settings?.model === model.id && settings.baseUrl.replace(/\/v1\/?$/, '/') === runtime.baseUrl
            return <div className="installed-model" key={model.id}>
              <div><strong>{model.id}</strong><span>{model.sizeBytes ? size(model.sizeBytes) : 'Managed by runtime'}</span></div>
              <button className={active ? 'assistant-secondary' : 'assistant-primary'} disabled={busy || active} onClick={() => void activate(runtime, model.id)}>{active ? 'Active' : 'Use model'}</button>
            </div>
          })}
        </article>
      ))}
      {error && <div className="assistant-error" role="alert">{error}</div>}
      {notice && <div className="local-notice" role="status">{notice}</div>}
      {downloading && <div className="download-panel" role="status">
        <strong>Downloading {downloading}</strong><p>{progress?.status}</p>
        <progress aria-label="Current model layer download" value={percent ?? undefined} max={100} />
        <div className="download-footer"><span>{percent === null ? 'Preparing / verifying' : `${percent}% of current layer`}</span>
          <button className="assistant-secondary" onClick={() => abortRef.current?.abort()}>Stop watching</button>
        </div>
      </div>}
      {confirmation && <div className="download-confirmation" ref={approvalRef} tabIndex={-1} role="region" aria-label="Model download approval">
        <h3>Download {confirmation.name}?</h3>
        <p>About {size(confirmation.downloadBytes)} plus runtime storage. Ollama downloads from its registry over the internet and verifies layers. Model terms: {confirmation.license}.</p>
        <p>This does not change your active model. No API key is sent.</p>
        <div className="confirmation-actions">
          <button className="assistant-secondary" onClick={() => setConfirmation(null)}>Not now</button>
          <button className="assistant-primary" onClick={() => void download(confirmation)}>Download model</button>
        </div>
      </div>}
      <div className="section-heading"><div><h3>A small, thoughtful collection</h3><p>Approximate downloads. Memory guidance, not a benchmark.</p></div></div>
      {overview?.catalog.map((model) => {
        const installed = ollama?.models.some((entry) => entry.id === model.id)
        const suggested = overview.hardware.availableMemoryBytes >= model.recommendedMemoryBytes
        return <article className="catalog-card" key={model.id}>
          <div className="runtime-heading"><h4>{model.name}</h4><span className="model-size">{size(model.downloadBytes)}</span></div>
          <p>{model.description}</p>
          <div className="model-meta"><span>{suggested ? 'Within memory guidance' : `${size(model.recommendedMemoryBytes)} available memory suggested`}</span>
            <a href={model.sourceUrl} target="_blank" rel="noreferrer">Model &amp; license ↗</a>
          </div>
          <button className="assistant-secondary" disabled={busy || !ollama?.available || installed} onClick={() => { setConfirmation(model); setError('') }}>{installed ? 'Installed' : 'Review download'}</button>
        </article>
      })}
      <p className="local-footnote">{overview?.hardware.accelerationNote} The browser does not enforce network isolation on external runtimes. Only download models whose license fits your use.</p>
      <button className="assistant-secondary" disabled={busy} onClick={() => void restoreCloud()}>Return to saved cloud model</button>
    </section>
  )
}
