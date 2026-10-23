import { expect, it, vi } from 'vitest'
import { AiProviderRouter } from '../src/adapters/ai/provider-router'
import type { AiSessionPort } from '../src/domain/ports'
import { DEFAULT_SETTINGS, type Interview } from '../src/domain/types'

function port(): AiSessionPort {
  return { connect: vi.fn(async () => {}), probe: vi.fn(async settings => ({ provider: settings.provider, status: 'ready' as const })), send: vi.fn(async () => ({ text: 'answer', turnId: 'turn' })), close: vi.fn(async () => {}), cancel: vi.fn(async () => {}), disconnect: vi.fn(), dispose: vi.fn(async () => {}) }
}
it('routes by the frozen interview provider while probes use the saved settings provider', async () => {
  const cloud = port(), local = port(), router = new AiProviderRouter(cloud, local)
  const interview: Interview = { ...DEFAULT_SETTINGS, provider: 'local', id: 'interview', title: '', createdAt: 0, updatedAt: 0, remote: { openRequestId: '', lastSequence: 0, contextSent: false }, completed: false }
  await router.connect(interview, { onConnection: () => {}, onRemote: () => {}, onPartial: () => {} })
  await router.probe(DEFAULT_SETTINGS)
  expect(local.connect).toHaveBeenCalledTimes(1)
  expect(cloud.connect).not.toHaveBeenCalled()
  expect(cloud.probe).toHaveBeenCalledTimes(1)
  expect(local.disconnect).not.toHaveBeenCalled()
  await router.dispose()
  expect(local.dispose).toHaveBeenCalled(); expect(cloud.dispose).toHaveBeenCalled()
})
