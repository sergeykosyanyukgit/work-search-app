import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStore, type StringCipher } from '../src/adapters/storage/sqlite-store'
import Database from 'better-sqlite3'
import { DEFAULT_SETTINGS, type Interview, type Question } from '../src/domain/types'

const key = randomBytes(32)
const cipher: StringCipher = {
  encrypt(text) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]) },
  decrypt(data) { const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8') }
}
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('encrypted SQLite storage', () => {
  it('migrates v1 cloud settings, sessions and pending commands atomically without changing tokens/cursors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'work-search-migration-')); dirs.push(dir); const path = join(dir, 'test.sqlite')
    const seed = new SqliteStore(path, cipher)
    const i: Interview = { ...DEFAULT_SETTINGS, id: 'legacy', title: 'Legacy interview', createdAt: 1, updatedAt: 2, completed: false, remote: { sessionId: 'preserved-session', openRequestId: 'immutable-open', lastSequence: 123, contextSent: true } }
    seed.saveInterview(i); seed.saveSettings(DEFAULT_SETTINGS); seed.setToken('preserved-secret')
    seed.savePending({ id: 'same-command-id', interviewId: i.id, command: { type: 'turn.start', clientRequestId: 'same-command-id', payload: { text: 'immutable' } }, createdAt: 1 })
    seed.close()
    const legacy = new Database(path)
    for (const table of ['settings', 'interviews', 'pending_commands']) {
      for (const row of legacy.prepare(`SELECT rowid AS row, payload FROM ${table}`).all() as Array<{ row: number; payload: Buffer }>) {
        const data = JSON.parse(cipher.decrypt(row.payload)); delete data.provider; delete data.localCodex
        legacy.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`).run(cipher.encrypt(JSON.stringify(data)), row.row)
      }
    }
    legacy.pragma('user_version = 1'); legacy.close()
    const migrated = new SqliteStore(path, cipher)
    expect(migrated.getSettings()).toMatchObject({ provider: 'cloud', localCodex: DEFAULT_SETTINGS.localCodex })
    expect(migrated.getInterview(i.id)).toMatchObject({ provider: 'cloud', remote: i.remote })
    expect(migrated.getToken()).toBe('preserved-secret')
    expect(migrated.listPending(i.id)[0]).toMatchObject({ provider: 'cloud', id: 'same-command-id', command: { payload: { text: 'immutable' } } })
    migrated.close()
    const reopened = new SqliteStore(path, cipher); expect(reopened.getInterview(i.id)?.remote.lastSequence).toBe(123); reopened.close()
  })
  it('persists history and pending delivery atomically without plaintext on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'work-search-test-')); dirs.push(dir); const path = join(dir, 'test.sqlite')
    let store = new SqliteStore(path, cipher)
    const i: Interview = { provider: 'cloud', localCodex: structuredClone(DEFAULT_SETTINGS.localCodex), id: 'interview', title: 'PRIVATE_TITLE_489', createdAt: 0, updatedAt: 1, profile: DEFAULT_SETTINGS.profile, serviceUrl: DEFAULT_SETTINGS.serviceUrl, profileSlug: 'interview-assistant', remote: { openRequestId: 'open', lastSequence: 0, contextSent: false }, completed: false }
    const q: Question = { id: 'question', interviewId: i.id, order: 1, createdAt: 0, status: 'queued', text: 'PRIVATE_QUESTION_721', answer: '', segments: [], partial: false }
    store.transaction(() => { store.saveInterview(i); store.saveQuestion(q); store.savePending({ id: 'command', interviewId: i.id, questionId: q.id, command: { text: q.text }, createdAt: 0 }); store.setToken('cm_live_PRIVATE_TOKEN_937') })
    expect(() => store.transaction(() => { store.saveQuestion({ ...q, answer: 'rolled back' }); throw new Error('fail') })).toThrow('fail')
    expect(store.listQuestions(i.id)[0]!.answer).toBe('')
    store.close()
    const bytes = readFileSync(path).toString('utf8')
    for (const secret of [i.title, q.text, 'cm_live_PRIVATE_TOKEN_937']) expect(bytes).not.toContain(secret)
    store = new SqliteStore(path, cipher)
    expect(store.getToken()).toBe('cm_live_PRIVATE_TOKEN_937'); expect(store.listPending(i.id)).toHaveLength(1)
    expect(store.listInterviews()[0]!.questionCount).toBe(1)
    store.deleteInterview(i.id); expect(store.listPending(i.id)).toHaveLength(0); expect(store.listQuestions(i.id)).toHaveLength(0)
    store.close()
  })
  it('does not store plaintext when encryption fails', () => {
    const store = new SqliteStore(':memory:', { encrypt() { throw new Error('encryption unavailable') }, decrypt: () => '' })
    expect(() => store.setToken('secret')).toThrow('encryption unavailable')
    expect(store.getToken()).toBeUndefined(); store.close()
  })
})
