import { expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ files: new Set<string>(), execute: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: async (path: string) => { if (!fixture.files.has(path)) throw new Error('missing'); return { isFile: () => true, mtimeMs: 1 } }, readdir: async () => [{ name: 'new-build-hash', isDirectory: () => true }] }))
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: async (...args: unknown[]) => { fixture.execute(...args); return { stdout: 'codex-cli 0.154.0-alpha.6.2\n', stderr: '' } } }) }))
import { discoverCodex } from '../src/adapters/ai/codex-discovery'

it('finds the native executable in changing install directories even without Codex on PATH', async () => {
  const path = 'C:\\AppData\\OpenAI\\Codex\\bin\\new-build-hash\\codex.exe'
  fixture.files.add(path)
  expect(await discoverCodex('', { PATH: '', LOCALAPPDATA: 'C:\\AppData' })).toMatchObject({ executablePath: path, version: '0.154.0-alpha.6.2' })
})
it('passes a path with spaces directly without a shell and rejects shims', async () => {
  const path = 'C:\\Codex with spaces\\codex.exe'; fixture.files.add(path)
  await discoverCodex(path)
  expect(fixture.execute).toHaveBeenLastCalledWith(path, ['--version'], expect.objectContaining({ windowsHide: true, timeout: 8000 }))
  await expect(discoverCodex('C:\\Codex with spaces\\codex.cmd')).rejects.toThrow('нативный')
  await expect(discoverCodex('codex.exe')).rejects.toThrow('нативный')
})
