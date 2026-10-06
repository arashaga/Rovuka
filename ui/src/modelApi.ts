import { apiHeaders, apiUrl } from './ipc.ts'

export type Provider = 'openAiCompatible' | 'azureOpenAi' | 'anthropic' | 'gemini'

export interface ModelSettings {
  provider: Provider
  baseUrl: string
  model: string
  apiVersion: string
  apiKeyConfigured: boolean
  configured: boolean
}

export const modelSettingsChannel = 'rovuka-model-settings'
export const memoryChangesChannel = 'rovuka-memory-changes'

function notifyUiChange(name: string) {
  const channel = new BroadcastChannel(name)
  channel.postMessage('changed')
  channel.close()
  window.dispatchEvent(new Event(name))
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...apiHeaders(), ...init?.headers },
  })
  await checkResponse(response)
  const result = (await response.json()) as T
  if (init?.method && init.method !== 'GET') {
    if (['/api/settings', '/api/local/activate', '/api/local/restore-cloud'].includes(path)) {
      notifyUiChange(modelSettingsChannel)
    }
    if (['/api/memory/config', '/api/memory/page', '/api/memory/research', '/api/memory/forget',
      '/api/memory/clear', '/api/memory/preferences'].includes(path)) {
      notifyUiChange(memoryChangesChannel)
    }
  }
  return result
}

export async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return
  let message = `Request failed (${response.status})`
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    // Keep the HTTP status when there is no JSON error response.
  }
  throw new Error(message)
}

export async function readEvents(
  response: Response,
  consume: (eventType: string, data: string) => void,
): Promise<void> {
  await checkResponse(response)
  if (!response.body) throw new Error('The server returned no response stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const consumeBlock = (block: string) => {
    const lines = block.split(/\r?\n/)
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n')
    if (data) consume(event, data)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const blocks = pending.split(/\r?\n\r?\n/)
      pending = blocks.pop() ?? ''
      if (pending.length > 1_000_000) throw new Error('Stream event exceeds the safety limit.')
      for (const block of blocks) consumeBlock(block)
      if (done) break
    }
    if (pending.trim()) consumeBlock(pending)
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
