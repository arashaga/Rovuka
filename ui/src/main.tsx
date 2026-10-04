import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import Assistant from './Assistant.tsx'
import './App.css'

const surface = new URLSearchParams(location.search).get('surface')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {surface === 'assistant' ? <Assistant /> : <App />}
  </StrictMode>,
)
