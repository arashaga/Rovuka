// Mirror of crates/aib-ipc/src/lib.rs. Keep in sync.

export type TabId = number

export type Command =
  | { type: 'newTab'; url?: string }
  | { type: 'closeTab'; tabId: TabId }
  | { type: 'activateTab'; tabId: TabId }
  | { type: 'navigate'; tabId?: TabId; input: string }
  | { type: 'back'; tabId?: TabId }
  | { type: 'forward'; tabId?: TabId }
  | { type: 'reload'; tabId?: TabId }
  | { type: 'stop'; tabId?: TabId }
  | { type: 'focusContent' }
  | { type: 'showDevTools'; tabId?: TabId }
  | { type: 'toggleAssistant' }
  | { type: 'setAssistantExpanded'; expanded: boolean }
  | { type: 'getPageText'; requestId: string }

export interface TabInfo {
  id: TabId
  url: string
  title: string
  favicon: string | null
  loading: boolean
  progress: number
  canGoBack: boolean
  canGoForward: boolean
}

export type DownloadState = 'inProgress' | 'complete' | 'canceled' | 'interrupted'

export interface DownloadInfo {
  id: number
  url: string
  fileName: string
  fullPath: string
  receivedBytes: number
  totalBytes: number
  percent: number
  state: DownloadState
}

export type PageTextEvent = Extract<HostEvent, { type: 'pageText' }>

export type HostEvent =
  | { type: 'tabs'; tabs: TabInfo[]; active: TabId | null }
  | { type: 'download'; download: DownloadInfo }
  | { type: 'focusOmnibox' }
  | { type: 'assistantLayout'; expanded: boolean }
  | {
      type: 'pageText'
      requestId: string
      tabId: TabId | null
      url: string
      title: string
      text: string
      truncated: boolean
      error: string | null
    }

type Listener = (e: HostEvent) => void

function wsUrl(): string {
  const params = new URLSearchParams(location.search)
  const token = params.get('token') ?? ''
  // Dev mode (Vite on another port) passes the host port explicitly.
  const port = params.get('port')
  const host = port ? `127.0.0.1:${port}` : location.host
  return `ws://${host}/ws?token=${encodeURIComponent(token)}`
}

class HostConnection {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private queue: string[] = []
  private retry = 250

  constructor() {
    this.connect()
  }

  private connect() {
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    ws.onopen = () => {
      this.retry = 250
      for (const m of this.queue.splice(0)) ws.send(m)
    }
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data as string) as HostEvent
        this.listeners.forEach((l) => l(e))
      } catch (err) {
        console.error('bad host event', err)
      }
    }
    ws.onclose = () => {
      this.ws = null
      setTimeout(() => this.connect(), this.retry)
      this.retry = Math.min(this.retry * 2, 4000)
    }
  }

  send(cmd: Command) {
    const m = JSON.stringify(cmd)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(m)
    else this.queue.push(m)
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

export const host = new HostConnection()

export function apiUrl(path: string): string {
  const params = new URLSearchParams(location.search)
  const port = params.get('port')
  const origin = port ? `http://127.0.0.1:${port}` : location.origin
  return new URL(path, origin).toString()
}

export function apiHeaders(): HeadersInit {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  return { 'Content-Type': 'application/json', 'X-AIB-Token': token }
}
