import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  await mkdir(resolve('.cache/e2e'), { recursive: true })
  const userData = await mkdtemp(resolve('.cache/e2e/window-controls-'))
  const environment = { ...process.env, WORK_SEARCH_USER_DATA: userData }
  delete environment.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: environment, timeout: 20000 })
  await expect.poll(() => app.windows().some(page => page.url().includes('/renderer/index.html'))).toBe(true)
  const page = app.windows().find(page => page.url().includes('/renderer/index.html'))!
  await page.waitForFunction(() => !!window.desktop)
  return { app, page }
}

async function overlayState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/renderer/index.html') && !win.webContents.getURL().includes('view=settings'))!
    return { visible: overlay.isVisible(), minimized: overlay.isMinimized(), focused: overlay.isFocused(),
      protected: overlay.isContentProtected(), bounds: overlay.getBounds(), work: screen.getDisplayMatching(overlay.getBounds()).workArea }
  })
}

async function show(page: Page): Promise<void> {
  const result = await page.evaluate(() => window.desktop.command({ type: 'overlay.show' }))
  expect(result.ok, result.error).toBe(true)
}

test('show restores a hidden, minimized or offscreen helper and brings it above settings', async () => {
  const { app, page } = await launch()
  try {
    expect((await page.evaluate(() => window.desktop.command({ type: 'overlay.hide' }))).ok).toBe(true)
    await expect.poll(async () => (await overlayState(app)).visible).toBe(false)
    await show(page)
    await expect.poll(async () => (await overlayState(app)).visible).toBe(true)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/renderer/index.html'))!.minimize())
    await expect.poll(async () => (await overlayState(app)).minimized).toBe(true)
    await show(page)
    await expect.poll(async () => (await overlayState(app)).minimized).toBe(false)

    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/renderer/index.html'))!
      const displays = screen.getAllDisplays()
      const x = Math.max(...displays.map(display => display.bounds.x + display.bounds.width)) + 5000
      win.setBounds({ ...win.getBounds(), x, y: -5000 })
      win.hide()
    })
    await show(page)
    const { bounds, work } = await overlayState(app)
    expect(bounds.x).toBeGreaterThanOrEqual(work.x)
    expect(bounds.y).toBeGreaterThanOrEqual(work.y)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(work.x + work.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(work.y + work.height)

    expect((await page.evaluate(() => window.desktop.command({ type: 'overlay.mouse' }))).ok).toBe(true)
    expect((await page.evaluate(() => window.desktop.snapshot())).mousePassthrough).toBe(true)
    expect((await page.evaluate(() => window.desktop.command({ type: 'settings.open' }))).ok).toBe(true)
    await expect.poll(() => app.windows().some(win => win.url().includes('view=settings'))).toBe(true)
    const settings = app.windows().find(win => win.url().includes('view=settings'))!
    await settings.waitForFunction(() => !!window.desktop)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('view=settings'))).toBe(true)
    await show(settings)
    await expect.poll(async () => (await overlayState(app)).focused).toBe(true)
    expect((await page.evaluate(() => window.desktop.snapshot())).mousePassthrough).toBe(false)
    expect((await overlayState(app)).protected).toBe(true)
  } finally { await app.close() }
})

test('all configured hotkeys are registered with Windows', async () => {
  const { app, page } = await launch()
  try {
    const keys = { recordHotkey: 'Control+Alt+Shift+F9', visibilityHotkey: 'Control+Alt+Shift+F10', mouseHotkey: 'Control+Alt+Shift+F11' }
    const result = await page.evaluate(async keys => window.desktop.command({ type: 'settings.save', settings: { ...(await window.desktop.snapshot()).settings, ...keys } }), keys)
    expect(result.ok, result.error).toBe(true)
    expect(await app.evaluate(({ globalShortcut }, keys) => keys.map(key => globalShortcut.isRegistered(key)), Object.values(keys))).toEqual([true, true, true])
    expect((await page.evaluate(() => window.desktop.snapshot())).shortcutErrors).toEqual([])
  } finally { await app.close() }
})

test('native hotkeys operate while a different test window owns Windows foreground focus', async () => {
  test.skip(process.platform !== 'win32', 'Win32 SendInput acceptance')
  test.skip(process.env.WORK_SEARCH_TEST_NATIVE_HOTKEYS !== '1', 'Set WORK_SEARCH_TEST_NATIVE_HOTKEYS=1 in an interactive Windows desktop that permits foreground focus')
  const { app, page } = await launch()
  try {
    // Isolated combinations avoid the user's running installed copy during acceptance.
    const keys = { recordHotkey: 'Control+Alt+Shift+F9', visibilityHotkey: 'Control+Alt+Shift+F10', mouseHotkey: 'Control+Alt+Shift+F11' }
    const result = await page.evaluate(async keys => window.desktop.command({ type: 'settings.save', settings: { ...(await window.desktop.snapshot()).settings, ...keys } }), keys)
    expect(result.ok, result.error).toBe(true)
    expect(await app.evaluate(({ globalShortcut }, keys) => keys.map(key => globalShortcut.isRegistered(key)), Object.values(keys))).toEqual([true, true, true])
    const inputWindow = await app.evaluate(async ({ BrowserWindow, app }) => {
      const win = new BrowserWindow({ width: 260, height: 100, show: false, title: 'Hotkey acceptance input', skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await win.loadURL('data:text/html,<title>Hotkey acceptance input</title><p>Windows hotkey acceptance</p>')
      win.show(); win.focus()
      return { id: win.id, handle: Number(win.getNativeWindowHandle().readBigUInt64LE()), processId: app.getAppMetrics().find(metric => metric.type === 'Browser')!.pid }
    })
    const press = async (virtualKey: number): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, id) => { const win = BrowserWindow.fromId(id)!; win.show(); win.focus() }, inputWindow.id)
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(inputWindow.id)
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve('e2e/helpers/send-hotkey.ps1'),
        '-VirtualKey', String(virtualKey), '-Control', '-Alt', '-Shift', '-ExpectedForegroundHandle', String(inputWindow.handle),
        '-ExpectedProcessId', String(inputWindow.processId)], { windowsHide: true, timeout: 10000 })
    }
    const initiallyVisible = (await overlayState(app)).visible
    await press(0x79) // F10
    await expect.poll(async () => (await overlayState(app)).visible).toBe(!initiallyVisible)
    await press(0x79)
    await expect.poll(async () => (await overlayState(app)).visible).toBe(initiallyVisible)
    await press(0x7a) // F11
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).mousePassthrough).toBe(true)
    await press(0x7a)
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).mousePassthrough).toBe(false)
    expect((await page.evaluate(() => window.desktop.command({ type: 'overlay.hide' }))).ok).toBe(true)
    await press(0x78) // F9: model is deliberately absent, so the physical microphone is never opened.
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).notice).toContain('Подготовьте модель Whisper')
    expect((await page.evaluate(() => window.desktop.snapshot())).capture).toBe('idle')
    await expect.poll(async () => (await overlayState(app)).visible).toBe(true)
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), inputWindow.id)
  } finally { await app.close() }
})
