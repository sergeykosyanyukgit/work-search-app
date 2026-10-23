import type { CapturedTrack, TranscriptSegment } from '../../domain/types'

export function parseWhisperResponse(value: unknown, track: CapturedTrack): TranscriptSegment[] {
  if (!value || typeof value !== 'object' || typeof (value as { text?: unknown }).text !== 'string') throw new Error('Некорректный ответ локального распознавания')
  const response = value as { text: string; segments?: unknown }
  if (!Array.isArray(response.segments)) throw new Error('Распознавание не вернуло временные метки')
  const durationMs = track.pcm.byteLength / 32
  const segments: TranscriptSegment[] = []
  for (const item of response.segments) {
    if (!item || typeof item !== 'object') throw new Error('Некорректный сегмент распознавания')
    const segment = item as { text?: unknown; start?: unknown; end?: unknown }
    if (typeof segment.text !== 'string' || typeof segment.start !== 'number' || typeof segment.end !== 'number' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start) throw new Error('Некорректные временные метки распознавания')
    const text = segment.text.replace(/\[\s*(?:BLANK_AUDIO|SILENCE|NO_SPEECH)\s*\]/gi, '').trim()
    if (!text) continue
    const startMs = Math.round(Math.max(0, Math.min(durationMs, segment.start * 1000)))
    const endMs = Math.round(Math.max(startMs, Math.min(durationMs, segment.end * 1000)))
    segments.push({ source: track.source, startMs: track.offsetMs + startMs, endMs: track.offsetMs + endMs, text })
  }
  return segments.sort((a, b) => a.startMs - b.startMs)
}
