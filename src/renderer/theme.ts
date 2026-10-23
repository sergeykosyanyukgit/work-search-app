import { useSyncExternalStore } from 'react'

export type AppTheme = 'light-blue' | 'dark-blue' | 'midnight'
export const THEME_STORAGE_KEY = 'work-search.theme'
export const DEFAULT_THEME: AppTheme = 'dark-blue'

let currentTheme: AppTheme = DEFAULT_THEME
let initialized = false
const listeners = new Set<() => void>()

function parseTheme(value: string | null): AppTheme {
  return value === 'light-blue' || value === 'dark-blue' || value === 'midnight' ? value : DEFAULT_THEME
}

function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme
  if (currentTheme === theme) return
  currentTheme = theme
  listeners.forEach(listener => listener())
}

export function initializeTheme() {
  if (initialized) return
  initialized = true
  try { applyTheme(parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY))) }
  catch { applyTheme(DEFAULT_THEME) }
  window.addEventListener('storage', event => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    try {
      if (event.storageArea !== window.localStorage) return
      applyTheme(parseTheme(event.key === null ? null : event.newValue))
    } catch { /* The current window keeps its theme if storage becomes unavailable. */ }
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function setTheme(theme: AppTheme): boolean {
  applyTheme(theme)
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); return true }
  catch { return false }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => currentTheme)
  return { theme, setTheme }
}
