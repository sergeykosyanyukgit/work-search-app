import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AudioLines, Check, ChevronRight, Download, HardDrive, KeyRound, Keyboard, Link2, LoaderCircle, Mic, Monitor, Palette, Power, RefreshCw, ShieldCheck, Sparkles, Trash2, Upload, UserRound, Volume2 } from 'lucide-react'
import type { AppSnapshot, AudioSource, Profile, Settings } from '../domain/types'
import type { Commands } from './hooks'
import { ConnectionBadge, hotkeyLabel, IconButton, modelLabels, Notice } from './components'
import { useTheme, type AppTheme } from './theme'

type SettingsTab = 'connection' | 'profile' | 'audio' | 'model' | 'hotkeys' | 'appearance'
const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Link2 }> = [
  { id: 'connection', label: 'Подключение', icon: Link2 }, { id: 'profile', label: 'Мой контекст', icon: UserRound },
  { id: 'audio', label: 'Источники звука', icon: Volume2 }, { id: 'model', label: 'Распознавание', icon: HardDrive },
  { id: 'hotkeys', label: 'Горячие клавиши', icon: Keyboard }, { id: 'appearance', label: 'Внешний вид', icon: Palette }
]

export function SettingsView({ snapshot, actions }: { snapshot: AppSnapshot; actions: Commands }) {
  const [tab, setTab] = useState<SettingsTab>('connection')
  const [draft, setDraft] = useState<Settings>(() => structuredClone(snapshot.settings))
  const [dirty, setDirty] = useState(false)
  const [token, setToken] = useState('')
  const draftRevision = useRef(0)
  const tokenRevision = useRef(0)
  const [saved, setSaved] = useState(false)
  const [confirmClearToken, setConfirmClearToken] = useState(false)
  const [microphones, setMicrophones] = useState<Array<{ id: string; label: string }>>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState<string>()
  const mounted = useRef(true)
  const fetchingDevices = useRef(false)
  const settingsSignature = JSON.stringify(snapshot.settings)
  const unsaved = dirty || token.length > 0
  const saving = actions.pending.has('settings.save')
  const modelBusy = snapshot.stt.status === 'loading' || actions.pending.has('model.download') || actions.pending.has('model.import')
  const modelProgress = typeof snapshot.stt.progress === 'number' ? Math.round(Math.min(1, Math.max(0, snapshot.stt.progress)) * 100) : undefined

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!dirty) setDraft(JSON.parse(settingsSignature) as Settings) }, [settingsSignature, dirty])
  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 3500)
    return () => window.clearTimeout(timer)
  }, [saved])

  const refreshDevices = useCallback(async () => {
    if (fetchingDevices.current) return
    fetchingDevices.current = true
    setDevicesLoading(true); setDevicesError(undefined)
    try {
      const result = await window.desktop.microphones()
      if (mounted.current) setMicrophones(result)
    } catch { if (mounted.current) setDevicesError('Не удалось прочитать список микрофонов. Проверьте доступ к микрофону в настройках Windows.') }
    finally { fetchingDevices.current = false; if (mounted.current) setDevicesLoading(false) }
  }, [])
  useEffect(() => { if (tab === 'connection' && snapshot.settings.provider === 'local' && snapshot.aiReadiness.status === 'unchecked' && !unsaved) void actions.run({ type: 'connection.test' }) }, [tab, snapshot.settings.provider, snapshot.aiReadiness.status, unsaved])
  useEffect(() => { if (tab === 'audio') void refreshDevices() }, [tab, refreshDevices])

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    draftRevision.current++
    setDraft(current => ({ ...current, [key]: value })); setDirty(true); setSaved(false)
  }
  function updateProfile<K extends keyof Profile>(key: K, value: Profile[K]) {
    draftRevision.current++
    setDraft(current => ({ ...current, profile: { ...current.profile, [key]: value } })); setDirty(true); setSaved(false)
  }
  async function saveSettings() {
    const validUrl = (() => { try { const value = new URL(draft.serviceUrl); return !value.username && !value.password && !value.hash && !value.search && (value.protocol === 'https:' || value.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)) } catch { return false } })()
    if (!validUrl) { actions.setError('Введите адрес HTTPS без логина, пароля и параметров. HTTP разрешён только для localhost.'); setTab('connection'); return }
    if (!draft.profileSlug.trim()) { actions.setError('Укажите slug серверного профиля.'); setTab('connection'); return }
    const keys = [draft.recordHotkey.trim(), draft.visibilityHotkey.trim(), draft.mouseHotkey.trim()]
    if (keys.some(key => !key) || new Set(keys.map(key => key.toLowerCase())).size !== keys.length) { actions.setError('Укажите три разных сочетания клавиш.'); setTab('hotkeys'); return }
    const next = { ...draft, serviceUrl: draft.serviceUrl.trim(), profileSlug: draft.profileSlug.trim(), recordHotkey: keys[0]!, visibilityHotkey: keys[1]!, mouseHotkey: keys[2]!, bounds: snapshot.settings.bounds }
    const submittedDraftRevision = draftRevision.current
    const submittedTokenRevision = tokenRevision.current
    if (await actions.run({ type: 'settings.save', settings: next, ...(token.trim() ? { token: token.trim() } : {}) })) {
      if (draftRevision.current === submittedDraftRevision) setDirty(false)
      if (tokenRevision.current === submittedTokenRevision) setToken('')
      setSaved(draftRevision.current === submittedDraftRevision && tokenRevision.current === submittedTokenRevision)
    }
  }
  function toggleSource(source: AudioSource) {
    const selected = draft.sources.includes(source)
    if (selected && draft.sources.length === 1) return
    update('sources', selected ? draft.sources.filter(item => item !== source) : [...draft.sources, source])
  }

  return <div className="settings-shell">
    <header className="settings-titlebar draggable"><div className="brand"><div className="brand-mark"><AudioLines size={18} strokeWidth={2.4} /></div><div><span className="brand-name">Work Search</span><span className="brand-caption">НАСТРОЙКИ</span></div></div><button type="button" className="button button-secondary button-small no-drag" onClick={() => void actions.run({ type: 'overlay.show' })}><Monitor size={14} />Показать помощника</button></header>
    <div className="settings-body"><aside className="settings-sidebar"><div className="sidebar-label">ПРИЛОЖЕНИЕ</div><nav aria-label="Настройки">{tabs.map(item => <button type="button" key={item.id} className={tab === item.id ? 'selected' : ''} onClick={() => setTab(item.id)} aria-current={tab === item.id ? 'page' : undefined}><item.icon size={16} /><span>{item.label}</span><ChevronRight className="nav-chevron" size={12} /></button>)}</nav><div className="sidebar-bottom"><div className="local-first-badge"><ShieldCheck size={18} /><span><strong>Локальное аудио</strong><small>На сервер отправляется текст</small></span></div><button type="button" className="quit-button" disabled={actions.pending.has('app.quit')} onClick={() => void actions.run({ type: 'app.quit' })}><Power size={13} />Выйти из приложения</button></div></aside>
      <main className="settings-main">
        {actions.error && <Notice message={actions.error} onClose={() => actions.setError(undefined)} />}
        {snapshot.shortcutErrors?.map(error => <Notice key={error} message={error} />)}
        {tab === 'connection' && <>
          <PageHeading eyebrow="AI-ПОМОЩНИК" title="Подключение AI">Режим и модель применяются со следующего интервью.</PageHeading>
          <section className="settings-card"><Field label="Провайдер AI" htmlFor="ai-provider"><select id="ai-provider" value={draft.provider} onChange={event => update('provider', event.target.value as Settings['provider'])}><option value="cloud">Облачный codex-manager</option><option value="local">Локальный Codex</option></select></Field></section>
          {snapshot.interview && !snapshot.interview.completed && <div className="settings-card"><p>Текущее интервью: <strong>{snapshot.interview.provider === 'local' ? 'Локальный Codex · ' + snapshot.interview.localCodex.model : 'Облачный codex-manager'}</strong></p><div className="connection-current-controls"><ConnectionBadge status={snapshot.connection} /><button type="button" className="text-button" disabled={snapshot.questions.some(q => q.status === 'generating') || actions.pending.has('connection.recover')} onClick={() => void actions.run({ type: 'connection.recover' })}>Продолжить подключение</button></div></div>}
          {draft.provider === 'cloud' && <><section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon"><Link2 size={18} /></div><div><h2>codex-manager</h2><p>Клиентский доступ к вашему AI-профилю</p></div></div><Field label="Адрес сервиса" htmlFor="service-url" help="Основной HTTPS-адрес codex-manager. Соединение WebSocket создаётся автоматически."><input id="service-url" type="url" value={draft.serviceUrl} onChange={event => update('serviceUrl', event.target.value)} placeholder="https://api.code-manager.ru" spellCheck={false} autoComplete="off" /></Field><Field label="Серверный профиль" htmlFor="profile-slug" help="Профиль должен быть заранее настроен на сервере для помощи на интервью."><input id="profile-slug" value={draft.profileSlug} onChange={event => update('profileSlug', event.target.value)} maxLength={100} spellCheck={false} placeholder="interview-assistant" /></Field></section>
          <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon"><KeyRound size={18} /></div><div><h2>Клиентский токен</h2><p>{snapshot.hasToken ? 'Токен сохранён и защищён' : 'Добавьте токен клиента codex-manager'}</p></div>{snapshot.hasToken && <span className="saved-token-badge"><Check size={12} />Сохранён</span>}</div><Field label={snapshot.hasToken ? 'Заменить токен' : 'Токен доступа'} htmlFor="client-token" help="Хранится в защищённом хранилище Windows. Сохранённое значение не показывается повторно."><input id="client-token" type="password" value={token} onChange={event => { tokenRevision.current++; setToken(event.target.value); setSaved(false) }} maxLength={512} placeholder={snapshot.hasToken ? 'Оставьте пустым, чтобы сохранить текущий' : 'Вставьте клиентский токен'} autoComplete="new-password" spellCheck={false} /></Field>{snapshot.hasToken && <div className="token-clear-row">{confirmClearToken ? <><span>Удалить сохранённый токен?</span><button type="button" className="text-button" disabled={actions.pending.has('token.clear')} onClick={() => setConfirmClearToken(false)}>Отмена</button><button type="button" className="text-button destructive" disabled={actions.pending.has('token.clear')} onClick={() => void actions.run({ type: 'token.clear' }).then(ok => { if (ok) setConfirmClearToken(false) })}>Удалить</button></> : <button type="button" className="text-button muted" onClick={() => setConfirmClearToken(true)}><Trash2 size={12} />Удалить токен с устройства</button>}</div>}</section>
          </>}
          {draft.provider === 'local' && <section className="settings-card local-codex-card">
            <h2>Установленный Codex</h2>
            <Field label="Путь к codex.exe" htmlFor="codex-path" help="Оставьте пустым для автоматического поиска установленного Windows CLI."><input id="codex-path" value={draft.localCodex.executablePath} onChange={event => update('localCodex', { ...draft.localCodex, executablePath: event.target.value })} placeholder="Автоматический поиск" spellCheck={false} /><button type="button" className="text-button" onClick={() => void window.desktop.command({ type: 'codex.select' }).then(result => { if (result.executablePath) update('localCodex', { ...draft.localCodex, executablePath: result.executablePath }); if (!result.ok) actions.setError(result.error) }).catch(() => actions.setError('Не удалось выбрать файл.'))}>Выбрать файл…</button></Field>
            {snapshot.aiReadiness.provider === 'local' && <><p className="help-text local-cli-path">{snapshot.aiReadiness.executablePath}</p><p className="help-text">Версия: {snapshot.aiReadiness.version ?? 'не проверена'} · ChatGPT: {snapshot.aiReadiness.authenticated === undefined ? 'не проверен' : snapshot.aiReadiness.authenticated ? 'вход выполнен' : 'нужен вход'}</p></>}
            <Field label="Модель Codex" htmlFor="codex-model" help="Reasoning: low · стандартная скорость. Каталог обновляется при проверке подключения."><select id="codex-model" value={draft.localCodex.model} onChange={event => update('localCodex', { ...draft.localCodex, model: event.target.value })}>
              {!snapshot.aiReadiness.models?.some(model => model.id === draft.localCodex.model) && <option value={draft.localCodex.model}>{draft.localCodex.model} (доступность не подтверждена)</option>}
              {snapshot.aiReadiness.models?.map(model => <option key={model.id} value={model.id} disabled={!model.supportsLow}>{model.label}{model.supportsLow ? '' : ' (нет low)'}</option>)}
            </select></Field>
            <p className="help-text">Используется авторизация установленного Codex. Если вход не выполнен, запустите codex login в терминале. Для ответов нужен интернет.</p>
            <p className="help-text">Интервью также сохраняются в истории Codex. Удаление интервью из приложения не удаляет эту копию.</p>
          </section>}
          <div className="settings-inline-action"><button type="button" className="button button-secondary" onClick={() => void actions.run({ type: 'connection.test' })} disabled={unsaved || (draft.provider === 'cloud' && !snapshot.hasToken) || actions.pending.has('connection.test') || snapshot.aiReadiness.status === 'checking'}>{actions.pending.has('connection.test') || snapshot.aiReadiness.status === 'checking' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Проверить подключение</button><span>{unsaved ? 'Сначала сохраните изменения' : draft.provider === 'cloud' && !snapshot.hasToken ? 'Добавьте клиентский токен' : 'Проверяется сохранённая конфигурация'}</span></div>
        </>}
        {tab === 'connection' && snapshot.aiReadiness.message && <p className="help-text" role="status">{snapshot.aiReadiness.message}</p>}
        {tab === 'profile' && <>
          <PageHeading eyebrow="ПОДГОТОВКА К ИНТЕРВЬЮ" title="Мой контекст">Расскажите о своём опыте и роли. Помощник учтёт эти сведения в ответах.</PageHeading>
          <div className="context-note"><Sparkles size={16} /><p>Контекст фиксируется при начале интервью. Изменения применятся к следующему интервью.</p></div>
          <section className="settings-card"><Field label="Ваш опыт и резюме" htmlFor="profile-resume" help="Ключевые навыки, проекты, зона ответственности и результаты."><textarea id="profile-resume" value={draft.profile.resume} onChange={event => updateProfile('resume', event.target.value)} maxLength={32000} rows={7} placeholder="Frontend-разработчик, 4 года опыта. React, TypeScript…" /><CharacterCount value={draft.profile.resume} max={32000} /></Field><Field label="Вакансия и компания" htmlFor="profile-vacancy" help="Требования к роли и детали предстоящего собеседования."><textarea id="profile-vacancy" value={draft.profile.vacancy} onChange={event => updateProfile('vacancy', event.target.value)} maxLength={16000} rows={5} placeholder="Senior Frontend Engineer. Продуктовая команда, архитектура интерфейсов…" /><CharacterCount value={draft.profile.vacancy} max={16000} /></Field><Field label="Дополнительные пожелания" htmlFor="profile-instructions" help="Например, отвечать по-русски и приводить короткие примеры кода."><textarea id="profile-instructions" value={draft.profile.instructions} onChange={event => updateProfile('instructions', event.target.value)} maxLength={8000} rows={4} placeholder="Начинай с главной мысли. Если есть компромиссы, поясни их." /></Field></section>
          <section className="settings-card"><h2>Подробность ответов</h2><div className="option-cards">{([{ value: 'brief', title: 'Кратко и по делу', description: 'Основная мысль и опорные тезисы' }, { value: 'detailed', title: 'С подробностями', description: 'Объяснение, примеры и нюансы' }] as const).map(option => <label key={option.value} className={`option-card ${draft.profile.responseStyle === option.value ? 'selected' : ''}`}><input type="radio" name="response-style" value={option.value} checked={draft.profile.responseStyle === option.value} onChange={() => updateProfile('responseStyle', option.value)} /><span><strong>{option.title}</strong><small>{option.description}</small></span></label>)}</div></section>
        </>}
        {tab === 'audio' && <>
          <PageHeading eyebrow="ЗАПИСЬ ВОПРОСА" title="Источники звука">Выберите, что слушать после нажатия горячей клавиши. Запись начинается только по вашему действию.</PageHeading>
          <section className="settings-card source-selection"><SourceSwitch label="Системный звук" description="Речь собеседника из звонка, браузера и других приложений" icon={<Monitor size={19} />} checked={draft.sources.includes('system')} disabled={draft.sources.length === 1 && draft.sources[0] === 'system'} onChange={() => toggleSource('system')} /><SourceSwitch label="Микрофон" description="Ваш голос и звук выбранного устройства ввода" icon={<Mic size={19} />} checked={draft.sources.includes('microphone')} disabled={draft.sources.length === 1 && draft.sources[0] === 'microphone'} onChange={() => toggleSource('microphone')} /></section>
          <section className="settings-card"><div className="settings-card-heading"><div className="settings-card-icon"><Mic size={18} /></div><div><h2>Устройство ввода</h2><p>Микрофон для записи вашего голоса</p></div><IconButton label="Обновить список микрофонов" disabled={devicesLoading} onClick={() => void refreshDevices()}><RefreshCw size={15} className={devicesLoading ? 'spin' : ''} /></IconButton></div>{devicesError && <Notice message={devicesError} />}
            <Field label="Микрофон" htmlFor="microphone-device"><select id="microphone-device" value={draft.microphoneId} onChange={event => update('microphoneId', event.target.value)} disabled={devicesLoading || !draft.sources.includes('microphone')}><option value="">Системное устройство по умолчанию</option>{draft.microphoneId && !microphones.some(device => device.id === draft.microphoneId) && <option value={draft.microphoneId}>Сохранённое устройство недоступно</option>}{microphones.filter(device => device.id).map((device, index) => <option value={device.id} key={device.id}>{device.label || `Микрофон ${index + 1}`}</option>)}</select></Field><p className="help-text">Источники распознаются отдельно. Системный звук продолжает воспроизводиться в ваших наушниках.</p></section>
          <div className="info-note"><ShieldCheck size={16} /><p>Аудио остаётся на устройстве и не сохраняется в историю. Максимальная запись одного вопроса — 2 минуты.</p></div>
        </>}
        {tab === 'model' && <>
          <PageHeading eyebrow="РАСПОЗНАВАНИЕ НА УСТРОЙСТВЕ" title="Локальная модель">Whisper преобразует речь в текст без отправки аудио в облако.</PageHeading>
          <section className="settings-card model-card"><div className="model-heading"><div className="model-art"><AudioLines size={36} strokeWidth={1.3} /></div><div><span className="eyebrow">WHISPER · МНОГОЯЗЫЧНАЯ</span><h2>Small</h2><p>Распознавание на CPU · Windows x64</p></div><span className={`model-status model-${snapshot.stt.status}`}>{['ready', 'processing'].includes(snapshot.stt.status) ? <Check size={13} /> : snapshot.stt.status === 'loading' ? <LoaderCircle className="spin" size={13} /> : <HardDrive size={13} />}{modelLabels[snapshot.stt.status]}</span></div><p className="model-description">Модель загружается один раз. В дальнейшем распознавание работает локально; для AI-ответов требуется подключение к сервису.</p>{snapshot.stt.message && <p className="model-message" role="status">{snapshot.stt.message}</p>}{snapshot.stt.status === 'loading' && <div className="download-progress"><div className={modelProgress === undefined ? 'indeterminate' : ''}><span style={{ width: modelProgress === undefined ? '35%' : `${modelProgress}%` }} /></div><span>{modelProgress === undefined ? 'Подготовка…' : `${modelProgress}%`}</span></div>}<div className="button-row model-actions"><button type="button" className="button button-primary" onClick={() => void actions.run({ type: 'model.download' })} disabled={modelBusy || snapshot.stt.status === 'ready' || snapshot.stt.status === 'processing'}>{modelBusy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{snapshot.stt.status === 'ready' || snapshot.stt.status === 'processing' ? 'Модель установлена' : 'Скачать модель'}</button><button type="button" className="button button-secondary" disabled={modelBusy || snapshot.stt.status === 'processing'} onClick={() => void actions.run({ type: 'model.import' })}><Upload size={15} />Импортировать файл</button></div><span className="integrity-note"><ShieldCheck size={12} />При установке проверяется контрольная сумма файла</span></section>
          <section className="settings-card"><Field label="Язык распознавания" htmlFor="recognition-language" help="Для интервью на одном языке явный выбор помогает распознаванию."><select id="recognition-language" value={draft.language} onChange={event => update('language', event.target.value as Settings['language'])}><option value="auto">Определять автоматически</option><option value="ru">Русский</option><option value="en">English</option></select></Field></section>
        </>}
        {tab === 'hotkeys' && <>
          <PageHeading eyebrow="УПРАВЛЕНИЕ БЕЗ ПЕРЕКЛЮЧЕНИЯ ОКОН" title="Горячие клавиши">Сочетания работают, даже когда открыто другое приложение.</PageHeading>
          <section className="settings-card hotkey-settings"><HotkeyField id="record-hotkey" label="Начать / завершить вопрос" description="Первое нажатие начинает запись, повторное отправляет вопрос." icon={<Mic size={18} />} value={draft.recordHotkey} onChange={value => update('recordHotkey', value)} /><HotkeyField id="visibility-hotkey" label="Показать / скрыть оверлей" description="Быстро убрать окно и вернуть его в любой момент." icon={<Monitor size={18} />} value={draft.visibilityHotkey} onChange={value => update('visibilityHotkey', value)} /><HotkeyField id="mouse-hotkey" label="Пропускать / принимать клики" description="Позволяет работать с окном под оверлеем." icon={<Keyboard size={18} />} value={draft.mouseHotkey} onChange={value => update('mouseHotkey', value)} /></section>
          <div className="info-note"><Keyboard size={16} /><p>Введите сочетание в формате <code>Ctrl+Alt+Space</code> или <code>Ctrl+Shift+H</code>. Если оно занято другим приложением, прежние настройки останутся активными.</p></div>
        </>}
        {tab === 'appearance' && <>
          <PageHeading eyebrow="ВАШ ОВЕРЛЕЙ" title="Внешний вид">Настройте окно так, чтобы оно удобно вписывалось в ваше рабочее пространство.</PageHeading>
          <ThemePicker />
          <section className="settings-card"><div className="slider-field"><label htmlFor="overlay-opacity">Непрозрачность окна</label><output htmlFor="overlay-opacity">{Math.round(draft.opacity * 100)}%</output><input id="overlay-opacity" type="range" min={35} max={100} step={1} value={Math.round(draft.opacity * 100)} onChange={event => update('opacity', Number(event.target.value) / 100)} /><div className="slider-labels"><span>Легче</span><span>Плотнее</span></div></div><div className="slider-field"><label htmlFor="reading-size">Размер текста ответа</label><output htmlFor="reading-size">{draft.fontSize} px</output><input id="reading-size" type="range" min={12} max={26} step={1} value={draft.fontSize} onChange={event => update('fontSize', Number(event.target.value))} /><div className="slider-labels"><span>Компактнее</span><span>Крупнее</span></div></div></section>
          <div className="appearance-preview"><span className="eyebrow"><Sparkles size={12} />ПРЕДПРОСМОТР</span><div className="preview-content" style={{ fontSize: draft.fontSize, opacity: draft.opacity }}><strong>Начните с основной мысли.</strong><p>Затем приведите пример из своего опыта и поясните, как вы пришли к решению.</p></div></div>
          <div className="info-note"><ShieldCheck size={16} /><p>Исключение окна из захвата включается средствами Windows. Результат зависит от приложения демонстрации экрана: проверьте запись или изображение у получателя перед интервью.</p></div>
        </>}
      </main>
    </div>
    <footer className="settings-footer"><div className={`settings-save-status ${saved ? 'saved' : ''}`}>{saved ? <><Check size={15} />Настройки сохранены</> : unsaved ? <><span className="status-dot" />Есть несохранённые изменения</> : <><ShieldCheck size={14} />Настройки хранятся на этом устройстве</>}</div><div className="button-row"><button type="button" className="button button-ghost" disabled={!unsaved || saving} onClick={() => { setDraft(structuredClone(snapshot.settings)); setDirty(false); setToken(''); setSaved(false); actions.setError(undefined) }}>Сбросить изменения</button><button type="button" className="button button-primary" onClick={() => void saveSettings()} disabled={!unsaved || saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Сохранить</button></div></footer>
  </div>
}

const themeOptions: Array<{ id: AppTheme; title: string; description: string }> = [
  { id: 'light-blue', title: 'Светлая голубая', description: 'Воздушная и ясная' },
  { id: 'dark-blue', title: 'Тёмная синяя', description: 'Спокойные синие тона' },
  { id: 'midnight', title: 'Полночь', description: 'Глубокий ночной синий' }
]

function ThemePicker() {
  const { theme, setTheme } = useTheme()
  const [storageError, setStorageError] = useState(false)
  return <section className="settings-card theme-card">
    <h2 id="theme-heading">Цветовая тема</h2>
    <p id="theme-description" className="help-text">Применяется сразу к настройкам и помощнику. Выбор сохраняется автоматически.</p>
    <fieldset className="theme-picker" aria-labelledby="theme-heading" aria-describedby="theme-description">
      {themeOptions.map(option => <label key={option.id} className={`theme-option ${theme === option.id ? 'selected' : ''}`}>
        <input type="radio" name="color-theme" value={option.id} checked={theme === option.id} onChange={() => setStorageError(!setTheme(option.id))} aria-label={option.title} />
        <span className="theme-preview" data-theme={option.id} aria-hidden="true"><span className="theme-preview-bar"><span /><span /><span /></span><span className="theme-preview-question" /><span className="theme-preview-answer"><span /><span /></span><span className="theme-preview-button" /></span>
        <span className="theme-option-copy"><strong>{option.title}</strong><small>{option.description}</small></span>
      </label>)}
    </fieldset>
    {storageError && <p className="theme-storage-error" role="status">Тема применена в этом окне, но сохранить выбор не удалось. После перезапуска он может сброситься.</p>}
  </section>
}

function PageHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <div className="settings-page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{children}</p></div>
}
function Field({ label, htmlFor, help, children }: { label: string; htmlFor: string; help?: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{help && <p className="help-text">{help}</p>}</div>
}
function CharacterCount({ value, max }: { value: string; max: number }) { return <span className="character-count">{value.length.toLocaleString('ru-RU')} / {max.toLocaleString('ru-RU')}</span> }
function SourceSwitch({ label, description, icon, checked, disabled, onChange }: { label: string; description: string; icon: ReactNode; checked: boolean; disabled: boolean; onChange: () => void }) {
  return <label className={`source-switch ${checked ? 'selected' : ''}`}><span className="source-switch-icon">{icon}</span><span className="source-switch-copy"><strong>{label}</strong><span>{description}</span></span><span className="toggle-switch"><input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} /><i /></span></label>
}
function HotkeyField({ id, label, description, icon, value, onChange }: { id: string; label: string; description: string; icon: ReactNode; value: string; onChange: (value: string) => void }) {
  return <div className="hotkey-field"><div className="hotkey-field-label"><span>{icon}</span><div><label htmlFor={id}>{label}</label><p>{description}</p></div></div><input id={id} value={value} onChange={event => onChange(event.target.value)} spellCheck={false} maxLength={100} autoComplete="off" placeholder="Ctrl+Alt+Space" /><span className="hotkey-preview">{hotkeyLabel(value)}</span></div>
}
