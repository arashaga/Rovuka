import { useEffect, useRef, useState } from 'react'
import { host, type DownloadInfo, type TabInfo, type TabId } from './ipc.ts'

function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url
}

function Favicon({ tab }: { tab: TabInfo }) {
  const [broken, setBroken] = useState(false)
  if (tab.loading) return <span className="spinner" />
  if (!tab.favicon || broken) return <span className="favicon-placeholder" />
  return <img className="favicon" src={tab.favicon} onError={() => setBroken(true)} alt="" />
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [active, setActive] = useState<TabId | null>(null)
  const [downloads, setDownloads] = useState<Map<number, DownloadInfo>>(new Map())
  const [omnibox, setOmnibox] = useState('')
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeTab = tabs.find((t) => t.id === active)

  useEffect(
    () =>
      host.subscribe((e) => {
        switch (e.type) {
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
    if (!editing) setOmnibox(displayUrl(activeTab?.url ?? ''))
  }, [activeTab?.url, active, editing])

  useEffect(() => {
    if (activeTab && displayUrl(activeTab.url) === '' && !activeTab.loading) {
      inputRef.current?.focus()
    }
  }, [active])

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
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === active ? 'active' : ''}`}
            title={t.title || t.url}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                host.send({ type: 'closeTab', tabId: t.id })
              } else if (e.button === 0) {
                host.send({ type: 'activateTab', tabId: t.id })
              }
            }}
          >
            <Favicon tab={t} />
            <span className="tab-title">{t.title || displayUrl(t.url) || 'New Tab'}</span>
            <button
              className="tab-close"
              title="Close tab (Ctrl+W)"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => host.send({ type: 'closeTab', tabId: t.id })}
            >
              ×
            </button>
          </div>
        ))}
        <button className="new-tab" title="New tab (Ctrl+T)" onClick={() => host.send({ type: 'newTab' })}>
          +
        </button>
      </div>

      <div className="toolbar">
        <button
          className="nav"
          title="Back (Alt+Left)"
          disabled={!activeTab?.canGoBack}
          onClick={() => host.send({ type: 'back' })}
        >
          ←
        </button>
        <button
          className="nav"
          title="Forward (Alt+Right)"
          disabled={!activeTab?.canGoForward}
          onClick={() => host.send({ type: 'forward' })}
        >
          →
        </button>
        {activeTab?.loading ? (
          <button className="nav" title="Stop" onClick={() => host.send({ type: 'stop' })}>
            ✕
          </button>
        ) : (
          <button className="nav" title="Reload (F5)" onClick={() => host.send({ type: 'reload' })}>
            ↻
          </button>
        )}

        <div className="omnibox">
          <input
            ref={inputRef}
            value={omnibox}
            placeholder="Search or enter address"
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
                setOmnibox(displayUrl(activeTab?.url ?? ''))
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
            ⤓ <span className="dl-name">{latest.fileName || latest.url}</span>
            <span className="dl-state">
              {latest.state === 'inProgress' ? `${Math.max(0, latest.percent)}%` : latest.state}
              {activeDownloads > 1 && ` (+${activeDownloads - 1})`}
            </span>
          </div>
        )}

        <button className="ask-ai" title="Ask about this page" onClick={() => host.send({ type: 'toggleAssistant' })}>
          ✦ Ask AI
        </button>
      </div>
    </div>
  )
}
