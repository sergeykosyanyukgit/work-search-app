import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

test('packaged renderer, protected windows, IPC, local history and streamed AI', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolveReady => server.once('listening', resolveReady))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Missing test server address')
  let turns = 0
  server.on('connection', (socket: WebSocket, request) => {
    expect(request.headers.authorization).toBe('Bearer cm_live_local_test')
    let sequence = 0
    const sessionId = randomUUID()
    const emit = (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => socket.send(JSON.stringify({ v: 1, type, sequence: ++sequence, at: new Date().toISOString(), sessionId, payload, ...extra }))
    socket.on('message', raw => {
      const command = JSON.parse(raw.toString()) as { type: string; clientRequestId: string; payload: Record<string, unknown> }
      if (command.type === 'session.open') { emit('session.accepted', {}); emit('session.ready', {}) }
      if (command.type === 'ping') emit('pong', command.payload)
      if (command.type === 'turn.start') {
        turns++
        expect(command.payload.originator).toBe('chatgpt')
        const turnId = randomUUID()
        emit('turn.queued', {}, { turnId, clientRequestId: command.clientRequestId })
        emit('codex.event', { type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Промежуточный текст' } }, { turnId })
        emit('codex.event', { type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Полный обновленный текст' } }, { turnId })
        emit('turn.completed', { finalResponse: '**Event loop** выполняет задачи очереди и обрабатывает асинхронные события.\n\n- Синхронный код выполняется первым.\n- Microtasks обрабатываются перед следующей задачей.' }, { turnId })
      }
      if (command.type === 'session.close') emit('session.closed', {})
    })
  })
  await mkdir(resolve('.cache/e2e'), { recursive: true })
  const userData = await mkdtemp(resolve('.cache/e2e/profile-'))
  const environment = { ...process.env, WORK_SEARCH_USER_DATA: userData }
  delete environment.ELECTRON_RUN_AS_NODE
  const launchOptions = process.env.WORK_SEARCH_TEST_PACKAGED === '1'
    ? { executablePath: resolve('release/win-unpacked/Work Search.exe'), args: [`--user-data-dir=${userData}`], env: environment, timeout: 20000 }
    : { args: [resolve('.')], env: environment, timeout: 20000 }
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch(launchOptions)
    if (process.env.WORK_SEARCH_TEST_PACKAGED === '1') expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await expect.poll(() => app!.windows().some(win => win.url().includes('/renderer/index.html'))).toBe(true)
    const page = app.windows().find(win => win.url().includes('/renderer/index.html'))!
    await page.waitForFunction(() => !!window.desktop, undefined, { timeout: 5000 })
    await expect(page.getByRole('navigation', { name: 'Раздел приложения' })).toBeVisible()
    const protections = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ protected: win.isContentProtected(), preferences: win.webContents.getLastWebPreferences() })))
    expect(protections.length).toBeGreaterThanOrEqual(2)
    for (const row of protections) { expect(row.protected).toBe(true); expect(row.preferences.sandbox).toBe(true); expect(row.preferences.contextIsolation).toBe(true); expect(row.preferences.nodeIntegration).toBe(false) }
    const configured = await page.evaluate(async serviceUrl => {
      const snapshot = await window.desktop.snapshot()
      return window.desktop.command({ type: 'settings.save', settings: { ...snapshot.settings, serviceUrl, sources: ['microphone'], recordHotkey: 'Ctrl+Alt+Shift+F5', visibilityHotkey: 'Ctrl+Alt+Shift+F6', mouseHotkey: 'Ctrl+Alt+Shift+F7', profile: { ...snapshot.settings.profile, resume: 'TypeScript developer' } }, token: 'cm_live_local_test' })
    }, `http://127.0.0.1:${address.port}`)
    expect(configured.ok).toBe(true)
    expect((await page.evaluate(() => window.desktop.snapshot())).interview).toBeUndefined()
    await page.getByRole('button', { name: 'Написать вопрос вручную' }).click()
    await page.getByLabel('Ваш вопрос', { exact: true }).fill('Как работает event loop в JavaScript?')
    await page.getByRole('button', { name: 'Отправить', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).questions[0]?.status).toBe('completed')
    const snapshot = await page.evaluate(() => window.desktop.snapshot())
    expect(snapshot.questions[0]?.answer).toContain('Event loop')
    expect(snapshot.questions[0]?.answer).not.toContain('Промежуточный')
    expect(snapshot.hasToken).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('cm_live_local_test')
    expect(turns).toBe(1)
    await page.screenshot({ path: 'test-results/electron-overlay.png' })
    expect((await page.evaluate(() => window.desktop.command({ type: 'settings.open' }))).ok).toBe(true)
    await expect.poll(() => app!.windows().length).toBeGreaterThanOrEqual(3)
    const settings = app.windows().find(win => win.url().includes('view=settings'))!
    await settings.waitForFunction(() => !!window.desktop)
    await settings.screenshot({ path: 'test-results/electron-settings.png' })
    await app.close(); app = undefined
    app = await electron.launch(launchOptions)
    await expect.poll(() => app!.windows().some(win => win.url().includes('/renderer/index.html'))).toBe(true)
    const restored = app.windows().find(win => win.url().includes('/renderer/index.html'))!
    await restored.waitForFunction(() => !!window.desktop, undefined, { timeout: 5000 })
    const afterRestart = await restored.evaluate(() => window.desktop.snapshot())
    expect(afterRestart.interview).toBeUndefined()
    expect(afterRestart.history).toHaveLength(1)
    expect(afterRestart.history[0]?.title).toBe(snapshot.interview?.title)
    expect(afterRestart.capture).toBe('idle')
    expect(turns).toBe(1)
  } finally {
    if (app) await app.close().catch(() => app?.process().kill())
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
})

test('hidden capture renderer transcribes a synthetic microphone without physical device access', async () => {
  test.skip(!process.env.WORK_SEARCH_TEST_MODEL, 'Set WORK_SEARCH_TEST_MODEL to the verified ggml-small.bin file')
  test.setTimeout(60000)
  await mkdir(resolve('.cache/e2e'), { recursive: true })
  const userData = await mkdtemp(resolve('.cache/e2e/audio-'))
  await mkdir(join(userData, 'models'))
  await copyFile(process.env.WORK_SEARCH_TEST_MODEL!, join(userData, 'models/ggml-small.bin'))
  const environment = { ...process.env, WORK_SEARCH_USER_DATA: userData }
  delete environment.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.'), '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('tests/audio-fixtures/en-question.wav')}`], env: environment, timeout: 20000 })
  try {
    const audioSwitches = await app.evaluate(({ app }) => ({ fakeDevice: app.commandLine.hasSwitch('use-fake-device-for-media-stream'), fakeFile: app.commandLine.getSwitchValue('use-file-for-fake-audio-capture') }))
    expect(audioSwitches.fakeDevice).toBe(true)
    expect(audioSwitches.fakeFile).toBe(resolve('tests/audio-fixtures/en-question.wav'))
    await expect.poll(() => app.windows().some(win => win.url().includes('/renderer/index.html'))).toBe(true)
    const page = app.windows().find(win => win.url().includes('/renderer/index.html'))!
    await page.waitForFunction(() => !!window.desktop)
    const capturePage = app.windows().find(win => win.url().includes('/capture/index.html'))!
    const captureErrors: string[] = []
    capturePage.on('pageerror', error => captureErrors.push(error.message))
    await capturePage.evaluate(() => {
      const contexts: AudioContext[] = []
      const tracks: MediaStreamTrack[] = []
      const stats = { frames: 0, samples: 0, largestLevel: 0, nonzeroSamples: 0 }
      const Context = window.AudioContext
      const Worklet = window.AudioWorkletNode
      window.AudioContext = class extends Context {
        constructor(options?: AudioContextOptions) { super(options); contexts.push(this) }
        override createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode { tracks.push(...stream.getAudioTracks()); return super.createMediaStreamSource(stream) }
      }
      window.AudioWorkletNode = class extends Worklet {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options)
          this.port.addEventListener('message', (event: MessageEvent) => {
            if (event.data?.type !== 'pcm') return
            stats.frames++
            stats.largestLevel = Math.max(stats.largestLevel, event.data.level)
            const pcm = new Int16Array(event.data.pcm)
            stats.samples += pcm.length
            stats.nonzeroSamples += pcm.reduce((count, sample) => count + (sample !== 0 ? 1 : 0), 0)
          })
        }
      }
      Object.defineProperty(window, '__audioTest', { value: () => ({ ...stats, contexts: contexts.map(context => ({ state: context.state, time: context.currentTime, sampleRate: context.sampleRate, sink: (context as AudioContext & { sinkId: unknown }).sinkId })), tracks: tracks.map(track => ({ state: track.readyState, muted: track.muted, enabled: track.enabled, label: track.label, settings: track.getSettings() })) }) })
    })
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).stt.status, { timeout: 20000 }).toBe('ready')
    const configured = await page.evaluate(async () => {
      const snapshot = await window.desktop.snapshot()
      const saved = await window.desktop.command({ type: 'settings.save', settings: { ...snapshot.settings, sources: ['microphone'], language: 'en', recordHotkey: 'Ctrl+Alt+Shift+F5', visibilityHotkey: 'Ctrl+Alt+Shift+F6', mouseHotkey: 'Ctrl+Alt+Shift+F7' } })
      if (!saved.ok) throw new Error(saved.error)
      await window.desktop.command({ type: 'overlay.hide' })
      return window.desktop.command({ type: 'record.toggle' })
    })
    expect(configured.ok, configured.error).toBe(true)
    expect((await page.evaluate(() => window.desktop.snapshot())).interview).toBeDefined()
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).capture).toBe('recording')
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).levels.microphone).toBeGreaterThan(0)
    await page.waitForTimeout(4000) // Capture a deterministic length of the fake WAV source.
    expect((await page.evaluate(() => window.desktop.command({ type: 'record.toggle' }))).ok).toBe(true)
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).questions[0]?.status, { timeout: 20000 }).toBe('queued')
    const result = await page.evaluate(() => window.desktop.snapshot())
    expect(result.questions[0]?.text.length).toBeGreaterThan(20)
    expect(result.questions[0]?.segments.every(segment => segment.source === 'microphone')).toBe(true)
    expect(result.capture).toBe('idle')
    expect(result.levels.microphone).toBe(0)
    const cleanup = await capturePage.evaluate(() => (window as unknown as { __audioTest(): { frames: number; nonzeroSamples: number; contexts: Array<{ state: string }>; tracks: Array<{ state: string }> } }).__audioTest())
    expect(cleanup.frames).toBeGreaterThan(0)
    expect(cleanup.nonzeroSamples).toBeGreaterThan(0)
    expect(cleanup.contexts.map(context => context.state)).toEqual(['closed'])
    expect(cleanup.tracks.every(track => track.state === 'ended')).toBe(true)
    expect(captureErrors).toEqual([])
    const captureWindow = app.windows().find(win => win.url().includes('/capture/index.html'))!
    expect(await captureWindow.evaluate(() => navigator.mediaDevices.enumerateDevices().then(devices => devices.some(device => device.kind === 'audioinput')))).toBe(true)
  } finally { await app.close(); await unlink(join(userData, 'models/ggml-small.bin')).catch(() => {}) }
})
