# Разработка Work Search

Проект ориентирован на Windows 11 x64. Пользовательский интерфейс и основная документация — на русском языке. Ошибки и предложения можно обсуждать в GitHub Issues; уязвимости сообщайте по [SECURITY.md](SECURITY.md).

## Подготовка

1. Клонируйте репозиторий и откройте PowerShell в его корне.
2. Установите Node.js версии из `engines` и pnpm версии из `packageManager` в [package.json](package.json). Проверьте `node --version` и `pnpm --version`.
3. Для сборки native SQLite нужны Visual Studio Build Tools с C++ Desktop и Python.
4. Прочитайте [архитектуру](docs/architecture.md) и [AGENTS.md](AGENTS.md).

```powershell
pnpm install --frozen-lockfile
node .agents/skills/work-search-testing/scripts/preflight.mjs
pnpm test
node --test service-integration/codex-manager/scripts/provision-interview-assistant.test.mjs
pnpm build
pnpm exec playwright install chromium --only-shell
pnpm exec playwright test e2e/ui-renderer.spec.ts
```

Если SQLite собран для Electron, перед Node-тестами выполните `npm rebuild better-sqlite3`. Это точечная пересборка native-модуля; зависимости и lockfile поддерживаются через pnpm. В проекте нет команды lint. Обычные mock-тесты не требуют токена AI, модели Whisper или доступа к физическим устройствам.

Для запуска desktop-приложения подготовьте ресурсы и Electron ABI:

```powershell
pnpm setup:whisper
pnpm setup:runtime
pnpm run rebuild
pnpm dev
```

Настройка AI и загрузка STT-модели выполняются в приложении. Скачать VC++ runtime скриптом и установить его в Windows — разные действия. Подробнее — в [README](README.md).

## Изменения и проверки

Создайте ветку, опишите наблюдаемое поведение до и после изменения. Для ошибки добавьте регрессионную проверку. Используйте матрицу [AGENTS.md](AGENTS.md), чтобы выбрать проверки по изменённому слою. Для документации проверьте пути, команды и ссылки; сборка обычно не нужна.

Перед pull request укажите:

- проблему, сценарий воспроизведения и результат изменения;
- изменения IPC, сохранённых данных или поведения восстановления, если они есть;
- точные команды проверок и их результаты, включая skipped;
- ограничения ручной приёмки и оставленное состояние SQLite ABI.

Публичные изменения проверяет [Windows CI](.github/workflows/ci.yml): `check:publication`, Node-тесты, mock provision, JS-сборку и browser UI, затем подготовку release-ресурсов, pack, packaged smoke и Electron-тесты на mock AI. Порядок сохраняет Node ABI до unit-тестов и переключает его на Electron перед desktop-проверками. CI не подтверждает установку NSIS, реальные аудиоустройства, авторизацию AI и защиту при демонстрации экрана. Проверка зависимостей и Gitleaks по полной доступной истории запускаются отдельными заданиями; найденные уязвимости и секреты блокируют их до исправления.

## Данные и внешние операции

Используйте временный профиль и синтетические данные. Не прикладывайте токены, `.env`, пользовательскую SQLite, историю Codex, реальные интервью, сырые RPC-ответы или аудиозаписи к публичным issues и тестам. Для dev/unpackaged Electron используйте отдельный `WORK_SEARCH_USER_DATA`, для packaged-приложения — `--user-data-dir`; условия готовых сценариев описаны в AGENTS.md.

Проверьте унаследованные `RUN_LOCAL_CODEX`, `WHISPER_TEST_*` и `WORK_SEARCH_TEST_*` перед запуском: они могут включить проверки с настоящей авторизацией или устройствами. Не включайте их ради устранения skipped. `scripts/benchmark-providers.mjs --run` использует пользовательскую авторизацию; provision даже без `--apply` обновляет квоты во внешнем сервисе. Эти команды не являются обычным локальным тестом.

Изменения вносите с сохранением прав на собственный вклад и совместимости с [MIT](LICENSE). Для добавляемых ресурсов укажите источник и лицензию; условия стороннего кода не заменяются лицензией проекта.
