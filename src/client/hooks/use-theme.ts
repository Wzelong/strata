import { useState, useEffect } from 'react'

type Theme = 'light' | 'dark'

const subscribers = new Set<(theme: Theme) => void>()

let currentTheme: Theme = (() => {
  if (typeof window === 'undefined') return 'dark'
  const stored = localStorage.getItem('strata-theme')
  if (stored === 'dark' || stored === 'light') return stored
  return 'dark'
})()

if (typeof window !== 'undefined') {
  document.documentElement.classList.toggle('dark', currentTheme === 'dark')
}

function setGlobalTheme(t: Theme) {
  if (t === currentTheme) return
  currentTheme = t
  document.documentElement.classList.toggle('dark', t === 'dark')
  localStorage.setItem('strata-theme', t)
  subscribers.forEach(fn => fn(t))
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => {
    subscribers.add(setTheme)
    return () => { subscribers.delete(setTheme) }
  }, [])
  const toggle = () => setGlobalTheme(currentTheme === 'dark' ? 'light' : 'dark')
  return { theme, toggle }
}
