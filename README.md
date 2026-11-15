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

## Neu in 1.6.0
- Beim Einrichten der Stimme wird ein noch laufender alter Stimmen-Server auf dem Port beendet (vorher blieb er stehen und die Grafikkarten-Version wurde nicht benutzt).
- Piper-Notfallstimmen: Deutsch bevorzugt pavoque, dann kerstin (Thorsten nur noch zuletzt); Türkisch bevorzugt dfki.
- Der erste Satzteil beim Vorlesen mit dem Stimmen-Server ist kürzer (ca. 6–8 Wörter), damit das erste Wort früher kommt.

## Neu in 1.7.0
- **OuteTTS (Test):** Einstellungen → Sprache → „Schnelle Stimme testen (OuteTTS, nur Deutsch)“. Eigenes Python 3.11, llama-server (Vulkan, läuft auf AMD-Grafikkarten) und das Modell OuteTTS-1.0-0.6B (Q8). Klont Deine Stimme aus der gewählten Aufnahme (einmalig mit Whisper). Türkisch ist nicht trainiert und wird automatisch von Piper gesprochen. Schlägt etwas fehl, bleibt die bisherige Stimme aktiv.

## Neu in 1.7.1
- OuteTTS-Einrichtung: Platzhalter für `llama_cpp` (die Bibliothek verlangt es beim Import, das Modell läuft aber im llama-server). Behebt „llama.cpp Python bindings not found“.

## Neu in 1.7.2
- OuteTTS-Einrichtung: sucht das llama-server-Paket in den letzten 12 llama.cpp-Releases (das neueste hatte noch keine Windows-Dateien) und nennt bei Misserfolg die Anzahl der Dateien.

## Neu in 1.7.3
- Alten Stimmen-Server auf Port 8004 beenden funktioniert jetzt auch auf deutschem Windows (netstat schreibt dort „ABHÖREN“ statt „LISTENING“). Beim Einrichten wird zusätzlich geprüft, dass wirklich der neue Server (OuteTTS bzw. Chatterbox) antwortet.

## Neu in 1.7.4
- Deutsche Piper-Notfallstimme: kerstin (weiblich) zuerst, dann eva_k, dann pavoque (männlich), Thorsten zuletzt.
