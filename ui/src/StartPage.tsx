import { useState, type FormEvent, type ReactNode } from 'react'
import { host, type AssistantPanel } from './ipc.ts'
import './StartPage.css'

type IconName = 'spark' | 'arrow' | 'plane' | 'bag' | 'research' | 'page' | 'model' | 'tabs' | 'shield'

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    spark: <path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    plane: <><path d="m21 3-6 18-3-9-9-3Z" /><path d="m12 12 9-9" /></>,
    bag: <><path d="M5 8h14l1 13H4Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
    research: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M8 8h5m-5 4h3" /></>,
    page: <><path d="M5 3h10l4 4v14H5Z" /><path d="M14 3v5h5M8 12h8m-8 4h5" /></>,
    model: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 9h6v6H9ZM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /></>,
    tabs: <><rect x="3" y="7" width="14" height="14" rx="2" /><path d="M7 7V3h14v14h-4M3 11h14" /></>,
    shield: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" /><path d="m8 12 3 3 5-6" /></>,
  }
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

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
    <svg viewBox="0 0 520 396" aria-hidden="true">
      <path className="start-art-orbit" d="M26 219C-10 62 238 8 430 68s73 265-126 270S61 386 26 219Z" />
      <path className="start-art-orbit start-art-orbit-inner" d="M51 177C81 24 401 54 453 199s-116 179-264 123S21 243 51 177Z" />
      <g className="start-art-float">
        <rect className="start-art-soft" x="90" y="56" width="372" height="262" rx="16" transform="rotate(5 276 187)" />
        <rect className="start-art-surface" x="58" y="80" width="388" height="260" rx="16" />
        <path className="start-art-line" d="M58 116h388" />
        <circle className="start-art-dot" cx="80" cy="98" r="4" />
        <circle className="start-art-dot" cx="95" cy="98" r="4" />
        <circle className="start-art-dot" cx="110" cy="98" r="4" />
        <rect className="start-art-soft" x="147" y="90" width="229" height="16" rx="8" />
        <text className="start-art-title" x="82" y="150">Your next step, in focus.</text>
        {[183, 237, 291].map((y, index) => <g key={y}>
          <rect className={index === 0 ? 'start-art-selected' : 'start-art-soft'} x="78" y={y - 21} width="347" height="45" rx="10" />
          <circle className={index === 0 ? 'start-art-accent' : 'start-art-surface'} cx="101" cy={y + 1} r="12" />
          <text className={index === 0 ? 'start-art-number first' : 'start-art-number'} x="101" y={y + 5}>{index + 1}</text>
          <path className="start-art-text-line" d={`M126 ${y - 5}h${[133, 110, 148][index]}`} />
          <path className="start-art-line" d={`M126 ${y + 8}h${[104, 133, 89][index]}`} />
          <path className="start-art-arrow" d={`M388 ${y}h16m-5-5 5 5-5 5`} />
        </g>)}
      </g>
      <g className="start-art-badge">
        <circle className="start-art-surface" cx="433" cy="71" r="34" />
        <circle className="start-art-globe" cx="433" cy="71" r="18" />
        <ellipse className="start-art-globe" cx="433" cy="71" rx="8" ry="18" />
        <path className="start-art-globe" d="M415 71h36m-33-9h30m-30 18h30" />
      </g>
      <g>
        <rect className="start-art-surface" x="20" y="296" width="162" height="48" rx="12" />
        <path className="start-art-arrow" d="m37 321 5 5 9-11" />
        <text className="start-art-caption" x="60" y="326">Sources, not guesses.</text>
      </g>
      <path className="start-art-spark" d="m45 58 5 13 13 5-13 5-5 13-5-13-13-5 13-5Z" />
      <path className="start-art-spark" d="m466 277 4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" />
    </svg>
    <figcaption>Research. Compare. Choose.<span>You make the final move.</span></figcaption>
  </figure>
}

export default function StartPage() {
  const [goal, setGoal] = useState('')
  const open = (panel: AssistantPanel, draft?: string) => host.send({ type: 'openAssistant', panel, goal: draft })
  const prepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (goal.trim()) open('task', goal.trim())
  }

  return <main className="start-page">
    <a className="start-skip" href="#start-task">Skip to task examples</a>
    <div className="start-shell">
      <section className="start-updates" aria-label="What's new">
        <div className="start-update-label"><span className="start-update-dot" />What's new</div>
        <div className="start-update-copy"><strong>Your task. One approval, or one step at a time.</strong>
          <span>Task-wide approval · Independently checked results · Model capability checks</span>
        </div>
        <button onClick={() => open('safety')}>Explore Safety <Icon name="arrow" /></button>
      </section>

      <header className="start-header">
        <div className="start-brand"><span className="start-brand-mark"><Icon name="spark" /></span>
          <div><strong>Rovuka</strong><span>Your web. Your model. Your choice.</span></div>
        </div>
        <nav aria-label="Start page shortcuts">
          <button className="start-text-button" onClick={() => host.send({ type: 'focusOmnibox' })}>Just browse</button>
          <button className="start-outline-button" onClick={() => open('settings')}><Icon name="model" />Connect your model</button>
        </nav>
      </header>

      <section className="start-hero" aria-labelledby="start-title">
        <div className="start-hero-copy">
          <span className="start-eyebrow"><Icon name="spark" />A browser for your next move</span>
          <h1 id="start-title">Less searching.<br /><em>More finding.</em></h1>
          <p className="start-lede">Turn a question into a useful shortlist. Explore the web, compare your options, and keep the links that matter.</p>
          <form className="start-composer" onSubmit={prepare}>
            <label htmlFor="start-goal">What would you like to find?</label>
            <textarea id="start-goal" value={goal} maxLength={5000} rows={2}
              placeholder="A weekend getaway, the right headphones, a better way to work..."
              onChange={event => setGoal(event.target.value)} />
            <div className="start-composer-footer"><span>Prepare here. Approve in Task mode.</span>
              <button className="start-primary-button" type="submit" disabled={!goal.trim()}>Prepare a task <Icon name="arrow" /></button>
            </div>
          </form>
          <p className="start-consent"><Icon name="shield" />No research starts until you choose a model, allow sharing, and press Start.</p>
        </div>
        <JourneyIllustration />
      </section>

      <section className="start-examples" id="start-task" aria-labelledby="start-examples-title">
        <div className="start-section-heading"><div><span className="start-eyebrow">Try a little possibility</span>
          <h2 id="start-examples-title">One goal. A better starting point.</h2></div><p>Choose an example, then make it yours.</p>
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

      <footer className="start-footer"><span>Built for curiosity. Designed to keep you in control.</span><span>Rovuka · Research + preparation previews</span></footer>
    </div>
  </main>
}
