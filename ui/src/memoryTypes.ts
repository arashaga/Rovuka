import type { ResearchReport, Source, TabComparison } from './taskTypes.ts'

export interface MemoryConfig {
  captureEnabled: boolean
  retentionDays: number
  excludedSites: string[]
}

export interface PersonalPreferences {
  travel: string
  shopping: string
  research: string
}

export interface SharedMemoryContext {
  items: { title: string; url: string; excerpt: string; capturedAt: string; kind: string }[]
  preferences: PersonalPreferences | null
  trust: string
}

export interface MemoryPreview {
  id: string
  context: SharedMemoryContext
  expiresInSeconds: number
}

export interface MemoryArchive {
  goal: string
  model: string
  capturedAt: string
  answer: string | null
  message: string | null
  comparison: TabComparison | null
  report: ResearchReport | null
  sources: Source[]
}

export interface MemoryItem {
  id: number
  kind: 'page' | 'research'
  title: string
  url: string
  excerpt: string
  capturedAt: string
  research: MemoryArchive | null
}

export interface MemoryOverview {
  config: MemoryConfig
  pages: number
  research: number
  directory: string
  lastError: string | null
  maxItems: number
}
