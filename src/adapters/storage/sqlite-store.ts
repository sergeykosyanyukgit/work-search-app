import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, type Interview, type InterviewSummary, type PendingCommand, type Question, type Settings } from '../../domain/types'
import type { InterviewRepository, SecretStore, SettingsRepository } from '../../domain/ports'
import { SettingsSchema } from '../../shared/ipc'

export interface StringCipher { encrypt(text: string): Buffer; decrypt(data: Buffer): string }
type EncryptedRow = { payload: Buffer }

export class SqliteStore implements InterviewRepository, SettingsRepository, SecretStore {
  private readonly db: Database.Database
  constructor(path: string, private readonly cipher: StringCipher) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 2) { this.db.close(); throw new Error('База создана более новой версией приложения.') }
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), payload BLOB NOT NULL);
        CREATE TABLE secrets (id TEXT PRIMARY KEY, payload BLOB NOT NULL);
        CREATE TABLE interviews (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload BLOB NOT NULL);
        CREATE TABLE questions (id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE, sort_order INTEGER NOT NULL, payload BLOB NOT NULL);
        CREATE INDEX questions_interview_order ON questions(interview_id, sort_order);
        CREATE TABLE pending_commands (id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE, payload BLOB NOT NULL);
        PRAGMA user_version = 1;
      `)
    })()
    if (version < 2) {
      try { this.db.transaction(() => {
        const settings = this.db.prepare('SELECT payload FROM settings WHERE id=1').get() as EncryptedRow | undefined
        if (settings) this.saveSettings({ ...this.decode<Settings>(settings), provider: 'cloud', localCodex: structuredClone(DEFAULT_SETTINGS.localCodex) })
        for (const row of this.db.prepare('SELECT payload FROM interviews').all() as EncryptedRow[]) {
          this.saveInterview({ ...this.decode<Interview>(row), provider: 'cloud', localCodex: structuredClone(DEFAULT_SETTINGS.localCodex) })
        }
        for (const row of this.db.prepare('SELECT payload FROM pending_commands').all() as EncryptedRow[]) {
          this.savePending({ ...this.decode<PendingCommand>(row), provider: 'cloud' })
        }
        this.db.pragma('user_version = 2')
      })() } catch (error) { this.db.close(); throw error }
    }
  }
  private encode(value: unknown): Buffer { return this.cipher.encrypt(JSON.stringify(value)) }
  private decode<T>(row: EncryptedRow): T { return JSON.parse(this.cipher.decrypt(row.payload)) as T }
  transaction<T>(action: () => T): T { return this.db.transaction(action)() }
  saveInterview(interview: Interview): void {
    this.db.prepare('INSERT INTO interviews(id,updated_at,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload').run(interview.id, interview.updatedAt, this.encode(interview))
  }
  getInterview(id: string): Interview | undefined {
    const row = this.db.prepare('SELECT payload FROM interviews WHERE id=?').get(id) as EncryptedRow | undefined
    return row && this.decode<Interview>(row)
  }
  listInterviews(): InterviewSummary[] {
    const rows = this.db.prepare('SELECT payload, (SELECT count(*) FROM questions WHERE interview_id=interviews.id) AS count FROM interviews ORDER BY updated_at DESC').all() as Array<EncryptedRow & { count: number }>
    return rows.map(row => { const i = this.decode<Interview>(row); return { provider: i.provider, id: i.id, title: i.title, createdAt: i.createdAt, updatedAt: i.updatedAt, completed: i.completed, questionCount: row.count } })
  }
  saveQuestion(question: Question): void {
    this.db.prepare('INSERT INTO questions(id,interview_id,sort_order,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(question.id, question.interviewId, question.order, this.encode(question))
  }
  listQuestions(interviewId: string): Question[] {
    const rows = this.db.prepare('SELECT payload FROM questions WHERE interview_id=? ORDER BY sort_order').all(interviewId) as EncryptedRow[]
    return rows.map(row => this.decode<Question>(row))
  }
  deleteInterview(id: string): void { this.db.prepare('DELETE FROM interviews WHERE id=?').run(id) }
  savePending(command: PendingCommand): void {
    this.db.prepare('INSERT INTO pending_commands(id,interview_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(command.id, command.interviewId, this.encode(command))
  }
  listPending(interviewId: string): PendingCommand[] {
    return (this.db.prepare('SELECT payload FROM pending_commands WHERE interview_id=?').all(interviewId) as EncryptedRow[]).map(row => this.decode<PendingCommand>(row))
  }
  deletePending(id: string): void { this.db.prepare('DELETE FROM pending_commands WHERE id=?').run(id) }
  getSettings(): Settings {
    const row = this.db.prepare('SELECT payload FROM settings WHERE id=1').get() as EncryptedRow | undefined
    return row ? SettingsSchema.parse(this.decode(row)) : structuredClone(DEFAULT_SETTINGS)
  }
  saveSettings(settings: Settings): void {
    this.db.prepare('INSERT INTO settings(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(this.encode(SettingsSchema.parse(settings)))
  }
  getToken(): string | undefined {
    const row = this.db.prepare("SELECT payload FROM secrets WHERE id='client-token'").get() as EncryptedRow | undefined
    return row ? this.cipher.decrypt(row.payload) : undefined
  }
  setToken(token: string): void {
    this.db.prepare("INSERT INTO secrets(id,payload) VALUES('client-token',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(this.cipher.encrypt(token))
  }
  clearToken(): void { this.db.prepare("DELETE FROM secrets WHERE id='client-token'").run() }
  close(): void { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.close() }
}
