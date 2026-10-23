import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join, resolve } from 'node:path'

// Read-only diagnostic. Run from the project root. No child processes or network.
const root = resolve('.')
let packageJson
try {
  packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (packageJson.name !== 'work-search-app') throw new Error('wrong-project')
} catch {
  console.error('Run this command from the work-search-app repository root.')
  process.exit(2)
}

const [major, minor] = process.versions.node.split('.').map(Number)
const hasFile = relative => {
  try { return statSync(join(root, relative)).isFile() } catch { return false }
}
const pathEntries = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
const pnpmNames = process.platform === 'win32' ? ['pnpm.exe', 'pnpm.cmd', 'pnpm.ps1'] : ['pnpm']
const pnpmOnPath = pathEntries.some(entry => pnpmNames.some(name => {
  try { return statSync(join(entry.replace(/^"|"$/g, ''), name)).isFile() } catch { return false }
}))
const requireProject = createRequire(join(root, 'package.json'))
const packages = {}
for (const name of ['typescript', 'vitest', '@playwright/test', 'electron', 'electron-vite', 'electron-builder']) {
  try { requireProject.resolve(name); packages[name] = true } catch { packages[name] = false }
}

let sqlite
let db
try {
  const Database = requireProject('better-sqlite3')
  db = new Database(':memory:')
  const value = db.prepare('SELECT 1 AS value').get().value
  sqlite = { nodeLoad: value === 1 ? 'ok' : 'failed', errorCode: null }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'LOAD_FAILED'
  sqlite = { nodeLoad: 'failed', errorCode: code }
} finally {
  db?.close()
}

const report = {
  project: packageJson.name,
  version: packageJson.version,
  node: { version: process.versions.node, abi: process.versions.modules, supported: major > 22 || (major === 22 && minor >= 12) },
  packageManager: { expected: packageJson.packageManager, pnpmOnPath, versionExecuted: false },
  packages,
  sqlite,
  artifactsPresent: {
    main: hasFile('out/main/index.js'),
    preload: hasFile('out/preload/index.cjs'),
    capturePreload: hasFile('out/preload/capture.cjs'),
    renderer: hasFile('out/renderer/renderer/index.html'),
    captureRenderer: hasFile('out/renderer/capture/index.html'),
    packagedExecutable: hasFile('release/win-unpacked/Work Search.exe'),
    whisperDirectory: existsSync(join(root, 'resources/whisper')),
    vcRuntimeDirectory: existsSync(join(root, 'resources/vcredist')),
  },
  inheritedOptIns: {
    liveLocalCodex: process.env.RUN_LOCAL_CODEX === '1',
    whisperBinaryConfigured: Boolean(process.env.WHISPER_TEST_BINARY_DIRECTORY),
    whisperModelConfigured: Boolean(process.env.WHISPER_TEST_MODEL_DIRECTORY),
    captureModelConfigured: Boolean(process.env.WORK_SEARCH_TEST_MODEL),
    nativeHotkeys: process.env.WORK_SEARCH_TEST_NATIVE_HOTKEYS === '1',
    packagedElectronE2e: process.env.WORK_SEARCH_TEST_PACKAGED === '1',
    chromiumExecutableConfigured: Boolean(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE),
  },
  limitations: [
    'File presence does not prove build freshness, resource hashes or a usable Chromium runtime.',
    'A failed Node SQLite load does not prove that the module is ready for Electron.',
    'No pnpm version, Electron process, live provider, microphone or user database was accessed.',
  ],
}
console.log(JSON.stringify(report, null, 2))
