import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import WebSocket from 'ws'
import { CodexRpcError, RpcEnvelope, parseProtocol } from './local-protocol'

export interface CodexTransport {
  request(method: string, params: unknown): Promise<unknown>
  onNotification: (method: string, params: unknown) => void
  onDisconnect: () => void
  dispose(): Promise<void>
}
// Per-process overrides; never modify CODEX_HOME, authentication, or config.toml.
export const LOCAL_OVERRIDES: Record<string, unknown> = {
  model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled',
  model_reasoning_effort: 'low', model_reasoning_summary: 'none', service_tier: 'default',
  project_root_markers: [], project_doc_max_bytes: 0,
  'features.skip_host_skill_discovery': true,
  ...Object.fromEntries(['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'code_mode_only', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'goals', 'sleep_tool', 'workspace_dependencies', 'skill_search', 'tool_suggest', 'skill_mcp_dependency_install', 'shell_snapshot'].map(name => [`features.${name}`, false]))
}

export class CodexRpc implements CodexTransport {
  onNotification: CodexTransport['onNotification'] = () => {}
  onDisconnect: () => void = () => {}
  private child?: ChildProcess
  private socket?: WebSocket
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private counter = 0
  private closing = false
  private disposal?: Promise<void>

  static async start(executablePath: string, directory: string, signal?: AbortSignal): Promise<CodexRpc> {
    const rpc = new CodexRpc()
    const abort = () => { void rpc.dispose() }
    signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true })
    try { await rpc.launch(executablePath, directory); signal?.throwIfAborted(); return rpc }
    catch (error) { await rpc.dispose(); throw error }
    finally { signal?.removeEventListener('abort', abort) }
  }
  private async launch(executablePath: string, directory: string): Promise<void> {
    await mkdir(directory, { recursive: true })
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(error => error ? reject(error) : resolve(port)) })
    })
    const key = randomBytes(32).toString('hex')
    const url = `ws://127.0.0.1:${port}`
    const args = ['app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(key).digest('hex')]
    for (const [name, value] of Object.entries(LOCAL_OVERRIDES)) args.push('-c', `${name}=${JSON.stringify(value)}`)
    // An isolated cwd prevents project settings and instructions from being inherited.
    // Strip host thread/remote credentials; existing Codex home authentication is retained.
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (/^CODEX_(THREAD|TURN|REMOTE|INTERNAL|APP_SERVER)/.test(name)) delete env[name]
    if (this.closing) throw new Error('Запуск Codex отменён.')
    this.child = spawn(executablePath, args, { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    // Raw CLI output can contain prompts or credentials: drain it without recording it.
    this.child.stderr?.resume()
    let startupFailed = false
    this.child.on('error', () => { startupFailed = true; this.broken() })
    this.child.on('exit', () => { startupFailed = true; this.broken() })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !startupFailed && !this.closing) {
      try { this.socket = await this.open(url, key); break } catch { await new Promise(done => setTimeout(done, 100)) }
    }
    if (!this.socket) throw new Error('Не удалось запустить локальный WebSocket Codex. Нужен CLI с поддержкой app-server и ws-auth (проверен 0.154.0-alpha.6.2).')
    // Fail closed on CLI versions that accept the flag but do not enforce it on loopback.
    const unauthorized = await this.open(url).catch(() => undefined)
    if (unauthorized) { unauthorized.terminate(); throw new Error('Этот Codex допускает WebSocket без транспортного ключа. Локальное подключение остановлено; выберите совместимый CLI.') }
    this.socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('binary')
        const entry = parseProtocol(RpcEnvelope, JSON.parse(raw.toString()))
        if (entry.method) {
          if (entry.id !== undefined) {
            // No approvals, user prompts or dynamic tool execution may escape this adapter.
            this.socket?.send(JSON.stringify({ id: entry.id, error: { code: -32601, message: 'Interactive requests and tools are disabled in Work Search.' } }))
          } else this.onNotification(entry.method, entry.params)
        } else if (typeof entry.id === 'number') {
          const call = this.pending.get(entry.id)
          if (!call) return
          this.pending.delete(entry.id); clearTimeout(call.timer)
          if (entry.error) call.reject(new CodexRpcError(entry.error.code, entry.error.message))
          else call.resolve(entry.result)
        }
      } catch { this.broken(); this.socket?.terminate() }
    })
    this.socket.on('close', () => this.broken())
    await this.request('initialize', { clientInfo: { name: 'work_search_app', title: 'Work Search', version: '0.1.4' }, capabilities: { experimentalApi: true } })
    this.socket.send(JSON.stringify({ method: 'initialized' }))
  }
  private open(url: string, key?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, handshakeTimeout: 1000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false })
      socket.once('open', () => resolve(socket))
      socket.on('error', () => { socket.terminate(); reject(new Error('WebSocket недоступен')) })
      socket.once('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); reject(new Error('WebSocket отклонён')) })
    })
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closing || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Соединение с локальным Codex потеряно. Продолжите интервью для сверки запроса.'))
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex не подтвердил команду ${method}. Продолжите интервью для сверки результата.`)) }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ id, method, params }), error => { if (error) this.broken() })
    })
  }
  private broken(): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('Соединение с локальным Codex потеряно. Продолжите интервью для сверки запроса.')) }
    this.pending.clear()
    if (!this.closing) this.onDisconnect()
  }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.closing = true; this.broken(); this.socket?.terminate()
      const child = this.child
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const pid = child.pid
        // Only this spawn's live root PID, never image-name based termination.
        if (process.platform === 'win32') await new Promise<void>(resolve => execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolve()))
        else child.kill('SIGTERM')
      }
      this.child = undefined
    })()
  }
}
