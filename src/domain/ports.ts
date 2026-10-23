import type { AiReadiness, AudioSource, CaptureResult, CapturedTrack, ConnectionStatus, Interview, InterviewSummary, PendingCommand, Question, RemoteSession, Settings, SttState, TranscriptSegment } from './types'

export interface AudioCapturePort {
  start(recordingId: string, options: { sources: AudioSource[]; microphoneId: string }): Promise<void>
  stop(): Promise<CaptureResult>
  cancel(): Promise<void>
  onLevels(listener: (levels: Record<AudioSource, number>) => void): void
  onStopped(listener: (result: CaptureResult) => void): void
  dispose(): Promise<void>
}
export interface SttPort {
  prepare(): Promise<void>
  transcribe(track: CapturedTrack, language: Settings['language'], signal: AbortSignal): Promise<TranscriptSegment[]>
  getState(): SttState
  onState(listener: (state: SttState) => void): void
  downloadModel(): Promise<void>
  importModel(path: string): Promise<void>
  dispose(): Promise<void>
}
export interface AiSessionCallbacks {
  onConnection(status: ConnectionStatus, message?: string): void
  onRemote(remote: RemoteSession): void
  onPartial(questionId: string, answer: string, turnId?: string): void
}
export interface AiAnswer { text: string; turnId: string }
export interface AiSessionPort {
  connect(interview: Interview, callbacks: AiSessionCallbacks, options?: { allowRecreate?: boolean }): Promise<void>
  probe(settings: Settings): Promise<AiReadiness>
  send(question: Question, text: string, signal: AbortSignal): Promise<AiAnswer>
  cancel(): Promise<void>
  close(): Promise<void>
  disconnect(): void
  dispose?(): Promise<void>
}
export interface InterviewRepository {
  saveInterview(interview: Interview): void
  getInterview(id: string): Interview | undefined
  listInterviews(): InterviewSummary[]
  saveQuestion(question: Question): void
  listQuestions(interviewId: string): Question[]
  deleteInterview(id: string): void
  savePending(command: PendingCommand): void
  listPending(interviewId: string): PendingCommand[]
  deletePending(id: string): void
  transaction<T>(action: () => T): T
}
export interface SettingsRepository { getSettings(): Settings; saveSettings(settings: Settings): void }
export interface SecretStore { getToken(): string | undefined; setToken(token: string): void; clearToken(): void }
