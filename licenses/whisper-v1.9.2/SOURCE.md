# Whisper CPU / ggml

`LICENSE` is copied verbatim from whisper.cpp v1.9.2, commit
`306c88f4d1286aec1bf96e544632897886af5501`:
https://raw.githubusercontent.com/ggml-org/whisper.cpp/306c88f4d1286aec1bf96e544632897886af5501/LICENSE

SHA256: `94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d`.
The bundled ggml sources are part of this repository tree, covered by its
MIT license (copyright 2023–2026 The ggml authors); there is no separate
`ggml/LICENSE` in this pinned tree. The CPU distribution excludes CUDA,
Vulkan, OpenBLAS and model weights. Archive provenance and SHA256 are pinned
in `scripts/setup-whisper.ps1` and `scripts/check-release-resources.mjs`.

Additional embedded CPU/server components:

- `httplib-LICENSE`: https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.20.0/LICENSE
  (version identified in the pinned `examples/server/httplib.h`).
- `json-LICENSE`: https://raw.githubusercontent.com/nlohmann/json/v3.11.2/LICENSE.MIT
  (version identified in the pinned `examples/json.hpp`). `json-NOTICE` preserves
  its unique SPDX copyright lines. This header also acknowledges Abseil code
  under Apache 2.0; `Apache-2.0-LICENSE` is the verbatim text from
  https://www.apache.org/licenses/LICENSE-2.0.txt.
- `llamafile-LICENSE`: verbatim leading license comment from the pinned
  `ggml/src/ggml-cpu/llamafile/sgemm.cpp` (Mozilla Foundation, MIT).
- `stb_vorbis-LICENSE`: verbatim trailing license block from the pinned
  `examples/stb_vorbis.c` (Sean Barrett, MIT or public domain).

Source header URLs use the same commit above, e.g.
https://raw.githubusercontent.com/ggml-org/whisper.cpp/306c88f4d1286aec1bf96e544632897886af5501/examples/json.hpp
All files here are copied into binary notices by the release generator.
