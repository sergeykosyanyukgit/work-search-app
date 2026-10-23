---
name: work-search-audio-stt
description: "Разрабатывать и измерять аудиопайплайн Work Search: микрофон/loopback, MessagePort PCM, AudioWorklet, Whisper, отмену и ресурсы. Применять для ошибок захвата, транскрипции или задержки STT."
---

# Захват и распознавание

Проследи `src/capture/capture.ts` и `pcm-worklet.ts` → `src/preload/capture.ts` → `src/adapters/audio/electron-audio-capture.ts` → `src/adapters/stt/whisper-cpp.ts` → controller. Форматы задаются в audio `protocol.ts`, `pcm.ts` и `src/domain/types.ts`.

## Локализуй этап

- Нет данных: проверь пользовательскую активацию, выбранные sources, состояние start/stop и завершение tracks во время старта.
- Поврежденная/сдвинутая дорожка: проверь recordingId, sequence, sampleRate, четное число байт PCM16, offset и общий отсчет microphone/system.
- Некорректный текст: проверь тишину, настройки языка и ответ Whisper с временными метками. `whisper-response.ts` ограничивает сегменты длиной track и прибавляет offset; timestamps входного ответа выражены в секундах.
- Долгая обработка: отдели готовность процесса/модели, STT каждой дорожки, очередь приложения и AI. Не приписывай сетевое ожидание Whisper.

При потере пакета не достраивай звук или timestamps предположениями. Ошибка/частичный захват должны сохранять возможность ручной проверки текста. Cancel освобождает память, порты и tracks; поздний пакет другой записи не должен восстанавливать завершенную операцию.

## Изменение Whisper или ресурсов

Сверь версии, SHA256 и пути в `src/adapters/stt/resources.ts` и `scripts/setup-whisper.ps1`. Изменение бинарников/модели должно быть согласовано с setup и упаковкой. Проверенные ресурсы не заменяются фикстурами с тем же именем.

Для оптимизации используй репозиторные RU/EN WAV по [tests/audio-fixtures/README.md](../../../tests/audio-fixtures/README.md). Зафиксируй CPU, число потоков, язык, версию модели/runtime, холодный/прогретый запуск, длительность и нормализованный текст. Изменяй один влияющий параметр за сравнение. Если качество меняется, показывай это вместе с ускорением. Две фикстуры не доказывают качество на всей речи.

## Проверка

`tests/audio.test.ts`, `tests/audio-capture.test.ts`, `tests/stt.test.ts` проверяют формат, изоляцию capture и поведение STT. Реальный Whisper — `tests/stt.native.test.ts` с двумя переменными ресурсов из [AGENTS.md](../../../AGENTS.md). Hidden-capture E2E использует `WORK_SEARCH_TEST_MODEL` и синтетический микрофон; физический loopback требует отдельной приемки.

Аудио/WAV остаются в памяти. Для отладки используй метаданные этапов и синтетические fixtures; stdout/stderr Whisper могут содержать распознанную речь и не подходят для журнала.
