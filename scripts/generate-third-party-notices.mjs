import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, readJson } from './check-release-resources.mjs'

function locatePackage(name, parent) {
  const require = createRequire(join(parent, 'package.json'))
  let candidate
  try { candidate = require.resolve(`${name}/package.json`) } catch { candidate = require.resolve(name) }
  let directory = dirname(candidate)
  while (dirname(directory) !== directory) {
    if (existsSync(join(directory, 'package.json')) && readJson(join(directory, 'package.json')).name === name) return realpathSync(directory)
    directory = dirname(directory)
  }
  throw new Error(`Cannot locate installed package ${name}`)
}

function licenseFiles(directory, prefix = '', depth = 0) {
  const result = []
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const relative = join(prefix, name)
    const path = join(directory, relative)
    if (statSync(path).isDirectory()) {
      if (depth < 2) result.push(...licenseFiles(directory, relative, depth + 1))
    } else if (/^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(name)) {
      result.push({ name: relative.replaceAll('\\', '/'), text: readFileSync(path, 'utf8') })
    }
  }
  return result
}

export function generateNotices(root = resolve('.')) {
  const visited = new Set()
  const packages = []
  function visit(name, parent, optional = false) {
    let directory
    try { directory = locatePackage(name, parent) } catch (error) { if (optional) return; throw error }
    if (visited.has(directory)) return
    visited.add(directory)
    const pkg = readJson(join(directory, 'package.json'))
    const files = licenseFiles(directory)
    if (!files.length) throw new Error(`No LICENSE/NOTICE found for ${pkg.name}@${pkg.version}; review its distribution terms before packaging`)
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, files })
    for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) visit(dependency, directory, dependency in (pkg.optionalDependencies ?? {}))
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {}).sort()) visit(dependency, directory, true)
  }
  const pkg = readJson(join(root, 'package.json'))
  for (const name of Object.keys(pkg.dependencies).sort()) visit(name, root)
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
  const target = join(root, '.cache/release-notices')
  mkdirSync(target, { recursive: true })
  const contents = {
    'LICENSE': readFileSync(join(root, 'LICENSE')),
    'THIRD_PARTY_NOTICES.md': readFileSync(join(root, 'THIRD_PARTY_NOTICES.md')),
    'whisper-LICENSE': readFileSync(join(root, 'licenses/whisper-v1.9.2/LICENSE')),
    'electron-LICENSE': readFileSync(join(root, 'node_modules/electron/dist/LICENSE')),
    'LICENSES.chromium.html': readFileSync(join(root, 'node_modules/electron/dist/LICENSES.chromium.html')),
    'npm-NOTICES.txt': Buffer.from(packages.map(pkg => `${pkg.name}@${pkg.version}\nDeclared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\n${pkg.files.map(file => `--- ${file.name} ---\n${file.text}`).join('\n')}\n`).join('\n========================================\n\n'))
  }
  const index = { schema: 1, electron: readJson(join(root, 'node_modules/electron/package.json')).version, inputs: {}, files: {}, packages: packages.map(({ name, version, license }) => ({ name, version, license })) }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) index.inputs[name] = sha256(readFileSync(join(root, name)))
  for (const [directory, prefix] of [['whisper-v1.9.2', 'whisper'], ['whisper-model', 'whisper-model']]) {
    for (const name of readdirSync(join(root, 'licenses', directory)).sort()) {
      const relative = `licenses/${directory}/${name}`
      const content = readFileSync(join(root, relative))
      contents[`${prefix}-${name}`] = content
      index.inputs[relative] = sha256(content)
    }
  }
  for (const [name, content] of Object.entries(contents)) {
    writeFileSync(join(target, name), content)
    index.files[name] = sha256(content)
  }
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(index, null, 2)}\n`)
  console.log(`Generated notices for ${packages.length} production packages + Electron/Chromium + Whisper/ggml`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateNotices()
