import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { AlertCircle, Check, LoaderCircle, X } from 'lucide-react'
import type { ConnectionStatus, QuestionStatus, SttState } from '../domain/types'

export const questionLabels: Record<QuestionStatus, string> = {
  recording: 'Идёт запись', transcribing: 'Распознаём речь', review: 'Проверьте вопрос', queued: 'В очереди',
  generating: 'Готовим ответ', completed: 'Ответ готов', failed: 'Ошибка', cancelled: 'Отменён', interrupted: 'Прерван'
}
export const connectionLabels: Record<ConnectionStatus, string> = {
  disconnected: 'Не подключено', connecting: 'Подключение', recovering: 'Восстанавливаем связь', ready: 'Сервис подключён', error: 'Ошибка подключения'
}
export const modelLabels: Record<SttState['status'], string> = {
  missing: 'Модель не установлена', loading: 'Подготовка модели', ready: 'Модель готова', processing: 'Распознаём речь', error: 'Модель недоступна'
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" {...props} className={`icon-button ${className}`} aria-label={label} title={label}>{children}</button>
}

export function ConnectionBadge({ status, compact = false }: { status: ConnectionStatus; compact?: boolean }) {
  return <span className={`connection-badge connection-${status}`} title={connectionLabels[status]}><span className="status-dot" />{!compact && <span>{connectionLabels[status]}</span>}</span>
}

export function StatusBadge({ status }: { status: QuestionStatus }) {
  return <span className={`question-status status-${status}`}>{['transcribing', 'generating'].includes(status) ? <LoaderCircle className="spin" size={12} /> : status === 'completed' ? <Check size={12} /> : <span className="status-dot" />}{questionLabels[status]}</span>
}

export function Notice({ message, onClose, kind = 'error' }: { message: string; onClose?: () => void; kind?: 'error' | 'info' | 'success' }) {
  return <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}><span className="notice-icon">{kind === 'success' ? <Check size={15} /> : <AlertCircle size={15} />}</span><span>{message}</span>{onClose && <IconButton label="Закрыть уведомление" onClick={onClose}><X size={13} /></IconButton>}</div>
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p></div>
}

export function timeLabel(ms: number) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function shortDate(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

export function hotkeyLabel(hotkey: string) {
  return hotkey.replaceAll('CommandOrControl', 'Ctrl').replaceAll('Control', 'Ctrl').replaceAll('Space', 'Пробел').split('+').join(' + ')
}
