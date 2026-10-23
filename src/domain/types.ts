export type AudioSource = 'microphone' | 'system'
export type QuestionStatus = 'recording' | 'transcribing' | 'review' | 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type ConnectionStatus = 'disconnected' | 'connecting' | 'recovering' | 'ready' | 'error'
export interface TranscriptSegment { source: AudioSource; startMs: number; endMs: number; text: string }
export interface CapturedTrack { source: AudioSource; pcm: Uint8Array; sampleRate: 16000; offsetMs: number }
export interface CaptureResult { recordingId: string; tracks: CapturedTrack[]; partial: boolean; error?: string }
export interface Profile { resume: string; vacancy: string; instructions: string; responseStyle: 'brief' | 'detailed' }
export type AiProvider = 'cloud' | 'local'
export interface LocalCodexConfig { executablePath: string; model: string }
export interface AiReadiness {
  provider: AiProvider; status: 'unchecked' | 'checking' | 'ready' | 'error'; message?: string
  executablePath?: string; version?: string; authenticated?: boolean
  models?: Array<{ id: string; label: string; supportsLow: boolean }>
}
export interface Settings {
  provider: AiProvider; localCodex: LocalCodexConfig
  serviceUrl: string; profileSlug: string; microphoneId: string; sources: AudioSource[]
  recordHotkey: string; visibilityHotkey: string; mouseHotkey: string
  opacity: number; fontSize: number; language: 'auto' | 'ru' | 'en'; profile: Profile
  bounds?: { x: number; y: number; width: number; height: number }
}
export interface RemoteSession {
  sessionId?: string; openRequestId: string; lastSequence: number; contextSent: boolean
  threadId?: string; cliVersion?: string
  deliveryUncertain?: boolean
}
export interface Interview {
  provider: AiProvider; localCodex: LocalCodexConfig
  id: string; title: string; createdAt: number; updatedAt: number; profile: Profile
  serviceUrl: string; profileSlug: string; remote: RemoteSession; completed: boolean
}
export interface Question {
  id: string; interviewId: string; order: number; revisionOf?: string; createdAt: number
  status: QuestionStatus; segments: TranscriptSegment[]; text: string; answer: string
  partial: boolean; error?: string; turnId?: string; durationMs?: number
  latency?: QuestionLatency
}
/** Local elapsed times; firstAnswer/total start after stop-recording or manual submit. */
export interface QuestionLatency {
  sttMs?: number; queueMs?: number; connectionMs?: number
  aiFirstAnswerMs?: number; aiTotalMs?: number; firstAnswerMs?: number; totalMs?: number
}
export interface DiagnosticEvent {
  provider?: AiProvider; model?: string; cliVersion?: string
  operation: 'capture' | 'stt' | 'ai'; result: 'completed' | 'failed' | 'cancelled'
  durationMs: number; questionId: string; latency?: QuestionLatency
}
export interface PendingCommand { provider?: AiProvider; id: string; interviewId: string; questionId?: string; sessionId?: string; command: unknown; createdAt: number }
export interface InterviewSummary { provider: AiProvider; id: string; title: string; createdAt: number; updatedAt: number; completed: boolean; questionCount: number }
export interface SttState { status: 'missing' | 'loading' | 'ready' | 'processing' | 'error'; message?: string; progress?: number }
export interface AppSnapshot {
  aiReadiness: AiReadiness
  settings: Settings; hasToken: boolean; interview?: Interview; questions: Question[]; history: InterviewSummary[]
  capture: 'idle' | 'starting' | 'recording' | 'stopping'; recordingStartedAt?: number
  levels: Record<AudioSource, number>; connection: ConnectionStatus; stt: SttState
  mousePassthrough: boolean; notice?: string; shortcutErrors?: string[]
}
export const DEFAULT_SETTINGS: Settings = {
  provider: 'cloud', localCodex: { executablePath: '', model: 'gpt-5.6-sol' },
  serviceUrl: 'https://api.code-manager.ru', profileSlug: 'interview-assistant', microphoneId: '',
  sources: ['microphone', 'system'], recordHotkey: 'Ctrl+Alt+Space', visibilityHotkey: 'Ctrl+Alt+H',
  mouseHotkey: 'Ctrl+Alt+M', opacity: 0.95, fontSize: 15, language: 'auto',
  profile: { resume: '', vacancy: '', instructions: '', responseStyle: 'brief' }
}
export const MAX_OUTSTANDING = 3
export const MAX_RECORDING_MS = 120_000
export const TERMINAL_STATUSES: QuestionStatus[] = ['completed', 'failed', 'cancelled', 'interrupted', 'review']
