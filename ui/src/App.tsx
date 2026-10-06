import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { host, type DownloadInfo, type TabInfo, type TabId } from './ipc.ts'
import { BrandMark, Icon } from './Icons.tsx'
import useModelStatus from './useModelStatus.ts'

function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url
}

function Favicon({ tab }: { tab: TabInfo }) {
  const [broken, setBroken] = useState(false)
  if (tab.loading) return <span className="spinner" />
  if (!tab.favicon || broken) return <Icon name={tab.url ? 'globe' : 'spark'} className="favicon-placeholder" />
  return <img className="favicon" src={tab.favicon} onError={() => setBroken(true)} alt="" />
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [active, setActive] = useState<TabId | null>(null)
  const [downloads, setDownloads] = useState<Map<number, DownloadInfo>>(new Map())
  const [omnibox, setOmnibox] = useState('')
  const [editing, setEditing] = useState(false)
  const [findingsOpen, setFindingsOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const [tabOverflow, setTabOverflow] = useState(false)
  const { settings, error: modelError } = useModelStatus()

  const activeTab = tabs.find((t) => t.id === active)
  const address = activeTab?.pendingUrl || activeTab?.loadError?.url || activeTab?.url || ''
  const parsedAddress = URL.canParse(address) ? new URL(address) : null
  const externalHttp = parsedAddress?.protocol === 'http:'
    && !['localhost', '127.0.0.1', '[::1]'].includes(parsedAddress.hostname)

  useEffect(
    () =>
      host.subscribe((e) => {
        switch (e.type) {
          case 'assistantLayout':
            setFindingsOpen(e.expanded)
            break
          case 'tabs':
            setTabs(e.tabs)
            setActive(e.active)
            break
          case 'download':
            setDownloads((prev) => new Map(prev).set(e.download.id, e.download))
            break
          case 'focusOmnibox':
            inputRef.current?.focus()
            inputRef.current?.select()
            break
        }
      }),
    [],
  )

  // Keep the omnibox in sync with the active tab unless the user is typing.
  useEffect(() => {
    if (!editing) setOmnibox(displayUrl(address))
  }, [address, active, editing])

  useEffect(() => {
    if (activeTab && displayUrl(address) === '' && !activeTab.loading) {
      inputRef.current?.focus()
    }
  }, [active])

  useEffect(() => {
    const list = tabListRef.current
    if (!list) return
    const measure = () => {
      setTabOverflow(list.scrollWidth > list.clientWidth + 1)
      const selected = list.querySelector<HTMLElement>('.tab.active')
      if (selected) {
        const edge = list.getBoundingClientRect()
        const box = selected.getBoundingClientRect()
        if (box.left < edge.left) list.scrollLeft += box.left - edge.left
        else if (box.right > edge.right) list.scrollLeft += box.right - edge.right
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [tabs.length, active])

  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, id: TabId) => {
    const index = tabs.findIndex(tab => tab.id === id)
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    host.send({ type: 'activateTab', tabId: tabs[next].id, keepChromeFocus: true })
    tabListRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${tabs[next].id}"]`)?.focus()
  }

  const submit = () => {
    const input = omnibox.trim()
    if (!input) return
    host.send({ type: 'navigate', tabId: active ?? undefined, input })
    setEditing(false)
    inputRef.current?.blur()
    host.send({ type: 'focusContent' })
  }

  const dlList = [...downloads.values()]
  const activeDownloads = dlList.filter((d) => d.state === 'inProgress').length
  const latest = dlList.at(-1)

  return (
    <div className="chrome">
      <div className="tabstrip">
        {tabOverflow && <button className="tab-scroll" title="Scroll tabs left" aria-label="Scroll tabs left"
          onClick={() => tabListRef.current?.scrollBy({ left: -240, behavior: 'smooth' })}><Icon name="back" /></button>}
        <div className="browser-tabs" ref={tabListRef} role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === active ? 'active' : ''}`}
            title={t.title || t.url}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                host.send({ type: 'closeTab', tabId: t.id })
              }
            }}
          >
            <button className="tab-select" role="tab" aria-selected={t.id === active}
              tabIndex={t.id === active ? 0 : -1} data-tab-id={t.id}
              onClick={() => host.send({ type: 'activateTab', tabId: t.id })} onKeyDown={event => tabKey(event, t.id)}>
              <Favicon tab={t} />
              <span className="tab-title">{t.title || displayUrl(t.url) || 'New Tab'}</span>
            </button>
            <button
              className="tab-close"
              title="Close tab (Ctrl+W)"
              aria-label={`Close ${t.title || 'new tab'}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => host.send({ type: 'closeTab', tabId: t.id })}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
        </div>
        {tabOverflow && <button className="tab-scroll" title="Scroll tabs right" aria-label="Scroll tabs right"
          onClick={() => tabListRef.current?.scrollBy({ left: 240, behavior: 'smooth' })}><Icon name="forward" /></button>}
        <button className="new-tab" title="New tab (Ctrl+T)" aria-label="New tab" onClick={() => host.send({ type: 'newTab' })}>
          <Icon name="plus" />
        </button>
        <span className="chrome-local" title="The browser runs on your computer. Your chosen model may be local or remote.">
          <Icon name="shield" />Local browser
        </span>
        <button className={`chrome-model ${modelError ? 'unavailable' : ''}`}
          title={modelError || (settings?.configured ? `Configured model: ${settings.model}. Open model settings.` : 'Connect your model API or a local runtime.')}
          onClick={() => host.send({ type: 'openAssistant', panel: 'settings' })}>
          <Icon name="model" /><span>{modelError ? 'Model unavailable' : settings?.configured ? settings.model : 'Connect model'}</span>
          <Icon name="down" />
        </button>
        <button className="chrome-brand" title="Open model settings" aria-label="Open model settings"
          onClick={() => host.send({ type: 'openAssistant', panel: 'settings' })}><BrandMark /></button>
      </div>

      <div className="toolbar">
        <button
          className="nav"
          title="Back (Alt+Left)"
          disabled={!activeTab?.canGoBack}
          onClick={() => host.send({ type: 'back' })}
        >
          <Icon name="back" />
        </button>
        <button
          className="nav"
          title="Forward (Alt+Right)"
          disabled={!activeTab?.canGoForward}
          onClick={() => host.send({ type: 'forward' })}
        >
          <Icon name="forward" />
        </button>
        {activeTab?.loading ? (
          <button className="nav" title="Stop" onClick={() => host.send({ type: 'stop' })}>
            <Icon name="close" />
          </button>
        ) : (
          <button className="nav" title="Reload (F5)" onClick={() => host.send({ type: 'reload' })}>
            <Icon name="reload" />
          </button>
        )}

        <button className="nav home-nav" title="Open Rovuka start page in a new tab" aria-label="Open Rovuka start page"
          onClick={() => host.send({ type: 'newTab' })}>
          <Icon name="home" />
        </button>

        {findingsOpen && <span className="workspace-indicator" role="status">Research workspace</span>}
        <div className="omnibox">
          <Icon name={parsedAddress?.protocol === 'https:' && !activeTab?.loading && !activeTab?.loadError && !activeTab?.pendingUrl
            ? 'lock' : 'globe'} className="omnibox-icon" />
          {externalHttp && <span className="connection-state" title="This address uses unencrypted HTTP. Do not enter private information.">Not secure</span>}
          <input
            ref={inputRef}
            value={omnibox}
            placeholder="Search or enter address"
            aria-label="Search or enter address"
            spellCheck={false}
            onFocus={(e) => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setOmnibox(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              else if (e.key === 'Escape') {
                setOmnibox(displayUrl(address))
                setEditing(false)
                e.currentTarget.blur()
                host.send({ type: 'focusContent' })
              }
            }}
          />
          {activeTab?.loading && (
            <div className="progress" style={{ width: `${Math.max(5, activeTab.progress * 100)}%` }} />
          )}
        </div>

        {latest && (
          <div className={`download ${latest.state}`} title={latest.fullPath}>
            <Icon name="download" /><span className="dl-name">{latest.fileName || latest.url}</span>
            <span className="dl-state">
              {latest.state === 'inProgress' ? `${Math.max(0, latest.percent)}%` : latest.state}
              {activeDownloads > 1 && ` (+${activeDownloads - 1})`}
            </span>
          </div>
        )}

        <button className="ask-ai" title="Ask about this page" onClick={() => host.send({ type: 'toggleAssistant' })}>
          <Icon name="spark" /><span>Ask AI</span>
        </button>
      </div>
    </div>
  )
}
