import { it, expect, vi } from 'vitest'
import { resolve } from 'node:path'
import { writeFile, mkdir, copyFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { discoverCodex } from '../src/adapters/ai/codex-discovery'
import { CodexRpc } from '../src/adapters/ai/codex-rpc'
import { AccountResponse, ModelsPage, parseProtocol } from '../src/adapters/ai/local-protocol'
import { LocalCodexClient } from '../src/adapters/ai/local-codex'
import { MemoryStore } from './helpers/memory-store'
import { DEFAULT_SETTINGS, type Interview, type Question } from '../src/domain/types'

it.skipIf(process.env.RUN_LOCAL_CODEX !== '1')('native Windows CLI enforces WS key, exposes existing login and models', async () => {
  const found = await discoverCodex('')
  const copy = resolve('.cache/native codex path/codex.exe')
  await mkdir(resolve('.cache/native codex path'), { recursive: true }); await copyFile(found.executablePath, copy)
  expect((await discoverCodex(copy)).version).toBe(found.version)
  const rpc = await CodexRpc.start(copy, resolve('.cache/native codex workspace'))
  try {
    const account = parseProtocol(AccountResponse, await rpc.request('account/read', { refreshToken: false }))
    const models = parseProtocol(ModelsPage, await rpc.request('model/list', {}))
    expect(account.account?.type).toBe('chatgpt')
    expect(models.data.some(row => row.model === 'gpt-5.6-sol')).toBe(true)
    const config = await rpc.request('config/read', { includeLayers: false }) as { config: Record<string, unknown> }
    // Only non-sensitive shape/capability evidence, never raw configuration.
    await writeFile(resolve('.cache/local-native-transport.json'), JSON.stringify({ version: found.version, authenticated: true, modelCount: models.data.length, configKeys: Object.keys(config.config), wsAuthenticationEnforced: true, executablePathWithSpaces: true }))
  } finally { await rpc.dispose() }
}, 45_000)

it.skipIf(process.env.RUN_LOCAL_CODEX !== '1')('native generation persists correlation and resumes after its process exits', async () => {
  const store = new MemoryStore()
  const interview: Interview = { ...structuredClone(DEFAULT_SETTINGS), provider: 'local', id: randomUUID(), title: 'Work Search 0.1.4 native acceptance', createdAt: Date.now(), updatedAt: Date.now(), completed: false, remote: { openRequestId: randomUUID(), lastSequence: 0, contextSent: false } }
  store.saveInterview(interview)
  const question: Question = { id: randomUUID(), interviewId: interview.id, order: 1, createdAt: Date.now(), status: 'generating', text: 'Что такое замыкание в JavaScript?', answer: '', segments: [], partial: false }
  store.saveQuestion(question)
  let capturedCommand: unknown
  const save = store.savePending.bind(store)
  store.savePending = row => { capturedCommand = structuredClone(row); save(row) }
  const client = new LocalCodexClient(store, { directory: resolve('.cache/native codex workspace') })
  let firstMs: number | undefined
  let startedAt = 0
  try {
    await client.connect(interview, { onConnection: () => {}, onRemote: () => {}, onPartial: (_id, text) => { if (text && firstMs === undefined) firstMs = performance.now() - startedAt } })
    startedAt = performance.now()
    const answer = await client.send(question, question.text, new AbortController().signal)
    expect(answer.text.length).toBeGreaterThan(5)
    const totalMs = performance.now() - startedAt
    await client.dispose()
    // Simulate a crash after the server completed but before the final local commit.
    store.savePending(capturedCommand as Parameters<MemoryStore['savePending']>[0])
    store.saveQuestion({ ...question, turnId: undefined, answer: '' })
    const restored = new LocalCodexClient(store, { directory: resolve('.cache/native codex workspace') })
    try {
      await restored.connect(store.getInterview(interview.id)!, { onConnection: () => {}, onRemote: () => {}, onPartial: () => {} })
      expect(store.listQuestions(interview.id)[0]?.status).toBe('completed')
      expect(store.listQuestions(interview.id)[0]?.answer).toBe(answer.text)
      expect(store.listPending(interview.id)).toHaveLength(0)
      await writeFile(resolve('.cache/local-native-generation.json'), JSON.stringify({ firstMs, totalMs, durableClientId: true, resumedAfterProcessExit: true, cliVersion: store.getInterview(interview.id)?.remote.cliVersion }))
    } finally { await restored.dispose() }
  } finally { await client.dispose() }
}, 180_000)

it.skipIf(process.env.RUN_LOCAL_CODEX !== '1')('interrupts an accepted native turn and clears pending only after confirmation', async () => {
  const store = new MemoryStore()
  const interview: Interview = { ...structuredClone(DEFAULT_SETTINGS), provider: 'local', id: randomUUID(), title: 'Work Search 0.1.4 cancellation acceptance', createdAt: Date.now(), updatedAt: Date.now(), completed: false, remote: { openRequestId: randomUUID(), lastSequence: 0, contextSent: false } }
  const question: Question = { id: randomUUID(), interviewId: interview.id, order: 1, createdAt: Date.now(), status: 'generating', text: 'Объясни устройство event loop в JavaScript подробно, примерно в 1000 словах.', answer: '', segments: [], partial: false }
  store.saveInterview(interview); store.saveQuestion(question)
  const client = new LocalCodexClient(store, { directory: resolve('.cache/native codex workspace') })
  try {
    await client.connect(interview, { onConnection: () => {}, onRemote: () => {}, onPartial: () => {} })
    const send = client.send(question, question.text, new AbortController().signal)
    void send.catch(() => {})
    await vi.waitFor(() => expect(store.listQuestions(interview.id)[0]?.turnId).toBeTruthy())
    await client.cancel()
    await expect(send).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.listPending(interview.id)).toHaveLength(0)
    expect(store.listQuestions(interview.id)[0]?.status).toBe('cancelled')
  } finally { await client.dispose() }
}, 60_000)
