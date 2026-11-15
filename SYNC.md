# Synchronisierung einrichten

Lesepixel gleicht **Texte, Lesepositionen, Lesezeichen, Markierungen, Lernkarten, Lesestatistik, Profile, Cover und markierte Abbildungen** über deinen eigenen Cloud-Speicher ab. Es gibt keinen Server und kein Lesepixel-Konto. **Fotos der Seiten werden nur hochgeladen, wenn du „Fotos mitsichern“ einschaltest** (Einstellungen → Synchronisierung); sonst bleiben sie auf dem Gerät, mit dem du gescannt hast.

Verschlüsselte (gesperrte) Bücher werden nur abgeglichen, solange sie auf dem Gerät entsperrt sind. In der Cloud liegen ihre Texte wie bei allen Büchern in deinem eigenen, durch dein Konto geschützten Speicher; ihre Fotos werden nie hochgeladen.

Damit Lesepixel auf deinen Google Drive oder dein OneDrive zugreifen darf, brauchst du **einmalig eine „Client-ID“**. Das ist eine Art App-Kennung, die du kostenlos in deinem eigenen Google- bzw. Microsoft-Konto anlegst. Sie ist nicht geheim und kommt in `js/config.js`.

**Du brauchst nur einen der beiden Anbieter.**

| | Google Drive | OneDrive |
|---|---|---|
| Einrichtung | ca. 10 Minuten, kostenlos, ohne Kreditkarte | ca. 5 Minuten, braucht aber ein (kostenloses) Azure-Konto, das ggf. eine Kreditkarte verlangt |
| Anmeldung im Alltag | Google erlaubt Web-Apps nur 1 Stunde pro Anmeldung. Lesepixel erneuert das beim Öffnen automatisch (kurzes Aufblitzen der Google-Seite) | bleibt angemeldet, solange du Lesepixel etwa einmal am Tag nutzt |
| Wo liegen die Daten? | versteckter App-Ordner in deinem Drive | Ordner `Apps/Lesepixel` in deinem OneDrive (bzw. wie du die App bei Microsoft benannt hast) |

Die Adresse deiner App (für die Einrichtung):

- **Ursprung:** `https://dellik7777.github.io`
- **Weiterleitungs-Adresse:** `https://dellik7777.github.io/openBook/`

Am bequemsten geht die Einrichtung am **Computer**.

---

## Variante A: Google Drive

1. **https://console.cloud.google.com** öffnen und mit deinem Google-Konto anmelden.
2. Oben links auf die Projektauswahl → **„Neues Projekt“** → Name `Lesepixel` → **Erstellen**. Danach sicherstellen, dass das Projekt oben ausgewählt ist.
3. **Google Drive API aktivieren:** Suchfeld oben → „Google Drive API“ → **Aktivieren**.
4. **Zustimmungsbildschirm** einrichten: Menü → **„APIs & Dienste“ → „OAuth-Zustimmungsbildschirm“** (heißt teils auch „Google Auth Platform“) → **Jetzt starten**
   - App-Name: `Lesepixel`, Support-E-Mail: deine Adresse
   - Zielgruppe: **Extern**
   - Kontakt-E-Mail: deine Adresse → zustimmen → **Erstellen**
5. **Testnutzer eintragen:** Bereich **„Zielgruppe“** → **„Testnutzer“ → „Nutzer hinzufügen“** → deine Google-Adresse (und die von allen, die Lesepixel mit eigenem Google-Konto nutzen sollen) → Speichern.
   Die App bleibt im Status „Test“, das ist für private Nutzung genau richtig.
6. **Client anlegen:** Bereich **„Clients“** → **„Client erstellen“**
   - Anwendungstyp: **Webanwendung**, Name: `Lesepixel`
   - **Autorisierte JavaScript-Quellen:** `https://dellik7777.github.io`
   - **Autorisierte Weiterleitungs-URIs:** `https://dellik7777.github.io/openBook/` (mit Schrägstrich am Ende!)
   - **Erstellen**
7. Die angezeigte **Client-ID** kopieren (endet auf `.apps.googleusercontent.com`). Ein Client-Secret wird nicht gebraucht.

Beim ersten Verbinden zeigt Google den Hinweis **„Google hat diese App nicht überprüft“**. Das ist normal, weil es deine eigene App ist: **„Erweitert“ → „Weiter zu Lesepixel“**.

---

## Variante B: OneDrive

1. **https://portal.azure.com** öffnen und mit dem Microsoft-Konto anmelden, zu dem dein OneDrive gehört.
   Falls Microsoft meldet, dass du ein Verzeichnis bzw. Abonnement brauchst: ein kostenloses Azure-Konto anlegen (https://azure.microsoft.com/free). Es entstehen keine Kosten.
2. Suchfeld → **„App-Registrierungen“** → **„Neue Registrierung“**
   - Name: `Lesepixel`
   - Unterstützte Kontotypen: **„Konten in einem beliebigen Organisationsverzeichnis und persönliche Microsoft-Konten“**
   - Umleitungs-URI: Plattform **„Single-Page-Anwendung (SPA)“**, Adresse `https://dellik7777.github.io/openBook/`
   - **Registrieren**
3. Auf der Übersichtsseite die **„Anwendungs-ID (Client)“** kopieren.

Die nötigen Berechtigungen (`Files.ReadWrite.AppFolder`, `User.Read`) fragt Lesepixel bei der Anmeldung selbst an.

---

## Client-ID eintragen

Am einfachsten: **Schick mir (Claude) die Client-ID**, dann trage ich sie in `js/config.js` ein. Danach ist sie auf allen Geräten automatisch da.

Alternativ in der App: **Einstellungen → Synchronisierung → „Erweitert: eigene Client-IDs“**. Das musst du dann aber auf jedem Gerät einzeln machen.

## Verbinden

Auf **jedem Gerät** (iPhone, iPad, Android): **Einstellungen → „Google Drive verbinden“** bzw. **„OneDrive verbinden“** und überall **dasselbe Konto** wählen.

Beim ersten Verbinden eines weiteren Geräts werden gleichnamige Profile (z. B. „Ich“) automatisch zusammengeführt.

## Wie die Synchronisierung arbeitet

- Abgeglichen wird beim Öffnen der App, kurz nach Änderungen, alle 5 Minuten und beim Wechsel in den Hintergrund. Das Wolken-Symbol oben in der Bibliothek zeigt den Status, antippen synchronisiert sofort.
- Bei Konflikten gewinnt die **jüngere Änderung**.
- Liest du auf einem anderen Gerät weiter, springt Lesepixel beim Öffnen des Buchs automatisch dorthin. Hast du im gerade offenen Buch schon geblättert, fragt Lesepixel vorher.
- Auf Geräten ohne Fotos zeigt die Originalansicht einen Hinweis statt des Bildes. Texte kannst du überall korrigieren, die Korrektur wird übertragen.
- Löschen (Buch, Seite, Profil) wird auf alle Geräte übertragen.
- **Trennen** in den Einstellungen löscht nichts, weder auf dem Gerät noch in der Cloud.
