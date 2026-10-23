import type { AudioSource } from '../../domain/types'

export const CAPTURE_PORT_CHANNEL = 'capture:port'
export type CaptureCommand =
  | { type: 'arm'; recordingId: string; sources: AudioSource[]; microphoneId: string }
  | { type: 'stop' | 'cancel'; recordingId: string }
  | { type: 'devices'; requestId: string }
export type CaptureMessage =
  | { type: 'ready' }
  | { type: 'armed' | 'started'; recordingId: string }
  | { type: 'pcm'; recordingId: string; source: AudioSource; sequence: number; offsetMs: number; pcm: ArrayBuffer; level: number }
  | { type: 'stopped'; recordingId: string; partial: boolean; error?: string; cancelled?: boolean }
  | { type: 'error'; recordingId: string; error: string }
  | { type: 'devices'; requestId: string; devices: Array<{ id: string; label: string }> }
