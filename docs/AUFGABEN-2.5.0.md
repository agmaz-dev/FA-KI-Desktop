# Aufgaben für Version 2.5.0 (Übergabe an Claude Code)

Stand: 20.11.2026, Branch `feature/agent-erkunden`, zuletzt gebaut: 2.4.0 (Windows + Mac M1).

## Arbeitsweise (vom Nutzer gewünscht)

- Alles in **einem Durchgang** bauen und erst mit dem fertigen Ergebnis melden.
- Vorher ehrlich sagen, was machbar ist und was nicht.
- Was ersetzt wird oder nicht funktioniert, aus der App entfernen (keine toten Einstellungen/Dateien).
- Installer-Dateien immer mit Versionsnummer im Namen.
- Oberfläche und Texte auf Deutsch. PR #3 nicht ohne OK des Nutzers mergen.

## Projekt in Kürze

- Electron 45, eigene Engine `llama-server` (llama.cpp b12530) – nur `127.0.0.1`, alles lokal.
- Diktieren: whisper.cpp (`whisper-server`), Vorlesen: Supertonic (+ OuteTTS „Meine Stimme“, nur Windows).
- Builds über GitHub Actions (`.github/workflows/build.yml`): Job `windows-latest` (NSIS) und `mac` (`macos-latest`, arm64, ad-hoc signiert, DMG).
  Mac: llama/whisper werden **nach** electron-builder ins Paket kopiert (`mac-bundle/`), weil electron-builder an den dylib-Symlinks scheitert.
- Release: Prerelease `v<version>-test`. Tests: `npm test`.

## 1. Mehrere Downloads gleichzeitig

- Heute: `main.js` → `models:download` hat eine Sperre (`pullController`, „Es läuft schon ein Download“).
- Neu: bis zu **3 parallel**, weitere in einer Warteschlange. Jeder Download mit eigenem Fortschritt und eigenem Abbrechen
  (`models:cancelDownload` mit Namen). Oberfläche in `src/models.js`: Liste aller laufenden/wartenden Downloads.

## 2. Hugging-Face-Link ins Suchfeld

- In „Erkunden“ (`src/models.js`, `doSearch`): Wenn die Eingabe ein Link `https://huggingface.co/<autor>/<name>` oder `<autor>/<name>` ist,
  direkt die Detailansicht dieses Modells öffnen (`hf:details`).
- Anlass: `lmstudio-community/Qwen3.5-9B-GGUF` tauchte in der Suche (max. 60 Treffer) nicht auf.

## 3. Phonon als Vorlesestimme (wie in der App des Nutzers)

- Modell: `gradium/phonon-40m-multilingual` (q8 GGUF, ca. 75 MB, 24 kHz mono, Lizenz CC BY-NC 4.0 – privat erlaubt).
  Deutsche Stimmen: **Anton**, Nele; Englisch: Zoey, Easton. Laufzeit: `ptts` (gradium-ai/xn-ptts), auch Transformers-Integration.
- Download möglicherweise **gated** (Bedingungen akzeptieren + HF-Token). Nutzer hat ein HF-Konto → Feld für HF-Token in den Einstellungen
  (sicher speichern, nur für Downloads verwenden).
- Einstellungen „Sprache“ so wie im Screenshot des Nutzers:
  - Karte „Phonon – mehrsprachige Sprachausgabe“ mit Größe, Lizenz, Herunterladen/„Heruntergeladen“
  - **Textsprache** (für Zahlen/Datum)
  - **Stimme** (Auswahl Anton, Nele, …) mit Knopf **Vorschau**
  - **Wiedergabegeschwindigkeit**
- Muss unter Windows **und** Mac (M1) laufen und vollständig offline nach dem Download.

## 4. Voxtral zum Diktieren (neben Whisper)

- Modell: `mistralai/Voxtral-Mini-4B-Realtime-2602` (Apache 2.0, ca. 3 GB, 13 Sprachen, Echtzeit, < 500 ms).
  Der Nutzer hat es getestet und findet es sehr schnell und gut → hohe Priorität.
- In den Einstellungen wählbar: Whisper oder Voxtral, mit Herunterladen-Karte.
- Vorher prüfen, welche lokale Laufzeit auf Windows (AMD RX 7800 XT, Vulkan) und Mac M1 (Metal) sauber läuft
  (z. B. llama.cpp/GGUF-Unterstützung, voxmlx auf dem Mac, Transformers). Ehrlich berichten, falls nur eine Plattform geht.
- Speicher beachten: Mac hat 16 GB gemeinsam für Modell + Voxtral.

## Bekannte offene Punkte

- Mikrofon unter Windows lieferte „[Musik]“; Test von 2.2.6 durch den Nutzer steht aus. Voxtral könnte helfen.
- Windows-Desktopicon wirkt blau (Icon-Cache), Installer-Icon ist orange.
- Fernzugriff vom Handy: später.
