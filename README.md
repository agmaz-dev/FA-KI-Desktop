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

## Neu in 1.4.0
- **Eigene Stimme mit einem Klick:** Einstellungen → Sprache → „Stimme jetzt einrichten“. Die App lädt ein portables Python, installiert Chatterbox (Multilingual, Deutsch und Türkisch), startet den Stimmen-Server im Hintergrund und erzeugt einen Testsatz. Eine eigene Stimmprobe (WAV) kann vorher gewählt werden. Der Server liegt in `voice-server/voice_server.py`.

## Neu in 1.5.0
- **Grafikkarte (Versuch):** Einstellungen → Sprache → „Mit Grafikkarte beschleunigen“ richtet ein zweites Python 3.12 mit AMD-ROCm-PyTorch ein (Windows 11, AMD-Treiber 26.2.2 oder neuer). Läuft es nicht oder ist der Grafikspeicher knapp, nutzt der Stimmen-Server automatisch den Prozessor. Die bisherige Stimme bleibt bei Fehlern aktiv.
- `setuptools<81` wird mitinstalliert (Wasserzeichen-Modul von Chatterbox braucht `pkg_resources`).
- Vorlesen: mehrere Sätze werden vorab erzeugt, der erste Satz wird kürzer geschnitten, „Stopp“ bricht auch den Stimmen-Server ab, Zeitlimit auf 5 Minuten, ein Wiederholungsversuch pro Satz.
