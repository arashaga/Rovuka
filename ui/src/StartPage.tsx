import { useEffect, useRef, useState, type FormEvent } from 'react'
import { host, type AssistantPanel, type TabInfo } from './ipc.ts'
import { apiRequest, memoryChangesChannel } from './modelApi.ts'
import { BrandMark, Icon, type IconName } from './Icons.tsx'
import type { MemoryOverview } from './memoryTypes.ts'
import './StartPage.css'

type Intent = 'research' | 'options' | 'prepare' | 'tabs'

const intents: { id: Intent; icon: IconName; label: string }[] = [
  { id: 'research', icon: 'spark', label: 'Intelligent synthesis' },
  { id: 'options', icon: 'matrix', label: 'Compare options' },
  { id: 'prepare', icon: 'shield', label: 'Prepare a search' },
  { id: 'tabs', icon: 'tabs', label: 'Compare open tabs' },
]

const examples: { id: string; icon: IconName; category: string; title: string; description: string; goal: string }[] = [
  {
    id: 'shopping', icon: 'bag', category: 'Find your next favorite', title: 'A smarter shortlist.',
    description: 'Three headphones under $100. Real sources, observed prices, direct links.',
    goal: 'Find three wireless headphones under $100 in the United States. Show a concise numbered list sorted by observed price in USD, with one reason to choose each and a direct product-page link. Clearly mark any price you cannot verify. Put supporting research below the options. Do not buy anything.',
  },
  {
    id: 'travel', icon: 'plane', category: 'Make room for a getaway', title: 'Plan a trip, not twenty tabs.',
    description: 'Compare flights and hotels together. You choose what to open and book.',
    goal: 'Help plan a five-night trip from Austin to Cancun for two adults and one hotel room. Ask me for the travel dates and budget first, then compare flight-and-hotel combinations sorted by observed trip cost with direct links. Clearly mark unverified prices and availability. Do not book anything.',
  },
  {
    id: 'research', icon: 'research', category: 'Go from curious to confident', title: 'Get to the useful part.',
    description: 'Compare Notion, Obsidian and OneNote for solo project planning, with sources.',
    goal: 'Compare Notion, Obsidian and Microsoft OneNote for solo project planning. Give three concise options with official links, the main tradeoffs and current pricing if observed. Recommend a fit for someone who values offline access and simple setup. Put sources and uncertainties below the comparison.',
  },
]

function JourneyIllustration() {
  return <figure className="start-illustration">
    <svg viewBox="0 0 340 234" aria-hidden="true">
      <g className="start-art-float">
        <rect className="start-art-surface" x="8" y="8" width="324" height="218" rx="13" />
        <path className="start-art-line" d="M8 42h324" />
        <rect className="start-art-selected" x="23" y="18" width="137" height="15" rx="4" />
        <text className="start-art-tab" x="31" y="29">A clearer research workspace</text>
        <path className="start-art-line" d="M174 25h115" />
        <text className="start-art-title" x="24" y="70">From intent to insight.</text>
        {[101, 138, 175].map((y, index) => <g key={y}>
          <rect className={index === 0 ? 'start-art-selected' : 'start-art-soft'} x="23" y={y - 16} width="293" height="30" rx="6" />
          <circle className={index === 0 ? 'start-art-accent' : 'start-art-surface'} cx="41" cy={y - 1} r="8" />
          <text className={index === 0 ? 'start-art-number first' : 'start-art-number'} x="41" y={y + 2}>{index + 1}</text>
          <text className="start-art-row" x="59" y={y + 2}>{['Find the useful sources', 'Compare what matters', 'Choose your next step'][index]}</text>
          <path className="start-art-arrow" d={`M290 ${y}h11m-4-4 4 4-4 4`} />
        </g>)}
        <text className="start-art-caption" x="24" y="209">Sources, not guesses.</text>
        <path className="start-art-arrow" d="m292 204 4 4 9-9" />
      </g>
    </svg>
    <figcaption>Research. Compare. Choose.<span>Illustration - you make the final move.</span></figcaption>
  </figure>
}

export default function StartPage() {
  const [goal, setGoal] = useState('')
  const [intent, setIntent] = useState<Intent>('options')
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [memory, setMemory] = useState<MemoryOverview | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const intentTabs = useRef<HTMLDivElement>(null)
  const sourceTabs = tabs.filter(tab => /^https?:\/\//.test(tab.url) && !tab.loading && !tab.loadError).length
  const open = (panel: AssistantPanel, draft?: string) => host.send({ type: 'openAssistant', panel, goal: draft })
  const openIntent = (mode: Intent, draft = '') => host.send({
    type: 'openAssistant', panel: 'task', goal: draft,
    prepare: mode === 'prepare', taskStartMode: mode === 'tabs' ? 'selectedTabs' : 'webSearch',
    compareOptions: mode !== 'research',
  })
  const prepareDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (goal.trim()) openIntent(intent, goal.trim())
  }

  useEffect(() => host.subscribe(event => { if (event.type === 'tabs') setTabs(event.tabs) }), [])

  useEffect(() => {
    let alive = true
    let request: AbortController | undefined
    const refresh = () => {
      request?.abort()
      const controller = new AbortController()
      request = controller
      void apiRequest<MemoryOverview>('/api/memory', { signal: controller.signal })
        .then(data => {
          if (!alive || controller.signal.aborted) return
          setMemory(data)
          setMemoryError(data.lastError || '')
        })
        .catch((reason: unknown) => {
          if (alive && !controller.signal.aborted) {
            setMemoryError(reason instanceof Error ? reason.message : String(reason))
          }
        })
    }
    const channel = new BroadcastChannel(memoryChangesChannel)
    channel.onmessage = event => { if (event.data === 'changed') refresh() }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(memoryChangesChannel, refresh)
    return () => {
      alive = false
      request?.abort()
      channel.close()
      window.removeEventListener('focus', refresh)
      window.removeEventListener(memoryChangesChannel, refresh)
    }
  }, [])

  return <main className="start-page">
    <a className="start-skip" href="#start-task">Skip to task examples</a>
    <div className="start-shell">
      <section className="start-updates" aria-label="What's new">
        <div className="start-update-label"><span className="start-update-dot" />What's new</div>
        <div className="start-update-copy"><strong>A fresh workspace. The same control.</strong>
          <span>New intent studio, clearer tabs and local memory. No task starts without you.</span>
        </div>
        <button onClick={() => open('memory')}>Explore Memory <Icon name="arrow" /></button>
      </section>

      <header className="start-header">
        <div className="start-brand"><BrandMark />
          <strong>Rovuka</strong><span className="start-preview-badge">EARLY PREVIEW</span>
        </div>
        <nav aria-label="Start page shortcuts">
          <button className="start-text-button" onClick={() => host.send({ type: 'focusOmnibox' })}>Just browse</button>
          <button className="start-outline-button" onClick={() => open('settings')}><Icon name="model" />Connect your model</button>
        </nav>
      </header>

      <section className="start-hero" aria-labelledby="start-title">
        <div className="start-hero-copy">
          <span className="start-eyebrow"><Icon name="spark" />Your web. Your model. Your next move.</span>
          <h1 id="start-title">Less searching.<br /><em>More finding.</em></h1>
          <p className="start-lede">Turn browsing into getting things done. Research with sources, compare the details, and keep what matters - with you in control.</p>
        </div>
        <JourneyIllustration />
      </section>

      <form className="start-composer" onSubmit={prepareDraft} aria-labelledby="start-studio-title">
        <div className="start-studio-heading"><Icon name="spark" /><h2 id="start-studio-title">Intent Studio</h2><span>From a goal to a useful next step</span></div>
        <div className="start-intent-modes" ref={intentTabs} role="tablist" aria-label="Intent mode">
          {intents.map((mode, index) => <button key={mode.id} type="button" role="tab" data-intent={mode.id}
            aria-selected={mode.id === intent} tabIndex={mode.id === intent ? 0 : -1}
            onClick={() => setIntent(mode.id)} onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index + 1) % intents.length
                : event.key === 'ArrowLeft' ? (index + intents.length - 1) % intents.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? intents.length - 1 : -1
              if (next < 0) return
              event.preventDefault()
              setIntent(intents[next].id)
              intentTabs.current?.querySelector<HTMLButtonElement>(`[data-intent="${intents[next].id}"]`)?.focus()
            }}>
            <Icon name={mode.icon} />{mode.label}{mode.id === 'tabs' && <span className="start-count">{sourceTabs}</span>}
          </button>)}
        </div>
        <label htmlFor="start-goal">What do you want to accomplish?</label>
        <textarea id="start-goal" value={goal} maxLength={5000} rows={2}
          placeholder={intent === 'prepare' ? 'Prepare a Cancun hotel search with my exact dates and guest count. Stop before booking.'
            : intent === 'tabs' ? 'Compare the tabs I choose. Show the important differences and what still needs checking.'
              : 'Find a weekend getaway, compare the right headphones, or research an idea...'}
          onChange={event => setGoal(event.target.value)} />
        <div className="start-composer-footer"><span><Icon name="shield" />{intent === 'tabs' ? 'Choose tabs and allow sharing in Task mode.'
          : intent === 'prepare' ? 'Open a public search page before starting. Review each change or approve a task scope.'
            : 'Editable draft first. Sharing and approvals stay your choice.'}</span>
          <button className="start-primary-button" type="submit" disabled={!goal.trim()}>Prepare a task <Icon name="arrow" /></button>
        </div>
        <p className="start-consent">No task starts until you choose a model, review sharing, and press Start. Booking and payment stay manual.</p>
      </form>

      <section className="start-workspaces" aria-labelledby="start-workspaces-title">
        <div className="start-section-heading"><h2 id="start-workspaces-title">Your workspaces</h2>
          <button className="start-text-button" onClick={() => open('memory')}>Open Memory <Icon name="arrow" /></button>
        </div>
        <div className="start-workspace-grid">
          <article className="start-workspace-card">
            <div className="start-workspace-top"><span className="start-icon-tile"><Icon name="clock" /></span>
              <span className="start-workspace-state">{memory ? memory.config.captureEnabled ? 'Capture on' : 'Capture paused' : 'Local only'}</span></div>
            <h3>Good research, remembered.</h3>
            {memoryError ? <p className="start-memory-error" role="alert">Memory needs attention: {memoryError}</p>
              : <p>{memory ? `${memory.research} saved research ${memory.research === 1 ? 'snapshot' : 'snapshots'} and ${memory.pages} saved ${memory.pages === 1 ? 'page' : 'pages'}. Nothing is shared without a separate preview.` : 'Loading your local memory...'}</p>}
            <button onClick={() => open('memory')}>Explore local memory <Icon name="arrow" /></button>
          </article>
          <article className="start-workspace-card">
            <div className="start-workspace-top"><span className="start-icon-tile"><Icon name="tabs" /></span>
              <span className="start-workspace-state">{sourceTabs} open web {sourceTabs === 1 ? 'page' : 'pages'}</span></div>
            <h3>See your options together.</h3>
            <p>Pick two to six readable tabs. Compare with source links, honest gaps and no action permission.</p>
            <button onClick={() => openIntent('tabs', 'Compare the tabs I select. Show the important differences, sources and any unknown details.')}>Compare selected tabs <Icon name="arrow" /></button>
          </article>
          <button className="start-workspace-new" onClick={() => open('task')}>
            <span><Icon name="plus" /></span><strong>Start something new</strong><small>A fresh goal. An editable draft.</small>
          </button>
        </div>
      </section>

      <section className="start-examples" id="start-task" aria-labelledby="start-examples-title">
        <div className="start-section-heading"><h2 id="start-examples-title">A little inspiration</h2><p>Choose an example, then make it yours.</p>
        </div>
        <div className="start-example-grid">
          {examples.map(example => <button className="start-example" data-example={example.id} key={example.id}
            onClick={() => open('task', example.goal)}>
            <span className="start-example-top"><span className="start-icon-tile"><Icon name={example.icon} /></span><Icon name="arrow" className="start-example-arrow" /></span>
            <span className="start-example-category">{example.category}</span><strong>{example.title}</strong>
            <span className="start-example-description">{example.description}</span><span className="start-example-action">Try this task</span>
          </button>)}
        </div>
      </section>

      <section className="start-features" aria-label="What Rovuka can do">
        <article><Icon name="page" /><h3>Ask this page</h3><p>Summarize, explain or ask a question about a page you choose to share.</p>
          <button onClick={() => open('chat')}>Open Ask AI <Icon name="arrow" /></button></article>
        <article><Icon name="research" /><h3>Research that leads somewhere</h3><p>Concise options with observed sources, price comparisons and direct links.</p>
          <button onClick={() => open('task')}>Create a task <Icon name="arrow" /></button></article>
        <article><Icon name="model" /><h3>Your model, your choice</h3><p>Connect a model API, or use Ollama or LM Studio on your computer. Runtimes are not bundled.</p>
          <button onClick={() => open('local')}>Explore local models <Icon name="arrow" /></button></article>
        <article><Icon name="tabs" /><h3>Keep your place</h3><p>Open result links in new tabs and return to your findings during this session.</p>
          <button onClick={() => host.send({ type: 'focusOmnibox' })}>Browse your way <Icon name="arrow" /></button></article>
      </section>

      <section className="start-safety" aria-labelledby="start-safety-title">
        <div className="start-safety-icon"><Icon name="shield" /></div>
        <div className="start-safety-copy"><span className="start-eyebrow">Helpful by design. Boundaries by default.</span>
          <h2 id="start-safety-title">Your curiosity. Your control.</h2>
          <div className="start-safety-tags"><span>Read-only research</span><span>Scoped approvals</span><span>Local audit</span></div>
          <p>Research stays read-only. Opt-in preparation can fill approved public search fields and open reviewed GET searches; it never authorizes purchases, bookings or other submissions. Recognizable secrets are masked before model calls, but detection is not exhaustive.</p>
          <p className="start-safety-limit">Your chosen model receives the content you agree to share. Website scripts and signed-in cookies still run; tasks are not isolated from your browsing profile.</p>
        </div>
        <button className="start-outline-button" onClick={() => open('safety')}>Review safety <Icon name="arrow" /></button>
      </section>

      <footer className="start-footer"><span><Icon name="shield" />Local memory. Explicit sharing. Human decisions.</span><span>Rovuka - Research + preparation previews</span></footer>
    </div>
  </main>
}
