# Hinweise für Claude

## Stimmen (gilt für alle Apps und Programme dieses Nutzers)
- Sprachausgabe immer mit **Supertonic 3** und genau **zwei Stimmen: Tessa (weiblich, Stil `F5`) und Caleb (männlich, Stil `M2`)**. Keine weiteren Stimmen (z. B. nicht Elena).
- Modell: `https://huggingface.co/supertone-oss-archive/supertonic-3`, Revision `aafc6e32416a594460b32413efc49d7fe4ce6d46`, einmaliger Download (~250 MB), läuft offline per ONNX Runtime.
- Referenz-Umsetzungen: `agmaz-dev/FA-KI-Desktop` → `lib/supertonic.js` (Node/Electron), `agmaz-dev/FA-KI-FOLD7` → `app/src/main/java/de/foldki/app/voice/Supertonic.kt` (Android/Kotlin).
- Standardstimme: Tessa. Fallback, solange Supertonic nicht eingerichtet ist: System-Stimme.

## Allgemein
- Antworten und App-Texte auf Deutsch.
