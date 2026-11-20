# FA KI Desktop

Deutsche Windows-App für lokale KI mit **eigener Engine** (llama.cpp, eingebaut, ohne Ollama). Alles läuft auf dem eigenen PC; Internet braucht nur der Modell-Download von Hugging Face.

- Chat mit Modellauswahl und Denktiefe (gpt-oss: niedrig/mittel/hoch)
- Chats werden nur lokal gespeichert
- PDF lesen (eigene Texterkennung, Scans per OCR Deutsch/Türkisch), Bilder, Textdateien
- Spracheingabe (whisper.cpp) und Gesprächsmodus, Vorlesen mit Piper-Stimmen (Deutsch/Türkisch), Windows-Stimme als Reserve
- E-Mail-Vorlagen (Antwort DE/TR, Zusammenfassung, Übersetzung)

Installer: `FA-KI-Desktop-Setup-<Version>.exe` (GitHub Actions → Releases/Artifacts).
Entwicklung: `npm ci && npm start`, Tests: `npm test`.

## Neu in 2.5.6

- Lange Gespräche: Die App hält jetzt immer Platz für die Antwort (samt „Gedanken“) frei und misst, wie viele Tokens der Text wirklich braucht. Kein „keine Antwort erhalten“ mehr bei vollem Kontext; falls doch, eine klare Meldung.
- Spracherkennung: Zeitlimit passend zur Aufnahme statt 3 Minuten. Hängt Voxtral auf der Grafikkarte (z. B. weil das Chat-Modell den Grafikspeicher füllt), startet es automatisch auf dem Prozessor neu.

## Neu in 2.5.5

- Erkunden: Sonderformate, die nur mit einer abgewandelten Engine laufen (z. B. „PQ2_0“ bei Bonsai), werden nicht mehr angeboten.
- Klare Meldung, wenn eine Modelldatei ein solches Sonderformat nutzt.
- Schnellmodus MTP: Hat eine Modelldatei eingebaute MTP-Köpfe (Vorausraten der nächsten Wörter), schaltet die App ihn automatisch ein. Klappt das Laden damit nicht, lädt sie ohne.

## Neu in 2.5.4

- Schnellerer Start: das Fenster kommt zuerst, Verbindungen (MCP, Google Drive) und Vorwärmen laufen danach im Hintergrund. Das Startprotokoll zeigt die Zeit jedes Schritts.
- Keine hängenden Hintergrundprogramme mehr: Engine, Spracherkennung und Sprachausgabe werden bei jedem Programmende beendet. Reste nach einem Absturz räumt der nächste Start auf.
- Weniger Abstürze beim Laden: bei bis zu 16 GB Speicher wird die Spracherkennung vor dem Laden eines Chat-Modells beendet und nicht mehr beim Start vorgewärmt. Reicht der Speicher nicht, lädt die App das Modell einmal mit kleinerem Kontext neu.
- Verständliche Fehlermeldungen (zu wenig Speicher, nicht unterstütztes Modell, fehlende Datei).
- Erkunden: Repos ohne GGUF (z. B. MLX) zeigen das echte Format und bieten passende GGUF-Fassungen als Knopf an. Entwurfsmodelle (dspark, eagle) werden nicht mehr als Stufe angeboten.
- Erkunden → huggingface.co: Klick auf „Download“ bei einer .gguf-Datei wird jetzt sicher erkannt; Fortschrittsbalken und Meldung stehen direkt über der Webseite.
- Neue Engine llama.cpp b12556 (Mac Metal, Windows Vulkan).

## Neu in 2.5.3
- **Start abgesichert:** Läuft schon eine FA-KI-Instanz ohne Fenster, öffnet ein erneuter Start (oder ein Klick aufs Dock-Symbol) ein Fenster. Scheitert der Start, zeigt die App eine Fehlermeldung und schreibt `start-protokoll.log` in den Datenordner.
- Die Installer werden in der CI jetzt auch gestartet: Erst wenn das Fenster aufgeht, gilt der Build als gut.

## Neu in 2.5.2
- **Erkunden findet mehr:** „Weitere laden“ holt beliebig viele Treffer (je 100). Ohne Treffer mit Leerzeichen („qwen 3.5“) wird auch „qwen3.5“ versucht.
- **Alle Modelldateien ladbar:** Auch neue Formate (NVFP4, FP16, TQ1_0, „4bpw“ …) und Dateien ohne Stufe im Namen erscheinen als Download-Option. Hilfsdateien (imatrix, MTP-Entwürfe, LoRA, Tokenizer) werden ausgeblendet; enthält ein Repo nur solche, sagt die App das klar.
- **huggingface.co direkt in Erkunden:** Umschalter „Suche | huggingface.co“ zeigt die echte Webseite. Auf einer Modellseite lädt „In FA KI laden“ das Modell, ein Klick auf eine .gguf-Datei reiht sie in die Downloads ein.

## Neu in 2.5.1
- **Neues Design im Apple-Stil:** Einstellungen mit einer Zeile pro Einstellung, Gruppen-Kästen, farbigen Symbolen und Suchfeld. Die Seitenleiste der Einstellungen ist aus Glas (Mac: Vibrancy, Windows 11: Acrylic). Jede Änderung gilt sofort, ohne „Speichern“. Chatfenster neu gestaltet, Blau als Akzent.
- **Neues Logo** als App-, Desktop- und Dock-Symbol und in der App.
- **Diktieren:** blauer Rahmen, Wellenform nach der echten Stimme, roter Stopp-Knopf. Mit Voxtral erscheint der Text schon während des Sprechens.
- **Mikrofon als ein Knopf:** unterbricht das Vorlesen und hört zu, nochmal Klick beendet. Der Knopf „Vorlesen stoppen“ entfällt.
- **Token-Anzeige im Chat** ein- und ausschaltbar (Allgemein).
- **Supertonic und Whisper entfernt.** Diktieren mit Voxtral, Vorlesen mit Phonon (oder „Meine Stimme“ unter Windows). Türkischen Text liest die System-Stimme. Alte Dateien werden beim Start aufgeräumt.
- **Bibliothek und Erkunden** sind eigene Menüpunkte in den Einstellungen.
- **MCP:** neuer Menüpunkt mit Karten für GitHub, Linear, Notion, Sentry, Atlassian, Cloudflare und Google Drive („Einrichten“ öffnet ein Anmeldefenster) und eigenen MCP-Servern (Befehl auf diesem Rechner oder Webadresse). GitHub wird dort eingerichtet statt unter „Internet und Agent“.

## Neu in 2.5.0
- **Mehrere Downloads:** Bis zu 3 Modelle laden gleichzeitig, weitere warten in einer Reihe. Jeder Download hat eigenen Fortschritt und eigenes „Abbrechen“ (Liste links unten, in der Bibliothek und in Erkunden).
- **Hugging-Face-Link im Suchfeld:** Ein Link `https://huggingface.co/autor/name` oder einfach `autor/name` in „Erkunden“ öffnet direkt dieses Modell, auch wenn es in den Suchtreffern fehlt.
- **Phonon (Vorlesen):** Neue mehrsprachige Stimmen von Gradium (`gradium/phonon-40m-multilingual`, 75 MB, Lizenz CC BY-NC 4.0): Anton, Nele und weitere deutsche Stimmen, dazu Zoey und Easton (Englisch). Einstellungen → Sprache: Herunterladen, **Textsprache** (für Zahlen/Datum), **Stimme** mit **Vorschau**, **Wiedergabegeschwindigkeit**. Das Modell ist geschützt: einmal auf Hugging Face die Bedingungen akzeptieren und den **Hugging-Face-Token** eintragen (verschlüsselt gespeichert, nur für Downloads). Danach offline. Türkisch liest weiter Supertonic.
- **Voxtral (Diktieren):** `mistralai/Voxtral-Mini-4B-Realtime-2602` als Alternative zu Whisper (Einstellungen → Sprache → „Erkennung mit“). Läuft in der eingebauten Engine (Vulkan unter Windows, Metal auf dem Mac), Download ca. 3,6 GB, erkennt die Sprache selbst.

## Neu in 2.4.0

- Mac: Die GPU-Anzeige in der Seitenleiste zeigt jetzt die Auslastung der Apple-GPU.
- Mac: „Erkunden“ rechnet mit dem gemeinsamen Speicher des Macs (ca. zwei Drittel für die GPU) und empfiehlt nur Modelle, die wirklich passen. Die Felder „Grafikspeicher/Arbeitsspeicher“ entfallen dort.

## Neu in 2.3.0

- **Mac:** Version für Apple-Chips (M1 und neuer) als .dmg. Eigene Engine mit Metal, Spracherkennung (Whisper) mit Metal, Mikrofon-Berechtigung, Mac-Menü. „Meine Stimme“ (OuteTTS) und die GPU-Anzeige gibt es nur unter Windows. Das Programm ist nicht von Apple beglaubigt: beim ersten Start Rechtsklick → Öffnen.

## Neu in 2.2.6

- **Mikrofon-Pegel:** wird jetzt auch aus der fertigen Aufnahme gemessen und der Audio-Kontext der Pegelanzeige wird gestartet (resume), damit keine falsche „Stille“-Meldung kommt.

## Neu in 2.2.5

- **Diktieren:** Rauschunterdrückung und Echo-Filter der Aufnahme sind aus (sie verschluckten bei manchen Mikrofonen die Sprache), leise Aufnahmen werden angehoben, und die Verkürzung der Erkennung (audio_ctx) ist entfernt. Der Mikrofon-Test spielt die Aufnahme zur Kontrolle ab.

## Neu in 2.2.4

- **Mikrofon:** Whisper-Platzhalter wie „[Musik]“ werden nicht mehr in die Eingabe geschrieben. Unter Einstellungen → Sprache kannst Du das Mikrofon wählen und es 3 Sekunden testen. Liefert das Mikrofon nur Stille, meldet die App das.
- **PDF/Word speichern:** Heißt der Chat wie eine Bilddatei (z. B. „Bild-123.png“), wird trotzdem immer im gewählten Format gespeichert.

## Neu in 2.2.3

- **Webseiten und Folien:** kein Code mehr im Chat. Stattdessen eine kleine Karte mit „Vorschau öffnen“ und „Code kopieren“, die Seite erscheint schon beim Schreiben rechts in der Vorschau.

## Neu in 2.2.2

- **Gedanken:** bleiben immer zugeklappt, auch beim Schreiben, und öffnen sich nur per Klick. Der Schalter „Gedankengang live aufklappen“ ist entfernt.

## Neu in 2.2.1

- **Rechtsklick im Eingabefeld:** Fehler behoben („clipboard.readImage is not a function“), „Bild einfügen“ funktioniert wieder.

## Neu in 2.2.0

- **Browser mit Tabs:** mehrere Tabs im Seitenfenster (+ für neuen Tab, × zum Schließen, Links mit neuem Fenster öffnen als Tab).
- **Schriftarten:** in Einstellungen → Allgemein getrennt für die App und für die Antworten, aus einer Liste oder mit dem Namen einer installierten Schrift. Der Schalter „Serifenschrift“ ist dadurch ersetzt.
- **Symbol:** das Programm-Symbol ist jetzt orange wie in der App.

## Neu in 2.1.2

- **E-Mail:** verständliche Fehlermeldung bei abgelehnter Anmeldung (App-Passwort nötig); Leerzeichen im App-Passwort werden entfernt.

## Neu in 2.1.1

- **Browser:** Globus-Knopf oben im Chat öffnet das Seitenfenster als Browser mit Adressleiste (Adresse oder Suchbegriff), Zurück, Vor, Neu laden.

## Neu in 2.1.0

- **Chat:** Gedanken und Werkzeug-Aktionen (z. B. GitHub lesen) sind eine kleine, zugeklappte Zeile; ein Klick klappt sie auf. Dunkler Anthrazit-Hintergrund. Rechtsklick ins Eingabefeld: „Einfügen“ und „Bild einfügen“ (kopiertes Bild aus der Zwischenablage).
- **Seitenfenster neben dem Chat:** Links aus Antworten öffnen dort als Webseite, und was die KI als HTML schreibt (Webseite, Folien, Entwurf) erscheint sofort als Vorschau, mit Knopf „Als PDF speichern“. Breite ziehbar. Die Vorschau hat kein Netz, erstellte Seiten können nichts senden.
- **Neue Struktur:** Links nur Chats, Modelle, Einstellungen. „Bibliothek“ und „Erkunden“ sind eine Seite „Modelle“ mit zwei Reitern. Die Trennlinie in der Suche ist ziehbar.
- **Auslastung:** Balken für GPU, CPU und Arbeitsspeicher links unten (GPU über die Windows-Leistungsanzeige, ungefähr).
- **Sprache:** Piper ist entfernt (Programm, Stimmen, Einstellungen). Vorlesen mit Supertonic oder „Meine Stimme“. Die Spracherkennung (Whisper, Standard Medium) hat einen eigenen, aufgeräumten Bereich.
- **E-Mail für die KI** (Einstellungen → Internet und Agent): Posteingang lesen und suchen, Mails schreiben und senden. Jede Mail zum Senden siehst Du vorher mit Empfänger und Text und musst sie jedes Mal erlauben. Mailtexte gelten für die KI nur als Daten.
- GitHub: die Repo-Liste zeigt jetzt bis zu 300 Repos, auch aus Organisationen. Die Engine-Version wird richtig angezeigt.

## Neu in 2.0.0 – eigene Engine, ohne Ollama

- Die App bringt ihre Rechen-Engine (llama.cpp mit Vulkan, läuft auf AMD, NVIDIA und Intel) selbst mit. Ollama wird nicht mehr gebraucht und nicht mehr gestartet.
- Modelle sind normale GGUF-Dateien im **Modellordner** (Standard: App-Daten, änderbar in der Bibliothek). Download direkt von Hugging Face, fortsetzbar nach Abbruch; lose GGUF-Dateien im Ordner werden erkannt.
- „Modell im Speicher halten“ entlädt das Modell nach der Zeit aus dem RAM und lädt es beim nächsten Chat neu.
- Bibliothek: Button „Aus Ollama übernehmen“ verknüpft vorhandene Ollama-Modelle ohne zusätzlichen Platz (nicht jede Ollama-Datei läuft in llama.cpp).
- Entfernt: Ollama-Adresse und Autostart in den Einstellungen.

## Neu in 1.3.0
- Antworten und ganze Chats als **PDF** oder **Word (.docx)** speichern (Knöpfe unter jeder Antwort, Export-Symbol oben).
- **Eigene Stimme:** In den Einstellungen unter Sprache den Stimmen-Motor „Eigener Stimmen-Server“ wählen (z. B. Chatterbox), eine eigene Stimmprobe auswählen, Ordner und Startbefehl des Servers eintragen. Die App kann den Server beim Start im Hintergrund starten.
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

## Neu in 1.8.0 – aufgeräumt
- Entfernt: Chatterbox, Grafikkarten-/ROCm-Einrichtung, Server-Felder (Adresse, Ordner, Startbefehl, Autostart-Schalter). Die Sprache-Seite hat nur noch: Stimme/Tempo, „Meine Stimme (OuteTTS)“ mit einem Knopf, Stimmen-Motor, Test/Stopp und die Piper-Bausteine.
- Fällt der Stimmen-Server aus, spricht Piper (statt sofort die Windows-Stimme).
- Knopf „Alte Dateien löschen“ entfernt die Reste von Chatterbox und dem Grafikkarten-Python (mehrere GB).
- Alte Einstellungen mit Chatterbox-Startbefehl werden beim Start automatisch auf Piper zurückgesetzt.

## Neu in 1.8.1
- OuteTTS: liefert die Grafikkarte kein Audio, startet der Stimmen-Server automatisch auf dem Prozessor neu und versucht es erneut.
- Protokoll des llama-servers (voice/hf-cache/llama-server.log); die Fehlermeldung zeigt dessen Ende.
- Größerer Kontext (8192) für das Sprachmodell.

## Neu in 1.8.2
- Deutsch spricht nur noch Piper „kerstin“ (Frauenstimme); alle Männerstimmen sind aus der Auswahl entfernt.

## Neu in 1.8.3
- OuteTTS: Token-IDs werden direkt vom llama-server geholt (neuere Versionen blenden die Audio-Codes im Text aus, deshalb kam kein Audio).

## Neu in 1.8.4
- Meine Stimme wird beim App-Start still vorgewärmt (Modell, Stimmprofil), damit der erste Satz sofort kommt.

## Neu in 1.8.5
- OuteTTS: kleinerer Speicherbedarf (Kontext 4096, kürzere Maximallänge) und Prompt-Cache, damit die Stimme neben dem großen Sprachmodell auf der Grafikkarte weniger stockt.
- Zeitprotokoll je Satz: voice/hf-cache/tts-timing.log.

## Neu in 1.8.6
- OuteTTS: llama-server mit einem einzigen Platz (-np 1) und Aufräumen übrig gebliebener llama-server-Prozesse; deutlich weniger Arbeitsspeicher.

## Neu in 1.8.7
- Der Stimmen-Server wird bei jedem App-Start auf den neuesten Stand gebracht (bisher nur bei der Einrichtung, dadurch kamen Verbesserungen nie an).
- Kontext wieder 8192 (die Stimmprobe allein braucht ca. 3400 Tokens), dazu ein einziger Platz (-np 1).

## Neu in 1.8.8
- OuteTTS nimmt automatisch die kleinere Datei OuteTTS-1.0-0.6B-Q4_0.gguf (oder Q5_0), wenn sie im Ordner voice neben der Q8-Datei liegt.
- Speicherleck im Stimmen-Server behoben (inference_mode, Aufräumen nach jedem Satz).

## Neu in 1.8.10
- Neue schnelle Stimmen: **Supertonic** mit Elena, Tessa und Caleb (Deutsch und Türkisch). Läuft ohne Grafikkarte und ohne Python direkt in der App, einmaliger Download von ca. 250 MB (Einstellungen → Sprache → „Supertonic einrichten“).
- Text einfügen im Eingabefeld funktioniert wieder, auch aus Word und Webseiten (dort liegt neben dem Text oft ein Bild in der Zwischenablage). Dazu gibt es ein Rechtsklick-Menü (Ausschneiden, Kopieren, Einfügen) und die Tastenkürzel.

## Neu in 1.8.9
- Piper: Stimmen, die das mitgelieferte Sprachprogramm nicht lesen kann (Kerstin „medium“), werden übersprungen und durch die passende Version (Kerstin „low“) ersetzt. Die bevorzugte Stimme (Kerstin, dfki) wird beim Start still nachgeladen, falls sie fehlt.

## Neu in 1.9.0 – Internet und GitHub

- **Internetsuche ohne Schlüssel und ohne Konto:** Modelle mit Werkzeug-Unterstützung (gpt-oss, Qwen) können im Web suchen und Seiten lesen. Die App fragt DuckDuckGo direkt ab, bei Sperre weicht sie auf DuckDuckGo Lite und Bing aus. Quellen kommen als anklickbare Links in den Chat; im Antwortkopf steht, welche Suchen und Seiten benutzt wurden.
- **Shop-Links:** Die KI baut aus dem Suchbegriff fertige Links für eBay, Kleinanzeigen, Amazon und idealo. Du klickst selbst darauf, es wird nichts abgerufen.
- **GitHub nur lesen:** Repos auflisten, Dateien und Ordner lesen, Code und Repos suchen. Es gibt keine Funktion, die etwas schreibt oder löscht. Der Token (nur Leserechte) kommt unter Einstellungen → KI und Modell → Internet und GitHub, wird mit den Windows-Anmeldedaten verschlüsselt gespeichert und nie an die Oberfläche oder das Modell gegeben.
- **Sicherheit:** Adressen im eigenen Netz und auf dem PC (localhost, 192.168…, 169.254…) sind für den Seitenabruf gesperrt, auch bei Weiterleitungen. Texte aus dem Netz werden dem Modell als nicht vertrauenswürdige Daten übergeben.
- Beide Funktionen lassen sich in den Einstellungen einzeln ausschalten.

## Neu in 1.8.11
**Spracherkennung (Whisper)**
- Umlaute bleiben heil: Aus „Grüße“ wurde manchmal „Gr��ße“, wenn ein „ü“ genau an einer Blockgrenze der Ausgabe lag.
- Deutlich schneller: Das Whisper-Modell bleibt in einem Hintergrundprogramm (`whisper-server`) geladen, statt bei jeder Aufnahme neu geladen zu werden. Es startet kurz nach dem App-Start bzw. beim Drücken des Mikrofons und wird 15 Minuten nach der letzten Nutzung wieder aus dem Speicher genommen. Zusätzlich rechnet Whisper nur noch ein Fenster passend zur Aufnahmelänge statt immer 30 Sekunden. Fehlt `whisper-server.exe`, wird wie bisher `whisper-cli.exe` benutzt.
- Messen unter Windows: `node scripts/bench-whisper.js aufnahme.wav small` vergleicht alt (whisper-cli) und neu (whisper-server).
- Tipp: Spracheingabe auf „Deutsch“ statt „Automatisch“ stellen – die Spracherkennung der Sprache kostet sonst etwa doppelt so viel Rechenzeit.

**Vorlesen (Supertonic)**
- „Stopp“ hält Supertonic jetzt sofort an: Der laufende Satz wird abgebrochen, schon vorbereitete Sätze werden nicht mehr berechnet.

**Meine Stimme (OuteTTS)**
- Die Einrichtung braucht eine Stimmprobe. Ohne Aufnahme bricht sie jetzt **vor** dem mehrere GB großen Download mit einer klaren Meldung ab (bisher scheiterte erst der Testsatz am Ende). Der Server meldet eine fehlende Probe verständlich (422).
- Die kleineren Modelle Q4/Q5 lädt die App nicht selbst herunter. Wer sie nutzen möchte, legt `OuteTTS-1.0-0.6B-Q4_0.gguf` (oder `Q5_0`) selbst in den Ordner `voice` neben die Q8-Datei.
- Der interne llama-server nimmt einen freien Port statt fest 8081.

**Chat und Ollama**
- Lange Ladezeiten großer Modelle führen nicht mehr nach 5 Minuten zu „fetch failed“; abgebrochene oder fehlerhafte Antworten schließen die Verbindung sauber.
- Fähigkeiten eines Modells (Denken, Bilder) bleiben nicht mehr aus, nur weil Ollama beim Start noch nicht bereit war.
- Lange Chats mit mehreren Dateien sprengen den Kontext nicht mehr: Dateien und Bilder gehen nur mit der neuesten Nachricht vollständig mit, älteste Runden fallen bei Bedarf weg.
- Textdateien in Windows-Kodierung (z. B. CSV aus Excel) und UTF-16 werden mit richtigen Umlauten gelesen.
- PDFs mit mehr als 80 Seiten: deutlicher Hinweis, dass nur die ersten 80 gelesen werden.
- Modell-Download abbrechen zeigt „Download abgebrochen“ statt einer Fehlermeldung.

**Sicherheit und Aufräumen**
- Die Oberfläche kann den Startbefehl des Stimmen-Servers nicht mehr setzen; nur bekannte Einstellungen werden übernommen.
- Beim Freimachen von Port 8004 werden nur noch eigene Programme beendet.
- `__pycache__` ist aus dem Repo und dem Installationsprogramm entfernt; adm-zip auf 0.6.1 (keine bekannten Lücken mehr).
- Piper-Stimmen werden beim Start nur noch nachgeladen, wenn Piper auch als Stimme genutzt wird.
- Build: whisper.cpp ist auf v1.9.5 angepinnt, `whisper-server.exe` wird mitgeliefert (der Build prüft das), ein vorhandenes Release wird nicht mehr überschrieben, der Workflow prüft auch Pull Requests und hat ein Zeitlimit von 45 Minuten.

## Neu in 1.10.5
Auch Fenster, Dialoge und Bildlaufleisten sind im dunklen Grau.

## Neu in 1.10.4
Dunkles Grau (wie im Claude-Chat) ist überall Standard, „Wie Windows“ entfällt; Erkunden mit neuem Design (Herausgeber-Symbol, Statistik-Kästchen).

## Neu in 1.10.3
Erkunden: alle Sortierungen von Hugging Face (Meiste Downloads, Meiste Likes, Im Trend, Zuletzt aktualisiert, Neueste), Sterne und Downloads rechts in der Liste, Suchverlauf, README-Übersetzer immer sichtbar.

## Neu in 1.10.2
Einstellungen ersetzen das ganze Fenster; Downloads laufen app-weit mit Fortschrittsbalken (Seitenleiste, Einstellungen, Bibliothek) und lassen sich abbrechen und fortsetzen; Bibliothek mit festen Spalten.

## Neu in 1.10.1
Oberfläche wie bei Bionic: „Erkunden“ und „Bibliothek“ liegen in Einstellungen → Lokale Modelle, gruppierte Navigation mit Zurück/Vorwärts, Eingabe „Gib FA KI eine Aufgabe“. Farben bleiben die von FA KI.

## Neu in 1.10.0 – Agent, Erkunden, Bibliothek und neue Oberfläche

**Agent (arbeitet wie ein Programmierer)**
- Die KI kann im **Arbeitsordner** Dateien lesen, anlegen, ändern und löschen, **Befehle** ausführen (Tests, Build, Skripte) und **Git** benutzen (status, add, commit, branch, push, pull, clone …).
- Auf **GitHub** kann sie Repos anlegen (standardmäßig privat), Dateien schreiben, Branches und Pull Requests erstellen, Pull Requests zusammenführen, Issues anlegen sowie Pull Requests und Actions-Läufe lesen. Das Löschen von Repos und das Ändern von Repo-Einstellungen gibt es bewusst nicht.
- **Jede Änderung und jeder Befehl wird vorher gezeigt** und läuft nur nach „Erlauben“. Im Dialog kann man für diesen Chat weitere Aktionen derselben Art freigeben; Löschen und Zusammenführen fragen immer.
- Sicherheit: Dateiwerkzeuge bleiben im Arbeitsordner (auch gegen `..` und Verknüpfungen), nie in `.git`; Git spricht nur mit https://github.com/ und kennt keine Konfigurations- oder Ausführ-Optionen; der Token wird nur bei Netzwerk-Befehlen an GitHub mitgegeben, nie an die KI und wird aus Ausgaben entfernt; Texte aus Dateien, Befehlen und Webseiten gelten als Daten, nicht als Anweisungen.
- Lange Arbeitsläufe (bis 30 Werkzeug-Runden): alte Ergebnisse werden gekürzt, damit sie in den Kontext passen.
- Einstellungen → **Internet und Agent**: Schalter, Arbeitsordner wählen, Prüfung ob Git und Node gefunden werden, GitHub-Token (zum Schreiben mit Schreibrechten).

**Erkunden und Bibliothek (wie bei LM Studio)**
- **Erkunden:** Modelle auf Hugging Face suchen (GGUF, sortiert nach Beliebtheit, Trend, Likes, Datum), Details mit Beschreibung, allen Stufen (Q4, Q6, Q8 …) mit Größe, **„Passt auf Deine Karte“** (Grafikspeicher und Arbeitsspeicher einstellbar), Empfehlung und Download direkt von Hugging Face in den Modellordner. Bilder/Werkzeuge/Denken sind nur aus Schlagworten geschätzt.
- **Bibliothek:** installierte Modelle mit Größe, Parametern, Bit-Stufe und Fähigkeiten; „Im Chat verwenden“ und „Löschen“.

**Oberfläche im Stil von Bionic**
- Rundes Eingabefeld: „+“ links (Datei, Vorlesen, Gesprächsmodus, Profil, Denktiefe, Schreibhilfen), Modell-Auswahl mit Filter rechts, Mikrofon, runder Senden-Knopf.
- „Kontext: N von M“ unter dem Eingabefeld.
- Linke Leiste mit Neuer Chat, Erkunden, Bibliothek, Chats und **Einstellungen mit Zahnrad unten links**. Einstellungen sind jetzt eine eigene Seite mit „Zurück zur App“.
- Entfernt: der alte Dialog „Modelle verwalten“ (ersetzt durch Erkunden und Bibliothek) und die Pop-up-Fenster.

