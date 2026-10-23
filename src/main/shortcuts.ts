import type { Settings } from '../domain/types'

const modifierAliases: Record<string, string> = {
  ctrl: 'Control', control: 'Control', commandorcontrol: 'Control', cmdorctrl: 'Control',
  alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super',
  command: 'Command', cmd: 'Command', altgr: 'AltGr'
}
const modifierOrder = ['Control', 'Alt', 'Shift', 'Super', 'Command', 'AltGr']
const keyNames = ['Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert',
  'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
  'PrintScreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv', ...Array.from({ length: 10 }, (_, i) => `num${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)]
const keyAliases = new Map(keyNames.map(key => [key.toLowerCase(), key]))
keyAliases.set('esc', 'Escape'); keyAliases.set('spacebar', 'Space'); keyAliases.set('пробел', 'Space')
// Electron accepts Return and Enter for the same physical key on Windows.
keyAliases.set('return', 'Enter')

export function normalizeShortcut(accelerator: string): string {
  const parts = accelerator.split('+').map(part => part.trim())
  const modifiers = new Set<string>()
  let key: string | undefined
  for (const part of parts) {
    if (!part) throw new Error('Укажите сочетание в формате Ctrl+Alt+Space. Для клавиши «+» используйте Plus.')
    const modifier = Object.hasOwn(modifierAliases, part.toLowerCase()) ? modifierAliases[part.toLowerCase()] : undefined
    if (modifier) { modifiers.add(modifier); continue }
    if (key) throw new Error(`В сочетании «${accelerator}» должна быть одна основная клавиша.`)
    key = keyAliases.get(part.toLowerCase()) ?? (/^[a-z0-9]$/i.test(part) ? part.toUpperCase() : part)
  }
  if (!key) throw new Error(`Добавьте основную клавишу в сочетание «${accelerator}».`)
  return [...modifierOrder.filter(modifier => modifiers.has(modifier)), key].join('+')
}

export function normalizeShortcutSettings(settings: Settings): Settings {
  const normalized = { ...settings, recordHotkey: normalizeShortcut(settings.recordHotkey),
    visibilityHotkey: normalizeShortcut(settings.visibilityHotkey), mouseHotkey: normalizeShortcut(settings.mouseHotkey) }
  if (new Set([normalized.recordHotkey, normalized.visibilityHotkey, normalized.mouseHotkey]).size !== 3) {
    throw new Error('Для записи, показа и мыши нужны разные сочетания клавиш.')
  }
  return normalized
}
