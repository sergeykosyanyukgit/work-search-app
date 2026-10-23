import { _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { checkReleaseResources, checkNotices } from './check-release-resources.mjs'

// Missing model weights are allowed; missing engines, runtimes and licenses are not.
const resources = resolve('release/win-unpacked/resources')
checkReleaseResources(resources)
checkNotices(resolve(resources, 'notices'), resolve('.'))

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
await mkdir(resolve('.cache'), { recursive: true })
const userData = await mkdtemp(resolve('.cache/packaged-'))
const app = await electron.launch({ executablePath: resolve('release/win-unpacked/Work Search.exe'), args: [`--user-data-dir=${userData}`], env: environment, timeout: 20000 })
try {
  if (await app.evaluate(({ app }) => app.getPath('userData')) !== userData) throw new Error('Packaged test did not select its isolated profile')
  let page
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !page) {
    page = app.windows().find(window => window.url().includes('/renderer/index.html'))
    if (!page) await new Promise(done => setTimeout(done, 100))
  }
  if (!page) throw new Error('Packaged overlay did not open')
  await page.waitForFunction(() => !!window.desktop)
  const sttDeadline = Date.now() + 20000
  let prepared = false
  while (Date.now() < sttDeadline && !prepared) {
    const { stt } = await page.evaluate(() => window.desktop.snapshot())
    prepared = stt.status === 'ready' || stt.status === 'error' || (stt.status === 'missing' && Boolean(stt.message))
    if (!prepared) await new Promise(done => setTimeout(done, 100))
  }
  if (!prepared) throw new Error('Packaged STT initialization timed out')
  const snapshot = await page.evaluate(() => window.desktop.snapshot())
  if (snapshot.capture !== 'idle') throw new Error('Packaged application unexpectedly started recording')
  if (snapshot.hasToken || snapshot.history.length) throw new Error('Packaged test profile is not empty')
  if (snapshot.stt.status === 'error') throw new Error(snapshot.stt.message || 'Native STT resource failure')
  const result = await app.evaluate(({ app, BrowserWindow, safeStorage }) => ({ packaged: app.isPackaged, windows: BrowserWindow.getAllWindows().length, contentProtected: BrowserWindow.getAllWindows().every(window => window.isContentProtected()), encryptionAvailable: safeStorage.isEncryptionAvailable() }))
  if (!result.packaged || !result.contentProtected || result.windows < 2 || !result.encryptionAvailable) throw new Error('Packaged startup invariants failed')
  await page.evaluate(() => window.desktop.command({ type: 'overlay.hide' }))
  const shown = await page.evaluate(() => window.desktop.command({ type: 'overlay.show' }))
  if (!shown.ok) throw new Error('Packaged overlay recovery failed')
  let visible = false
  const showDeadline = Date.now() + 5000
  while (!visible && Date.now() < showDeadline) {
    visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes('/renderer/index.html') && window.isVisible() && !window.isMinimized()))
    if (!visible) await new Promise(done => setTimeout(done, 100))
  }
  if (!visible) throw new Error('Packaged overlay did not become visible')
  const submitted = await page.evaluate(() => window.desktop.command({ type: 'question.submit', text: 'Проверка первого вопроса в установленном пакете' }))
  const after = await page.evaluate(() => window.desktop.snapshot())
  if (!submitted.ok || !after.interview || after.questions[0]?.status !== 'queued') throw new Error('Packaged first question failed')
  console.log(JSON.stringify({ ...result, capture: snapshot.capture, stt: snapshot.stt.status, overlayRestored: visible, firstQuestionQueued: true, isolatedProfile: true }))
} finally { await app.close() }
