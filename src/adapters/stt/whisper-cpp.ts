import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SttPort } from '../../domain/ports'
import type { CapturedTrack, Settings, SttState, TranscriptSegment } from '../../domain/types'
import { encodeWav, MAX_PCM_BYTES, pcmLevel } from '../audio/pcm'
import { SMALL_MODEL, WHISPER_FILES } from './resources'
import { parseWhisperResponse } from './whisper-response'

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function availablePort(): Promise<number> {
  const probe = createServer()
  return new Promise<number>((resolvePort, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') { probe.close(); reject(new Error('Не удалось выбрать локальный порт')); return }
      probe.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

export class WhisperCppAdapter implements SttPort {
  private state: SttState = { status: 'missing' }
  private listeners = new Set<(state: SttState) => void>()
  private process?: ChildProcess
  private baseUrl?: string
  private preparing?: Promise<void>
  private modelOperation?: Promise<void>
  private operationAbort?: AbortController
  private transcriptionAbort?: AbortController
  private transcribing = false
  private disposed = false
  private readonly modelPath: string
  private binaryVerified = false
  private modelVerified?: { size: number; mtimeMs: number }

  constructor(private readonly options: { binaryDirectory: string; modelDirectory: string }) {
    this.modelPath = join(options.modelDirectory, SMALL_MODEL.name)
  }

  getState(): SttState { return { ...this.state } }
  onState(listener: (state: SttState) => void): void { this.listeners.add(listener); listener(this.getState()) }
  private update(state: SttState): void { this.state = state; for (const listener of this.listeners) listener(this.getState()) }

  async prepare(): Promise<void> {
    if (this.disposed) throw new Error('Распознавание завершено')
    if (this.process && this.baseUrl && this.process.exitCode === null) return
    if (this.preparing) return this.preparing
    this.preparing = this.prepareProcess()
    try { await this.preparing } finally { this.preparing = undefined }
  }

  private async prepareProcess(): Promise<void> {
    this.update({ status: 'loading', message: 'Подготовка локального распознавания…' })
    try {
      if (!this.binaryVerified) {
        await Promise.all(Object.entries(WHISPER_FILES).map(async ([name, digest]) => {
          const path = join(this.options.binaryDirectory, name)
          if (await sha256(path).catch(() => '') !== digest) throw new Error(`Локальный движок отсутствует или повреждён (${name}). Переустановите приложение.`)
        }))
        this.binaryVerified = true
      }
      const model = await stat(this.modelPath).catch(() => undefined)
      if (!model) { this.update({ status: 'missing', message: 'Скачайте или выберите модель Whisper small в настройках.' }); return }
      if (model.size !== this.modelVerified?.size || model.mtimeMs !== this.modelVerified?.mtimeMs) {
        if (model.size !== SMALL_MODEL.size || await sha256(this.modelPath) !== SMALL_MODEL.sha256) throw new Error('Модель повреждена. Скачайте Whisper small заново.')
        this.modelVerified = { size: model.size, mtimeMs: model.mtimeMs }
      }
      if (this.disposed) return
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await this.launch(); this.update({ status: 'ready' }); return }
        catch (error) { await this.stopProcess(); if (attempt === 2) throw error }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update({ status: 'error', message })
      throw error
    }
  }

  private async launch(): Promise<void> {
    const port = await availablePort()
    const prefix = `/${randomBytes(16).toString('hex')}`
    const url = `http://127.0.0.1:${port}${prefix}`
    const parallelism = availableParallelism()
    // On larger CPUs, eight threads reduced measured small-model latency by ~27%.
    // Leave four logical CPUs for capture/video calls; preserve the old cap on small hosts.
    const threads = Math.max(1, parallelism > 8 ? Math.min(8, parallelism - 4) : Math.min(4, parallelism))
    const child = spawn(join(this.options.binaryDirectory, 'whisper-server.exe'), [
      '--host', '127.0.0.1', '--port', String(port), '--request-path', prefix,
      '--public', join(this.options.binaryDirectory, 'no-public-content'),
      '-m', this.modelPath, '-ng', '-t', String(threads), '-l', 'auto', '-nlp'
    ], { cwd: this.options.binaryDirectory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child
    let startupError: Error | undefined
    // Discard native stdout: it can include recognized speech; no transcript enters logs.
    child.stdout?.resume()
    child.stderr?.resume()
    child.once('error', error => { startupError = error })
    child.once('exit', () => {
      if (this.process !== child) return
      this.process = undefined; this.baseUrl = undefined
      if (!this.disposed && this.state.status !== 'loading') {
        this.update({ status: 'error', message: 'Локальный движок остановился. Перезапуск…' })
        if (!this.transcribing) void this.prepare().catch(() => undefined)
      }
    })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (this.disposed || startupError || child.exitCode !== null || this.process !== child) throw startupError ?? new Error('Не удалось запустить локальный движок. Проверьте Microsoft Visual C++ Runtime.')
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
        if (response.ok && (await response.json() as { status?: unknown }).status === 'ok') { this.baseUrl = url; return }
      } catch { /* The upstream process loads the model before opening its listening socket. */ }
      await delay(150)
    }
    throw new Error('Модель не загрузилась за 60 секунд')
  }

  async transcribe(track: CapturedTrack, language: Settings['language'], signal: AbortSignal): Promise<TranscriptSegment[]> {
    if (this.transcribing || this.modelOperation) throw new Error('Локальное распознавание занято')
    this.transcribing = true
    try { return await this.transcribeTrack(track, language, signal) }
    finally { this.transcribing = false }
  }

  private async transcribeTrack(track: CapturedTrack, language: Settings['language'], signal: AbortSignal): Promise<TranscriptSegment[]> {
    signal.throwIfAborted()
    if (track.sampleRate !== 16000 || track.pcm.byteLength > MAX_PCM_BYTES || track.pcm.byteLength % 2 || !Number.isFinite(track.offsetMs) || track.offsetMs < 0) throw new Error('Некорректный формат записи')
    if (!['auto', 'ru', 'en'].includes(language)) throw new Error('Неподдерживаемый язык распознавания')
    // Skip digital silence and sub-250 ms clicks before invoking a generative speech model.
    if (track.pcm.byteLength < 8000 || pcmLevel(track.pcm) < 0.0003) return []
    await this.prepare()
    signal.throwIfAborted()
    if (!this.baseUrl || !this.process) throw new Error(this.state.message ?? 'Модель распознавания ещё не готова')
    const controller = new AbortController()
    this.transcriptionAbort = controller
    const timeout = AbortSignal.timeout(300_000)
    const combined = AbortSignal.any([signal, controller.signal, timeout])
    this.update({ status: 'processing', message: track.source === 'system' ? 'Распознавание системного звука…' : 'Распознавание микрофона…' })
    try {
      const wav = encodeWav(track.pcm)
      const form = new FormData()
      form.set('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), `${track.source}.wav`)
      form.set('language', language); form.set('response_format', 'verbose_json')
      form.set('token_timestamps', 'false'); form.set('no_language_probabilities', 'true')
      form.set('temperature', '0.0'); form.set('no_speech_thold', '0.6')
      const response = await fetch(`${this.baseUrl}/inference`, { method: 'POST', body: form, signal: combined })
      if (!response.ok) throw new Error(`Ошибка локального распознавания (${response.status})`)
      const content = await response.text()
      if (content.length > 4_000_000) throw new Error('Ответ распознавания слишком большой')
      const segments = parseWhisperResponse(JSON.parse(content) as unknown, track)
      combined.throwIfAborted()
      this.update({ status: 'ready' })
      return segments
    } catch (error) {
      if (combined.aborted) {
        // Termination ensures the model mutex is free even if native abort stalls.
        await this.stopProcess()
        this.update({ status: 'loading', message: 'Перезапуск распознавания после отмены…' })
        if (!this.disposed) void this.prepare().catch(() => undefined)
        if (signal.aborted) throw signal.reason
        if (this.disposed) throw new Error('Приложение закрывается')
        if (timeout.aborted) { this.update({ status: 'error', message: 'Распознавание превысило пять минут' }); throw new Error('Распознавание превысило пять минут') }
      } else {
        this.update({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        await this.stopProcess()
        if (!this.disposed) void this.prepare().catch(() => undefined)
      }
      throw error
    } finally { if (this.transcriptionAbort === controller) this.transcriptionAbort = undefined }
  }

  async downloadModel(): Promise<void> {
    return this.withModelOperation(async signal => {
      const part = join(this.options.modelDirectory, `.${SMALL_MODEL.name}.${randomUUID()}.part`)
      await mkdir(this.options.modelDirectory, { recursive: true })
      try {
        const response = await fetch(SMALL_MODEL.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) })
        if (!response.ok || !response.body) throw new Error(`Не удалось скачать модель (${response.status})`)
        const file = await open(part, 'wx')
        let total = 0
        let reportedAt = 0
        const hash = createHash('sha256')
        const reader = response.body.getReader()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            const chunk = next.value
            signal.throwIfAborted()
            total += chunk.byteLength
            if (total > SMALL_MODEL.size) throw new Error('Размер загружаемой модели не совпадает с ожидаемым')
            hash.update(chunk)
            let written = 0
            while (written < chunk.byteLength) written += (await file.write(chunk, written)).bytesWritten
            if (Date.now() - reportedAt > 150) { this.update({ status: 'loading', message: 'Скачивание модели Whisper small…', progress: total / SMALL_MODEL.size }); reportedAt = Date.now() }
          }
          await file.sync()
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close() }
        if (total !== SMALL_MODEL.size || hash.digest('hex') !== SMALL_MODEL.sha256) throw new Error('Контрольная сумма модели не совпадает. Повторите загрузку.')
        await rename(part, this.modelPath)
      } finally { await rm(part, { force: true }).catch(() => undefined) }
    })
  }

  async importModel(path: string): Promise<void> {
    return this.withModelOperation(async signal => {
      const source = await stat(path)
      if (!source.isFile() || source.size !== SMALL_MODEL.size) throw new Error('Выберите исходную многоязычную модель ggml-small.bin (487 601 967 байт)')
      await mkdir(this.options.modelDirectory, { recursive: true })
      const part = join(this.options.modelDirectory, `.${SMALL_MODEL.name}.${randomUUID()}.part`)
      try {
        if (resolve(path) === resolve(this.modelPath)) {
          if (await sha256(path) !== SMALL_MODEL.sha256) throw new Error('Контрольная сумма модели не совпадает')
          return
        }
        await copyFile(path, part)
        signal.throwIfAborted()
        if (await sha256(part) !== SMALL_MODEL.sha256) throw new Error('Это не исходная модель Whisper small или файл повреждён')
        signal.throwIfAborted()
        await rename(part, this.modelPath)
      } finally { await rm(part, { force: true }).catch(() => undefined) }
    })
  }

  private async withModelOperation(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) throw new Error('Распознавание завершено')
    if (this.transcribing) throw new Error('Дождитесь завершения распознавания')
    if (this.modelOperation) throw new Error('Модель уже загружается')
    const controller = new AbortController()
    this.operationAbort = controller
    this.modelOperation = (async () => {
      try {
        if (this.preparing) await this.preparing.catch(() => undefined)
        await this.stopProcess()
        this.update({ status: 'loading', message: 'Проверка модели…', progress: 0 })
        await action(controller.signal)
        this.modelVerified = undefined
        await this.prepare()
      } catch (error) {
        this.update({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        throw error
      }
    })()
    try { await this.modelOperation } finally { this.modelOperation = undefined; this.operationAbort = undefined }
  }

  private async stopProcess(): Promise<void> {
    const child = this.process
    this.process = undefined; this.baseUrl = undefined
    if (!child || child.exitCode !== null) return
    await new Promise<void>(resolveStop => {
      const timer = setTimeout(resolveStop, 2000)
      child.once('exit', () => { clearTimeout(timer); resolveStop() })
      child.kill()
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.operationAbort?.abort(); this.transcriptionAbort?.abort()
    await this.stopProcess()
    await this.modelOperation?.catch(() => undefined)
    await this.preparing?.catch(() => undefined)
    this.listeners.clear()
  }
}
