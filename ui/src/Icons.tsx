import type { ReactNode } from 'react'

const paths = {
  spark: <path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  plane: <><path d="m21 3-6 18-3-9-9-3Z" /><path d="m12 12 9-9" /></>,
  bag: <><path d="M5 8h14l1 13H4Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
  research: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M8 8h5m-5 4h3" /></>,
  page: <><path d="M5 3h10l4 4v14H5Z" /><path d="M14 3v5h5M8 12h8m-8 4h5" /></>,
  model: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 9h6v6H9ZM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /></>,
  tabs: <><rect x="3" y="7" width="14" height="14" rx="2" /><path d="M7 7V3h14v14h-4M3 11h14" /></>,
  shield: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" /><path d="m8 12 3 3 5-6" /></>,
  back: <path d="m15 5-7 7 7 7" />,
  forward: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  reload: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1a8 8 0 0 1 13 2L20 12M4 12l.9 3.9a8 8 0 0 0 13 2" /></>,
  home: <path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9" />,
  settings: <><path d="m10 3-1 3-3 1-3 3v4l3 3 3 1 1 3h4l1-3 3-1 3-3v-4l-3-3-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" /></>,
  matrix: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" />,
  collapse: <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5M8 8 3 3m13 5 5-5M8 16l-5 5m13-5 5 5" />,
  send: <><path d="m21 3-6 18-3-9-9-3Z" /><path d="m12 12 9-9" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof paths

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`rovuka-mark ${className}`}><Icon name="spark" /></span>
}
