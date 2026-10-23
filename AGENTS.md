# Work Search: инструкции для разработки

## Контекст и границы

Windows 11 x64, Electron + React + TypeScript. Локальный Whisper распознает микрофон и системный звук; ответы приходят через облачный codex-manager или установленный локальный Codex App Server. Локальный AI-транспорт также требует интернета. Исходники полного сервера codex-manager находятся вне этого репозитория.

Перед изменением прочитай `package.json`, `docs/architecture.md` и относящиеся к задаче файлы. Для локального Codex используй `docs/local-codex.md`, для задержек — `docs/latency.md`, для Windows-проверок — `docs/acceptance.md`. Документы содержат исторические результаты: текущие версии, состояния и число тестов сверяй по коду и новому прогону.

Общайся с пользователем по-русски. Сохраняй существующий стиль TypeScript и русские пользовательские тексты. Сначала проверяй `git status --short`: файлы проекта могут быть untracked, и пустой `git diff` не подтверждает отсутствие работы. Не отменяй чужие изменения.

## Назначение AGENTS.md и публичная разработка

Этот файл задаёт инструкции AI-агентам, работающим с репозиторием, и служит справочником архитектурных ограничений для разработчика. Он не настраивает runtime AI в интервью. Для ручной разработки и обычных mock-тестов установка Codex, plugins и запуск субагентов не обязательны. Вход для новых участников — [CONTRIBUTING.md](CONTRIBUTING.md), описание функций — [README.md](README.md).

- Собственный код публикуется по [MIT](LICENSE). Для стороннего кода, моделей, бинарников и fixtures сохраняй происхождение и условия из [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); лицензия проекта не заменяет их.
- В публичные файлы, issues, fixtures и примеры не добавляй пользовательскую БД, токены, настоящие интервью, auth.json, персональные абсолютные пути или production client ID. Примеры должны работать с явными аргументами и placeholders.
- Для уязвимостей используй [SECURITY.md](SECURITY.md); не публикуй секреты или эксплуатационные детали в открытом issue.
- Устанавливай зависимости из `pnpm-lock.yaml` через `pnpm install --frozen-lockfile`. Изменяй lockfile осознанно вместе с зависимостями, не создавай альтернативные lockfiles. `private: true` защищает от случайного npm publish и совместим с публичными исходниками GitHub.
- [Windows CI](.github/workflows/ci.yml) последовательно проверяет Node-тесты, mock provision, JS-сборку, browser UI, подготовку release-ресурсов, pack, packaged smoke и Electron-тесты с mock AI; отдельное задание проверяет зависимости. Native/live-приёмка, NSIS, подпись и публикация требуют отдельных доказательств.
- Перед выпуском сверяй незакрытые пункты [аудита](docs/audit-2026-10-23.md). Исторический зелёный прогон не закрывает найденный дефект без соответствующей проверки.
- Перед публикацией запускай `pnpm check:publication` и secret scan по всем публикуемым refs. Этот gate проверяет коммит и историю, поэтому новые изменения сначала должны попасть в локальный коммит. Не добавляй резервные Git bundles в refs/архивы публикации и не используй `push --mirror`; порядок замены прежней ветки — в [docs/publication.md](docs/publication.md).

## Разделение ответственности

| Слой | Назначение | Основная роль |
| --- | --- | --- |
| `src/domain/`, `src/application/` | Типы, порты, prompt, FIFO, use cases и состояние интервью | `backend` |
| `src/renderer/` | React, оверлей, настройки, история, CSS и доступность | `frontend` |
| `src/main/`, `src/preload/index.ts`, `src/shared/ipc.ts` | Композиция, Windows-окна, горячие клавиши, типизированный IPC | `electron` |
| `src/adapters/ai/`, `service-integration/` | Cloud/local AI, RPC, восстановление и профили | `ai_integrations` |
| `src/capture/`, `src/preload/capture.ts`, `src/adapters/audio/`, `src/adapters/stt/` | Захват, PCM, ресурсы Whisper и STT | `audio_stt` |
| `src/adapters/storage/` | SQLite, шифрование, миграции, outbox и диагностика | `storage` |
| `tests/`, `e2e/` | Автоматические проверки и фикстуры | `qa` совместно с автором изменения |
| Конфигурация сборки, installer/runtime/smoke scripts | Native ABI, Windows-пакет и NSIS | `release` |

`architect` анализирует изменения между слоями и готовит контракты. `reviewer` независимо проверяет реализацию и риски. Обе роли работают в режиме чтения. Подробные определения: `.codex/agents/*.toml`; каталог и примеры запросов: `docs/subagents.md`.

## Работа с субагентами

- Для задачи с независимыми частями делегируй их подходящим ролям. Для небольшой локальной правки используй одного исполнителя; не запускай весь каталог для каждой задачи.
- Главный агент задает каждому исполнителю цель, конкретные файлы для записи, входные контракты, критерии готовности и проверки. Чтение смежных файлов разрешено.
- Один файл одновременно редактирует один исполнитель. Особенно согласуй `src/domain/types.ts`, `src/domain/ports.ts`, `src/shared/ipc.ts`, `src/main/index.ts`, `package.json`, lockfile и общие тесты.
- Контракты, миграции и зависимые правки выполняй последовательно. Параллельное чтение и независимые правки допустимы.
- Главный агент координирует запуск; дочерние роли не создают вложенные команды без явного задания. Число активных субагентов ограничено тремя в `.codex/config.toml`.
- Назначь одного владельца сборок и запуска тестов, использующих общие артефакты. `build`, native rebuild, Electron E2E и упаковку не запускай одновременно с зависимыми проверками.
- Перед завершением собери результаты всех назначенных задач, проверь интеграцию и сообщи выполненные проверки и ограничения. Модель, effort и разрешения исполнительных ролей наследуются из родительской сессии.

## Проектные skills

Skills обнаруживаются в `.agents/skills/`. Перед профильной задачей прочитай только подходящий `SKILL.md`; ссылки и примеры — в [docs/skills.md](docs/skills.md). Основные привязки также указаны в TOML субагентов.

| Задача | Skill |
| --- | --- |
| Сквозная функция, очередь, состояния интервью | `work-search-feature` |
| Main/preload, IPC, Windows-окна и hotkeys | `work-search-electron-ipc` |
| React, формы, оверлей и CSS | `work-search-react-ui` |
| AI delivery, streaming, reconnect и outbox | `work-search-ai-recovery` |
| Capture, PCM, Whisper и скорость STT | `work-search-audio-stt` |
| SQLite, миграции, шифрование и диагностика | `work-search-sqlite` |
| Воспроизведение регрессии и запуск проверок | `work-search-testing` |
| Windows build/pack/dist и комплектность пакета | `work-search-release` |

`architect` и `reviewer` применяют анализ/критерии skills в рамках своего режима чтения. Навык не расширяет назначенную область записи и не запускает автоматически live-проверки. Для проверки актуального Codex RPC используй доступный `openai-docs`; для работы с UI через компьютер — доступный `computer-use:computer-use`. Профильные security skills выбирай при запросе security-review/audit, а не для любой обычной правки.

## Сохраняемые свойства продукта

- Domain опирается на порты. React получает `AppSnapshot` и отправляет `DesktopCommand`; Node, файловая система, SQLite и сетевые AI-клиенты остаются за границей renderer.
- IPC проверяет sender/frame и строгие Zod-схемы. Сохраняй sandbox, context isolation, отключенный node integration, CSP и ограниченные разрешения capture-контекста.
- Очередь FIFO резервирует слот до доступа к устройствам. Используй `MAX_OUTSTANDING` и `MAX_RECORDING_MS` из domain; более поздний вопрос не обгоняет ранний. STT и AI могут идти одновременно, внутри каждого этапа — одна операция.
- Частичный захват и ошибка STT требуют проверки текста; пустой звук не отправляется. Ручной вопрос работает без STT-модели. Отмена сохраняет историю; редакция вопроса создает ревизию.
- Провайдер, модель, endpoint и профиль фиксируются на интервью. Проверка настроек использует отдельный транспорт и не прерывает активный ответ.
- Outbox записывается до отправки. Неопределенная доставка и обрыв соединения не означают успешную отмену или разрешение повторить генерацию. Cloud replay и local thread history имеют разные контракты восстановления.
- Аудио остается в RAM и локальном Whisper. Содержательные данные SQLite и токены шифруются; не добавляй plaintext fallback. Диагностика не содержит речь, тексты интервью, токены и сырые RPC/CLI-ответы.
- Сохраняй аутентификацию локального App Server, ограничение его инструментов и завершение только собственного дерева процессов. Настройки агентов разработки не должны включать инструменты в runtime интервью.
- Пользовательские записи, авторизация и установленные приложения не являются тестовыми фикстурами. Используй временные профили и синтетические данные.
- Изменяй эти свойства только когда задача явно требует изменения соответствующего поведения, с согласованными контрактами, проверками и документацией.

## Команды проверки

Требования: Node >=22.12 и pnpm из `packageManager` в `package.json`. Зависимости устанавливаются через pnpm; проверяй доступность менеджера в текущем shell. В проекте нет команды lint.

| Изменение | Проверка |
| --- | --- |
| TypeScript и общие контракты | `pnpm typecheck` |
| Domain/controller | `pnpm exec vitest run tests/domain.test.ts tests/controller-start.test.ts tests/controller-recovery.test.ts` |
| AI | `pnpm exec vitest run tests/ai-client.test.ts tests/local-codex.test.ts tests/provider-router.test.ts tests/codex-discovery.test.ts` |
| Audio/STT | `pnpm exec vitest run tests/audio.test.ts tests/audio-capture.test.ts tests/stt.test.ts` |
| SQLite/диагностика | `pnpm exec vitest run tests/storage.test.ts tests/diagnostics.test.ts` |
| Windows-окна/сочетания | `pnpm exec vitest run tests/window-manager.test.ts` |
| Обычная unit/integration-серия | `pnpm test` |
| Скрипты внешнего сервиса | `node --test service-integration/codex-manager/scripts/provision-interview-assistant.test.mjs` |
| Сборка | `pnpm build` (включает typecheck) |
| React UI | После build: `pnpm exec playwright test e2e/ui-renderer.spec.ts` |
| Electron E2E | После build и подготовки Electron ABI: `pnpm test:e2e`; полная серия включает browser UI и требует Chromium |
| Упакованное приложение | `pnpm run pack`, затем `pnpm test:packaged` |
| Установщик NSIS | `pnpm run dist`, когда создание установщика входит в задачу |

Запускай проверки по измененному поведению. Для правок только документации/конфигурации агентов проверяй формат, пути и согласованность инструкций; сборка приложения обычно не нужна. Для исправления ошибки добавляй тест наблюдаемой регрессии, а не копию реализации. После успешных проверок не повторяй их без новых изменений или причин.

### Native SQLite и условия E2E

`better-sqlite3` зависит от ABI: после `pnpm run rebuild`, `pack` или `dist` модуль подготовлен для Electron. Для Node/Vitest-тестов хранения используй `npm rebuild better-sqlite3`; перед следующим запуском Electron — `pnpm run rebuild`. Это точечная пересборка, не установка зависимостей через другой менеджер. Не выполняй эти операции одновременно с тестами других агентов. Указывай оставленное состояние ABI в отчете.

Для browser E2E нужен Chromium: при отсутствии установленного runtime — `pnpm exec playwright install chromium --only-shell`. `e2e/ui-renderer.spec.ts` также поддерживает `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Vitest настроен с `fileParallelism=false`, Playwright — с `workers=1`. Перед полной серией проверь унаследованные opt-in переменные: они могут включить native/live-тесты без изменения самой команды. Для диагностики из корня проекта доступен `node .agents/skills/work-search-testing/scripts/preflight.mjs`; он не устанавливает зависимости и не меняет ABI.

- Реальный STT: `WHISPER_TEST_BINARY_DIRECTORY` и `WHISPER_TEST_MODEL_DIRECTORY` для `tests/stt.native.test.ts`; используй проверенные ресурсы и RU/EN fixtures.
- Скрытый capture E2E: `WORK_SEARCH_TEST_MODEL` — абсолютный путь к проверенному `ggml-small.bin`; также нужны проверенные бинарники в `resources/whisper`. Тест использует искусственный микрофон.
- Native Codex: `RUN_LOCAL_CODEX=1` для native-тестов и `e2e/local-provider.spec.ts`. Они отправляют синтетические запросы с реальной ChatGPT-авторизацией; запускай при наличии поручения на такую проверку. Local-provider E2E всегда использует свежий `release/win-unpacked`, поэтому ему нужен `pnpm run pack`, а не только build. `WORK_SEARCH_TEST_PACKAGED=1` также переключает первый `electron.spec.ts` на пакет.
- Native hotkeys: `WORK_SEARCH_TEST_NATIVE_HOTKEYS=1` требует интерактивный Windows desktop и реальное управление фокусом.
- `scripts/benchmark-providers.mjs --run` требует пакет, использует реальную авторизацию, для cloud читает пользовательскую SQLite и копирует зашифрованный токен; он обновляет benchmark-отчет. `--apply`/`--issue-key` в service-integration меняют внешнюю систему; даже preview без `--apply` выполняет POST quota/refresh. Выполняй эти команды только в рамках явно порученной проверки или операции, учитывая уже полученное разрешение. Для локальной проверки provision-логики запускай отдельный `node --test` с mock API.

Не объявляй skipped-тест пройденным. Синтетическое аудио, регистрация hotkey и проверка window flags не заменяют приемку физического loopback, доставки клавиш и демонстрации экрана на Windows. Packaged smoke допускает отсутствующую STT-модель и не проверяет получение AI-ответа. Отдельная установка NSIS также не подтверждается одним packaged smoke.

## Результат задания

Кратко сообщи: что изменилось для пользователя; затронутые файлы и контракты; точные выполненные проверки; ошибки/пропуски и оставшиеся ограничения. Для ревью сначала приведи подтвержденные дефекты с файлами и строками. Не включай секреты, сырые логи и исторические результаты под видом текущих.
