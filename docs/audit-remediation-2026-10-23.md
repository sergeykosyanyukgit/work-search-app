# Исправления по аудиту Work Search

Дата: 23 октября 2026. Версия приложения остаётся 0.1.4. Исправления выполнены поверх исходного [аудита](audit-2026-10-23.md); первоначальные результаты сохранены отдельно и не выдаются за текущие.

**Результат:** исправлены технические замечания F01–F08, добавлены регрессионные проверки, собраны свежие Windows x64 пакет и NSIS. Итоговый audit зависимостей — 0 известных уязвимостей. Право конкретного издателя распространять Microsoft runtime определяется условиями Microsoft. Последующая подготовка локальной истории без прежних WAV описана в [порядке публикации](publication.md); исходные результаты проверок ниже сохранены как исторические.

## Что исправлено

| ID | Результат | Реализация и проверка |
| --- | --- | --- |
| F01 | Закрыто для текущего lockfile | Electron 44.9.3, electron-builder 26.15.3, Vite 7.3.7, Vitest 4.1.12; обновлены совместимые зависимости и `pnpm-lock.yaml`. В `pnpm-workspace.yaml` ограничены безопасные версии веток brace-expansion и http-cache-semantics. [Новый audit](audit-dependencies-remediated-2026-10-23.json): 0 high/moderate/low/critical |
| F02 | Техническая комплектация закрыта | Генератор собирает полные лицензии 91 production npm-пакета, Electron/Chromium, pinned Whisper/ggml и embedded библиотек, MIT весов Whisper и собственную MIT. Pack включает notices и блокируется при их отсутствии, изменении или устаревании. Условия издателя описаны в [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) |
| F03 | Закрыто | Контроллер сохраняет успешные STT-сегменты при ошибке следующей дорожки. Вопрос получает `partial` и `review`, доступный текст остаётся для проверки, AI не вызывается. Проверены оба варианта partial/full capture |
| F04 | Закрыто | Локальный уход не требует reconnect. Неопределённые запросы сохраняются в outbox; уход не утверждает их отмену. Idle cloud close ограничен 1 секундой. Epoch и identity-guards исключают изменение нового интервью поздними callbacks и завершением старого job |
| F05 | Закрыто | Восстановленные native items заполняют map блоков до следующих дельт. Регрессия проверяет два блока, продолжение, обрыв и последующую сверку без потери префикса |
| F06 | Закрыто | Настройки, токен, ручной вопрос и редакция очищаются только для подтверждённой отправленной версии. Новый ввод во время pending сохраняется; ошибки также не стирают черновик |
| F07 | Закрыто | Черновики редакций хранятся в RAM по interview ID/question ID и переживают смену вопроса, историю, новую запись и обычное переключение интервью. Удаление интервью очищает его черновики; поздний ответ команды их не восстанавливает |
| F08 | Закрыто | BeforePack и packaged smoke требуют точный pinned Whisper payload, manifest/hash, действительную Microsoft Authenticode VC++, полный и свежий комплект notices. NSIS прекращает установку при отсутствии/ошибке runtime. Проверка ресурсов не зависит от установленной STT-модели |

Исправлены также две проблемы, найденные при интеграции: наследование несовместимого `PSModulePath` от PowerShell 7 в Windows PowerShell 5 и CRLF-конвертация pinned лицензий в Windows clone. Setup импортирует системные модули из `$PSHOME`, Authenticode использует системный PowerShell и module-qualified команду; `.gitattributes` сохраняет `licenses/**` побайтово.

## Контракты и данные

Публичный IPC, `AppSnapshot`, `DesktopCommand`, SQLite schema/user_version и формат outbox не менялись. Изменены controller, cloud close и накопление local blocks, React-черновики, release scripts/config, зависимости и тесты. Новых plaintext-хранилищ, внешних инструментов AI или сетевых запросов renderer не добавлено.

Обычные UI-кнопки finish/new/resume сохраняют ограничение при незавершённых вопросах. Исправленный пользовательский offline-сценарий — уход после завершённого ответа. Контроллер дополнительно проверен при приостановке активного durable-запроса; это не означает появления новой UI-команды отмены/ухода.

После локального disconnect недоступная удалённая сессия может оставаться на сервере до завершения/expiry. При возобновлении её состояние сверяется по прежнему outbox. Это не разрешение автоматически повторить неопределённо доставленную генерацию.

## Аудиофикстуры

В текущем дереве JFK sample удалён, Windows Irina WAV заменён. Новые `en-question.wav`/`ru-question.wav` синтезированы eSpeak NG 1.52.0 из собственных текстов, встроенными формантными голосами без MBROLA, SAPI, микрофона или воспроизведения. Программа распакована только в игнорируемый `.cache`, в приложение не включена. Происхождение, команды, условия и SHA256 — в [описании fixtures](../tests/audio-fixtures/README.md).

Новые WAV проверены настоящим локальным Whisper Small на CPU, с проверенными SHA256 движка и модели. Ранние варианты русской синтетической речи не прошли проверку ключевых слов и были заменены. Финальная проверка допускает только удвоение «с» в «ассинхронность»; «синхронность» без отрицательного префикса не проходит. Это проверка интеграции на синтетической речи, а не оценка WER на реальных голосах.

## Выполненные проверки

Среда: Windows x64, Node 24.19.0, **закреплённый pnpm 11.19.0 через corepack**. `COREPACK_HOME` направлен в `.cache/corepack`, TEMP/TMP — в `.cache/audit-tmp`. Для сетевых mock-серверов, Chromium и native процессов использован запуск вне ограничений sandbox; реальные AI-сервисы и пользовательская история не использовались.

| Проверка | Результат |
| --- | --- |
| `corepack pnpm install --frozen-lockfile --ignore-scripts` после обновления | Успех, lockfile согласован. Это проверка установки в текущем checkout, не тест чистой Windows |
| `corepack pnpm audit --json` | Код 0, **0 известных уязвимостей**, все категории; полный graph, включая Electron как devDependency |
| `corepack pnpm test` с `WHISPER_TEST_BINARY_DIRECTORY=resources/whisper`, `WHISPER_TEST_MODEL_DIRECTORY=resources/models` (абсолютные пути) | **102 passed, 3 skipped**, 16 файлов прошли, 1 пропущен. Пропущены только native Codex с реальной авторизацией |
| `node --test service-integration/codex-manager/scripts/provision-interview-assistant.test.mjs` | **17 passed**, 0 skipped, mock API |
| `corepack pnpm build` / build внутри pack и dist | Успех, включая `tsc --noEmit`, production main/preload/renderer |
| `corepack pnpm exec playwright test e2e/ui-renderer.spec.ts` | **16 passed**, включая 4 новых сценария pending/переключения/удаления |
| `corepack pnpm setup:whisper`, `corepack pnpm setup:runtime` | Успех; закреплённый Whisper v1.9.2 и Microsoft runtime 14.51.36247.0; runtime только подготовлен, не установлен |
| `corepack pnpm run pack` | Успех: генерация notices, hash/signature preflight, сборка, Electron native rebuild, свежий win-unpacked |
| `corepack pnpm test:packaged` | Успех после pack и повторно после dist; ресурсы/notices, DPAPI, window protection, отдельный профиль, возврат окна, ручной вопрос. Отсутствующая модель в smoke допускается |
| `corepack pnpm test:e2e` с `WORK_SEARCH_TEST_MODEL` на проверенный `resources/models/ggml-small.bin` | **20 passed, 2 skipped**: synthetic capture/STT, mock AI streaming, IPC/history, browser UI, окна и регистрация hotkeys. Пропущены реальный local Codex и физическая доставка hotkeys при внешнем фокусе |
| `corepack pnpm run dist` | Успех: NSIS с изменённой макрокомандой скомпилирован; установщик не запускался |
| `git diff --check`, разбор YAML/PowerShell, проверка локальных ссылок и `git check-attr` | Успех; `licenses/**` и WAV имеют `text: unset`, core.autocrlf не меняет pinned байты |

Первый запуск browser-серии после обновления Playwright не нашёл новый Chromium; установлен требуемый runtime. Новый тест удаления первоначально объединял два snapshots до React commit; ожидание изменено на наблюдаемое удаление интервью. Финальные серии выше прошли после исправлений. Эти промежуточные отказы не скрыты как «пропущенные» тесты.

## Артефакты

- `release/win-unpacked/Work Search.exe` — свежий Windows x64 пакет.
- `release/Work-Search-Setup-0.1.4.exe` — **145 330 552 байта**, SHA256 `07ea31a43cef5a527be4e5d91c17e4d9ad37fbaffba531187e77495deecd8c9a`.
- Статус Authenticode установщика — **NotSigned**. Логи electron-builder о шаге signing не являются подтверждением цифровой подписи.

SQLite оставлен для **Electron ABI 149** (Electron 44.9.3, встроенный Node 24.22.0). Полная Node-серия выполнена до pack/dist. Перед следующим Node/Vitest storage-прогоном выполните `npm rebuild better-sqlite3`; перед Electron верните `pnpm run rebuild`.

## Что остаётся перед публикацией

- GitHub workflow расширен проверками pack/smoke/Electron после Node-тестов, но удалённый GitHub-run, branch protection и Private vulnerability reporting пока не выполнялись/не настраивались.
- Установку NSIS на чистой Windows, физический loopback, доставку hotkeys, реальные AI-провайдеры и результат демонстрации экрана нужно проверить отдельно. Синтетические тесты их не заменяют.
- Перед распространением bundled VC++ издатель должен убедиться в своих правах по условиям Microsoft. Автоматическая проверка подписи этого не доказывает.
- После этого этапа по отдельному поручению владельца подготовлена новая локальная история без прежних WAV. Приватная резервная копия исключена из публикации. История GitHub меняется только после явной отправки очищенной ветки; порядок и ограничения описаны в [инструкции](publication.md).
- Code signing и auto-update не добавлялись. Установщик не устанавливался, push, Release и изменение видимости GitHub не выполнялись.

Исправления controller/UI и release-пути независимо просмотрены reviewer. Найденные им retention черновиков и Windows line-ending проблемы устранены до завершения работы.
