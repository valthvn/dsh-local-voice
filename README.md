# dsh-local-voice

**Saisie vocale locale multi-modèles pour [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** : Whisper, Parakeet v3 et Moonshine, 100 % hors ligne, en français et dans 99 autres langues.

*English below.*

La saisie vocale officielle de DeepSeek Harness n'utilise que SenseVoice (chinois, anglais, japonais, coréen, cantonais). Ce plug-in ajoute d'autres modèles au **même sélecteur de modèle** et au **même bouton micro**. Rien n'est envoyé dans le cloud.

## Modèles

| Modèle | Langues | Téléchargement | Pour qui |
|---|---|---|---|
| **Parakeet TDT 0.6B v3** *(recommandé)* | 25 langues européennes, détection auto | ~670 Mo | Français et anglais rapides et précis sur CPU |
| Whisper Tiny | 99 | ~105 Mo | Petites machines |
| Whisper Base | 99 | ~160 Mo | Petites machines |
| Whisper Small | 99 | ~375 Mo | Bon compromis |
| Whisper Medium | 99 | ~945 Mo | Précision |
| Whisper Large v3 Turbo | 99 | ~1,0 Go | Précis et plus rapide que Large |
| Whisper Large v3 | 99 | ~1,8 Go | Précision maximale, lent |
| Moonshine Base | anglais | ~290 Mo | Anglais ultra rapide |

Les modèles proviennent de [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (versions ONNX int8). Chaque fichier est figé sur un commit Hugging Face et vérifié (taille + SHA-256) avant utilisation. Un miroir (`hf-mirror.com`) sert de solution de repli.

## Fonctionnalités

- **Choix du modèle** dans le sélecteur de la saisie vocale, avec progression du téléchargement.
- **Modèles personnalisés** : n'importe quel modèle sherpa-onnx (Whisper, NeMo transducer, Moonshine) déjà présent sur le disque.
- **Mots personnalisés** : les noms propres et le jargon (« DeepSeek », « Kubernetes ») sont corrigés par correspondance approximative.
- **Remplacements** : par exemple « point à la ligne » devient un saut de ligne.
- **Suppression des hésitations** (« euh », « hum », « um », « uh »…).
- **Traduction vers l'anglais** (Whisper, sauf Turbo).
- **Déchargement automatique** du modèle après 5 minutes d'inactivité (réglable).

## Installation

1. Dans DeepSeek Harness, ouvrez **Plugins** et activez le bundle officiel **Saisie vocale** (il fournit le bouton micro).
2. Toujours dans **Plugins**, installez ce bundle depuis GitHub :
   ```
   github:valthvn/dsh-local-voice
   ```
   ou en ligne de commande : `dsh plugin --profile desktop install github:valthvn/dsh-local-voice`
3. Cliquez sur le micro, choisissez par exemple **Parakeet TDT 0.6B v3** et la langue **Français**, puis lancez la préparation (téléchargement unique).

## Configuration

Dans le fichier `cordis.patch.yml` de votre profil (`~/.dsh/profiles/<profil>/`) :

```yaml
- id: speech-to-text-local-voice
  config:
    models: [parakeet-v3, whisper-small, whisper-turbo]   # modèles proposés
    removeFillerWords: true
    customWords: [DeepSeek, Kubernetes, Valentin]
    replacements:
      "point à la ligne": "\n"
      "nouveau paragraphe": "\n\n"
    translateToEnglish: false
    threads: 4
    idleTimeoutMs: 300000
    customModels:
      - id: my-whisper
        name: Mon Whisper fine-tuné
        family: whisper
        directory: C:/models/my-whisper
        files: { encoder: encoder.int8.onnx, decoder: decoder.int8.onnx, tokens: tokens.txt }
        languages: [auto, fr, en]
        translate: true

# Modèle et langue par défaut du bouton micro :
- id: speech-to-text
  config:
    defaultProvider: local-parakeet-v3
    language: fr
```

Les identifiants de provider sont `local-<modèle>` : `local-parakeet-v3`, `local-whisper-small`, etc.

Les modèles sont stockés dans `~/.dsh/speech-to-text/local-voice/models/`.

## Limites

- Fonctionne sur CPU uniquement (comme le plug-in officiel). Plateformes : Windows x64, macOS, Linux glibc.
- La transcription démarre à la fin de l'enregistrement (pas de streaming).
- Parakeet v3 détecte la langue tout seul : l'indice de langue est ignoré.

---

## English

Local multi-model voice input for DeepSeek Harness. It adds Whisper (tiny → large-v3), NVIDIA Parakeet TDT 0.6B v3 (25 European languages) and Moonshine (English) to the official voice-input model picker. It also offers custom words (fuzzy correction), exact replacements, filler-word removal, Whisper translation to English, and custom sherpa-onnx models. Everything runs offline on CPU through sherpa-onnx.

To install it, enable the official **Voice input** bundle, then install `github:valthvn/dsh-local-voice` from the **Plugins** page. Pick a model in the microphone menu and prepare it.

## Licence

MIT. Parts of the host and worker code come from `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` (MIT, © 2026 DeepSeek). Each model has its own licence: Whisper is MIT, Parakeet is CC-BY-4.0, Moonshine is MIT.
