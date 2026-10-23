import { z } from 'zod'
import type { AppSnapshot, Settings } from '../domain/types'

export const SettingsSchema = z.object({
  provider: z.enum(['cloud', 'local']),
  localCodex: z.object({ executablePath: z.string().max(4096), model: z.string().trim().min(1).max(150) }).strict(),
  serviceUrl: z.string().url().refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) }, 'Требуется HTTPS либо локальный HTTP'),
  profileSlug: z.string().min(1).max(100), microphoneId: z.string().max(512),
  sources: z.array(z.enum(['microphone', 'system'])).min(1).max(2).refine(a => new Set(a).size === a.length),
  recordHotkey: z.string().min(1).max(100), visibilityHotkey: z.string().min(1).max(100), mouseHotkey: z.string().min(1).max(100),
  opacity: z.number().min(0.35).max(1), fontSize: z.number().int().min(12).max(26), language: z.enum(['auto', 'ru', 'en']),
  profile: z.object({ resume: z.string().max(32000), vacancy: z.string().max(16000), instructions: z.string().max(8000), responseStyle: z.enum(['brief', 'detailed']) }).strict(),
  bounds: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(360).max(2000), height: z.number().int().min(300).max(2000) }).strict().optional()
}).strict()
export const DesktopCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }).strict(),
  z.object({ type: z.literal('interview.new'), title: z.string().max(150).optional() }).strict(),
  z.object({ type: z.literal('interview.resume'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('interview.finish') }).strict(),
  z.object({ type: z.literal('interview.delete'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('record.toggle') }).strict(),
  z.object({ type: z.literal('question.cancel'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('question.submit'), text: z.string().trim().min(1).max(32000), revisionOf: z.string().uuid().optional() }).strict(),
  z.object({ type: z.literal('settings.save'), settings: SettingsSchema, token: z.string().max(512).optional() }).strict(),
  z.object({ type: z.literal('settings.open') }).strict(),
  z.object({ type: z.literal('token.clear') }).strict(),
  z.object({ type: z.literal('connection.test') }).strict(),
  z.object({ type: z.literal('connection.recover') }).strict(),
  z.object({ type: z.literal('codex.select') }).strict(),
  z.object({ type: z.literal('model.download') }).strict(),
  z.object({ type: z.literal('model.import') }).strict(),
  z.object({ type: z.literal('overlay.hide') }).strict(),
  z.object({ type: z.literal('overlay.show') }).strict(),
  z.object({ type: z.literal('overlay.mouse') }).strict(),
  z.object({ type: z.literal('app.quit') }).strict()
])
export type DesktopCommand = z.infer<typeof DesktopCommandSchema>
export interface CommandResult { ok: boolean; error?: string; executablePath?: string }
export interface DesktopApi {
  snapshot(): Promise<AppSnapshot>
  command(command: DesktopCommand): Promise<CommandResult>
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void
  microphones(): Promise<Array<{ id: string; label: string }>>
}
export type ValidSettings = Settings
declare global { interface Window { desktop: DesktopApi } }
