import type { InterviewRepository, SecretStore, SettingsRepository } from '../../src/domain/ports'
import { DEFAULT_SETTINGS, type Interview, type PendingCommand, type Question, type Settings } from '../../src/domain/types'

export class MemoryStore implements InterviewRepository, SecretStore, SettingsRepository {
  interviews = new Map<string, Interview>()
  questions = new Map<string, Question>()
  pending = new Map<string, PendingCommand>()
  settings = structuredClone(DEFAULT_SETTINGS)
  token?: string
  getSettings() { return structuredClone(this.settings) }
  saveSettings(value: Settings) { this.settings = structuredClone(value) }
  getToken() { return this.token }
  setToken(value: string) { this.token = value }
  clearToken() { this.token = undefined }
  getInterview(id: string) { const row = this.interviews.get(id); return row && structuredClone(row) }
  saveInterview(row: Interview) { this.interviews.set(row.id, structuredClone(row)) }
  listInterviews() { return [...this.interviews.values()].map(row => ({ ...row, questionCount: this.listQuestions(row.id).length })) }
  deleteInterview(id: string) { this.interviews.delete(id) }
  listQuestions(id: string) { return [...this.questions.values()].filter(row => row.interviewId === id).map(row => structuredClone(row)) }
  saveQuestion(row: Question) { this.questions.set(row.id, structuredClone(row)) }
  listPending(id: string) { return [...this.pending.values()].filter(row => row.interviewId === id).map(row => structuredClone(row)) }
  savePending(row: PendingCommand) { this.pending.set(row.id, structuredClone(row)) }
  deletePending(id: string) { this.pending.delete(id) }
  transaction<T>(action: () => T): T { return action() }
}
