# Whisper Small model weights

OpenAI Whisper states that its code and model weights are released under MIT:
https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/README.md#license

`LICENSE` is copied verbatim from:
https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE

Commit: `86098128c0b4f24f0e2aa2994de830614b474227`.
LICENSE SHA256: `b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d`.

The application downloads or imports the multilingual Small model converted
to ggml format by whisper.cpp:
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

Accepted weights SHA256:
`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.
Weights are prepared separately and are not part of the application installer.
The packaged notices include this license for the downloaded/imported model;
`setup-whisper.ps1 -IncludeModel` also stages this LICENSE and source information
beside the model. The whisper.cpp engine has its own separate license notices.
