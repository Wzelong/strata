import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { openUrl } from './lib/utils'
import './index.css'

document.addEventListener('click', (e) => {
  const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('/api')) return
  if (href.startsWith('http://') || href.startsWith('https://') || anchor.target === '_blank') {
    e.preventDefault()
    openUrl(href)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
