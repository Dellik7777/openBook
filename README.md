# Lesepixel 📖

**Gedrucktes abfotografieren und überall lesen – wie ein E-Book.**

> Früher „openBook“. Repository und Web-Adresse (`…github.io/openBook/`) behalten den alten Namen, damit installierte Apps, gespeicherte Bücher und Sync-Einstellungen weiter funktionieren.

Lesepixel ist eine Web-App (PWA) fürs Handy. Du fotografierst die Seiten eigener Dokumente, Notizen, Unterlagen oder Bücher (siehe [Rechtliches](#rechtliches)). Die App erkennt den Text direkt auf dem Gerät und macht daraus ein E-Book mit anpassbarer Schrift, Nachtmodus, Lesezeichen und Suche. Fotos und Texterkennung bleiben auf deinem Gerät. Optional werden Texte und Lesestände über **deinen eigenen** Google Drive oder OneDrive zwischen iPhone, iPad und Android abgeglichen.

## Funktionen

**Scannen**
- Kamera-Scanner für viele Seiten am Stück: Antippen oder Auslöser drücken, nächste Seite, fertig
- **Doppelseiten-Modus**: ein Foto vom aufgeschlagenen Buch wird automatisch in linke und rechte Seite geteilt
- Scan-Filter (Graustufen, helles Papier), Taschenlampe, „Zurück“ für die letzte Aufnahme
- Import vorhandener Fotos aus der Galerie
- **Seiten gerade rücken:** Lesepixel findet die Seite im Foto, schneidet den Tisch ab, entzerrt schräge Aufnahmen und gleicht die Wölbung zur Buchmitte aus (mit Sicherheitsprüfung, damit kein Text abgeschnitten wird)
- **Auto-Auslöser:** umblättern, still halten, die App fotografiert selbst
- **Qualitätscheck** direkt nach dem Foto (unscharf, zu dunkel) mit „Nochmal“
- **Seitenprüfung:** Lesepixel liest die gedruckten Seitenzahlen mit und meldet sofort, wenn eine Seite fehlt, doppelt ist oder in falscher Reihenfolge liegt. Mit „Nachscannen“ wird die fehlende Seite an der richtigen Stelle eingefügt, mit „Passt so“ wird der Hinweis ausgeblendet
- **Abbildungs-Modus:** Karten, Bilder und Diagramme in Farbe als ganze Seite fotografieren

**Texterkennung (OCR)**
- Tesseract läuft komplett im Browser (Deutsch + Englisch), auch offline
- Läuft im Hintergrund weiter, während du scannst; wird nach einem Neustart fortgesetzt
- Repariert Silbentrennung am Zeilenende, entfernt Seitenzahlen und Kolumnentitel und verbindet Absätze über Seitengrenzen
- **Erhält die Formatierung:** Überschriften, Aufzählungen mit Ebenen, nummerierte Listen, **fett** und *kursiv* (eigene Bildanalyse von Strichstärke und Schräglage)
- **Schatten-Entfernung:** Schatten von Hand oder Handy, Falten und ungleichmäßiges Licht werden vor der Erkennung herausgerechnet

**Lesen wie auf einem E-Book-Reader**
- Echter Seitenumbruch statt Scrollen: rechts tippen = weiter, links = zurück, Mitte = Menü, Wischen geht auch
- Schriftgröße, Schriftart (Literata, Georgia, Sans, Weit), Zeilenabstand, Ränder, Blocksatz mit Silbentrennung
- Absätze mit Einzug (Roman) oder Abstand (Fachtext), automatisch passend zum Inhalt
- Hintergründe: Weiß, Papier, Sepia, Dunkel, Schwarz
- Fußzeile mit Buchseite und Prozent oder verbleibender Lesezeit (antippen zum Umschalten)
- Lesezeichen, Volltextsuche, Seitenübersicht, Schieberegler
- **Vorlesen** mit der Stimme des Geräts – blättert mit und hebt den Absatz hervor
- **Inhaltsverzeichnis** aus den erkannten Überschriften, „Noch X Min. im Kapitel“
- **Markieren und Notizen** in vier Farben, Liste aller Markierungen, Export als Markdown
- **Zwei Spalten im Querformat** auf dem Tablet
- **Lesestatistik:** Lesezeit pro Tag, Tage in Folge, meistgelesene Bücher
- **Abbildungen im Text:** markierte Bilder, Karten und Diagramme stehen an der richtigen Stelle im Lesefluss, mit Bildunterschrift; antippen zum Vergrößern
- Fußzeile mit den echten Seitenzahlen des gedruckten Buchs
- Originalfoto-Ansicht mit Zoom, z. B. für Tabellen oder Formeln
- Leseposition wird gespeichert, der Bildschirm bleibt beim Lesen an

**Leseprofile & Synchronisierung**
- Mehrere **Leseprofile** (z. B. für die Familie): jedes mit eigener Leseposition, eigenen Lesezeichen und Schrifteinstellungen
- **Sync über Google Drive oder OneDrive**: Texte, Profile, Lesepositionen, Lesezeichen und Cover auf allen Geräten, ohne eigenen Server (Fotos bleiben lokal). Einrichtung: siehe **[SYNC.md](SYNC.md)**
- Auf einem anderen Gerät weitergelesen? Lesepixel springt an die neueste Stelle

**Buch an eigenes Gerät senden (ohne Internet)**
- Direktübertragung per **WLAN oder Hotspot**: Verbindungsaufbau über zwei QR-Codes, danach gehen die Daten direkt von Gerät zu Gerät, ohne Internet, Server oder Cloud
- Funktioniert auch zwischen iPhone, iPad und Android; Fotos optional
- Kein gemeinsames WLAN? Lesepixel zeigt einen **WLAN-QR-Code** für den Hotspot, den das andere Gerät mit der normalen Kamera-App scannt

**Verwalten**
- Bibliothek mit Covern (Foto oder automatisch erzeugt) und Lesefortschritt
- **Ordner** (auch verschachtelt) und **Tags**, Filter nach Tag
- **Suche über alle Bücher** (Titel, Autor, Tags, Text) – ein Treffer öffnet den Leser an der Stelle
- **App-Sperre mit Face ID / Touch ID** und PIN, wahlweise für die ganze App oder einzelne Bücher
- **Erinnerung an die Sicherung** und **Speicher sparen** (Fotos verkleinern oder löschen, Text bleibt)
- Unsicher erkannte Wörter werden im Editor zum Prüfen angeboten
- Seiten-Editor: drehen, zuschneiden, verschieben, löschen, Text korrigieren, neu erkennen, Seitenzahl korrigieren, **Abbildungen markieren** (Beschriftungen in der Abbildung landen dann nicht im Lesetext)
- **EPUB-Export**, z. B. für „Send to Kindle“, Apple Books oder Tolino
- **Durchsuchbares PDF**: Originalfotos mit unsichtbarer Textebene
- Sicherung und Wiederherstellung der ganzen Bibliothek als ZIP (mit Fotos)

## Installieren

Lesepixel braucht **HTTPS** (für Kamera und Offline-Modus). Am einfachsten geht das mit GitHub Pages:

1. Den Code auf den Branch `main` bringen.
2. Im Repository **Settings → Pages → Build and deployment → Source: GitHub Actions** wählen.
3. Der Workflow `.github/workflows/pages.yml` veröffentlicht die App unter `https://<benutzer>.github.io/<repo>/`.
4. Die Adresse auf dem Handy öffnen und zum Startbildschirm hinzufügen:
   - **iPhone (Safari):** Teilen → „Zum Home-Bildschirm“
   - **Android (Chrome):** Menü ⋮ → „App installieren“

Danach startet Lesepixel wie eine normale App und funktioniert auch ohne Internet.

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

Bücher liegen in der IndexedDB des Browsers. Mit Synchronisierung liegt zusätzlich der Text (ca. 0,5 MB pro Buch) in deinem Cloud-Speicher. Eine Seite braucht etwa 200 bis 400 KB, ein Buch mit 300 Seiten also ungefähr 60 bis 120 MB. Lesepixel fragt nach dauerhaftem Speicher. Trotzdem gilt: **regelmäßig eine Sicherung erstellen** (Einstellungen → Alles sichern), besonders vor einem Handywechsel.

## Rechtliches

Lesepixel ist ein Werkzeug; wofür es eingesetzt wird, liegt in der Verantwortung der Nutzer.

- **Unbedenklich:** eigene Dokumente und Notizen, gemeinfreie Werke (Urheber seit über 70 Jahren tot), Werke mit Erlaubnis des Rechteinhabers, einzelne Auszüge für den privaten Gebrauch.
- **Nicht erlaubt:** ein urheberrechtlich geschütztes Buch im Wesentlichen vollständig zu kopieren – auch privat und auch bei eigenen Büchern –, es sei denn, es wird von Hand abgeschrieben, der Rechteinhaber stimmt zu oder das Buch ist seit mindestens zwei Jahren vergriffen (§ 53 Abs. 4 b UrhG).
- Gescannte Inhalte nicht weitergeben oder veröffentlichen.

In der App: **Einstellungen → Rechtliches** (Nutzungshinweis, Datenschutz-Entwurf, Impressum, Lizenzen). Angaben zum Anbieter werden in `js/legal.js` eingetragen. Keine Rechtsberatung – vor einem öffentlichen oder kommerziellen Angebot rechtlich prüfen lassen.

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
js/reader.js          E-Book-Leser (CSS-Spalten-Paginierung)
js/pageeditor.js      Seiten bearbeiten
js/ocr.js             OCR-Warteschlange (Tesseract.js, Web Worker)
js/textproc.js        OCR → Absätze, Seitenzahlen, Kolumnentitel, Abbildungen im Lesefluss
js/pagecheck.js       Seitenprüfung (fehlende/doppelte/vertauschte Seiten)
js/fontstyle.js       Fett/kursiv aus den Bildpunkten erkennen
js/rich.js            Formatierung (Überschriften, Listen, fett/kursiv) als einfache Auszeichnung
js/imageproc.js       Skalieren, Scan-Filter, Teilen, Drehen, Zuschneiden
js/db.js              IndexedDB
js/epub.js            EPUB-3-Export
js/backup.js          Sicherung/Wiederherstellung
sw.js                 Service Worker (offline)
js/transfer.js        Direktübertragung (WebRTC-Datenkanal, Signalisierung per QR-Code)
js/transferview.js    Bildschirme „Senden“ und „Empfangen“
js/lock.js            App-Sperre (WebAuthn/Face ID, PIN)
js/search.js          Suche über alle Bücher
js/storage.js         Speicher sparen
js/stats.js, statsview.js  Lesestatistik
js/pagedetect.js      Seitenerkennung, Entzerrung, Wölbung, Qualität, Bewegung
js/pdf.js             Durchsuchbares PDF (eigener PDF-Schreiber)
js/legal.js           Angaben zum Anbieter (Impressum/Datenschutz)
js/legalview.js       Seite „Rechtliches“
vendor/               Tesseract, Sprachdaten, JSZip, QR-Codes, Literata, Montserrat (siehe vendor/README.md)
```
