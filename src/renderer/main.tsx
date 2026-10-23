import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initializeTheme } from './theme'
import './styles.css'

initializeTheme()

class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div className="startup-state"><h1>Не удалось открыть интерфейс</h1><p>Закройте и заново запустите приложение. Сохранённые интервью останутся в истории.</p></div>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>)
