import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Release scripts are standalone JavaScript, executed by Node/builder.
import beforePack, { checkReleaseResources, checkRuntimeResources, checkNotices, sha256, whisperFiles, archiveSha256, whisperVersion, requiredNotices } from '../scripts/check-release-resources.mjs'

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'work-search-release-'))
  directories.push(path)
  return path
}
function json(path: string, data: unknown) { writeFileSync(path, JSON.stringify(data)) }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('release payload gates', () => {
  it('rejects a missing VC++ runtime even when a manifest is present', () => {
    const path = directory()
    json(join(path, 'manifest.json'), { publisher: 'Microsoft Corporation', version: '14.test', sha256: sha256('runtime') })
    const verify = vi.fn()
    expect(() => checkRuntimeResources(path, verify)).toThrow()
    expect(verify).not.toHaveBeenCalled()
  })

  it('rejects a changed runtime before Authenticode and propagates signature failure', () => {
    const path = directory()
    json(join(path, 'manifest.json'), { publisher: 'Microsoft Corporation', version: '14.test', sha256: sha256('runtime') })
    writeFileSync(join(path, 'vc_redist.x64.exe'), 'changed')
    const verify = vi.fn(() => { throw new Error('Invalid signature') })
    expect(() => checkRuntimeResources(path, verify)).toThrow('SHA256 mismatch')
    expect(verify).not.toHaveBeenCalled()
    writeFileSync(join(path, 'vc_redist.x64.exe'), 'runtime')
    expect(() => checkRuntimeResources(path, verify)).toThrow('Invalid signature')
  })

  it('requires valid Microsoft publisher metadata before accepting runtime', () => {
    const path = directory()
    json(join(path, 'manifest.json'), { publisher: 'Other', version: '14.test', sha256: sha256('runtime') })
    writeFileSync(join(path, 'vc_redist.x64.exe'), 'runtime')
    const verify = vi.fn()
    expect(() => checkRuntimeResources(path, verify)).toThrow('publisher/version')
    expect(verify).not.toHaveBeenCalled()
    json(join(path, 'manifest.json'), { publisher: 'Microsoft Corporation', version: '14.test', sha256: sha256('runtime') })
    expect(checkRuntimeResources(path, verify)).toBe('14.test')
    expect(verify).toHaveBeenCalledWith(join(path, 'vc_redist.x64.exe'))
  })

  it('rejects a rewritten Whisper manifest and corrupted pinned EXE without needing a model', () => {
    const path = directory()
    mkdirSync(join(path, 'whisper'))
    const manifest = { version: whisperVersion, archiveSha256, files: { ...whisperFiles, 'whisper-server.exe': sha256('fake') } }
    json(join(path, 'whisper/manifest.json'), manifest)
    writeFileSync(join(path, 'whisper/whisper-server.exe'), 'fake')
    expect(() => checkReleaseResources(path)).toThrow('Whisper manifest hash mismatch')
    json(join(path, 'whisper/manifest.json'), { ...manifest, files: whisperFiles })
    expect(() => checkReleaseResources(path)).toThrow('Resource SHA256 mismatch')
  })

  it('blocks direct builder calls with unsupported targets', async () => {
    await expect(beforePack({ electronPlatformName: 'linux', arch: 1 })).rejects.toThrow('Windows x64')
    await expect(beforePack({ electronPlatformName: 'win32', arch: 3 })).rejects.toThrow('Windows x64')
  })

  it('requires licenses in packaged resources and detects tampering', () => {
    const path = directory()
    const names: string[] = requiredNotices
    const files = Object.fromEntries(names.map(name => { writeFileSync(join(path, name), name); return [name, sha256(name)] }))
    json(join(path, 'manifest.json'), { schema: 1, files })
    expect(() => checkNotices(path)).not.toThrow()
    writeFileSync(join(path, 'npm-NOTICES.txt'), 'truncated')
    expect(() => checkNotices(path)).toThrow('SHA256 mismatch')
    delete files['whisper-LICENSE']
    json(join(path, 'manifest.json'), { schema: 1, files })
    expect(() => checkNotices(path)).toThrow('Missing packaged notice')
  })

  it('blocks notices generated from a different lockfile before packaging', () => {
    const path = directory()
    const project = directory()
    const names: string[] = requiredNotices
    const files = Object.fromEntries(names.map(name => { writeFileSync(join(path, name), name); return [name, sha256(name)] }))
    writeFileSync(join(project, 'package.json'), '{}')
    writeFileSync(join(project, 'pnpm-lock.yaml'), 'changed lock')
    json(join(path, 'manifest.json'), { schema: 1, files, inputs: { 'package.json': sha256('{}'), 'pnpm-lock.yaml': sha256('old lock') } })
    expect(() => checkNotices(path, project)).toThrow('Stale third-party notices: pnpm-lock.yaml')
  })

  it.each(['whisper-model-LICENSE', 'whisper-model-SOURCE.md', 'whisper-Apache-2.0-LICENSE'])('rejects a package missing %s even if other notices are intact', (missing) => {
    const path = directory()
    const names: string[] = requiredNotices
    const files = Object.fromEntries(names.filter(name => name !== missing).map(name => {
      writeFileSync(join(path, name), name)
      return [name, sha256(name)]
    }))
    json(join(path, 'manifest.json'), { schema: 1, files })
    expect(() => checkNotices(path)).toThrow(`Missing packaged notice: ${missing}`)
  })
})

