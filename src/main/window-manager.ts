import { BrowserWindow, globalShortcut, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { AppSnapshot, Settings } from '../domain/types'
import { normalizeShortcut, normalizeShortcutSettings } from './shortcuts'

export { normalizeShortcutSettings } from './shortcuts'

interface ShowOverlayOptions { focus?: boolean; resetMouse?: boolean }

export class WindowManager {
  overlay?: BrowserWindow
  settings?: BrowserWindow
  private shortcuts: string[] = []
  private shortcutActions = new Map<string, () => void>()
  private saveBoundsTimer?: ReturnType<typeof setTimeout>
  private mouse = false
  private overlayReady = false
  private overlayRequested = true
  private pendingShow: ShowOverlayOptions = {}
  private lastPresented: 'overlay' | 'settings' = 'overlay'
  private onDisplayChanged = (): void => {
    for (const win of [this.overlay, this.settings]) {
      if (win && !win.isDestroyed()) win.setBounds(this.constrain(win.getBounds()))
    }
  }
  constructor(private base: string, private devUrl: string | undefined, private onBounds: (bounds: Rectangle) => void) {}
  private load(win: BrowserWindow, settings = false): void {
    if (this.devUrl) void win.loadURL(`${this.devUrl}/renderer/index.html${settings ? '?view=settings' : ''}`)
    else void win.loadFile(join(this.base, '../renderer/renderer/index.html'), { query: settings ? { view: 'settings' } : {} })
  }
  private secure(win: BrowserWindow): void {
    win.setContentProtection(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('will-attach-webview', event => event.preventDefault())
  }
  private constrain(bounds: Rectangle): Rectangle {
    const display = screen.getDisplayMatching(bounds)
    const work = display.workArea
    const width = Math.max(Math.min(360, work.width), Math.min(bounds.width, work.width))
    const height = Math.max(Math.min(300, work.height), Math.min(bounds.height, work.height))
    return { x: Math.max(work.x, Math.min(bounds.x, work.x + work.width - width)), y: Math.max(work.y, Math.min(bounds.y, work.y + work.height - height)), width, height }
  }
  create(settings: Settings): void {
    const work = screen.getPrimaryDisplay().workArea
    const bounds = this.constrain(settings.bounds ?? { x: work.x + work.width - 548, y: work.y + 64, width: 520, height: Math.min(780, work.height - 100) })
    this.overlay = new BrowserWindow({ ...bounds, minWidth: 360, minHeight: 300, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: '#111318', title: 'Work Search', webPreferences: { preload: join(this.base, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    this.secure(this.overlay)
    this.overlay.setOpacity(settings.opacity)
    this.overlay.on('close', event => { event.preventDefault(); this.hideOverlay() })
    this.overlay.on('focus', () => { this.lastPresented = 'overlay' })
    const remember = (): void => {
      clearTimeout(this.saveBoundsTimer)
      this.saveBoundsTimer = setTimeout(() => { if (this.overlay && !this.overlay.isDestroyed()) this.onBounds(this.overlay.getBounds()) }, 400)
    }
    this.overlay.on('moved', remember); this.overlay.on('resized', remember)
    this.overlay.once('ready-to-show', () => { this.overlayReady = true; if (this.overlayRequested) this.showOverlay(this.pendingShow) })
    this.load(this.overlay)
    screen.on('display-removed', this.onDisplayChanged); screen.on('display-metrics-changed', this.onDisplayChanged)
  }
  showSettings(): void {
    if (this.settings && !this.settings.isDestroyed()) {
      if (this.settings.isMinimized()) this.settings.restore()
      this.settings.setBounds(this.constrain(this.settings.getBounds()))
      this.settings.show(); this.settings.moveTop(); this.settings.focus(); this.lastPresented = 'settings'; return
    }
    const work = screen.getDisplayMatching(this.overlay?.getBounds() ?? screen.getPrimaryDisplay().workArea).workArea
    this.settings = new BrowserWindow({ width: Math.min(980, work.width), height: Math.min(820, work.height), minWidth: Math.min(720, work.width), minHeight: Math.min(580, work.height), show: false, skipTaskbar: true, alwaysOnTop: true,
      title: 'Настройки — Work Search', backgroundColor: '#111318', autoHideMenuBar: true,
      webPreferences: { preload: join(this.base, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
    this.secure(this.settings)
    this.settings.on('focus', () => { this.lastPresented = 'settings' })
    this.settings.once('ready-to-show', () => { this.settings?.show(); this.lastPresented = 'settings' })
    this.load(this.settings, true)
  }
  initializeShortcuts(settings: Settings, onRecord: () => void, onMouse: (value: boolean) => void): string[] {
    const errors: string[] = []
    const labels = ['Запись', 'Показ окна', 'Пропуск кликов']
    const keys = [settings.recordHotkey, settings.visibilityHotkey, settings.mouseHotkey]
    const callbacks = this.callbacks(onRecord, onMouse)
    // At startup no previous configuration can be restored. One occupied key must not disable the others.
    keys.forEach((value, index) => {
      try {
        const key = normalizeShortcut(value)
        if (this.shortcuts.includes(key)) throw new Error(`Сочетание ${key} уже назначено другому действию.`)
        this.registerShortcut(key)
        this.shortcuts.push(key); this.shortcutActions.set(key, callbacks[index]!)
      } catch (error) { errors.push(`${labels[index]}: ${error instanceof Error ? error.message : 'Не удалось зарегистрировать сочетание.'}`) }
    })
    return errors
  }
  private callbacks(onRecord: () => void, onMouse: (value: boolean) => void): Array<() => void> {
    return [onRecord, () => this.toggleVisibility(), () => onMouse(this.toggleMouse())]
  }
  private registerShortcut(key: string): void {
    try {
      if (!globalShortcut.register(key, () => this.shortcutActions.get(key)?.())) throw new Error(`Сочетание ${key} занято другой программой.`)
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`Сочетание «${key}» не поддерживается. Используйте, например, Ctrl+Alt+Space.`)
      throw error
    }
  }
  configureShortcuts(settings: Settings, onRecord: () => void, onMouse: (value: boolean) => void): void {
    const normalized = normalizeShortcutSettings(settings)
    const next = [normalized.recordHotkey, normalized.visibilityHotkey, normalized.mouseHotkey]
    const callbacks = this.callbacks(onRecord, onMouse)
    const newlyRegistered: string[] = []
    try {
      // Existing registrations keep working until every new accelerator is acquired.
      next.forEach(key => {
        if (this.shortcuts.includes(key)) return
        this.registerShortcut(key)
        newlyRegistered.push(key)
      })
    } catch (error) { newlyRegistered.forEach(key => globalShortcut.unregister(key)); throw error }
    this.shortcuts.forEach(key => { if (!next.includes(key)) globalShortcut.unregister(key) })
    // Swap action routing without releasing retained OS registrations.
    this.shortcutActions = new Map(next.map((key, i) => [key, callbacks[i]!]))
    this.shortcuts = next
  }
  applySettings(settings: Settings): void { this.overlay?.setOpacity(settings.opacity) }
  showOverlay(options: ShowOverlayOptions = {}): void {
    this.overlayRequested = true; this.pendingShow = options
    const win = this.overlay
    if (!win || win.isDestroyed() || !this.overlayReady) return
    if (options.resetMouse) { this.mouse = false; win.setIgnoreMouseEvents(false) }
    if (win.isMinimized()) win.restore()
    win.setBounds(this.constrain(win.getBounds()))
    win.setAlwaysOnTop(true)
    if (options.focus) { win.show(); win.focus() } else win.showInactive()
    // showInactive alone does not raise an already visible window above the settings window.
    win.moveTop()
    this.lastPresented = 'overlay'
  }
  hideOverlay(): void { this.overlayRequested = false; if (this.overlay && !this.overlay.isDestroyed()) this.overlay.hide() }
  toggleVisibility(): void {
    const win = this.overlay
    const settingsAbove = this.lastPresented === 'settings' && this.settings && !this.settings.isDestroyed() && this.settings.isVisible()
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !settingsAbove) this.hideOverlay()
    else this.showOverlay()
  }
  toggleMouse(): boolean { this.mouse = !this.mouse; this.overlay?.setIgnoreMouseEvents(this.mouse, { forward: true }); return this.mouse }
  broadcast(snapshot: AppSnapshot): void {
    for (const win of [this.overlay, this.settings]) if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('desktop:snapshot', snapshot)
  }
  owns(id: number): boolean { return [this.overlay, this.settings].some(w => w && !w.isDestroyed() && w.webContents.id === id) }
  dispose(): void {
    clearTimeout(this.saveBoundsTimer); this.shortcuts.forEach(key => globalShortcut.unregister(key))
    this.shortcuts = []; this.shortcutActions.clear()
    screen.removeListener('display-removed', this.onDisplayChanged); screen.removeListener('display-metrics-changed', this.onDisplayChanged)
    for (const win of [this.overlay, this.settings]) if (win && !win.isDestroyed()) win.destroy()
  }
}
