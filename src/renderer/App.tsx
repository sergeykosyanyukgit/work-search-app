import { LoaderCircle } from 'lucide-react'
import { useCommands, useDesktopSnapshot } from './hooks'
import { Overlay } from './Overlay'
import { SettingsView } from './Settings'

export function App() {
  const { snapshot, error } = useDesktopSnapshot()
  const actions = useCommands()
  if (!snapshot) return <div className="startup-state">{error ? <p role="alert">{error}</p> : <p role="status"><LoaderCircle className="spin" size={16} />Загрузка…</p>}</div>
  return new URLSearchParams(window.location.search).get('view') === 'settings'
    ? <SettingsView snapshot={snapshot} actions={actions} />
    : <Overlay snapshot={snapshot} actions={actions} />
}
