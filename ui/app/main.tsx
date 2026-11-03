import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { pageStore } from './store/store.ts'
import './styles/app.css'

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root')
pageStore().start()
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
