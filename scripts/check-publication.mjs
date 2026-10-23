import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })
const history = git('rev-list', '--objects', '--all').toString('utf8').split('\n').filter(Boolean)
const legacyWavBlobs = new Set([
  '3184d372cd2f8b804d3a540c70ec50d927b335d2', // Former JFK sample.
  '39a51d3950903f3d46b52ed0f8f9c9b458009b98' // Former Windows Irina output.
])
for (const entry of history) {
  assert.ok(!legacyWavBlobs.has(entry.split(' ', 1)[0]), 'Legacy WAV remains reachable from a Git ref')
}

const files = git('ls-tree', '-rz', '--name-only', 'HEAD').toString('utf8').split('\0').filter(Boolean)
const expectedWavs = new Map([
  ['tests/audio-fixtures/en-question.wav', 'e821de7ff3cea0e08f718cab836269e00435373db12f643fdbcba1f73e8b0dd3'],
  ['tests/audio-fixtures/ru-question.wav', 'c206d0269d5b5857196edba93eeb01657dd18de8e552374251b60517747af61e']
])
for (const file of files) {
  assert.ok(!/^(?:\.cache|node_modules|out|release|dist|test-results|playwright-report)\//i.test(file), `Private/generated path is tracked: ${file}`)
  assert.ok(!/^resources\/(?:models|whisper|vcredist)\//i.test(file), `Downloaded runtime is tracked: ${file}`)
  assert.ok(!/(?:^|\/)(?:\.env(?:\..+)?|auth\.json)$/i.test(file) || file.endsWith('.env.example'), `Credential file is tracked: ${file}`)
  assert.ok(!/\.(?:sqlite(?:3)?(?:-wal|-shm)?|db|pem|pfx|p12|key|exe|dll)$/i.test(file), `Private/binary payload is tracked: ${file}`)
  if (/\.wav$/i.test(file)) assert.ok(expectedWavs.has(file), `Unreviewed audio is tracked: ${file}`)
}
for (const [file, expected] of expectedWavs) {
  assert.ok(files.includes(file), `Synthetic audio is missing: ${file}`)
  const actual = createHash('sha256').update(git('cat-file', 'blob', `HEAD:${file}`)).digest('hex')
  assert.equal(actual, expected, `Synthetic fixture SHA256 changed: ${file}; review provenance before updating the gate`)
}
console.log(JSON.stringify({ trackedFiles: files.length, refsChecked: 'all', legacyWavsReachable: false, verifiedSyntheticWavs: expectedWavs.size }))
