import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rectangle } from 'electron'

const harness = vi.hoisted(() => ({
  registrations: new Map<string, () => void>(), blocked: new Set<string>(), registered: [] as string[], unregistered: [] as string[],
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWindow extends EventEmitter {
    destroyed = false
    visible = false
    minimized = false
    focused = false
    ignored = false
    calls: string[] = []
    bounds: Rectangle
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {}, isDestroyed: () => false })
    constructor(options: Partial<Rectangle>) { super(); this.bounds = { x: 0, y: 0, width: 520, height: 780, ...options } }
    isDestroyed(): boolean { return this.destroyed }
    isVisible(): boolean { return this.visible }
    isMinimized(): boolean { return this.minimized }
    isFocused(): boolean { return this.focused }
    setContentProtection(): void { this.calls.push('protect') }
    setOpacity(): void {}
    setAlwaysOnTop(): void { this.calls.push('topmost') }
    setIgnoreMouseEvents(ignore: boolean): void { this.ignored = ignore }
    getBounds(): Rectangle { return this.bounds }
    setBounds(bounds: Rectangle): void { this.bounds = bounds }
    restore(): void { this.minimized = false; this.calls.push('restore') }
    hide(): void { this.visible = false; this.calls.push('hide') }
    show(): void { this.visible = true; this.calls.push('show') }
    showInactive(): void { this.visible = true; this.calls.push('showInactive') }
    moveTop(): void { this.calls.push('moveTop') }
    focus(): void { this.focused = true; this.calls.push('focus'); this.emit('focus') }
    async loadURL(): Promise<void> {}
    async loadFile(): Promise<void> {}
    destroy(): void { this.destroyed = true }
  }
  return {
    BrowserWindow: FakeWindow,
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: harness.workArea }),
      getDisplayMatching: () => ({ workArea: harness.workArea })
    }),
    globalShortcut: {
      register: (key: string, callback: () => void): boolean => {
        harness.registered.push(key)
        if (harness.blocked.has(key) || harness.registrations.has(key)) return false
        harness.registrations.set(key, callback); return true
      },
      unregister: (key: string): void => { harness.unregistered.push(key); harness.registrations.delete(key) }
    }
  }
})

import { screen } from 'electron'
import { DEFAULT_SETTINGS } from '../src/domain/types'
import { WindowManager, normalizeShortcutSettings } from '../src/main/window-manager'

type TestWindow = NonNullable<WindowManager['overlay']> & {
  calls: string[]; minimized: boolean; ignored: boolean; bounds: Rectangle
}
let manager: WindowManager
let overlay: TestWindow
beforeEach(() => {
  harness.registrations.clear(); harness.blocked.clear(); harness.registered = []; harness.unregistered = []
  harness.workArea = { x: 0, y: 0, width: 1920, height: 1080 }
  manager = new WindowManager('C:/app/out/main', undefined, vi.fn())
  manager.create(DEFAULT_SETTINGS)
  overlay = manager.overlay as TestWindow
})
afterEach(() => { manager.dispose() })

describe('overlay recovery', () => {
  it('protects the window before showing and preserves a hide requested while loading', () => {
    manager.hideOverlay()
    overlay.emit('ready-to-show')
    expect(overlay.isVisible()).toBe(false)
    manager.showOverlay()
    expect(overlay.isVisible()).toBe(true)
    expect(overlay.calls.indexOf('protect')).toBeLessThan(overlay.calls.indexOf('showInactive'))
  })

  it('restores a minimized window, returns it to the active display and raises it without stealing focus', () => {
    overlay.emit('ready-to-show')
    overlay.minimized = true
    overlay.bounds = { x: 3000, y: -1500, width: 520, height: 780 }
    overlay.calls = []
    manager.toggleVisibility()
    expect(overlay.isVisible()).toBe(true)
    expect(overlay.isMinimized()).toBe(false)
    expect(overlay.getBounds()).toEqual({ x: 1400, y: 0, width: 520, height: 780 })
    expect(overlay.calls).toEqual(['restore', 'topmost', 'showInactive', 'moveTop'])
  })

  it('explicit tray recovery always shows an interactive overlay and focuses it', () => {
    overlay.emit('ready-to-show')
    manager.toggleMouse()
    expect(overlay.ignored).toBe(true)
    manager.showOverlay({ focus: true, resetMouse: true })
    expect(overlay.isVisible()).toBe(true)
    expect(overlay.ignored).toBe(false)
    expect(overlay.isFocused()).toBe(true)
    expect(manager.toggleMouse()).toBe(true)
  })

  it('reveals an overlay covered by settings on the first toggle and hides it on the next', () => {
    overlay.emit('ready-to-show')
    manager.showSettings()
    manager.settings!.emit('ready-to-show')
    overlay.calls = []
    manager.toggleVisibility()
    expect(overlay.isVisible()).toBe(true)
    expect(overlay.calls).toContain('moveTop')
    manager.toggleVisibility()
    expect(overlay.isVisible()).toBe(false)
  })

  it('restores settings and relocates both windows when a monitor is removed', () => {
    overlay.emit('ready-to-show')
    manager.showSettings()
    const settings = manager.settings as TestWindow
    settings.emit('ready-to-show')
    settings.minimized = true
    manager.showSettings()
    expect(settings.isMinimized()).toBe(false)
    harness.workArea = { x: -1280, y: 0, width: 1280, height: 720 }
    screen.emit('display-removed')
    for (const win of [overlay, settings]) {
      const bounds = win.getBounds()
      expect(bounds.x).toBeGreaterThanOrEqual(-1280)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(0)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(720)
    }
  })
})

describe('global shortcut registration', () => {
  it('keeps visibility and mouse recovery keys working when recording is occupied at startup', () => {
    harness.blocked.add('Control+Alt+Space')
    const onRecord = vi.fn(); const onMouse = vi.fn()
    const errors = manager.initializeShortcuts(DEFAULT_SETTINGS, onRecord, onMouse)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Запись:')
    expect([...harness.registrations.keys()]).toEqual(['Control+Alt+H', 'Control+Alt+M'])
    overlay.emit('ready-to-show')
    harness.registrations.get('Control+Alt+H')!()
    expect(overlay.isVisible()).toBe(false)
    harness.registrations.get('Control+Alt+M')!()
    expect(onMouse).toHaveBeenCalledWith(true)
    expect(onRecord).not.toHaveBeenCalled()
  })

  it('does not disable valid startup keys when another accelerator is malformed', () => {
    const errors = manager.initializeShortcuts({ ...DEFAULT_SETTINGS, visibilityHotkey: 'Ctrl++' }, vi.fn(), vi.fn())
    expect(errors).toHaveLength(1)
    expect([...harness.registrations.keys()]).toEqual(['Control+Alt+Space', 'Control+Alt+M'])
  })

  it('normalizes aliases, whitespace and modifier ordering before registering or saving', () => {
    const settings = normalizeShortcutSettings({ ...DEFAULT_SETTINGS, recordHotkey: ' alt + ctrl + spacebar ', visibilityHotkey: 'h+ALT+CommandOrControl' })
    expect(settings.recordHotkey).toBe('Control+Alt+Space')
    expect(settings.visibilityHotkey).toBe('Control+Alt+H')
    manager.configureShortcuts(DEFAULT_SETTINGS, vi.fn(), vi.fn())
    manager.configureShortcuts(settings, vi.fn(), vi.fn())
    expect(harness.registered).toHaveLength(3)
    expect(harness.unregistered).toEqual([])
    expect(() => normalizeShortcutSettings({ ...DEFAULT_SETTINGS, visibilityHotkey: 'Alt+Control+space' })).toThrow('разные сочетания')
  })

  it('rolls back only newly acquired keys when a changed setting conflicts, preserving old actions', () => {
    const oldRecord = vi.fn(); const newRecord = vi.fn()
    manager.configureShortcuts(DEFAULT_SETTINGS, oldRecord, vi.fn())
    harness.blocked.add('Control+Alt+Q')
    expect(() => manager.configureShortcuts({ ...DEFAULT_SETTINGS, recordHotkey: 'Ctrl+Alt+R', visibilityHotkey: 'Ctrl+Alt+Q' }, newRecord, vi.fn())).toThrow('занято')
    expect([...harness.registrations.keys()]).toEqual(['Control+Alt+Space', 'Control+Alt+H', 'Control+Alt+M'])
    expect(harness.unregistered).toEqual(['Control+Alt+R'])
    harness.registrations.get('Control+Alt+Space')!()
    expect(oldRecord).toHaveBeenCalledOnce()
    expect(newRecord).not.toHaveBeenCalled()
  })

  it('can swap actions between already registered keys without losing OS registrations', () => {
    const onRecord = vi.fn()
    manager.configureShortcuts(DEFAULT_SETTINGS, onRecord, vi.fn())
    manager.configureShortcuts({ ...DEFAULT_SETTINGS, recordHotkey: DEFAULT_SETTINGS.visibilityHotkey, visibilityHotkey: DEFAULT_SETTINGS.recordHotkey }, onRecord, vi.fn())
    harness.registrations.get('Control+Alt+H')!()
    expect(onRecord).toHaveBeenCalledOnce()
    expect(harness.registered).toHaveLength(3)
    expect(harness.unregistered).toHaveLength(0)
  })
})
