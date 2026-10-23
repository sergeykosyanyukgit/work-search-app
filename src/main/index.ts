import { app, dialog, ipcMain, Menu, safeStorage, session, Tray, nativeImage } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { SqliteStore } from '../adapters/storage/sqlite-store'
import { Diagnostics } from '../adapters/storage/diagnostics'
import { ElectronAudioCapture } from '../adapters/audio/electron-audio-capture'
import { WhisperCppAdapter } from '../adapters/stt/whisper-cpp'
import { AiProviderRouter, CloudAiClient } from '../adapters/ai/provider-router'
import { LocalCodexClient } from '../adapters/ai/local-codex'
import { InterviewController } from '../application/interview-controller'
import { DesktopCommandSchema, type DesktopCommand } from '../shared/ipc'
import { WindowManager, normalizeShortcutSettings } from './window-manager'

const base = dirname(fileURLToPath(import.meta.url))
let windows: WindowManager
let controller: InterviewController
let store: SqliteStore
let tray: Tray | undefined
let quitting = false
let commandChain = Promise.resolve()

if (process.env.WORK_SEARCH_USER_DATA && !app.isPackaged) {
  mkdirSync(process.env.WORK_SEARCH_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.WORK_SEARCH_USER_DATA)
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { windows?.showOverlay({ focus: true, resetMouse: true }); controller?.setMousePassthrough(false) })
  app.on('window-all-closed', () => {})
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault(); quitting = true
    const timeout = setTimeout(() => app.exit(), 10000)
    void controller?.shutdown().finally(() => {
      clearTimeout(timeout); windows?.dispose(); tray?.destroy(); store?.close(); app.exit()
    })
  })
  void app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Не удалось запустить Work Search', error instanceof Error ? error.message : 'Ошибка запуска')
    app.exit(1)
  })
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null)
  if (process.platform !== 'win32') throw new Error('Эта версия Work Search поддерживает Windows 11 x64.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное шифрование недоступно. Проверьте профиль Windows и перезапустите приложение.')
  store = new SqliteStore(join(app.getPath('userData'), 'interviews.sqlite'), { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const capture = new ElectronAudioCapture({ rendererPath: join(base, '../renderer/capture/index.html'), preloadPath: join(base, '../preload/capture.cjs'), ...(devUrl ? { devUrl: `${devUrl}/capture/index.html` } : {}) })
  const stt = new WhisperCppAdapter({ binaryDirectory: app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'resources/whisper'), modelDirectory: join(app.getPath('userData'), 'models') })
  controller = new InterviewController(store, capture, stt, new AiProviderRouter(new CloudAiClient(store, store), new LocalCodexClient(store, { directory: join(app.getPath('userData'), 'codex-workspace') })))
  const diagnostics = new Diagnostics(join(app.getPath('userData'), 'diagnostics.log'))
  controller.onDiagnostics(event => diagnostics.write(event))
  windows = new WindowManager(base, devUrl, bounds => {
    const settings = { ...store.getSettings(), bounds }; store.saveSettings(settings)
  })
  // UI sessions never receive media permission; capture has its own isolated session.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  windows.create(store.getSettings())
  controller.onChange(snapshot => windows.broadcast(snapshot))
  controller.setShortcutErrors(windows.initializeShortcuts(store.getSettings(), () => enqueue({ type: 'record.toggle' }), value => controller.setMousePassthrough(value)))
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNk+P+/HgMDAwMjI4MAAAb6AwHGnQwVAAAAAElFTkSuQmCC')
  tray = new Tray(icon); tray.setToolTip('Work Search — помощник для собеседований')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать помощника', click: () => { windows.showOverlay({ focus: true, resetMouse: true }); controller.setMousePassthrough(false) } },
    { label: 'Скрыть помощника', click: () => windows.hideOverlay() },
    { label: 'Настройки', click: () => windows.showSettings() },
    { type: 'separator' }, { label: 'Завершить приложение', click: () => app.quit() }
  ]))
  tray.on('double-click', () => { windows.showOverlay({ focus: true, resetMouse: true }); controller.setMousePassthrough(false) })
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!windows.owns(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('Недопустимый источник команды.')
  }
  ipcMain.handle('desktop:snapshot', event => { trusted(event); return controller.snapshot() })
  ipcMain.handle('desktop:microphones', async event => { trusted(event); return capture.microphones() })
  ipcMain.handle('desktop:command', async (event, raw: unknown) => {
    trusted(event)
    try {
      const command = DesktopCommandSchema.parse(raw)
      if (command.type === 'codex.select') {
        const selected = await dialog.showOpenDialog(windows.settings ?? windows.overlay!, { title: 'Выберите codex.exe', properties: ['openFile'], filters: [{ name: 'Codex CLI', extensions: ['exe'] }] })
        return { ok: true, executablePath: selected.canceled ? undefined : selected.filePaths[0] }
      }
      if (['model.download', 'model.import'].includes(command.type)) {
        if (command.type === 'model.download') await stt.downloadModel()
        else {
          const selected = await dialog.showOpenDialog(windows.settings ?? windows.overlay!, { title: 'Выберите ggml-small.bin', properties: ['openFile'], filters: [{ name: 'Whisper model', extensions: ['bin'] }] })
          if (!selected.canceled && selected.filePaths[0]) await stt.importModel(selected.filePaths[0])
        }
      } else if (['connection.test', 'snapshot', 'overlay.show', 'overlay.hide', 'overlay.mouse', 'settings.open', 'app.quit'].includes(command.type)) {
        // Window controls remain usable while a queued network command is waiting.
        await execute(command)
      } else await new Promise<void>((resolve, reject) => {
        commandChain = commandChain.then(() => execute(command)).then(resolve, reject)
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка команды'
      controller.notify(message)
      return { ok: false, error: message }
    }
  })
  await capture.initialize()
  void stt.prepare().catch(error => controller.notify(error instanceof Error ? error.message : 'Локальная модель недоступна'))
}

function enqueue(command: DesktopCommand): void {
  commandChain = commandChain.then(() => execute(command)).catch(error => {
    controller.notify(error instanceof Error ? error.message : 'Ошибка команды')
    windows.showOverlay({ focus: false })
  })
}
async function execute(command: DesktopCommand): Promise<void> {
  switch (command.type) {
    case 'snapshot': windows.broadcast(controller.snapshot()); return
    case 'interview.new': return controller.newInterview(command.title)
    case 'interview.resume': return controller.resumeInterview(command.id)
    case 'interview.finish': return controller.finishInterview()
    case 'interview.delete': return controller.deleteInterview(command.id)
    case 'record.toggle': return controller.toggleRecording()
    case 'question.cancel': return controller.cancel(command.id)
    case 'question.submit': return controller.submitText(command.text, command.revisionOf)
    case 'settings.save': {
      const previous = store.getSettings()
      const next = normalizeShortcutSettings({ ...command.settings, bounds: previous.bounds })
      windows.configureShortcuts(next, () => enqueue({ type: 'record.toggle' }), value => controller.setMousePassthrough(value))
      try { controller.saveSettings(next, command.token); windows.applySettings(next); controller.setShortcutErrors([]) }
      catch (error) { windows.configureShortcuts(previous, () => enqueue({ type: 'record.toggle' }), value => controller.setMousePassthrough(value)); throw error }
      return
    }
    case 'settings.open': windows.showSettings(); return
    case 'token.clear': controller.clearToken(); return
    case 'connection.test': return controller.testConnection()
    case 'connection.recover': return controller.recoverConnection()
    case 'overlay.show': windows.showOverlay({ focus: true, resetMouse: true }); controller.setMousePassthrough(false); return
    case 'overlay.hide': windows.hideOverlay(); return
    case 'overlay.mouse': controller.setMousePassthrough(windows.toggleMouse()); return
    case 'app.quit': app.quit(); return
    case 'model.download': case 'model.import': case 'codex.select': return
  }
}
