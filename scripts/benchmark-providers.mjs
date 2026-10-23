import { _electron as electron } from '@playwright/test'
import { resolve, join } from 'node:path'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Opt-in live acceptance against the packaged UI. Prompts below are synthetic.
// The existing encrypted cloud token is copied directly between SQLite databases in main.
// It never appears in a renderer, command line, log or benchmark report.
if (!process.argv.includes('--run')) throw new Error('Use --run to execute ten synthetic live questions against the installed ChatGPT authorization and saved manager token.')
const execute = promisify(execFile)
const providers = process.argv.includes('--local-only') ? ['local'] : process.argv.includes('--cloud-only') ? ['cloud'] : ['cloud', 'local']
async function codexPids() {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-Process codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)'], { windowsHide: true })
  return JSON.parse(stdout)
}
const beforePids = await codexPids()
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
await mkdir(resolve('.cache'), { recursive: true })
const userData = await mkdtemp(resolve('.cache/providers-014-'))
const app = await electron.launch({ executablePath: resolve('release/win-unpacked/Work Search.exe'), args: [`--user-data-dir=${userData}`], env: environment, timeout: 30000 })
const questions = ['Что такое замыкание в JavaScript?', 'Чем отличается interface от type в TypeScript?', 'Когда нужен useMemo в React?', 'Что такое идемпотентность HTTP-запроса?', 'Чем Promise.all отличается от Promise.allSettled?']
const reportPath = resolve('docs/benchmarks/providers-windows-0.1.4.json')
const previous = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => ({ samples: [] }))
const report = { version: '0.1.4', date: new Date().toISOString(), environment: 'Windows, packaged Electron, same machine and connection; no STT', samples: previous.samples.filter(sample => !providers.includes(sample.provider)) }
try {
  let page
  for (let i = 0; i < 100 && !page; i++) { page = app.windows().find(window => window.url().includes('/renderer/index.html')); if (!page) await new Promise(done => setTimeout(done, 100)) }
  if (!page) throw new Error('Packaged overlay did not open')
  await page.waitForFunction(() => !!window.desktop)
  const cloud = providers.includes('cloud') ? await app.evaluate(async ({ app, safeStorage }) => {
    const { createRequire } = process.getBuiltinModule('module'), { join } = process.getBuiltinModule('path')
    const require = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = require('better-sqlite3')
    const source = new Database(join(app.getPath('appData'), 'work-search-app', 'interviews.sqlite'), { readonly: true, fileMustExist: true })
    const destination = new Database(join(app.getPath('userData'), 'interviews.sqlite'))
    try {
      const secret = source.prepare("SELECT payload FROM secrets WHERE id='client-token'").get()
      if (!secret) throw new Error('No saved manager token for live cloud acceptance')
      destination.prepare("INSERT INTO secrets(id,payload) VALUES('client-token',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(secret.payload)
      const row = source.prepare('SELECT payload FROM settings WHERE id=1').get()
      const settings = row ? JSON.parse(safeStorage.decryptString(row.payload)) : {}
      return { serviceUrl: settings.serviceUrl ?? 'https://api.code-manager.ru', profileSlug: settings.profileSlug ?? 'interview-assistant' }
    } finally { source.close(); destination.close() }
  }) : {}
  for (const provider of providers) {
    const settings = await page.evaluate(() => window.desktop.snapshot().then(snapshot => snapshot.settings))
    const configured = await page.evaluate(settings => window.desktop.command({ type: 'settings.save', settings }), { ...settings, ...cloud, provider })
    if (!configured.ok) throw new Error(configured.error)
    const probe = await page.evaluate(() => window.desktop.command({ type: 'connection.test' }))
    const readiness = await page.evaluate(() => window.desktop.snapshot().then(snapshot => snapshot.aiReadiness))
    if (!probe.ok || readiness.status !== 'ready') throw new Error(readiness.message ?? probe.error)
    await page.evaluate(provider => window.desktop.command({ type: 'interview.new', title: `Work Search 0.1.4 · ${provider} benchmark` }), provider)
    for (const [index, question] of questions.entries()) {
      const sent = await page.evaluate(text => window.desktop.command({ type: 'question.submit', text }), question)
      if (!sent.ok) throw new Error(sent.error)
      const deadline = Date.now() + 150000
      let result
      while (Date.now() < deadline) {
        result = await page.evaluate(index => window.desktop.snapshot().then(snapshot => ({ question: snapshot.questions[index], interview: snapshot.interview })), index)
        if (result.question && (['completed', 'failed', 'cancelled', 'interrupted'].includes(result.question.status) || result.question.error)) break
        await new Promise(done => setTimeout(done, 30))
      }
      if (result?.question?.status !== 'completed') throw new Error(result?.question?.error ?? `${provider} question status: ${result?.question?.status}`)
      const sample = { provider, index: index + 1, firstRequest: index === 0, model: provider === 'local' ? result.interview.localCodex.model : undefined, profile: provider === 'cloud' ? cloud.profileSlug : undefined, cliVersion: result.interview.remote.cliVersion, latency: result.question.latency }
      report.samples.push(sample)
      console.log(JSON.stringify(sample))
      await mkdir(resolve('docs/benchmarks'), { recursive: true })
      await writeFile(reportPath, JSON.stringify(report, null, 2))
    }
    await page.screenshot({ path: resolve(`test-results/packaged-${provider}-014.png`) })
    await page.evaluate(() => window.desktop.command({ type: 'interview.finish' }))
  }
  await page.evaluate(() => window.desktop.command({ type: 'settings.open' }))
  const settingsPage = app.windows().find(window => window.url().includes('view=settings'))
  if (settingsPage) await settingsPage.screenshot({ path: resolve('test-results/packaged-settings-local-014.png') })
} finally {
  await app.close()
  const afterPids = await codexPids()
  report.processCleanup = { newCodexProcessesRemaining: afterPids.filter(pid => !beforePids.includes(pid)), preexistingProcessesStillRunning: beforePids.every(pid => afterPids.includes(pid)) }
  await writeFile(reportPath, JSON.stringify(report, null, 2))
}
