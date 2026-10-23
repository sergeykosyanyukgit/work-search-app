import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'

test('packaged local provider runs without cloud token, cancels, and restores encrypted history', async () => {
  test.skip(process.env.RUN_LOCAL_CODEX !== '1', 'Opt-in: native CLI with existing ChatGPT login')
  test.setTimeout(60000)
  await mkdir(resolve('.cache'), { recursive: true })
  const userData = await mkdtemp(resolve('.cache/local-packaged-014-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const options = { executablePath: resolve('release/win-unpacked/Work Search.exe'), args: [`--user-data-dir=${userData}`], env, timeout: 20000 }
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch(options)
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await expect.poll(() => app!.windows().some(page => page.url().includes('/renderer/index.html'))).toBe(true)
    let page = app.windows().find(page => page.url().includes('/renderer/index.html'))!
    await page.waitForFunction(() => !!window.desktop)
    let snapshot = await page.evaluate(() => window.desktop.snapshot())
    expect(snapshot.hasToken).toBe(false)
    expect((await page.evaluate(settings => window.desktop.command({ type: 'settings.save', settings }), { ...snapshot.settings, provider: 'local' as const })).ok).toBe(true)
    await page.evaluate(() => window.desktop.command({ type: 'connection.test' }))
    expect((await page.evaluate(() => window.desktop.snapshot())).aiReadiness.status).toBe('ready')
    expect((await page.evaluate(() => window.desktop.snapshot())).interview).toBeUndefined()
    await page.evaluate(() => window.desktop.command({ type: 'question.submit', text: 'Объясни устройство event loop подробно, примерно в 1000 словах.' }))
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).questions[0]?.turnId).toBeTruthy()
    snapshot = await page.evaluate(() => window.desktop.snapshot())
    const interviewId = snapshot.interview!.id, questionId = snapshot.questions[0]!.id
    const cancelled = await page.evaluate(id => window.desktop.command({ type: 'question.cancel', id }), questionId)
    expect(cancelled.ok, cancelled.error).toBe(true)
    expect((await page.evaluate(() => window.desktop.snapshot())).questions[0]?.status).toBe('cancelled')
    await page.evaluate(() => window.desktop.command({ type: 'settings.open' }))
    await expect.poll(() => app!.windows().some(window => window.url().includes('view=settings'))).toBe(true)
    const settings = app.windows().find(window => window.url().includes('view=settings'))!
    await expect(settings.getByLabel('Модель Codex')).toHaveValue('gpt-5.6-sol')
    await settings.screenshot({ path: 'test-results/packaged-settings-local-014.png' })
    await app.close(); app = await electron.launch(options)
    await expect.poll(() => app!.windows().some(page => page.url().includes('/renderer/index.html'))).toBe(true)
    page = app.windows().find(page => page.url().includes('/renderer/index.html'))!
    await page.waitForFunction(() => !!window.desktop)
    snapshot = await page.evaluate(() => window.desktop.snapshot())
    expect(snapshot.interview).toBeUndefined(); expect(snapshot.capture).toBe('idle'); expect(snapshot.hasToken).toBe(false)
    expect(snapshot.history[0]?.provider).toBe('local')
    await page.evaluate(id => window.desktop.command({ type: 'interview.resume', id }), interviewId)
    snapshot = await page.evaluate(() => window.desktop.snapshot())
    expect(snapshot.questions[0]?.status).toBe('cancelled')
    expect(snapshot.interview?.provider).toBe('local')
  } finally { await app?.close() }
})
