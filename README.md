# dsh-local-voice

**Local multi-model voice input for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** It runs Whisper, Parakeet v3 and Moonshine fully offline, covering French and 99 other languages.

> [!IMPORTANT]
> **This is an add-on to DeepSeek Harness's built-in voice input. It does not work on its own.**
> First enable the official **Voice input** bundle (`@deepseek-ai/dsh-experimental-voice-input-bundle`) on the **Plugins** page.
> That bundle provides the microphone button, the model picker and the speech-to-text service. This plugin only adds more models to it.
> If the official bundle is off, this plugin stays in the **"Waiting for dependencies"** state.

## Why

The built-in voice input only ships SenseVoice, which covers Chinese, English, Japanese, Korean and Cantonese. This plugin adds well-known open models to the **same model picker** and the **same microphone button**. Audio never leaves your machine.

## Models

| Model | Languages | Download | Best for |
|---|---|---|---|
| **Parakeet TDT 0.6B v3** *(recommended)* | 25 European languages, auto-detected | ~670 MB | Fast, accurate French/English/German/Spanish… on CPU |
| Whisper Tiny | 99 | ~105 MB | Low-end machines |
| Whisper Base | 99 | ~160 MB | Low-end machines |
| Whisper Small | 99 | ~375 MB | Good balance |
| Whisper Medium | 99 | ~945 MB | Accuracy |
| Whisper Large v3 Turbo | 99 | ~1.0 GB | Accurate and faster than Large |
| Whisper Large v3 | 99 | ~1.8 GB | Maximum accuracy, slow |
| Moonshine Base | English | ~290 MB | Very fast English |

The models are the int8 ONNX exports published by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Every file is pinned to a Hugging Face commit and checked for exact size and SHA-256 before use. [HF-Mirror](https://hf-mirror.com) is used as a fallback source.

## Features

- **Model choice**: models appear in the voice-input model picker, with download progress.
- **Custom models**: use any sherpa-onnx Whisper, NeMo transducer or Moonshine model you already have on disk.
- **Custom words**: names and jargon such as "DeepSeek" or "Kubernetes" are fixed by fuzzy matching (for example, "deep seek" becomes "DeepSeek").
- **Replacements**: exact whole-word substitutions, for example "new line" becomes a line break.
- **Filler-word removal**: removes "um", "uh", "euh", "hum" and similar.
- **Translate to English**: available with Whisper, except Turbo.
- **Auto-unload**: the model is released after 5 minutes of inactivity (configurable).

## Installation

1. **Prerequisite:** in DeepSeek Harness, open **Plugins** and enable the official **Voice input** bundle.
2. On the same page, install this bundle from GitHub:
   ```
   github:valthvn/dsh-local-voice
   ```
   You can also use the CLI: `dsh plugin --profile desktop install github:valthvn/dsh-local-voice`
3. In a session, click the microphone and open the model picker. Choose a model (for example **Parakeet TDT 0.6B v3**) and a language, then start the preparation. The model is downloaded once.

## Configuration

Add overrides to your profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/`):

```yaml
- id: speech-to-text-local-voice
  config:
    models: [parakeet-v3, whisper-small, whisper-turbo]   # catalog models offered in the picker
    removeFillerWords: true
    customWords: [DeepSeek, Kubernetes]
    replacements:
      "new line": "\n"
      "new paragraph": "\n\n"
    translateToEnglish: false
    threads: 4
    idleTimeoutMs: 300000
    customModels:
      - id: my-whisper
        name: My fine-tuned Whisper
        family: whisper
        directory: C:/models/my-whisper
        files: { encoder: encoder.int8.onnx, decoder: decoder.int8.onnx, tokens: tokens.txt }
        languages: [auto, fr, en]
        translate: true

# Default model and language of the microphone button (official speech-to-text service):
- id: speech-to-text
  config:
    defaultProvider: local-parakeet-v3
    language: auto
```

Catalog ids are `parakeet-v3`, `whisper-tiny`, `whisper-base`, `whisper-small`, `whisper-medium`, `whisper-turbo`, `whisper-large-v3` and `moonshine-base-en`. Each one is registered as provider `local-<id>`, for example `local-parakeet-v3`.

Models are stored in `~/.dsh/speech-to-text/local-voice/models/`.

## Testing outside DeepSeek Harness

```
npm install
node test/e2e.mjs whisper-tiny path/to/recording.wav fr /absolute/data/dir
```

The script downloads and verifies the model, then prints the transcript. It expects a 16 kHz mono PCM16 WAV file.

## Limitations

- CPU only, like the built-in provider. Supported platforms are Windows x64, macOS (arm64/x64) and Linux glibc (arm64/x64).
- Transcription starts when recording stops. There is no streaming.
- Parakeet v3 detects the language by itself and ignores the language hint.

## License

MIT. Parts of the host and worker code are derived from `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` (MIT, © 2026 DeepSeek). The models keep their own licenses: Whisper is MIT, Parakeet is CC-BY-4.0 and Moonshine is MIT.

This project is not affiliated with DeepSeek.
