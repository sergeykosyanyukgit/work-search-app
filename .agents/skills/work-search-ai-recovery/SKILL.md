---
name: work-search-ai-recovery
description: "Диагностировать и изменять доставку AI-запросов Work Search: cloud WebSocket и local Codex RPC, outbox, reconnect, отмену, streaming и восстановление без повторной генерации."
---

# Доставка и восстановление AI

Начни с [docs/local-codex.md](../../../docs/local-codex.md), `src/adapters/ai/provider-router.ts` и конкретного адаптера. При изменении Codex RPC сверяй протокол с установленной версией и официальной документацией OpenAI; доступный `openai-docs` помогает этой проверке. Не подменяй фактический контракт протоколом другой версии.

## Выбери правильную модель восстановления

| Свойство | cloud | local |
| --- | --- | --- |
| Реализация | codex-manager.ts | local-codex.ts, codex-rpc.ts, local-protocol.ts |
| Идентичность | sessionId, clientRequestId, sequence | threadId, turnId, clientUserMessageId/clientId |
| После обрыва | Сверка удаленной сессии и replay/cursor | thread/resume и пагинированная история turns/items |
| Текст | Полный item.text заменяет блок | Дельты внутри item ID, снимок заменяет блок |
| Неизвестная доставка | Не переносить автоматически в новую session | Не отправлять повторный turn/start без сверки истории |

## Воспроизведи сбой на границе

Выбери момент: до записи outbox, после записи до отправки, после отправки до acknowledgement, во время partial, при terminal или при ранней отмене. Зафиксируй сохраненные request/turn ID, статус вопроса и число исходящих команд на тестовом транспорте. Не включай содержимое вопроса/токенов в диагностический лог.

Сначала outbox с неизменным payload, затем отправка. Для восстановления ищи доказательство доставки/завершения. Временная пустая история после turn/start и «no active turn to interrupt» могут требовать ограниченной повторной сверки; это не разрешение начать вторую генерацию. Если подтверждения нет, сохраняй частичный ответ и состояние неопределенности, пока продукт не получит явный ручной retry/новое интервью.

Сопоставляй local-запрос по turnId или userMessage.clientId, не по совпадению текста; прочитай все страницы истории. Для cloud учти, что pong завершает handshake до фильтрации повторного sequence, а некоррелированный protocol.error не подтверждает отмену. Проверь атомарность ответа и курсора, снятие outbox только по подтвержденному исходу и блокировку последующих вопросов. После подключения controller может уже видеть восстановленный final: повторный send тогда не нужен.

При изменении streaming повтори полный item дважды, чередуй items и заверши finalResponse; текст не должен удваиваться. Отдельно проверь исключение reasoning/служебных сообщений и независимость probe от активного turn.

## Проверка и измерение

Используй назначенные сценарии `tests/ai-client.test.ts`, `tests/local-codex.test.ts`, `tests/provider-router.test.ts` и `tests/controller-recovery.test.ts`. Discovery отдельно проверяется `tests/codex-discovery.test.ts`.

Для профилей прочитай [service-integration/README.md](../../../service-integration/README.md) и запускай отдельные `node --test` проверки скриптов. Исходники manager/worker в этом репозитории отсутствуют; копирование provision-скрипта не меняет серверный runtime.

Live Codex, benchmark --run и серверные mutations имеют разные условия из [AGENTS.md](../../../AGENTS.md). Даже preview provision-скрипта без --apply делает POST quota/refresh; это внешняя операция, а не офлайн-проверка. Benchmark требует пакет, читает пользовательскую SQLite для копирования зашифрованного cloud-токена и обновляет файл отчета. Для latency сравнивай одинаковые модель, профиль и путь по [docs/latency.md](../../../docs/latency.md); первый текст, полный ответ, холодный и повторный запросы показывай отдельно.
