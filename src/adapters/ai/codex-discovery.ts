import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, basename } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export async function discoverCodex(manual: string, env: NodeJS.ProcessEnv = process.env): Promise<{ executablePath: string; version: string }> {
  const candidates = manual ? [manual] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(path => join(path.replace(/^"|"$/g, ''), 'codex.exe'))
  if (!manual) {
    const root = join(env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')
    const builds = await readdir(root, { withFileTypes: true }).catch(() => [])
    const installed = await Promise.all(builds.filter(row => row.isDirectory()).map(async row => {
      const path = join(root, row.name, 'codex.exe')
      return { path, modified: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 }
    }))
    candidates.push(...installed.sort((a, b) => b.modified - a.modified).map(row => row.path))
    for (const base of [env.APPDATA && join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Codex')].filter((row): row is string => !!row)) {
      candidates.push(join(base, 'codex.exe'), join(base, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'), join(base, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'))
    }
  }
  for (const executablePath of [...new Set(candidates)]) {
    if (!isAbsolute(executablePath) || basename(executablePath).toLowerCase() !== 'codex.exe' || !(await stat(executablePath).catch(() => undefined))?.isFile()) continue
    try {
      const { stdout } = await execute(executablePath, ['--version'], { windowsHide: true, timeout: 8000, maxBuffer: 4096 })
      const version = /^codex-cli ([\w.+-]+)\s*$/.exec(stdout.trim())?.[1]
      if (version) return { executablePath, version }
    } catch { /* Try the next installation; never invoke a shell shim. */ }
  }
  throw new Error(manual ? 'Не удалось запустить выбранный codex.exe. Выберите нативный Windows CLI.' : 'Codex не найден. Установите Codex для Windows или выберите codex.exe вручную.')
}
