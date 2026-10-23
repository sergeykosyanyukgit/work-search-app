import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSnapshot } from '../domain/types'
import type { DesktopCommand } from '../shared/ipc'

export function useDesktopSnapshot() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true
    let receivedUpdate = false
    if (!window.desktop) {
      setError('Откройте приложение через Electron: соединение с локальным процессом недоступно.')
      return
    }
    const unsubscribe = window.desktop.subscribe(next => {
      receivedUpdate = true
      if (alive) { setSnapshot(next); setError(undefined) }
    })
    void window.desktop.snapshot().then(next => {
      if (alive && !receivedUpdate) { setSnapshot(next); setError(undefined) }
    }).catch(() => { if (alive) setError('Не удалось получить состояние приложения. Попробуйте перезапустить его.') })
    return () => { alive = false; unsubscribe() }
  }, [])
  return { snapshot, error }
}

export function useCommands() {
  const running = useRef(new Set<string>())
  const mounted = useRef(true)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = useCallback(async (command: DesktopCommand): Promise<boolean> => {
    const key = command.type
    if (running.current.has(key)) return false
    running.current.add(key)
    setPending(new Set(running.current))
    setError(undefined)
    try {
      const result = await window.desktop.command(command)
      if (!result.ok && mounted.current) setError(result.error || 'Не удалось выполнить действие. Попробуйте ещё раз.')
      return result.ok
    } catch {
      if (mounted.current) setError('Связь с приложением прервалась. Попробуйте ещё раз.')
      return false
    } finally {
      running.current.delete(key)
      if (mounted.current) setPending(new Set(running.current))
    }
  }, [])
  return { run, pending, error, setError }
}

export type Commands = ReturnType<typeof useCommands>

export function useRecordingClock(startedAt: number | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [active, startedAt])
  return startedAt && active ? Math.max(0, now - startedAt) : 0
}
