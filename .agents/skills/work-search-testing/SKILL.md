---
name: work-search-testing
description: "Выбирать и выполнять проверки Work Search: Vitest, browser/Electron Playwright, native SQLite ABI, фикстуры и opt-in native-тесты. Использовать для воспроизведения регрессий, проверки реализации или ошибок тестовой среды."
---

# Проверка изменения

Выбери проверку по наблюдаемому поведению и [матрице AGENTS.md](../../../AGENTS.md). Прочитай сам тест перед запуском: одно имя e2e не означает одинаковые зависимости или доступ к сервису.

## Сначала проверь среду

Из корня проекта можно выполнить:

```powershell
node .agents/skills/work-search-testing/scripts/preflight.mjs
```

Скрипт показывает Node, ожидаемый pnpm, наличие локальных инструментов, загрузку SQLite в текущем Node и наличие сборочных артефактов. Он создает только in-memory SQLite; ничего не устанавливает, не перестраивает, не запускает Electron и не читает пользовательскую БД/секреты. Наличие артефакта не подтверждает его свежесть. Отрицательная Node-проверка SQLite не доказывает готовность Electron ABI.

## Выбери минимальный уровень

| Проверяемое поведение | Инструмент | Ограничение результата |
| --- | --- | --- |
| FIFO, отмена, controller recovery | Vitest + fake ports/MemoryStore | Не проверяет реальные процессы/устройства |
| AI transport | Vitest + тестовый WS/RPC | Не подтверждает live-сервис или авторизацию |
| Формат SQLite/миграция | Vitest + временная БД | Требует Node ABI; cipher тестовый |
| React и команды UI | e2e/ui-renderer.spec.ts | Нужны свежая сборка и Chromium; DesktopApi подменен |
| Main/preload, окна, IPC | Electron E2E | Нужны сборка и Electron ABI; полная test:e2e включает и browser UI, которому нужен Chromium |
| Комплектность пакета и DPAPI | test:packaged | Нужен актуальный win-unpacked; missing-модель допустима, ответ AI и установка NSIS не проверяются |
| Provision-скрипт сервиса | node --test service-integration/... | Не входит в pnpm test; проверяет mock admin API |

`pnpm typecheck` полезен для TS-контрактов. При точечной регрессии запусти относящиеся файлы через `pnpm exec vitest run ...` или `pnpm exec playwright test ...`; расширяй серию, когда изменение затрагивает общие контракты. Текстовая/CSS-правка без новой логики не требует теста, копирующего разметку.

## Порядок при нескольких runtime

Только один исполнитель управляет rebuild/build/E2E. Сначала Node-проверки; если SQLite не загружается из-за ABI, `npm rebuild better-sqlite3`, затем выбранные Vitest. Для Electron — `pnpm run rebuild`, build и нужный E2E. Для browser-only UI-теста Electron rebuild не требуется. Возврат к Node-тестам хранения после Electron снова требует Node rebuild.

До полной серии проверь унаследованные переменные: `RUN_LOCAL_CODEX=1` включает реальные запросы даже в `pnpm test`; `WHISPER_TEST_*` включает native STT. Для обычного прогона запускай процесс с нужным окружением, не меняя постоянные пользовательские настройки. Не включай opt-in флаги автоматически ради зеленого отчета. Если нужные ресурсы уже подготовлены и проверка поручена, используй их без повторного запроса того же разрешения.

`e2e/local-provider.spec.ts` при `RUN_LOCAL_CODEX=1` всегда использует win-unpacked, поэтому требует свежий pack. `WORK_SEARCH_TEST_PACKAGED=1` также переключает первый electron.spec на пакет. Hidden-capture E2E требует и WORK_SEARCH_TEST_MODEL, и проверенные бинарники resources/whisper. Benchmark --run и даже preview provision без --apply имеют внешние побочные эффекты; условия — в AGENTS.md.

Отчет: точная команда, фактические passed/failed/skipped, причина пропуска, состояние ABI и что результат не проверял. Историческая приемка не заменяет текущий прогон.
