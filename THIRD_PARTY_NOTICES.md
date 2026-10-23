# Сторонние компоненты и ресурсы

MIT из [LICENSE](LICENSE) относится к собственному коду Work Search и собственным синтетическим тестовым WAV. Сторонние компоненты сохраняют свои лицензии. Команда `pnpm licenses:generate` собирает полные тексты в `.cache/release-notices`; pack/dist включают этот каталог в `resources/notices`. При отсутствии, изменении или устаревании обязательных notices упаковка блокируется.

| Компонент | Происхождение и условия | Комплектация |
| --- | --- | --- |
| Production npm-граф | Фактические установленные версии из `pnpm-lock.yaml`; LICENSE/NOTICE/COPYING каждого пакета | Генератор рекурсивно собирает полные тексты и список пакетов в `npm-NOTICES.txt`. Отсутствие лицензионного файла блокирует генерацию |
| Electron и Chromium | Лицензии из `node_modules/electron/dist/LICENSE` и `LICENSES.chromium.html` | Копируются целиком, версия Electron сверяется перед упаковкой |
| Whisper CPU и ggml | [whisper.cpp v1.9.2](https://github.com/ggml-org/whisper.cpp/tree/v1.9.2), commit `306c88f4d1286aec1bf96e544632897886af5501`, MIT | Закреплённые тексты в [licenses/whisper-v1.9.2](licenses/whisper-v1.9.2/SOURCE.md), включая embedded httplib, json, Abseil/Apache 2.0, llamafile и stb_vorbis. Корневой LICENSE Whisper также копируется в его runtime-каталог |
| Модель Whisper Small | [OpenAI Whisper](https://github.com/openai/whisper#license): код и веса выпущены по MIT; ggml-конверсия из [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) | Модель скачивается отдельно или импортируется; SHA256 закреплён. Её лицензия включается в notices; веса не входят в стандартный установщик |
| Microsoft Visual C++ Redistributable | Официальный Microsoft v14 x64, загруженный `setup:runtime`; Microsoft Software License Terms | Пакет проверяет hash/manifest и действительную Microsoft Authenticode. Сам redistributable содержит условия Microsoft; применимые ссылки приведены ниже |
| RU/EN WAV | Собственные тексты, синтез eSpeak NG 1.52.0 встроенными формантными голосами | MIT Work Search; происхождение, параметры и SHA256 в [описании fixtures](tests/audio-fixtures/README.md). Синтезатор и его GPL-данные в приложение не включены |

## Подготовка выпуска

```powershell
pnpm setup:whisper
pnpm setup:runtime
pnpm licenses:generate
pnpm release:preflight
pnpm run pack
pnpm test:packaged
```

Изменение package.json, lockfile, собственной лицензии, этого документа или закреплённых upstream notices требует повторной генерации. Hook `beforePack` выполняет проверки и при прямом запуске electron-builder. В пакет входит также собственный LICENSE Work Search.

## Условия издателя

Проверка подписи подтверждает издателя бинарника, но не лицензионные права распространителя. Microsoft [ограничивает распространение VC++ Redistributable лицензированными пользователями Visual Studio](https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files); перед публикацией установщика издатель должен проверить применимость своей лицензии и [условия соответствующего runtime](https://visualstudio.microsoft.com/license-terms/). Work Search не предоставляет эту лицензию и не меняет условия Microsoft.

Прежние JFK/Irina WAV исключены из подготовленной локальной Git-истории. В ней оставлены только новые синтетические записи с проверенными SHA256. Резервная копия исходной истории хранится локально в игнорируемом `.cache` и не предназначена для публикации. Замена remote-ветки и проверка свежего clone описаны в [порядке публикации](docs/publication.md); без отправки очищенной ветки история на GitHub не меняется.
