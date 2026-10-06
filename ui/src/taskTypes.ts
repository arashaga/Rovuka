import type { SharedMemoryContext } from './memoryTypes.ts'

export type TaskStatus = 'running' | 'awaitingApproval' | 'completed' | 'stopped' | 'failed' | 'needsInput' | 'noEvidence'
export type OperationKind = 'fill' | 'select' | 'click' | 'scroll' | 'submitSearch' | 'hotelSearch'

export interface OperationPreview {
  kind: OperationKind
  target: string
  value: string | null
  destination: string | null
  fields: { name: string; value: string }[]
}

export interface Source {
  id: number
  url: string
  title: string
  kind: 'search' | 'page'
}

export interface ReadTarget {
  id: number
  url: string
  title: string
  documentEpoch: number
}

export interface ReadTab {
  target: ReadTarget
  unavailable: string | null
}

export interface TabComparison {
  columns: string[]
  rows: { sourceId: number; quotes: (string | null)[] }[]
  capturedAt: string
  unknownCells: number
  duplicateTabs: number
}

export interface ResearchReport {
  intent: 'travel' | 'shopping' | 'general' | 'research'
  title: string
  summary: string
  recommendedOption: number | null
  options: {
    name: string; fit: string; details: string; tradeoffs: string; sources: number[]
    offer: {
      currency: string
      basis: 'tripTotal' | 'itemTotal' | 'serviceTotal' | 'stayTotal' | 'perNight' | 'perPersonRoundTrip'
      scope: string
      totalMinor: number
      exclusions: string
      components: {
        kind: 'flight' | 'hotel' | 'product' | 'service' | 'other'
        name: string; detail: string; unitAmountMinor: number; quantity: number; sourceId: number; quote: string
      }[]
    } | null
    links: { label: string; url: string; sourceId: number; visited: boolean; kind: 'search' | 'page' | 'link' }[]
  }[]
  findings: { title: string; detail: string; sources: number[] }[]
  gaps: string[]
}

export interface Task {
  id: string
  startedAt: string
  goal: string
  model: string
  status: TaskStatus
  steps: string[]
  sources: Source[]
  pending: { id: string; url: string; reason: string; kind: 'search' | 'link' | 'redirect' | 'operation' | 'readTab'; operation: OperationPreview | null } | null
  answer: string | null
  error: string | null
  maxSteps: number
  pagesRead: number
  startMode: 'webSearch' | 'currentPage' | 'selectedTabs'
  message: string | null
  conversation: { role: 'user' | 'assistant'; content: string }[]
  questionId: string | null
  protocolIssue: string | null
  protocolDiagnostic: { stage: string; message: string; response: string; attempt: number; resolved: boolean } | null
  report: ResearchReport | null
  searches: { query: string; url: string; sourceId: number | null; vertical: 'web' | 'flights' | 'hotels' }[]
  researchPermission: 'askEach' | 'allResearch'
  taskPermission: 'askEach' | 'allSupported'
  permissionEvents: { at: string; decision: string; scope: string; url: string | null }[]
  compareOptions: boolean
  build: string
  logFile: string | null
  privacy: { redactions: number; blockedLinks: number }
  auditEnabled: boolean
  auditError: string | null
  mode: 'research' | 'prepare'
  requirements: { destination: string; checkIn: string; checkOut: string; adults: number; rooms: number } | null
  verification: { checks: number; verified: boolean; detail: string }
  issue: { category: string; recovery: string; retryable: boolean } | null
  modelUsage: { requests: number; readerRequests: number; elapsedMs: number; repairs: number }
  selectedTabs: ReadTarget[]
  comparison: TabComparison | null
  preserveTabs: boolean
  workspaceTab: number | null
  memoryContext: SharedMemoryContext | null
  actions: { id: string; kind: OperationKind; target: string; value: string | null; status: 'awaitingApproval' | 'approved' | 'executed' | 'stale' | 'failed' | 'cancelled' | 'declined' }[]
}

export const taskActive = (task: Task | null) =>
  task?.status === 'running' || task?.status === 'awaitingApproval' || task?.status === 'needsInput'
