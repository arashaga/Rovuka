import { useEffect, useState } from 'react'
import { host, type TabInfo } from './ipc.ts'
import StartPage from './StartPage.tsx'
import './NavigationError.css'

function explanation(code: number): string {
  if (code <= -200 && code >= -299) return 'The website has a certificate problem. Rovuka has not bypassed its security checks.'
  if (code === -105) return 'This website address could not be found. Check the spelling or try another address.'
  if (code === -102) return 'The website refused the connection. Check the address, or try again later.'
  if (code === -106) return 'Your device appears to be offline. Check your internet connection and try again.'
  if (code === -7 || code === -118) return 'The website took too long to respond. Check your connection or try again later.'
  return 'The website could not be loaded. Check the address and your connection, or try again later.'
}

export default function StartSurface() {
  const [tab, setTab] = useState<TabInfo | null>(null)
  useEffect(() => host.subscribe(event => {
    if (event.type === 'tabs') setTab(event.tabs.find(item => item.id === event.active) || null)
  }), [])
  const error = tab?.loadError
  if (!error || !tab) return <StartPage />
  return <main className="navigation-error">
    <section className="navigation-error-card" aria-labelledby="navigation-error-title">
      <svg className="navigation-error-art" viewBox="0 0 80 64" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="4" y="6" width="72" height="52" rx="8" />
        <path d="M4 18h72M14 12h2m5 0h2M23 40h12m10 0h12m-18-8-6 16" />
      </svg>
      <span className="navigation-error-brand">Rovuka</span>
      <h1 id="navigation-error-title">Couldn't open this page</h1>
      <p>{explanation(error.code)}</p>
      <code className="navigation-error-url">{error.url}</code>
      <p className="navigation-error-code">{error.name} ({error.code})</p>
      <div className="navigation-error-actions">
        <button className="assistant-primary" onClick={() => host.send({ type: 'reload', tabId: tab.id })}>Try again</button>
        <button className="assistant-secondary" onClick={() => host.send({ type: 'focusOmnibox' })}>Edit address</button>
        {tab.canGoBack && <button className="assistant-secondary" onClick={() => host.send({ type: 'back', tabId: tab.id })}>Go back</button>}
      </div>
      <p className="navigation-error-note">This error screen is not shared with your model. A failed page cannot be used for AI research or preparation.</p>
    </section>
  </main>
}
