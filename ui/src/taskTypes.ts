export type TaskStatus = 'running' | 'awaitingApproval' | 'completed' | 'stopped' | 'failed' | 'needsInput' | 'noEvidence'

export interface Source {
  id: number
  url: string
  title: string
  kind: 'search' | 'page'
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
  pending: { id: string; url: string; reason: string; kind: 'search' | 'link' | 'redirect' } | null
  answer: string | null
  error: string | null
  maxSteps: number
  pagesRead: number
  startMode: 'webSearch' | 'currentPage'
  message: string | null
  conversation: { role: 'user' | 'assistant'; content: string }[]
  questionId: string | null
  protocolIssue: string | null
  protocolDiagnostic: { stage: string; message: string; response: string; attempt: number; resolved: boolean } | null
  report: ResearchReport | null
  searches: { query: string; url: string; sourceId: number | null; vertical: 'web' | 'flights' | 'hotels' }[]
  researchPermission: 'askEach' | 'allResearch'
  permissionEvents: { at: string; decision: string; scope: string; url: string | null }[]
  compareOptions: boolean
  build: string
  logFile: string | null
  privacy: { redactions: number; blockedLinks: number }
  auditEnabled: boolean
  auditError: string | null
}

export const taskActive = (task: Task | null) =>
  task?.status === 'running' || task?.status === 'awaitingApproval' || task?.status === 'needsInput'
