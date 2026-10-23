---
name: work-search-electron-ipc
description: "Добавлять и проверять IPC-команды, preload, окна, горячие клавиши и жизненный цикл Electron в Work Search. Использовать для main/preload/shared IPC и Windows-взаимодействия; обычный React/CSS менять через skill UI."
---

# Electron: команда и граница процесса

Прочитай [архитектуру](../../../docs/architecture.md), `src/shared/ipc.ts`, `src/preload/index.ts` и нужный handler в `src/main/index.ts`.

## Изменение команды

1. Опиши допустимый payload и ошибку в `DesktopCommandSchema`. Схемы strict; ограничения ID, длины и URL должны проверяться до side effects.
2. Используй существующий `DesktopApi.command`, если операция помещается в него. Расширение самого preload API требуется только для нового способа взаимодействия.
3. Проведи команду через main к владельцу поведения. Проверка `windows.owns(event.sender.id)` и главного `senderFrame` применяется и к чтению данных.
4. Реши, нужна ли общая `commandChain`. Управление окнами и probe должны оставаться доступными во время длинной операции; изменения интервью не должны гоняться друг с другом.
5. Согласуй результат, snapshot и обработку ошибки в UI. Не передавай через IPC секреты или невалидированные сырые ответы адаптера.

Проверяй две разные границы: runtime Zod-validation и правильность wiring. TypeScript не проверяет команду от постороннего renderer.

## Изменение окон или разрешений

Уточни владельца: `WindowManager` для UI, `ElectronAudioCapture` и отдельный preload для capture. Настройки defaultSession не должны автоматически распространять доступ к микрофону на UI. Сохрани contextIsolation/sandbox, запрет Node, навигации и новых окон.

Для show/hide проверь скрытое, свернутое и ушедшее за экран окно; явный показ должен вернуть управление мышью. Для горячих клавиш проверь нормализацию и rollback регистрации при конфликте. Для закрытия проверь, что закрытие оверлея скрывает его, а app.quit освобождает ресурсы.

## Проверка

Используй `pnpm typecheck` и `tests/window-manager.test.ts`. Реальное IPC и оконное поведение проверяют `e2e/electron.spec.ts` и `e2e/window-controls.spec.ts`; для них нужны сборка и Electron ABI согласно [AGENTS.md](../../../AGENTS.md). Browser UI с подмененным DesktopApi не заменяет эти проверки.

Проверка регистрации hotkey не доказывает доставку клавиши сторонним foreground-приложением. Отчет различает автоматический результат и ручную приемку из [docs/acceptance.md](../../../docs/acceptance.md).
