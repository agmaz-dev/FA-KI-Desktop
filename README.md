# FA KI Desktop

Deutsche Windows-App für lokale KI mit [Ollama](https://ollama.com). Alles läuft auf dem eigenen PC.

- Chat mit Modellauswahl und Denktiefe (gpt-oss: niedrig/mittel/hoch)
- Chats werden nur lokal gespeichert
- PDF lesen (eigene Texterkennung, Scans per OCR Deutsch/Türkisch), Bilder, Textdateien
- Spracheingabe (whisper.cpp) und Gesprächsmodus, Vorlesen mit Piper-Stimmen (Deutsch/Türkisch), Windows-Stimme als Reserve
- E-Mail-Vorlagen (Antwort DE/TR, Zusammenfassung, Übersetzung)

Installer: `FA-KI-Desktop-Setup-<Version>.exe` (GitHub Actions → Releases/Artifacts).
Entwicklung: `npm ci && npm start`, Tests: `npm test`.

## Neu in 1.3.0
- Antworten und ganze Chats als **PDF** oder **Word (.docx)** speichern (Knöpfe unter jeder Antwort, Export-Symbol oben).
- **Eigene Stimme:** In den Einstellungen unter Sprache den Stimmen-Motor „Eigener Stimmen-Server“ wählen (z. B. Chatterbox), eine eigene Stimmprobe auswählen, Ordner und Startbefehl des Servers eintragen. Die App kann den Server beim Start im Hintergrund starten.
- **Ollama** wird beim Start automatisch gestartet, falls es nicht läuft (abschaltbar).
- Die KI stellt sich als „FA KI“ vor.
