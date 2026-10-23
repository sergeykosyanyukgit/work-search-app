import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const executable = process.argv[2]
if (!executable) throw new Error('Usage: node scripts/generate-audio-fixtures.mjs PATH_TO_ESPEAK_NG_EXE')
const binary = resolve(executable)
const env = { ...process.env, ESPEAK_DATA_PATH: join(dirname(binary), 'espeak-ng-data') }
const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' })
if (!/1\.52\.0\b/.test(version)) throw new Error('Use eSpeak NG 1.52.0 for these reproducible fixtures')
mkdirSync('.cache', { recursive: true })
const temporary = mkdtempSync(resolve('.cache/audio-fixtures-'))

function pcm16Mono(wav) {
  let format, samples
  for (let offset = 12; offset + 8 <= wav.length;) {
    const length = wav.readUInt32LE(offset + 4)
    const type = wav.toString('ascii', offset, offset + 4)
    if (type === 'fmt ') format = wav.subarray(offset + 8, offset + 8 + length)
    if (type === 'data') samples = wav.subarray(offset + 8, offset + 8 + length)
    offset += 8 + length + (length % 2)
  }
  if (!format || !samples || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt16LE(14) !== 16) throw new Error('Expected mono PCM16 WAV')
  const sourceRate = format.readUInt32LE(4)
  const count = Math.floor(samples.length / 2 * 16000 / sourceRate)
  const result = Buffer.alloc(44 + count * 2)
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22)
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34)
  result.write('data', 36); result.writeUInt32LE(count * 2, 40)
  for (let index = 0; index < count; index++) {
    const position = index * sourceRate / 16000
    const left = Math.floor(position), fraction = position - left
    const first = samples.readInt16LE(left * 2)
    const second = samples.readInt16LE(Math.min(left + 1, samples.length / 2 - 1) * 2)
    result.writeInt16LE(Math.round(first + (second - first) * fraction), 44 + index * 2)
  }
  return result
}

for (const [name, voice] of [['en-question', 'en-us'], ['ru-question', 'ru']]) {
  const text = resolve(`tests/audio-fixtures/${name}.txt`)
  const output = join(temporary, `${name}.wav`)
  // Built-in formant voices only: no MBROLA, SAPI, microphone or audio playback.
  execFileSync(binary, ['-v', voice, '-s', '130', '-g', '5', '-b', '1', '-f', text, '-w', output], { env, stdio: 'pipe' })
  const wav = pcm16Mono(readFileSync(output))
  writeFileSync(`tests/audio-fixtures/${name}.wav`, wav)
  console.log(`${name}.wav: ${wav.length} bytes, mono PCM16 16 kHz, eSpeak NG 1.52.0 ${voice}`)
}
