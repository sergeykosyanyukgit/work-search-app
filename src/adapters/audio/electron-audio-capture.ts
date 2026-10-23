import { BrowserWindow, MessageChannelMain, desktopCapturer, screen, session, type MessagePortMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { AudioCapturePort } from '../../domain/ports'
import type { AudioSource, CaptureResult } from '../../domain/types'
import { TrackAccumulator } from './pcm'
import { CAPTURE_PORT_CHANNEL, type CaptureCommand, type CaptureMessage } from './protocol'

interface Waiter<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(timeoutMs: number, errorMessage: string): Waiter<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
  // Timers are cleared in both paths without creating an unhandled rejected promise.
  void promise.then(() => clearTimeout(timer), () => clearTimeout(timer))
  return { promise, resolve, reject }
}
interface ActiveCapture { id: string; accumulators: Map<AudioSource, TrackAccumulator>; failure?: string; cancelled: boolean }

export class ElectronAudioCapture implements AudioCapturePort {
  private window?: BrowserWindow
  private port?: MessagePortMain
  private initializing?: Promise<void>
  private ready?: Waiter<void>
  private armed?: Waiter<void>
  private started?: Waiter<void>
  private stopping?: Waiter<CaptureResult>
  private active?: ActiveCapture
  private levels: Record<AudioSource, number> = { microphone: 0, system: 0 }
  private levelListeners = new Set<(levels: Record<AudioSource, number>) => void>()
  private stoppedListeners = new Set<(result: CaptureResult) => void>()
  private deviceRequests = new Map<string, Waiter<Array<{ id: string; label: string }>>>()
  private disposed = false

  constructor(private readonly options: { rendererPath: string; preloadPath: string; devUrl?: string }) {}

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Аудиозахват завершён')
    if (this.initializing) return this.initializing
    if (this.window && !this.window.isDestroyed() && this.port) return
    this.initializing = this.createRenderer()
    try { await this.initializing } finally { this.initializing = undefined }
  }

  private async createRenderer(): Promise<void> {
    const captureSession = session.fromPartition(`capture-${randomUUID()}`, { cache: false })
    const win = new BrowserWindow({
      show: false, width: 1, height: 1, frame: false, skipTaskbar: true,
      webPreferences: { preload: this.options.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, session: captureSession }
    })
    this.window = win
    win.setContentProtection(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    const trusted = (contents: Electron.WebContents | null): boolean => contents === win.webContents && !win.isDestroyed()
    captureSession.setPermissionCheckHandler((contents, permission) => trusted(contents) && ['media', 'display-capture'].includes(permission))
    captureSession.setPermissionRequestHandler((contents, permission, callback) => callback(trusted(contents) && Boolean(this.active) && ['media', 'display-capture'].includes(permission)))
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      if (!this.active || win.isDestroyed() || request.frame !== win.webContents.mainFrame) { callback({}); return }
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).then(sources => {
        if (!this.active || win.isDestroyed()) { callback({}); return }
        const primary = String(screen.getPrimaryDisplay().id)
        const source = sources.find(candidate => candidate.display_id === primary) ?? sources[0]
        callback(source ? { video: source, audio: 'loopback' } : {})
      }).catch(() => callback({}))
    }, { useSystemPicker: false })
    const failure = (): void => {
      this.failCapture('Процесс захвата аудио завершился. Запись сохранена частично.')
      this.ready?.reject(new Error('Процесс захвата аудио не запустился'))
      this.port?.close(); this.port = undefined
      if (this.window === win) this.window = undefined
      if (!win.isDestroyed()) win.destroy()
    }
    win.webContents.on('render-process-gone', failure)
    win.on('unresponsive', failure)
    win.on('closed', () => {
      if (this.window === win) { this.window = undefined; this.port?.close(); this.port = undefined; this.failCapture('Окно аудиозахвата закрылось') }
    })
    const ready = deferred<void>(15_000, 'Не удалось подготовить аудиозахват')
    this.ready = ready
    try {
      if (this.options.devUrl) await win.loadURL(this.options.devUrl)
      else await win.loadURL(pathToFileURL(this.options.rendererPath).href)
      const { port1, port2 } = new MessageChannelMain()
      this.port = port1
      port1.on('message', event => this.receive(event.data as CaptureMessage))
      port1.start()
      win.webContents.postMessage(CAPTURE_PORT_CHANNEL, null, [port2])
      await ready.promise
    } catch (error) {
      ready.reject(error)
      this.port?.close(); this.port = undefined
      if (this.window === win) this.window = undefined
      if (!win.isDestroyed()) win.destroy()
      throw error
    } finally { if (this.ready === ready) this.ready = undefined }
  }

  private send(command: CaptureCommand): void {
    if (!this.port) throw new Error('Аудиозахват не готов')
    this.port.postMessage(command)
  }

  async start(recordingId: string, options: { sources: AudioSource[]; microphoneId: string }): Promise<void> {
    await this.initialize()
    if (this.active) throw new Error('Запись уже запущена')
    const sources = [...new Set(options.sources)]
    if (!sources.length || sources.some(source => source !== 'system' && source !== 'microphone')) throw new Error('Выберите источник звука')
    this.active = { id: recordingId, accumulators: new Map(sources.map(source => [source, new TrackAccumulator(source)])), cancelled: false }
    const armed = deferred<void>(5_000, 'Аудиозахват не ответил')
    this.armed = armed
    try {
      this.send({ type: 'arm', recordingId, sources, microphoneId: options.microphoneId })
      await armed.promise
      if (!this.active || this.active.cancelled) throw new Error('Запись отменена')
      const started = deferred<void>(30_000, 'Не удалось получить доступ к аудиоустройствам')
      this.started = started
      // Passing true supplies the transient user activation required by getDisplayMedia.
      void this.window!.webContents.executeJavaScript('window.__captureStart()', true).catch(error => started.reject(error))
      await started.promise
    } catch (error) {
      await this.cancel()
      throw error
    } finally { this.armed = undefined; this.started = undefined }
  }

  async stop(): Promise<CaptureResult> {
    if (this.stopping) return this.stopping.promise
    if (!this.active) throw new Error('Нет активной записи')
    const id = this.active.id
    const stopping = deferred<CaptureResult>(5_000, 'Аудиозахват не подтвердил остановку')
    this.stopping = stopping
    try { this.send({ type: 'stop', recordingId: id }); return await stopping.promise }
    catch (error) {
      if (this.active?.id === id) {
        const result = this.collect(true, error instanceof Error ? error.message : String(error))
        await this.resetRenderer()
        return result
      }
      throw error
    } finally { if (this.stopping === stopping) this.stopping = undefined }
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (!active) return
    active.cancelled = true
    this.armed?.reject(new Error('Запись отменена'))
    this.started?.reject(new Error('Запись отменена'))
    try {
      const stopping = this.stopping ?? deferred<CaptureResult>(2_000, 'Отмена захвата не подтверждена')
      this.stopping = stopping
      this.send({ type: 'cancel', recordingId: active.id })
      await stopping.promise
    } catch { await this.resetRenderer() }
    finally {
      if (this.active === active) { for (const track of active.accumulators.values()) track.clear(); this.active = undefined }
      this.stopping = undefined
      this.clearLevels()
    }
  }

  async microphones(): Promise<Array<{ id: string; label: string }>> {
    await this.initialize()
    const requestId = randomUUID()
    const response = deferred<Array<{ id: string; label: string }>>(5_000, 'Не удалось получить список микрофонов')
    this.deviceRequests.set(requestId, response)
    try { this.send({ type: 'devices', requestId }); return await response.promise }
    finally { this.deviceRequests.delete(requestId) }
  }

  private receive(message: CaptureMessage): void {
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') { this.ready?.resolve(); return }
    if (message.type === 'devices') { if (Array.isArray(message.devices)) this.deviceRequests.get(message.requestId)?.resolve(message.devices); return }
    const active = this.active
    if (!active || message.recordingId !== active.id) return
    if (message.type === 'armed') { this.armed?.resolve(); return }
    if (message.type === 'started') { this.started?.resolve(); return }
    if (message.type === 'pcm') {
      if (active.cancelled || active.failure) return
      const accumulator = active.accumulators.get(message.source)
      try {
        if (!accumulator || !(message.pcm instanceof ArrayBuffer)) throw new Error('Получен некорректный аудиопоток')
        accumulator.append(message.sequence, message.offsetMs, new Uint8Array(message.pcm))
        this.levels[message.source] = Number.isFinite(message.level) ? Math.max(0, Math.min(1, message.level)) : 0
        for (const listener of this.levelListeners) listener({ ...this.levels })
      } catch (error) {
        active.failure = error instanceof Error ? error.message : String(error)
        this.send({ type: 'stop', recordingId: active.id })
      }
    } else if (message.type === 'error') {
      if (this.started || this.armed) { this.started?.reject(new Error(message.error)); this.armed?.reject(new Error(message.error)) }
      else this.failCapture(message.error)
    } else if (message.type === 'stopped') {
      const cancelled = active.cancelled || message.cancelled
      const wasStarting = Boolean(this.started || this.armed)
      if (wasStarting) { this.started?.reject(new Error(message.error ?? 'Запись остановлена до запуска')); this.armed?.reject(new Error(message.error ?? 'Запись остановлена до запуска')) }
      const result = this.collect(message.partial || Boolean(active.failure), active.failure ?? message.error, cancelled)
      if (this.stopping) this.stopping.resolve(result)
      else if (!cancelled && !wasStarting) for (const listener of this.stoppedListeners) listener(result)
    }
  }

  private collect(partial: boolean, error?: string, cancelled = false): CaptureResult {
    const active = this.active!
    const tracks = [...active.accumulators.values()].map(track => track.finish()).filter(track => track.pcm.byteLength)
    this.active = undefined
    this.clearLevels()
    return { recordingId: active.id, tracks: cancelled ? [] : tracks, partial, error }
  }

  private failCapture(error: string): void {
    this.armed?.reject(new Error(error)); this.started?.reject(new Error(error))
    if (!this.active) return
    const result = this.collect(true, error, this.active.cancelled)
    if (this.stopping) this.stopping.resolve(result)
    else if (!this.started && !this.armed) for (const listener of this.stoppedListeners) listener(result)
  }

  private clearLevels(): void { this.levels = { microphone: 0, system: 0 }; for (const listener of this.levelListeners) listener({ ...this.levels }) }
  private async resetRenderer(): Promise<void> {
    this.port?.close(); this.port = undefined
    const win = this.window; this.window = undefined
    if (win && !win.isDestroyed()) win.destroy()
  }
  onLevels(listener: (levels: Record<AudioSource, number>) => void): void { this.levelListeners.add(listener) }
  onStopped(listener: (result: CaptureResult) => void): void { this.stoppedListeners.add(listener) }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.cancel()
    await this.resetRenderer()
    for (const request of this.deviceRequests.values()) request.reject(new Error('Приложение закрывается'))
    this.deviceRequests.clear(); this.levelListeners.clear(); this.stoppedListeners.clear()
  }
}
