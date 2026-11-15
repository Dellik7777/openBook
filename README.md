# openBook 📖

**Deine eigenen Bücher abfotografieren und überall lesen, wie auf einem Kindle.**

openBook ist eine Web-App (PWA) fürs Handy. Du fotografierst die Seiten eines Buchs, das dir gehört. Die App erkennt den Text direkt auf dem Gerät und macht daraus ein E-Book mit anpassbarer Schrift, Nachtmodus, Lesezeichen und Suche. Fotos und Texterkennung bleiben auf deinem Gerät. Optional werden Texte und Lesestände über **deinen eigenen** Google Drive oder OneDrive zwischen iPhone, iPad und Android abgeglichen.

## Funktionen

**Scannen**
- Kamera-Scanner für viele Seiten am Stück: Antippen oder Auslöser drücken, nächste Seite, fertig
- **Doppelseiten-Modus**: ein Foto vom aufgeschlagenen Buch wird automatisch in linke und rechte Seite geteilt
- Scan-Filter (Graustufen, helles Papier), Taschenlampe, „Zurück“ für die letzte Aufnahme
- Import vorhandener Fotos aus der Galerie
- **Seitenprüfung:** openBook liest die gedruckten Seitenzahlen mit und meldet sofort, wenn eine Seite fehlt, doppelt ist oder in falscher Reihenfolge liegt. Mit „Nachscannen“ wird die fehlende Seite an der richtigen Stelle eingefügt, mit „Passt so“ wird der Hinweis ausgeblendet
- **Abbildungs-Modus:** Karten, Bilder und Diagramme in Farbe als ganze Seite fotografieren

**Texterkennung (OCR)**
- Tesseract läuft komplett im Browser (Deutsch + Englisch), auch offline
- Läuft im Hintergrund weiter, während du scannst; wird nach einem Neustart fortgesetzt
- Repariert Silbentrennung am Zeilenende, entfernt Seitenzahlen und Kolumnentitel und verbindet Absätze über Seitengrenzen

**Lesen wie auf einem Kindle**
- Echter Seitenumbruch statt Scrollen: rechts tippen = weiter, links = zurück, Mitte = Menü, Wischen geht auch
- Schriftgröße, Schriftart (Literata, Georgia, Sans, Weit), Zeilenabstand, Ränder, Blocksatz mit Silbentrennung
- Hintergründe: Weiß, Papier, Sepia, Dunkel, Schwarz
- Fußzeile mit Buchseite und Prozent oder verbleibender Lesezeit (antippen zum Umschalten)
- Lesezeichen, Volltextsuche, Seitenübersicht, Schieberegler
- **Abbildungen im Text:** markierte Bilder, Karten und Diagramme stehen an der richtigen Stelle im Lesefluss, mit Bildunterschrift; antippen zum Vergrößern
- Fußzeile mit den echten Seitenzahlen des gedruckten Buchs
- Originalfoto-Ansicht mit Zoom, z. B. für Tabellen oder Formeln
- Leseposition wird gespeichert, der Bildschirm bleibt beim Lesen an

**Leseprofile & Synchronisierung**
- Mehrere **Leseprofile** (z. B. für die Familie): jedes mit eigener Leseposition, eigenen Lesezeichen und Schrifteinstellungen
- **Sync über Google Drive oder OneDrive**: Texte, Profile, Lesepositionen, Lesezeichen und Cover auf allen Geräten, ohne eigenen Server (Fotos bleiben lokal). Einrichtung: siehe **[SYNC.md](SYNC.md)**
- Auf einem anderen Gerät weitergelesen? openBook springt an die neueste Stelle

**Verwalten**
- Bibliothek mit Covern (Foto oder automatisch erzeugt) und Lesefortschritt
- Seiten-Editor: drehen, zuschneiden, verschieben, löschen, Text korrigieren, neu erkennen, Seitenzahl korrigieren, **Abbildungen markieren** (Beschriftungen in der Abbildung landen dann nicht im Lesetext)
- **EPUB-Export**, z. B. für „Send to Kindle“, Apple Books oder Tolino
- Sicherung und Wiederherstellung der ganzen Bibliothek als ZIP (mit Fotos)

## Installieren

openBook braucht **HTTPS** (für Kamera und Offline-Modus). Am einfachsten geht das mit GitHub Pages:

1. Den Code auf den Branch `main` bringen.
2. Im Repository **Settings → Pages → Build and deployment → Source: GitHub Actions** wählen.
3. Der Workflow `.github/workflows/pages.yml` veröffentlicht die App unter `https://<benutzer>.github.io/<repo>/`.
4. Die Adresse auf dem Handy öffnen und zum Startbildschirm hinzufügen:
   - **iPhone (Safari):** Teilen → „Zum Home-Bildschirm“
   - **Android (Chrome):** Menü ⋮ → „App installieren“

Danach startet openBook wie eine normale App und funktioniert auch ohne Internet.

### Lokal ausprobieren

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Es gibt keinen Build-Schritt und keine Abhängigkeiten. Alles liegt im Repository, auch die OCR-Engine.

## Tipps für gute Scans

- Gleichmäßiges Licht ohne harte Schatten; bei wenig Licht die Taschenlampe nutzen
- Handy möglichst parallel zur Seite halten, die Seite sollte den Rahmen gut ausfüllen
- Bei dicken Büchern den Doppelseiten-Modus nutzen und das Buch leicht flach drücken
- Erkennung dauert auf dem Handy etwa 3 bis 10 Sekunden pro Seite. Du kannst einfach weiterscannen

## Daten & Speicher

Bücher liegen in der IndexedDB des Browsers. Mit Synchronisierung liegt zusätzlich der Text (ca. 0,5 MB pro Buch) in deinem Cloud-Speicher. Eine Seite braucht etwa 200 bis 400 KB, ein Buch mit 300 Seiten also ungefähr 60 bis 120 MB. openBook fragt nach dauerhaftem Speicher. Trotzdem gilt: **regelmäßig eine Sicherung erstellen** (Einstellungen → Alles sichern), besonders vor einem Handywechsel.

> openBook ist für die private Nutzung **eigener** Bücher gedacht (Privatkopie). Bitte keine gescannten Bücher weitergeben.

## Aufbau

```
index.html            App-Shell
css/app.css           Design (Bibliothek, Scanner, Leser)
js/app.js             Router, Bibliothek, Buchdetails, Profile, Einstellungen
js/profiles.js        Leseprofile (aktives Profil, Leseeinstellungen)
js/config.js          Client-IDs für Google Drive / OneDrive
js/sync/sync.js       Abgleich (Zusammenführen, Löschmarkierungen, Zeitplan)
js/sync/google.js     Google Drive (appDataFolder, OAuth-Weiterleitung)
js/sync/onedrive.js   OneDrive (App-Ordner, OAuth mit PKCE)
js/scanner.js         Kamera-Scanner
js/reader.js          Kindle-artiger Leser (CSS-Spalten-Paginierung)
js/pageeditor.js      Seiten bearbeiten
js/ocr.js             OCR-Warteschlange (Tesseract.js, Web Worker)
js/textproc.js        OCR → Absätze, Seitenzahlen, Kolumnentitel, Abbildungen im Lesefluss
js/pagecheck.js       Seitenprüfung (fehlende/doppelte/vertauschte Seiten)
js/imageproc.js       Skalieren, Scan-Filter, Teilen, Drehen, Zuschneiden
js/db.js              IndexedDB
js/epub.js            EPUB-3-Export
js/backup.js          Sicherung/Wiederherstellung
sw.js                 Service Worker (offline)
vendor/               Tesseract, Sprachdaten, JSZip, Literata (siehe vendor/README.md)
```
