import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import { DEFAULT_SETTINGS, type AppSnapshot, type Question } from '../src/domain/types'
import type { DesktopCommand } from '../src/shared/ipc'

// Tests exercise the real built renderer with an in-memory preload contract.
// Run pnpm build first. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use an installed browser.
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } })
let server: Server
let baseUrl: string
const staticRoot = resolve('out/renderer')
const interviewId = '65c6c8ce-7c79-44d2-b13f-c57c74047281'
const questionId = 'c8572fa6-73e2-4b23-bddc-a76fb423bf83'

test.beforeAll(async () => {
  await readFile(resolve(staticRoot, 'renderer/index.html'))
  server = createServer((request, response) => {
    const file = resolve(staticRoot, `.${new URL(request.url || '/', 'http://localhost').pathname}`)
    if (!file.startsWith(staticRoot + sep)) { response.writeHead(403).end(); return }
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<string, string>)[extname(file)] || 'application/octet-stream'
    void readFile(file).then(data => { response.writeHead(200, { 'Content-Type': type }); response.end(data) }).catch(() => response.writeHead(404).end())
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/renderer/index.html`
})
test.afterAll(async () => { if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) })

function initialSnapshot(): AppSnapshot {
  return {
    aiReadiness: { provider: 'cloud', status: 'unchecked' }, settings: structuredClone(DEFAULT_SETTINGS), hasToken: true, questions: [], history: [],
    capture: 'idle', levels: { microphone: 0, system: 0 }, connection: 'ready', stt: { status: 'ready' }, mousePassthrough: false,
    interview: { provider: 'cloud', localCodex: structuredClone(DEFAULT_SETTINGS.localCodex), id: interviewId, title: 'Frontend Developer · техническое интервью', createdAt: 1789113600000, updatedAt: 1789113600000, profile: structuredClone(DEFAULT_SETTINGS.profile), serviceUrl: DEFAULT_SETTINGS.serviceUrl, profileSlug: DEFAULT_SETTINGS.profileSlug, completed: false, remote: { openRequestId: 'session-open', lastSequence: 0, contextSent: false } }
  }
}
function sampleQuestion(overrides: Partial<Question> = {}): Question {
  return { id: questionId, interviewId, order: 1, createdAt: 1789113600000, status: 'completed', text: 'В чём разница между useMemo и useCallback?', answer: '**useMemo** сохраняет результат вычисления, а **useCallback** — ссылку на функцию.\n\n- Используйте `useMemo` для дорогих вычислений.\n- Используйте `useCallback`, когда стабильная ссылка помогает избежать лишних рендеров.\n\n```ts\nconst total = useMemo(() => sum(items), [items]);\n```\n\nСначала измерьте производительность: мемоизация тоже имеет свою стоимость.', segments: [{ source: 'system', startMs: 0, endMs: 8000, text: 'В чём разница между useMemo и useCallback?' }], partial: false, durationMs: 8000, ...overrides }
}

type TestWindow = Window & { __uiTest: { commands: DesktopCommand[]; update: (snapshot: AppSnapshot) => void; delay: (type: DesktopCommand['type']) => void; release: (ok?: boolean) => void } }
async function openRenderer(page: Page, snapshot: AppSnapshot, settings = false) {
  await page.addInitScript(({ initial }) => {
    let current = initial
    const listeners = new Set<(value: AppSnapshot) => void>()
    const commands: DesktopCommand[] = []
    let delayed: DesktopCommand['type'] | undefined
    let release: ((ok: boolean) => void) | undefined
    const publish = (next: AppSnapshot) => { current = structuredClone(next); for (const listener of listeners) listener(structuredClone(current)) }
    ;(window as TestWindow).__uiTest = { commands, update: publish, delay: type => { delayed = type }, release: (ok = true) => { release?.(ok); release = undefined } }
    window.desktop = {
      snapshot: async () => structuredClone(current),
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      microphones: async () => [{ id: 'test-mic', label: 'USB Conference Microphone' }],
      command: async command => {
        commands.push(structuredClone(command))
        if (command.type === delayed) {
          delayed = undefined
          const ok = await new Promise<boolean>(resolve => { release = resolve })
          if (!ok) return { ok: false, error: 'Синтетическая ошибка команды' }
        }
        if (command.type === 'settings.save') publish({ ...current, settings: command.settings, hasToken: current.hasToken || Boolean(command.token) })
        if (command.type === 'token.clear') publish({ ...current, hasToken: false })
        return { ok: true }
      }
    }
  }, { initial: snapshot })
  await page.goto(baseUrl + (settings ? '?view=settings' : ''))
  await expect(settings ? page.getByRole('button', { name: 'Показать помощника' }) : page.getByRole('navigation', { name: 'Раздел приложения' })).toBeVisible()
}
async function getCommands(page: Page) { return page.evaluate(() => (window as TestWindow).__uiTest.commands) }

test('shows first text before completion and exposes the latency breakdown', async ({ page }) => {
  await page.setViewportSize({ width: 510, height: 760 })
  const snapshot = initialSnapshot()
  snapshot.questions = [sampleQuestion({ answer: 'Первый текст ответа', status: 'generating', latency: { queueMs: 0, sttMs: 400, connectionMs: 50, aiFirstAnswerMs: 750, firstAnswerMs: 1200 } })]
  await openRenderer(page, snapshot)
  const panel = page.locator('.latency-details')
  await expect(panel.locator('summary')).toContainText('Первый текст: 1,2 с')
  await expect(panel.locator('summary')).not.toContainText('Готово')
  snapshot.questions[0]!.status = 'completed'
  snapshot.questions[0]!.latency = { ...snapshot.questions[0]!.latency, aiTotalMs: 1650, totalMs: 2100 }
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), snapshot)
  await expect(panel.locator('summary')).toContainText('Готово: 2,1 с')
  await panel.locator('summary').click()
  await expect(panel).toContainText('AI до первого текста')
  await expect(panel).toContainText('0,75 с')
  await expect(panel).toContainText('Распознавание')
  await page.screenshot({ path: 'test-results/ui-latency.png', animations: 'disabled' })
})

test('local settings expose the model catalog and keep the active interview provider visible', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 })
  const snapshot = initialSnapshot()
  snapshot.settings.provider = 'local'; snapshot.hasToken = false
  snapshot.aiReadiness = { provider: 'local', status: 'ready', authenticated: true, executablePath: 'C:\\Program Files\\Codex\\codex.exe', version: '0.154.0-alpha.6.2', models: [{ id: 'gpt-5.6-sol', label: 'Sol', supportsLow: true }, { id: 'another-model', label: 'Another model', supportsLow: true }] }
  await openRenderer(page, snapshot, true)
  await expect(page.getByLabel('Провайдер AI')).toHaveValue('local')
  await expect(page.getByLabel('Модель Codex')).toHaveValue('gpt-5.6-sol')
  await expect(page.getByRole('strong').filter({ hasText: 'Облачный codex-manager' })).toBeVisible()
  await expect(page.getByLabel('Токен доступа')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Проверить подключение' })).toBeEnabled()
  await page.getByLabel('Модель Codex').selectOption('another-model')
  await expect(page.getByRole('button', { name: 'Проверить подключение' })).toBeDisabled()
  await page.screenshot({ path: 'test-results/ui-local-settings.png', animations: 'disabled' })
})

test('manual questions and revisions submit distinct commands; remote markdown cannot load resources', async ({ page }) => {
  await page.setViewportSize({ width: 510, height: 760 })
  const initial = initialSnapshot()
  initial.questions = [sampleQuestion({ answer: sampleQuestion().answer + '\n\n<img src="https://invalid.example/secret" />\n\n![tracking](https://invalid.example/pixel)\n\n[link](javascript:alert(1))' })]
  const externalRequests: string[] = []
  page.on('request', request => { if (request.url().includes('invalid.example')) externalRequests.push(request.url()) })
  await openRenderer(page, initial)
  await expect(page.getByRole('heading', { name: initial.questions[0]!.text })).toBeVisible()
  await expect(page.locator('.markdown-answer pre')).toContainText('useMemo')
  expect(await page.locator('.markdown-answer img').count()).toBe(0)
  expect(await page.locator('.markdown-answer a').count()).toBe(0)
  expect(externalRequests).toEqual([])
  await page.screenshot({ path: 'test-results/ui-answer.png', animations: 'disabled' })

  await page.getByRole('button', { name: 'Редактировать вопрос и запросить новый ответ' }).click()
  await page.getByRole('textbox', { name: 'Исправленный вопрос' }).fill('Когда useCallback не нужен?')
  await page.getByRole('button', { name: 'Отправить версию' }).click()
  await expect.poll(() => getCommands(page)).toContainEqual({ type: 'question.submit', text: 'Когда useCallback не нужен?', revisionOf: questionId })

  await page.getByRole('button', { name: 'Написать вопрос вручную' }).click()
  await page.getByRole('textbox', { name: 'Ваш вопрос', exact: true }).fill('Что такое замыкание?')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect.poll(() => getCommands(page)).toContainEqual({ type: 'question.submit', text: 'Что такое замыкание?' })
})

test('settings preserve edits across snapshot updates and never resend an unchanged token', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 780 })
  const initial = initialSnapshot()
  await openRenderer(page, initial, true)
  await expect(page.getByLabel('Заменить токен')).toHaveValue('')
  await page.getByRole('button', { name: 'Мой контекст' }).click()
  await page.getByLabel('Ваш опыт и резюме').fill('5 лет разработки интерфейсов на TypeScript.')
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), { ...initial, levels: { microphone: .5, system: .2 } })
  await expect(page.getByLabel('Ваш опыт и резюме')).toHaveValue('5 лет разработки интерфейсов на TypeScript.')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Настройки сохранены', { exact: true })).toBeVisible()
  const firstSave = (await getCommands(page)).find(command => command.type === 'settings.save')
  expect(firstSave).toHaveProperty('settings.profile.resume', '5 лет разработки интерфейсов на TypeScript.')
  expect(firstSave).not.toHaveProperty('token')

  await page.getByRole('button', { name: 'Подключение', exact: true }).click()
  await page.getByLabel('Заменить токен').fill('test-replacement-token')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByLabel('Заменить токен')).toHaveValue('')
  expect((await getCommands(page)).filter(command => command.type === 'settings.save').at(-1)).toHaveProperty('token', 'test-replacement-token')
  await page.screenshot({ path: 'test-results/ui-settings.png', animations: 'disabled' })

  await page.getByRole('button', { name: 'Источники звука' }).click()
  await expect(page.getByLabel('Микрофон', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Микрофон' })).toContainText('USB Conference Microphone')
})

test('pending saves preserve newer settings and tokens and do not resend an acknowledged token', async ({ page }) => {
  await openRenderer(page, initialSnapshot(), true)
  await page.getByLabel('Заменить токен').fill('synthetic-first-token')
  await page.getByRole('button', { name: 'Мой контекст', exact: true }).click()
  await page.getByLabel('Ваш опыт и резюме').fill('Отправленный контекст')
  await page.evaluate(() => (window as TestWindow).__uiTest.delay('settings.save'))
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
  await page.getByLabel('Ваш опыт и резюме').fill('Более новый контекст')
  await page.evaluate(() => (window as TestWindow).__uiTest.release())
  await expect(page.getByLabel('Ваш опыт и резюме')).toHaveValue('Более новый контекст')
  await expect(page.getByText('Есть несохранённые изменения', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Подключение', exact: true }).click()
  await expect(page.getByLabel('Заменить токен')).toHaveValue('')

  await page.getByLabel('Заменить токен').fill('synthetic-second-token')
  await page.evaluate(() => (window as TestWindow).__uiTest.delay('settings.save'))
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await page.getByLabel('Заменить токен').fill('synthetic-third-token')
  await page.evaluate(() => (window as TestWindow).__uiTest.release())
  await expect(page.getByLabel('Заменить токен')).toHaveValue('synthetic-third-token')
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByLabel('Заменить токен')).toHaveValue('')
  await page.getByRole('button', { name: 'Мой контекст', exact: true }).click()
  await page.getByLabel('Ваш опыт и резюме').fill('Последний контекст')
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Настройки сохранены', { exact: true })).toBeVisible()
  const saves = (await getCommands(page)).filter(command => command.type === 'settings.save')
  expect(saves).toHaveLength(4)
  expect(saves[1]).toHaveProperty('settings.profile.resume', 'Более новый контекст')
  expect(saves[2]).toHaveProperty('token', 'synthetic-third-token')
  expect(saves[3]).not.toHaveProperty('token')
})

test('revision drafts survive selection, history, new recordings and delayed submissions', async ({ page }) => {
  const snapshot = initialSnapshot()
  snapshot.history = [{ provider: 'cloud', id: interviewId, title: snapshot.interview!.title, createdAt: 1789113600000, updatedAt: 1789113600000, completed: false, questionCount: 2 }]
  const secondId = '09c0659d-f994-4d20-9367-a6e84ec7d737'
  snapshot.questions = [sampleQuestion(), sampleQuestion({ id: secondId, order: 2, text: 'Второй вопрос' })]
  await openRenderer(page, snapshot)
  const chips = page.locator('.question-navigation button')
  await chips.nth(0).click()
  await page.getByRole('button', { name: 'Редактировать вопрос и запросить новый ответ' }).click()
  const editor = page.getByRole('textbox', { name: 'Исправленный вопрос' })
  await editor.fill('Черновик первого вопроса')
  await chips.nth(1).click()
  await page.getByRole('button', { name: 'Редактировать вопрос и запросить новый ответ' }).click()
  await editor.fill('Черновик второго вопроса')
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await expect(editor).toHaveValue('Черновик второго вопроса')
  snapshot.questions.push(sampleQuestion({ id: '6814451b-e871-4bc2-a3a5-b6acee89c161', order: 3, status: 'recording', text: '', answer: '' }))
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), snapshot)
  await expect(page.locator('.question-placeholder')).toBeVisible()
  await chips.nth(0).click()
  await expect(editor).toHaveValue('Черновик первого вопроса')
  await page.evaluate(() => (window as TestWindow).__uiTest.delay('question.submit'))
  await page.getByRole('button', { name: 'Отправить версию' }).click()
  await editor.fill('Продолжение первого черновика')
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.evaluate(() => (window as TestWindow).__uiTest.release())
  await expect.poll(() => getCommands(page)).toContainEqual({ type: 'question.submit', text: 'Черновик первого вопроса', revisionOf: questionId })
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await expect(editor).toHaveValue('Продолжение первого черновика')
  await expect(page.getByRole('button', { name: 'Отправить версию' })).toBeEnabled()
  await page.getByRole('button', { name: 'Отправить версию' }).click()
  await expect(editor).toHaveCount(0)
  await chips.nth(1).click()
  await expect(editor).toHaveValue('Черновик второго вопроса')
  const otherInterview = { ...snapshot, interview: { ...snapshot.interview!, id: 'ae61d4b4-35eb-4844-b163-52244b464541', title: 'Другое интервью' }, questions: [] }
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), otherInterview)
  await expect(editor).toHaveCount(0)
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), snapshot)
  await chips.nth(1).click()
  await expect(editor).toHaveValue('Черновик второго вопроса')
  await page.evaluate(() => (window as TestWindow).__uiTest.delay('question.submit'))
  await page.getByRole('button', { name: 'Отправить версию' }).click()
  await page.evaluate(() => (window as TestWindow).__uiTest.release(false))
  await expect(page.getByText('Синтетическая ошибка команды')).toBeVisible()
  await expect(editor).toHaveValue('Черновик второго вопроса')
})

test('deleting an interview discards its revision drafts while switching keeps them', async ({ page }) => {
  const snapshot = initialSnapshot()
  snapshot.questions = [sampleQuestion()]
  snapshot.history = [{ provider: 'cloud', id: interviewId, title: snapshot.interview!.title, createdAt: 1789113600000, updatedAt: 1789113600000, completed: false, questionCount: 1 }]
  await openRenderer(page, snapshot)
  await page.getByRole('button', { name: 'Редактировать вопрос и запросить новый ответ' }).click()
  const editor = page.getByRole('textbox', { name: 'Исправленный вопрос' })
  await editor.fill('Черновик удаляемого интервью')
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.getByRole('button', { name: /Удалить интервью «Frontend Developer/ }).click()
  await page.getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect.poll(() => getCommands(page)).toContainEqual({ type: 'interview.delete', id: interviewId })
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), { ...snapshot, interview: undefined, history: [], questions: [] })
  await expect(page.locator('.session-label')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Помощник', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.question-content')).toHaveCount(0)
  // Reintroducing the same synthetic IDs makes retention observable without inspecting React state.
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), snapshot)
  await expect(page.getByRole('heading', { name: snapshot.questions[0]!.text })).toBeVisible()
  await expect(editor).toHaveCount(0)
  await page.getByRole('button', { name: 'Редактировать вопрос и запросить новый ответ' }).click()
  await expect(editor).toHaveValue(snapshot.questions[0]!.text)
})

test('manual composer retains edits made while submission is pending and after errors', async ({ page }) => {
  await openRenderer(page, initialSnapshot())
  await page.getByRole('button', { name: 'Написать вопрос вручную' }).click()
  const editor = page.getByRole('textbox', { name: 'Ваш вопрос', exact: true })
  await editor.fill('Первый ручной вопрос')
  await page.evaluate(() => (window as TestWindow).__uiTest.delay('question.submit'))
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await editor.fill('Следующий ручной вопрос')
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.evaluate(() => (window as TestWindow).__uiTest.release())
  await expect(page.getByRole('heading', { name: 'История интервью' })).toBeVisible()
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await expect(editor).toHaveValue('Следующий ручной вопрос')
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled()
  await page.evaluate(() => (window as TestWindow).__uiTest.delay('question.submit'))
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await page.evaluate(() => (window as TestWindow).__uiTest.release(false))
  await expect(page.getByText('Синтетическая ошибка команды')).toBeVisible()
  await expect(editor).toHaveValue('Следующий ручной вопрос')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(editor).toHaveCount(0)
})

test('the full queue blocks new recording and manual submissions, while capture meters follow snapshots', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  const initial = initialSnapshot()
  initial.questions = [sampleQuestion({ status: 'generating', answer: '' }), sampleQuestion({ id: '09c0659d-f994-4d20-9367-a6e84ec7d737', order: 2, status: 'queued', text: 'Что такое event loop?', answer: '' }), sampleQuestion({ id: '6814451b-e871-4bc2-a3a5-b6acee89c161', order: 3, status: 'transcribing', text: '', answer: '' })]
  await openRenderer(page, initial)
  await expect(page.getByRole('button', { name: /Очередь заполнена/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Написать вопрос вручную' }).click()
  await page.getByRole('textbox', { name: 'Ваш вопрос', exact: true }).fill('Четвёртый вопрос')
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Закрыть ввод вопроса' }).click()

  initial.capture = 'recording'; initial.recordingStartedAt = Date.now() - 14000
  initial.questions = [sampleQuestion({ status: 'recording', text: '', answer: '' })]
  initial.levels = { microphone: .23, system: .8 }
  await page.evaluate(next => (window as TestWindow).__uiTest.update(next), initial)
  await expect(page.getByRole('button', { name: /Завершить вопрос/ })).toBeEnabled()
  await expect(page.getByRole('meter', { name: 'Уровень: Система' })).toHaveAttribute('aria-valuenow', '80')
  await page.screenshot({ path: 'test-results/ui-recording-small.png', animations: 'disabled' })
})

test('history deletion requires an explicit confirmation for the selected interview', async ({ page }) => {
  const initial = initialSnapshot()
  initial.history = [{ provider: 'cloud', id: interviewId, title: 'Frontend · первый этап', createdAt: 1789113600000, updatedAt: 1789113600000, completed: true, questionCount: 5 }]
  await page.setViewportSize({ width: 510, height: 760 })
  await openRenderer(page, initial)
  await page.screenshot({ path: 'test-results/ui-workspace-empty.png', animations: 'disabled' })
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.getByRole('button', { name: /Удалить интервью «Frontend/ }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  expect((await getCommands(page)).filter(command => command.type === 'interview.delete')).toHaveLength(0)
  await page.getByRole('button', { name: 'Оставить' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.getByRole('button', { name: /Удалить интервью «Frontend/ }).click()
  await page.getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect.poll(() => getCommands(page)).toContainEqual({ type: 'interview.delete', id: interviewId })
})

test('color themes support keyboard selection and persist independently of settings', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 980 })
  await openRenderer(page, initialSnapshot(), true)
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  const themes = page.getByRole('group', { name: 'Цветовая тема' })
  const dark = themes.getByRole('radio', { name: 'Тёмная синяя' })
  await expect(dark).toBeChecked()
  await dark.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(themes.getByRole('radio', { name: 'Светлая голубая' })).toBeChecked()
  await expect(themes.getByRole('radio', { name: 'Светлая голубая' })).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-blue')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
  await page.screenshot({ path: 'test-results/theme-light-blue-appearance.png', animations: 'disabled' })
  await page.keyboard.press('ArrowRight')
  await expect(dark).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark-blue')
  await page.screenshot({ path: 'test-results/theme-dark-blue-appearance.png', animations: 'disabled' })
  await page.keyboard.press('ArrowRight')
  await expect(themes.getByRole('radio', { name: 'Полночь' })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
  await page.screenshot({ path: 'test-results/theme-midnight-appearance.png', animations: 'disabled' })
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
  expect(await getCommands(page)).toEqual([])
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  await expect(themes.getByRole('radio', { name: 'Полночь' })).toBeChecked()
})

test('theme changes reach an already open assistant and history through shared storage', async ({ page, context }) => {
  await page.setViewportSize({ width: 1000, height: 980 })
  const snapshot = initialSnapshot()
  snapshot.questions = [sampleQuestion({ partial: true, latency: { firstAnswerMs: 1200, totalMs: 2100 } })]
  snapshot.history = [{ provider: 'cloud', id: interviewId, title: 'Frontend · проверка темы', createdAt: 1789113600000, updatedAt: 1789113600000, completed: true, questionCount: 5 }]
  await openRenderer(page, snapshot, true)
  const assistant = await context.newPage()
  await assistant.setViewportSize({ width: 510, height: 900 })
  await openRenderer(assistant, snapshot)
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  const backgrounds: string[] = []
  for (const [id, label] of [['light-blue', 'Светлая голубая'], ['midnight', 'Полночь'], ['dark-blue', 'Тёмная синяя']]) {
    await page.getByRole('radio', { name: label, exact: true }).check()
    await expect(assistant.locator('html')).toHaveAttribute('data-theme', id!)
    await expect(assistant.locator('.markdown-answer pre')).toContainText('useMemo')
    await expect(assistant.getByText('Запись получена не полностью — проверьте вопрос.')).toBeVisible()
    backgrounds.push(await assistant.locator('.overlay-shell').evaluate(element => getComputedStyle(element).backgroundImage))
    await assistant.screenshot({ path: `test-results/theme-${id}-overlay.png`, animations: 'disabled' })
    await assistant.getByRole('button', { name: 'История', exact: true }).click()
    await expect(assistant.getByText('Frontend · проверка темы', { exact: true })).toBeVisible()
    await assistant.screenshot({ path: `test-results/theme-${id}-history.png`, animations: 'disabled' })
    await assistant.getByRole('button', { name: 'Помощник', exact: true }).click()
  }
  expect(new Set(backgrounds).size).toBe(3)
  expect(await getCommands(page)).toEqual([])
  expect(await getCommands(assistant)).toEqual([])
})

test('changing or resetting draft settings preserves the independently selected theme', async ({ page, context }) => {
  await openRenderer(page, initialSnapshot(), true)
  await page.getByLabel('Заменить токен').fill('synthetic-theme-token')
  await page.getByRole('button', { name: 'Мой контекст', exact: true }).click()
  await page.getByLabel('Ваш опыт и резюме').fill('Несохранённый контекст для проверки темы.')
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  const opacity = page.getByRole('slider', { name: 'Непрозрачность окна' })
  await opacity.focus()
  await page.keyboard.press('Home')
  await page.getByRole('radio', { name: 'Светлая голубая' }).check()
  const otherSettings = await context.newPage()
  await openRenderer(otherSettings, initialSnapshot(), true)
  await otherSettings.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  await otherSettings.getByRole('radio', { name: 'Полночь' }).check()
  await expect(page.getByRole('radio', { name: 'Полночь' })).toBeChecked()
  await expect(opacity).toHaveValue('35')
  await page.getByRole('button', { name: 'Мой контекст', exact: true }).click()
  await expect(page.getByLabel('Ваш опыт и резюме')).toHaveValue('Несохранённый контекст для проверки темы.')
  await page.getByRole('button', { name: 'Подключение', exact: true }).click()
  await expect(page.getByLabel('Заменить токен')).toHaveValue('synthetic-theme-token')
  expect(await getCommands(page)).toEqual([])
  await page.getByRole('button', { name: 'Сбросить изменения', exact: true }).click()
  await expect(page.getByLabel('Заменить токен')).toHaveValue('')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Полночь' })).toBeChecked()
  await expect(opacity).toHaveValue(String(Math.round(DEFAULT_SETTINGS.opacity * 100)))
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
})

test('invalid, removed and cleared stored themes fall back to the default', async ({ page, context }) => {
  await openRenderer(page, initialSnapshot(), true)
  await page.evaluate(() => localStorage.setItem('work-search.theme', 'unknown-theme'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark-blue')
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Тёмная синяя' })).toBeChecked()
  const other = await context.newPage()
  await openRenderer(other, initialSnapshot())
  for (const operation of ['invalid', 'remove', 'clear'] as const) {
    await page.getByRole('radio', { name: 'Светлая голубая' }).check()
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'light-blue')
    await other.evaluate(value => {
      if (value === 'invalid') localStorage.setItem('work-search.theme', 'unknown-theme')
      if (value === 'remove') localStorage.removeItem('work-search.theme')
      if (value === 'clear') localStorage.clear()
    }, operation)
    await expect(page.getByRole('radio', { name: 'Тёмная синяя' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark-blue')
  }
})

test('unavailable storage reads keep the settings usable with the default theme', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Synthetic denied read', 'SecurityError') }
  })
  await openRenderer(page, initialSnapshot(), true)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark-blue')
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Тёмная синяя' })).toBeChecked()
  await page.getByRole('radio', { name: 'Светлая голубая' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-blue')
  expect(errors).toEqual([])
})

test('failed theme persistence applies locally and reports the failure without saving settings', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Synthetic full storage', 'QuotaExceededError') }
  })
  await openRenderer(page, initialSnapshot(), true)
  await page.getByRole('button', { name: 'Внешний вид', exact: true }).click()
  await page.getByRole('radio', { name: 'Светлая голубая' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-blue')
  await expect(page.getByRole('status').filter({ hasText: 'сохранить выбор не удалось' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
  expect(await getCommands(page)).toEqual([])
  expect(errors).toEqual([])
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark-blue')
})
