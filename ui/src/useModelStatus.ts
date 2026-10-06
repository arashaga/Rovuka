import { useEffect, useState } from 'react'
import { apiRequest, modelSettingsChannel, type ModelSettings } from './modelApi.ts'

export default function useModelStatus() {
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    let request: AbortController | undefined
    const refresh = () => {
      request?.abort()
      const controller = new AbortController()
      request = controller
      void apiRequest<ModelSettings>('/api/settings', { signal: controller.signal })
        .then(saved => {
          if (!alive || controller.signal.aborted) return
          setSettings(saved)
          setError('')
        })
        .catch((reason: unknown) => {
          if (alive && !controller.signal.aborted) {
            setError(reason instanceof Error ? reason.message : String(reason))
          }
        })
    }
    const channel = new BroadcastChannel(modelSettingsChannel)
    channel.onmessage = event => { if (event.data === 'changed') refresh() }
    window.addEventListener('focus', refresh)
    window.addEventListener(modelSettingsChannel, refresh)
    refresh()
    return () => {
      alive = false
      request?.abort()
      channel.close()
      window.removeEventListener('focus', refresh)
      window.removeEventListener(modelSettingsChannel, refresh)
    }
  }, [])

  return { settings, error }
}
