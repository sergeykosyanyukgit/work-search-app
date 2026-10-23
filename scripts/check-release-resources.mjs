import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const whisperVersion = 'v1.9.2'
export const archiveSha256 = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
export const whisperFiles = {
  "whisper-server.exe": "9e581a4a2b7bd5aec0993f5794fea3d65af2d7f5921cf51c2a4e4b5a3a464d89",
  "whisper.dll": "792fc523c7ad16e6b9c348e30ad5e5f591165cbcf6a80ca8d0db02a38ce3eea2",
  "ggml.dll": "894c6237ee7849843213906a2b6a0b371aaa6234048d465f206d910ae846fafb",
  "ggml-base.dll": "1482359d921b4c1b183d49db1d770f9b5e90d86a618b8b648d4845c2471ad6b0",
  "ggml-cpu-alderlake.dll": "d1c5411561361f7ce71ff8455ecf01f666f581b0608fa91a1dfe7d3fd6a25bd1",
  "ggml-cpu-cannonlake.dll": "2ef36f05fa252ff4fdcb8d42ebce1ceba4f3d3de12b93bed15bdee6237dccd63",
  "ggml-cpu-cascadelake.dll": "505899aaf3f99c5d714361640f561458ea97f8a09eb0614568a66bead2115cb0",
  "ggml-cpu-haswell.dll": "f8cf2f35a06498d783d77fde42004dd54d2f8236b0d42ac323b94bba65a603c4",
  "ggml-cpu-icelake.dll": "78ad143ee2e674d037b4840ef33b5748a0659762a26e0ae2b621c4f9451cbde8",
  "ggml-cpu-sandybridge.dll": "ee47db7dc40fb30eca73e62a05306059c2c3c42aecddf2e8d6ad7e530069b815",
  "ggml-cpu-skylakex.dll": "164e2793897944a43ee071ce6c0b09018088bdf4dd8b14ac0755c58849cf8c50",
  "ggml-cpu-sse42.dll": "7318a9a3b95a85b2453c437b274412bbbae89e5ecdf5babb19b99edc06ded063",
  "ggml-cpu-x64.dll": "af0f1c2f28ff9e3f472481dd969907bda85fa39d4fde17617d4bb0b389301b60"
}
export const whisperLicenseSha256 = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
export const sha256 = data => createHash('sha256').update(data).digest('hex')
export const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

function assertHash(path, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || sha256(readFileSync(path)) !== expected) throw new Error(`Resource SHA256 mismatch: ${path}`)
}

export function verifyMicrosoftSignature(path) {
  if (process.platform !== 'win32') throw new Error('VC++ Authenticode verification requires Windows')
  // The file path is passed as an environment value, never interpolated as PowerShell code.
  // A pwsh parent can export PSModulePath pointing at incompatible PowerShell 7 modules.
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:WORK_SEARCH_VERIFY_RUNTIME; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'Invalid Microsoft Authenticode signature' }"], {
    env: { ...process.env, WORK_SEARCH_VERIFY_RUNTIME: resolve(path) }, stdio: 'pipe'
  })
}

export function checkReleaseResources(resourceRoot, { verifySignature = verifyMicrosoftSignature } = {}) {
  const whisper = join(resourceRoot, 'whisper')
  const manifest = readJson(join(whisper, 'manifest.json'))
  if (manifest.version !== whisperVersion || manifest.archiveSha256 !== archiveSha256) throw new Error('Whisper manifest is not the pinned release')
  if (JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(Object.keys(whisperFiles).sort())) throw new Error('Whisper manifest file set mismatch')
  for (const [name, hash] of Object.entries(whisperFiles)) {
    if (manifest.files[name] !== hash) throw new Error(`Whisper manifest hash mismatch: ${name}`)
    assertHash(join(whisper, name), hash)
  }
  const actual = readdirSync(whisper).filter(name => /\.(exe|dll)$/i.test(name)).sort()
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(whisperFiles).sort())) throw new Error('Unexpected Whisper binary payload')
  assertHash(join(whisper, 'LICENSE'), whisperLicenseSha256)
  return { whisper: manifest.version, runtime: checkRuntimeResources(join(resourceRoot, 'vcredist'), verifySignature) }
}

export function checkRuntimeResources(runtime, verifySignature = verifyMicrosoftSignature) {
  const vc = readJson(join(runtime, 'manifest.json'))
  if (vc.publisher !== 'Microsoft Corporation' || typeof vc.version !== 'string' || !vc.version.trim()) throw new Error('VC++ manifest has no Microsoft publisher/version')
  const executable = join(runtime, 'vc_redist.x64.exe')
  assertHash(executable, vc.sha256)
  verifySignature(executable)
  return vc.version
}

export const requiredNotices = [
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'npm-NOTICES.txt', 'electron-LICENSE', 'LICENSES.chromium.html',
  'whisper-LICENSE', 'whisper-SOURCE.md', 'whisper-httplib-LICENSE', 'whisper-json-LICENSE',
  'whisper-json-NOTICE', 'whisper-Apache-2.0-LICENSE', 'whisper-llamafile-LICENSE', 'whisper-stb_vorbis-LICENSE',
  'whisper-model-LICENSE', 'whisper-model-SOURCE.md'
]

export function checkNotices(directory, projectRoot) {
  const index = readJson(join(directory, 'manifest.json'))
  if (index.schema !== 1 || !index.files || Object.keys(index.files).length < 5) throw new Error('Missing third-party notices manifest')
  for (const name of requiredNotices) {
    if (!index.files[name]) throw new Error(`Missing packaged notice: ${name}`)
  }
  for (const [name, hash] of Object.entries(index.files)) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Invalid notice filename')
    assertHash(join(directory, name), hash)
    if (!statSync(join(directory, name)).size) throw new Error(`Empty notice: ${name}`)
  }
  if (projectRoot) {
    for (const name of ['package.json', 'pnpm-lock.yaml', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      if (index.inputs?.[name] !== sha256(readFileSync(join(projectRoot, name)))) throw new Error(`Stale third-party notices: ${name}; regenerate notices`)
    }
    for (const [name, hash] of Object.entries(index.inputs ?? {})) {
      if (name.startsWith('licenses/')) {
        if (!/^licenses\/(?:whisper-v1\.9\.2|whisper-model)\/[\w.-]+$/.test(name)) throw new Error('Invalid notice input path')
        assertHash(join(projectRoot, name), hash)
      }
    }
    const electronVersion = readJson(join(projectRoot, 'node_modules/electron/package.json')).version
    if (index.electron !== electronVersion) throw new Error('Stale Electron notices')
    assertHash(join(projectRoot, 'node_modules/electron/dist/LICENSE'), index.files['electron-LICENSE'])
    assertHash(join(projectRoot, 'node_modules/electron/dist/LICENSES.chromium.html'), index.files['LICENSES.chromium.html'])
  }
}

// electron-builder beforePack hook: also guards callers bypassing package scripts.
export default async function beforePack(context) {
  if (context.electronPlatformName !== 'win32' || context.arch !== 1) throw new Error('Only Windows x64 release payload is supported')
  const root = context.packager.projectDir
  checkReleaseResources(join(root, 'resources'))
  checkNotices(join(root, '.cache/release-notices'), root)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? 'resources')
  console.log(JSON.stringify(checkReleaseResources(root)))
  checkNotices(resolve('.cache/release-notices'), resolve('.'))
}

