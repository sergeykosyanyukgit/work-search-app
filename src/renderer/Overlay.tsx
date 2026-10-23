import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import Markdown from 'react-markdown'
import { ArrowUp, AudioLines, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, History, Keyboard, LoaderCircle, MessageSquare, Mic, Monitor, MousePointer2, PencilLine, Plus, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react'
import { MAX_OUTSTANDING, MAX_RECORDING_MS, TERMINAL_STATUSES, type AppSnapshot, type AudioSource, type InterviewSummary, type Question, type QuestionLatency } from '../domain/types'
import type { Commands } from './hooks'
import { useRecordingClock } from './hooks'
import { ConnectionBadge, EmptyState, hotkeyLabel, IconButton, modelLabels, Notice, questionLabels, shortDate, StatusBadge, timeLabel } from './components'

type QuestionDraft = { text: string; editing: boolean }

export function Overlay({ snapshot, actions }: { snapshot: AppSnapshot; actions: Commands }) {
  const [view, setView] = useState<'assistant' | 'history'>('assistant')
  const [selectedId, setSelectedId] = useState<string>()
  const [composerOpen, setComposerOpen] = useState(false)
  const [manualText, setManualText] = useState('')
  const manualRevision = useRef(0)
  // UI drafts outlive the selected question and history panel; no content is persisted to disk.
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, Record<string, QuestionDraft>>>({})
  const [dismissedNotice, setDismissedNotice] = useState<string>()
  const newestId = snapshot.questions.at(-1)?.id
  const outstanding = snapshot.questions.filter(question => !TERMINAL_STATUSES.includes(question.status)).length
  const queueFull = outstanding >= MAX_OUTSTANDING
  const selected = snapshot.questions.find(question => question.id === selectedId) ?? snapshot.questions.at(-1)
  const recording = snapshot.capture === 'recording'
  const transitioning = snapshot.capture === 'starting' || snapshot.capture === 'stopping'
  const elapsed = useRecordingClock(snapshot.recordingStartedAt, snapshot.capture !== 'idle')
  const modelReady = snapshot.stt.status === 'ready' || snapshot.stt.status === 'processing'
  const canStartRecording = modelReady && !queueFull
  const run = actions.run

  useEffect(() => { setSelectedId(newestId) }, [newestId])
  useEffect(() => { setView('assistant') }, [snapshot.interview?.id])
  useEffect(() => {
    const retained = new Set(snapshot.history.map(interview => interview.id))
    if (snapshot.interview) retained.add(snapshot.interview.id)
    setQuestionDrafts(current => Object.keys(current).some(id => !retained.has(id))
      ? Object.fromEntries(Object.entries(current).filter(([id]) => retained.has(id)))
      : current)
  }, [snapshot.history, snapshot.interview?.id])

  async function submitManual(event: FormEvent) {
    event.preventDefault()
    if (!manualText.trim() || queueFull) return
    const revision = manualRevision.current
    if (await run({ type: 'question.submit', text: manualText.trim() }) && manualRevision.current === revision) {
      setManualText(''); setComposerOpen(false)
    }
  }

  async function submitRevision(question: Question, draft: QuestionDraft) {
    if (!draft.text.trim() || queueFull) return
    if (await run({ type: 'question.submit', text: draft.text.trim(), revisionOf: question.id })) {
      setQuestionDrafts(current => current[question.interviewId]?.[question.id] === draft
        ? { ...current, [question.interviewId]: { ...current[question.interviewId], [question.id]: { ...draft, editing: false } } }
        : current)
    }
  }

  return <div className="overlay-shell" style={{ '--reading-size': `${snapshot.settings.fontSize}px` } as CSSProperties}>
    <header className="overlay-titlebar draggable">
      <div className="overlay-session">
        {snapshot.interview && <div className="session-label" title={snapshot.interview.title}><span className={`session-dot ${!snapshot.interview.completed ? 'live' : ''}`} /><span>{snapshot.interview.title}</span></div>}
        <ConnectionBadge status={snapshot.connection} compact />
      </div>
      <div className="window-actions no-drag">
        <IconButton label={snapshot.mousePassthrough ? 'Включить управление мышью' : 'Пропускать клики через окно'} className={snapshot.mousePassthrough ? 'is-active' : ''} onClick={() => void run({ type: 'overlay.mouse' })} disabled={actions.pending.has('overlay.mouse')}><MousePointer2 size={15} /></IconButton>
        <IconButton label="Настройки" onClick={() => void run({ type: 'settings.open' })} disabled={actions.pending.has('settings.open')}><Settings2 size={16} /></IconButton>
        <span className="toolbar-separator" />
        <IconButton label={`Скрыть окно · ${hotkeyLabel(snapshot.settings.visibilityHotkey)}`} onClick={() => void run({ type: 'overlay.hide' })}><X size={16} /></IconButton>
      </div>
    </header>

    <div className="view-toolbar">
      <nav className="segmented-control" aria-label="Раздел приложения"><button type="button" className={view === 'assistant' ? 'selected' : ''} aria-pressed={view === 'assistant'} onClick={() => setView('assistant')}><Sparkles size={14} />Помощник</button><button type="button" className={view === 'history' ? 'selected' : ''} aria-pressed={view === 'history'} onClick={() => setView('history')}><History size={14} />История</button></nav>
      {outstanding > 0 && <span className={`queue-count ${queueFull ? 'queue-full' : ''}`} title="Запись и вопросы в обработке">В работе {outstanding}/{MAX_OUTSTANDING}</span>}
    </div>

    <div className="overlay-notices">
      {actions.error && <Notice message={actions.error} onClose={() => actions.setError(undefined)} />}
      {snapshot.shortcutErrors?.map(error => <Notice key={error} message={error} />)}
      {snapshot.notice && dismissedNotice !== snapshot.notice && <Notice message={snapshot.notice} kind="info" onClose={() => setDismissedNotice(snapshot.notice)} />}
      {snapshot.mousePassthrough && <Notice kind="info" message={`Клики проходят сквозь окно. Вернуть управление: ${hotkeyLabel(snapshot.settings.mouseHotkey)}.`} />}
    </div>

    {view === 'history' ? <HistoryPanel snapshot={snapshot} actions={actions} onOpen={() => setView('assistant')} /> : <>
      {snapshot.questions.length > 1 && <div className="question-navigation" aria-label="Вопросы текущего интервью">{snapshot.questions.map(question => <button type="button" key={question.id} className={`question-chip ${selected?.id === question.id ? 'selected' : ''}`} onClick={() => setSelectedId(question.id)} aria-pressed={selected?.id === question.id} title={question.text || questionLabels[question.status]}><span className={`chip-dot status-${question.status}`} /><span>{String(question.order).padStart(2, '0')}</span><span className="chip-text">{question.text || questionLabels[question.status]}</span></button>)}</div>}
      <main className="assistant-content">
        {!modelReady && !selected && <button type="button" className="setup-banner" onClick={() => void run({ type: 'settings.open' })}><div className="setup-icon"><Monitor size={18} /></div><span><strong>{modelLabels[snapshot.stt.status]}</strong><span>Подготовьте локальное распознавание в настройках</span></span><ChevronRight size={17} /></button>}
        {(snapshot.interview?.provider ?? snapshot.settings.provider) === 'cloud' && !snapshot.hasToken && !selected && <button type="button" className="setup-banner" onClick={() => void run({ type: 'settings.open' })}><div className="setup-icon"><Keyboard size={18} /></div><span><strong>Подключите AI-помощника</strong><span>Добавьте клиентский токен codex-manager</span></span><ChevronRight size={17} /></button>}
        {selected && <QuestionContent key={selected.id} question={selected} actions={actions} queueFull={queueFull} draft={questionDrafts[selected.interviewId]?.[selected.id]} onDraft={draft => setQuestionDrafts(current => ({ ...current, [selected.interviewId]: { ...current[selected.interviewId], [selected.id]: draft } }))} onSubmit={draft => submitRevision(selected, draft)} />}
      </main>
      <div className="composer-area">
        {composerOpen ? <form onSubmit={event => void submitManual(event)} className="manual-composer"><div className="composer-heading"><label htmlFor="manual-question">Ваш вопрос</label><IconButton label="Закрыть ввод вопроса" onClick={() => setComposerOpen(false)}><X size={14} /></IconButton></div><textarea id="manual-question" autoFocus value={manualText} onChange={event => { manualRevision.current++; setManualText(event.target.value) }} maxLength={32000} rows={3} placeholder="Например: чем отличается процесс от потока?" /><div className="composer-footer"><span>{queueFull ? 'Дождитесь свободного места в очереди' : snapshot.interview && !snapshot.interview.completed ? 'Ответ появится в этом интервью' : 'Создадим новое интервью и покажем ответ'}</span><button type="submit" className="button button-primary button-small" disabled={!manualText.trim() || queueFull || actions.pending.has('question.submit')}>{actions.pending.has('question.submit') ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}Отправить</button></div></form> : <button type="button" className="manual-toggle" onClick={() => setComposerOpen(true)}><Plus size={14} />Написать вопрос вручную</button>}
      </div>
    </>}

    <footer className="capture-dock">
      <div className="audio-status"><div className="source-levels"><SourceLevel source="microphone" value={snapshot.levels.microphone} enabled={snapshot.settings.sources.includes('microphone')} recording={recording} /><SourceLevel source="system" value={snapshot.levels.system} enabled={snapshot.settings.sources.includes('system')} recording={recording} /></div><span className={`recording-clock ${recording ? 'is-recording' : ''}`}><span className="status-dot" />{snapshot.capture !== 'idle' ? `${timeLabel(Math.min(elapsed, MAX_RECORDING_MS))} / 02:00` : 'Запись выключена'}</span></div>
      {snapshot.capture !== 'idle' && <div className="recording-progress"><span style={{ width: `${Math.min(elapsed / MAX_RECORDING_MS, 1) * 100}%` }} /></div>}
      <button type="button" className={`record-button ${recording ? 'recording' : ''}`} onClick={() => void run({ type: 'record.toggle' })} disabled={transitioning || actions.pending.has('record.toggle') || (!recording && !canStartRecording)} title={!modelReady && !recording ? 'Сначала подготовьте модель в настройках' : queueFull && !recording ? 'В очереди уже три вопроса' : undefined}><span className="record-button-main">{transitioning ? <LoaderCircle size={18} className="spin" /> : recording ? <Square size={15} fill="currentColor" /> : <Mic size={18} />}<span>{snapshot.capture === 'starting' ? 'Подключаем звук…' : snapshot.capture === 'stopping' ? 'Завершаем запись…' : recording ? 'Завершить вопрос' : queueFull ? 'Очередь заполнена' : 'Слушать вопрос'}</span></span><kbd>{hotkeyLabel(snapshot.settings.recordHotkey)}</kbd></button>
      {snapshot.interview && !snapshot.interview.completed && <div className="dock-caption"><button type="button" onClick={() => void run({ type: 'interview.finish' })} disabled={actions.pending.has('interview.finish') || snapshot.capture !== 'idle' || outstanding > 0}>Завершить интервью</button></div>}
    </footer>
  </div>
}

function SourceLevel({ source, value, enabled, recording }: { source: AudioSource; value: number; enabled: boolean; recording: boolean }) {
  const level = recording && enabled && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const label = source === 'microphone' ? 'Микрофон' : 'Система'
  return <div className={`source-level ${!enabled ? 'disabled' : ''}`} title={`${label}: ${!enabled ? 'отключён в настройках' : recording ? 'запись' : 'ожидание'}`}>{source === 'microphone' ? <Mic size={12} /> : <Monitor size={12} />}<span>{label}</span><span className="level-bars" role="meter" aria-label={`Уровень: ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>{Array.from({ length: 7 }, (_, index) => <i key={index} style={{ height: `${5 + index % 4 * 2}px` }} className={level > index / 7 + 0.015 ? 'lit' : ''} />)}</span></div>
}

function QuestionContent({ question, actions, queueFull, draft, onDraft, onSubmit }: { question: Question; actions: Commands; queueFull: boolean; draft?: QuestionDraft; onDraft: (draft: QuestionDraft) => void; onSubmit: (draft: QuestionDraft) => Promise<void> }) {
  const editing = draft?.editing ?? question.status === 'review'
  const text = draft?.text ?? question.text
  const previousStatus = useRef(question.status)
  const renderedAnswer = useMemo(() => <Markdown skipHtml components={{ a: ({ children }) => <span className="markdown-link">{children}</span>, img: () => null }}>{question.answer}</Markdown>, [question.answer])
  useEffect(() => {
    if (question.status === 'review' && previousStatus.current !== 'review' && !draft?.editing) onDraft({ editing: true, text: question.text })
    previousStatus.current = question.status
  }, [question.text, question.status, draft, onDraft])
  const canCancel = !TERMINAL_STATUSES.includes(question.status)
  async function revise(event: FormEvent) {
    event.preventDefault()
    const submitted = draft ?? { text, editing: true }
    if (!draft) onDraft(submitted)
    await onSubmit(submitted)
  }
  return <article className="question-content">
    <section className="question-card">
      <div className="section-heading"><span className="eyebrow"><MessageSquare size={12} />ВОПРОС {String(question.order).padStart(2, '0')}</span><div className="question-tools"><StatusBadge status={question.status} />{question.text && !editing && <IconButton label="Редактировать вопрос и запросить новый ответ" onClick={() => onDraft({ text: question.text, editing: true })}><PencilLine size={14} /></IconButton>}{canCancel && <IconButton label="Отменить обработку вопроса" disabled={actions.pending.has('question.cancel')} onClick={() => void actions.run({ type: 'question.cancel', id: question.id })}><X size={14} /></IconButton>}</div></div>
      {editing ? <form className="revision-form" onSubmit={event => void revise(event)}><label htmlFor={`revision-${question.id}`} className="sr-only">Исправленный вопрос</label><textarea id={`revision-${question.id}`} autoFocus value={text} maxLength={32000} rows={4} onChange={event => onDraft({ text: event.target.value, editing: true })} /><div className="revision-caption">Сохранится как новая версия вопроса с отдельным ответом.</div><div className="button-row"><button type="button" className="button button-ghost button-small" onClick={() => onDraft({ text: question.text, editing: false })}>Отмена</button><button type="submit" className="button button-primary button-small" disabled={!text.trim() || queueFull || actions.pending.has('question.submit')}><ArrowUp size={13} />Отправить версию</button></div></form> : question.text ? <h2 className="recognized-question">{question.text}</h2> : <div className="question-placeholder"><AudioLines size={19} /><span>{question.status === 'recording' ? 'Слушаем вопрос. Завершите запись, когда собеседник закончит.' : question.status === 'transcribing' ? 'Преобразуем речь в текст на вашем устройстве…' : 'Текст вопроса пока недоступен.'}</span></div>}
      {question.partial && <div className="partial-note"><CircleHelp size={12} />Запись получена не полностью — проверьте вопрос.</div>}
      {question.segments.length > 0 && <details className="transcript-details"><summary><ChevronDown size={12} />По источникам<span>{question.durationMs ? timeLabel(question.durationMs) : ''}</span></summary><div className="transcript-segments">{question.segments.map((segment, index) => <div className="transcript-segment" key={`${segment.source}-${segment.startMs}-${index}`}><span>{segment.source === 'system' ? <Monitor size={11} /> : <Mic size={11} />}{timeLabel(segment.startMs)}</span><p>{segment.text}</p></div>)}</div></details>}
    </section>
    <section className="answer-section">
      <div className="section-heading"><span className="eyebrow"><Sparkles size={13} />ПОДСКАЗКА</span>{question.answer && question.status === 'generating' && <span className="streaming-label"><span className="status-dot" />В реальном времени</span>}</div>
      {question.answer ? <div className={`markdown-answer ${question.status === 'generating' ? 'is-streaming' : ''}`}>{renderedAnswer}</div> : question.status === 'generating' ? <div className="answer-loading" role="status"><div className="thinking-symbol"><Sparkles size={20} /></div><p>Подбираем формулировку<span className="ellipsis">…</span></p><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line short" /></div> : question.status === 'queued' ? <EmptyState icon={<Clock3 size={23} />} title="Вопрос в очереди">Ответ появится после предыдущего вопроса. Можно продолжать интервью.</EmptyState> : question.status === 'failed' || question.status === 'interrupted' ? <EmptyState icon={<CircleHelp size={23} />} title={question.status === 'failed' ? 'Не получилось подготовить ответ' : 'Обработка была прервана'}>{question.error || 'Проверьте подключение и отправьте новую версию вопроса.'}</EmptyState> : question.status === 'cancelled' ? <EmptyState icon={<Square size={21} />} title="Вопрос отменён">Он сохранён в истории. Вы можете отредактировать его и отправить снова.</EmptyState> : <div className="answer-placeholder"><Sparkles size={19} /><p>{question.status === 'review' ? 'Проверьте распознанный текст и отправьте вопрос.' : 'Здесь появится ответ — сразу после распознавания вопроса.'}</p></div>}
      {question.error && question.answer && <Notice kind="info" message={question.error} />}
      {question.latency && <LatencySummary latency={question.latency} />}
    </section>
  </article>
}

function LatencySummary({ latency }: { latency: QuestionLatency }) {
  const seconds = (value: number) => `${(value / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} с`
  const stages: Array<[string, number | undefined]> = [
    ['Распознавание', latency.sttMs], ['Ожидание очереди', latency.queueMs], ['Подключение', latency.connectionMs],
    ['AI до первого текста', latency.aiFirstAnswerMs], ['AI до завершения', latency.aiTotalMs]
  ]
  return <details className="latency-details"><summary><Clock3 size={12} /><span>{latency.firstAnswerMs !== undefined ? `Первый текст: ${seconds(latency.firstAnswerMs)}` : 'Время обработки'}{latency.totalMs !== undefined ? ` · Готово: ${seconds(latency.totalMs)}` : ''}</span><ChevronDown size={12} /></summary><p>От отправки текста или остановки записи. Длительность самой записи не учитывается.</p><dl>{stages.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{seconds(value!)}</dd></div>)}</dl></details>
}

function trapDialogFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return
  const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  const first = buttons[0]
  const last = buttons[buttons.length - 1]
  if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus() }
}

function HistoryPanel({ snapshot, actions, onOpen }: { snapshot: AppSnapshot; actions: Commands; onOpen: () => void }) {
  const [deleting, setDeleting] = useState<InterviewSummary>()
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const hasActiveWork = snapshot.capture !== 'idle' || snapshot.questions.some(question => !TERMINAL_STATUSES.includes(question.status))
  const items = [...snapshot.history].sort((a, b) => b.updatedAt - a.updatedAt).filter(item => item.title.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')))
  async function create(event: FormEvent) {
    event.preventDefault()
    if (await actions.run({ type: 'interview.new', ...(title.trim() ? { title: title.trim() } : {}) })) { setCreating(false); setTitle(''); onOpen() }
  }
  return <main className="history-panel">
    <div className="history-heading"><div><span className="eyebrow">ВАШ ПРОГРЕСС</span><h1>История интервью</h1></div><button type="button" className="button button-primary button-small" disabled={hasActiveWork} title={hasActiveWork ? 'Дождитесь завершения текущих вопросов' : undefined} onClick={() => setCreating(value => !value)}><Plus size={14} />Новое</button></div>
    {creating && <form onSubmit={event => void create(event)} className="new-interview-form"><label htmlFor="interview-title">Название интервью</label><input id="interview-title" autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={150} placeholder="Например, Frontend · техническое интервью" /><div className="button-row"><button className="button button-ghost button-small" type="button" onClick={() => setCreating(false)}>Отмена</button><button type="submit" className="button button-primary button-small" disabled={actions.pending.has('interview.new') || hasActiveWork}>Создать</button></div></form>}
    {snapshot.history.length > 3 && <label className="history-search"><History size={14} /><input aria-label="Поиск по истории" value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти интервью" /></label>}
    {items.length ? <div className="history-list">{items.map(item => <div key={item.id} className={`history-card ${item.id === snapshot.interview?.id ? 'current' : ''}`}><div className="history-card-icon">{item.completed ? <CheckCheck size={18} /> : <MessageSquare size={18} />}</div><button type="button" className="history-card-content" disabled={actions.pending.has('interview.resume') || (hasActiveWork && item.id !== snapshot.interview?.id)} onClick={() => { if (item.id === snapshot.interview?.id) onOpen(); else void actions.run({ type: 'interview.resume', id: item.id }).then(ok => { if (ok) onOpen() }) }}><strong>{item.title}</strong><span>{shortDate(item.updatedAt)}<i />{item.questionCount} вопр. · {item.provider === 'local' ? 'Локальный Codex' : 'codex-manager'}</span><small>{item.id === snapshot.interview?.id ? 'Открыто сейчас' : item.completed ? 'Завершено' : 'Можно продолжить'}</small></button><IconButton label={`Удалить интервью «${item.title}»`} disabled={actions.pending.has('interview.delete') || (hasActiveWork && item.id === snapshot.interview?.id)} onClick={() => setDeleting(item)}><Trash2 size={14} /></IconButton></div>)}</div> : <EmptyState icon={<History size={26} />} title={search ? 'Ничего не найдено' : 'Здесь будет ваша история'}>{search ? 'Попробуйте другое название.' : 'Вопросы и ответы сохраняются на этом устройстве. Начните новое интервью или запишите первый вопрос.'}</EmptyState>}
    {deleting && <div className="modal-backdrop" onKeyDown={event => { if (event.key === 'Escape') setDeleting(undefined); trapDialogFocus(event) }}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><div className="dialog-icon"><Trash2 size={20} /></div><h2 id="delete-title">Удалить интервью?</h2><p>«{deleting.title}» и его сохранённые вопросы с ответами будут удалены из приложения.{deleting.provider === 'local' && ' Копия в истории Codex сохранится.'}</p><div className="button-row"><button autoFocus type="button" className="button button-secondary" onClick={() => setDeleting(undefined)} disabled={actions.pending.has('interview.delete')}>Оставить</button><button type="button" className="button button-danger" disabled={actions.pending.has('interview.delete')} onClick={() => void actions.run({ type: 'interview.delete', id: deleting.id }).then(ok => { if (ok) setDeleting(undefined) })}>{actions.pending.has('interview.delete') ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}Удалить</button></div></section></div>}
  </main>
}
