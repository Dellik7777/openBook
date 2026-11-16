// Seite „Rechtliches“: Nutzungshinweis (Urheberrecht), Datenschutz, Impressum, Lizenzen.

import legal from './legal.js';
import { h, iconButton, pixels } from './ui.js';

const PH = (t) => h('span', { class: 'placeholder' }, `[${t}]`);

function section(title, ...children) {
  return h('section', { class: 'legal-sec' }, h('h2', {}, pixels('small'), title), ...children);
}

function anbieter() {
  const v = legal.verantwortlich;
  if (!v) return h('p', {}, PH('Name, Anschrift und E-Mail des Anbieters – noch nicht eingetragen'));
  return h('p', {},
    v.firma ? [v.firma, h('br')] : null,
    v.name, h('br'),
    v.strasse || PH('Straße'), h('br'),
    v.ort || PH('PLZ Ort'), h('br'),
    v.email ? ['E-Mail: ', h('a', { href: 'mailto:' + v.email }, v.email), h('br')] : null,
    v.telefon ? ['Telefon: ', v.telefon, h('br')] : null,
    v.ustId ? ['USt-IdNr.: ', v.ustId] : null,
  );
}

export function usageNotice() {
  return [
    h('p', {}, 'Lesepixel ist ein Werkzeug, um Gedrucktes abzufotografieren, den Text zu erkennen und bequem zu lesen. Wofür du es einsetzt, liegt in deiner Verantwortung.'),
    h('p', {}, h('strong', {}, 'Ohne Bedenken:'), ' eigene Dokumente und Notizen, Texte, deren Urheber seit über 70 Jahren tot sind (gemeinfrei), Werke mit Erlaubnis des Rechteinhabers sowie einzelne Auszüge (z. B. Kapitel oder Seiten) für den privaten Gebrauch.'),
    h('p', {}, h('strong', {}, 'Nicht erlaubt:'), ' Ein urheberrechtlich geschütztes Buch im Wesentlichen vollständig zu kopieren ist in Deutschland auch für den privaten Gebrauch grundsätzlich nur zulässig, wenn es von Hand abgeschrieben wird, der Rechteinhaber zustimmt oder das Buch seit mindestens zwei Jahren vergriffen ist (§ 53 Abs. 4 b UrhG). Das gilt auch für Bücher, die dir gehören.'),
    h('p', {}, 'Gescannte Inhalte dürfen nicht an andere weitergegeben oder veröffentlicht werden. Die Übertragungs- und Synchronisierungsfunktionen sind nur für deine eigenen Geräte gedacht.'),
    h('p', { class: 'muted small' }, 'Diese Hinweise sind eine allgemeine Information und keine Rechtsberatung.'),
  ];
}

export async function openLegal(root) {
  const view = h('div', { class: 'page legal' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => { history.length > 1 ? history.back() : (location.hash = '#/'); }),
      h('h1', { class: 'grow tr-title' }, 'Rechtliches'),
    ),
    h('nav', { class: 'legal-nav' },
      ...[['nutzung', 'Nutzung'], ['datenschutz', 'Datenschutz'], ['impressum', 'Impressum'], ['lizenzen', 'Lizenzen']]
        .map(([id, t]) => h('a', { href: '#', onClick: (e) => { e.preventDefault(); view.querySelector('#legal-' + id).scrollIntoView({ behavior: 'smooth' }); } }, t))),

    h('div', { id: 'legal-nutzung' }, section('Nutzung & Urheberrecht', ...usageNotice())),

    h('div', { id: 'legal-datenschutz' }, section('Datenschutz',
      h('p', { class: 'draft' }, 'Entwurf – vor einer öffentlichen Bewerbung der App bitte rechtlich prüfen lassen.'),
      h('h3', {}, 'Verantwortlich'),
      anbieter(),
      h('h3', {}, 'Grundsatz: Alles bleibt auf deinem Gerät'),
      h('p', {}, 'Fotos, erkannte Texte, Lesepositionen und Einstellungen werden ausschließlich im Speicher deines Browsers auf deinem Gerät abgelegt. Die Texterkennung läuft vollständig auf dem Gerät. Es gibt kein Benutzerkonto, keine Analyse- oder Werbedienste und keine Cookies zur Nachverfolgung. Der Anbieter erhält keine deiner Inhalte.'),
      h('h3', {}, 'Bereitstellung der App (Hosting)'),
      h('p', {}, 'Die App wird über GitHub Pages ausgeliefert (GitHub, Inc., 88 Colin P Kelly Jr St, San Francisco, CA 94107, USA). Beim Laden verarbeitet GitHub technisch notwendige Verbindungsdaten wie deine IP-Adresse, um die Dateien auszuliefern und den Dienst abzusichern (Art. 6 Abs. 1 lit. f DSGVO). Eine Übermittlung in die USA ist möglich; GitHub ist nach dem EU-US Data Privacy Framework zertifiziert. Nach dem ersten Laden funktioniert die App ohne Verbindung.'),
      h('h3', {}, 'Kamera'),
      h('p', {}, 'Die Kamera wird nur nach deiner Freigabe und nur zum Fotografieren von Seiten und zum Lesen von QR- und ISBN-Strichcodes genutzt. Bilder werden nicht übertragen (außer mit „Fotos mitsichern“ in deinen eigenen Cloud-Speicher).'),
      h('h3', {}, 'ISBN nachschlagen (optional)'),
      h('p', {}, 'Wenn du beim Anlegen eines Buchs „ISBN scannen“ bzw. „Nachschlagen“ nutzt, wird ausschließlich die ISBN an Open Library (Internet Archive, USA), die Deutsche Nationalbibliothek, lobid (Hochschulbibliothekszentrum NRW) und Google Books (Google Ireland Ltd.) gesendet, um Titel, Autor und Cover abzurufen. Dabei sehen diese Anbieter technisch bedingt deine IP-Adresse. Der Strichcode selbst wird auf dem Gerät gelesen.'),
      h('h3', {}, 'Vorlesen'),
      h('p', {}, 'Die Vorlesefunktion nutzt die Sprachausgabe deines Geräts bzw. Browsers. Lesepixel wählt bevorzugt Stimmen, die auf dem Gerät laufen. Sind nur Online-Stimmen verfügbar (z. B. in manchen Browsern am Computer), überträgt der Browser den vorgelesenen Text an dessen Anbieter.'),
      h('p', {}, 'Eigene Stimmen (Piper): Wenn du eine eigene Stimme lädst, wird nur die Stimmdatei von Hugging Face (Hugging Face Inc., USA) heruntergeladen; dabei sieht der Anbieter technisch bedingt deine IP-Adresse. Die Sprachausgabe läuft danach vollständig auf deinem Gerät, der Text wird nicht übertragen.'),
      h('h3', {}, 'App-Sperre'),
      h('p', {}, 'Face ID / Touch ID wird über die Geräte-Schnittstelle des Browsers geprüft. Biometrische Daten verlassen das Gerät nicht und sind für Lesepixel nicht zugänglich. Die PIN wird nur als Prüfsumme gespeichert. Gesperrte Bücher werden auf dem Gerät verschlüsselt (AES-256-GCM); der Schlüssel wird nur mit der PIN bzw. Face ID verpackt gespeichert. Sicherungsdateien, die du selbst exportierst, enthalten die Bücher unverschlüsselt.'),
      h('h3', {}, 'Wort nachschlagen (optional)'),
      h('p', {}, 'Wenn du ein markiertes Wort nachschlägst, wird nur dieses Wort an Wikipedia (Wikimedia Foundation, USA) gesendet, um den Kurzartikel anzuzeigen; dabei wird deine IP-Adresse technisch übermittelt. Die Links zu Duden, DWDS, Wiktionary und DeepL öffnen die jeweilige Website im Browser; dort gelten deren Datenschutzbestimmungen.'),
      h('h3', {}, 'Synchronisierung (optional)'),
      h('p', {}, 'Wenn du die Synchronisierung einschaltest, werden Texte, Profile, Lesestände, Lesezeichen, Markierungen, Lernkarten-Stand, Lesestatistik, Cover und markierte Abbildungen in deinem eigenen Speicher bei Google Drive (Google Ireland Ltd.) oder Microsoft OneDrive (Microsoft Ireland Operations Ltd.) abgelegt. Seitenfotos nur, wenn du „Fotos mitsichern“ einschaltest (Fotos gesperrter Bücher nie). Die Anmeldung erfolgt direkt bei diesen Anbietern; es gelten deren Datenschutzbestimmungen. Rechtsgrundlage ist deine Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die du jederzeit durch „Trennen“ widerrufen kannst.'),
      h('h3', {}, 'Übertragung an eigene Geräte'),
      h('p', {}, 'Bei „An eigenes Gerät senden“ werden die Daten direkt und verschlüsselt zwischen deinen Geräten im lokalen Netz übertragen, ohne Server des Anbieters oder Dritter.'),
      h('h3', {}, 'Deine Rechte'),
      h('p', {}, 'Da der Anbieter keine personenbezogenen Daten von dir speichert, kannst du Auskunft, Berichtigung und Löschung direkt selbst umsetzen: Inhalte in der App löschen bzw. die Website-Daten im Browser entfernen. Du hast außerdem das Recht, dich bei einer Datenschutz-Aufsichtsbehörde zu beschweren.'),
      h('p', { class: 'muted small' }, `Stand: ${legal.stand}`),
    )),

    h('div', { id: 'legal-impressum' }, section('Impressum',
      legal.verantwortlich
        ? [h('p', {}, 'Angaben gemäß § 5 DDG'), anbieter()]
        : [h('p', {}, PH('Impressum noch nicht eingetragen')),
          h('p', { class: 'muted small' }, 'Pflicht, sobald die App geschäftsmäßig angeboten wird (§ 5 DDG): Name, ladungsfähige Anschrift, E-Mail und Telefon.')],
    )),

    h('div', { id: 'legal-lizenzen' }, section('Lizenzen',
      h('p', {}, 'Lesepixel enthält folgende freie Software und Schriften. Die vollständigen Lizenztexte liegen im Ordner vendor/ des Quellcodes.'),
      h('ul', { class: 'lic' },
        ...[
          ['Tesseract.js & Tesseract-Kern (Texterkennung)', 'Apache License 2.0'],
          ['Tesseract-Sprachdaten Deutsch/Englisch', 'Apache License 2.0'],
          ['JSZip (ZIP, EPUB, Sicherungen)', 'MIT bzw. GPLv3 (MIT gewählt)'],
          ['qrcode-generator (QR-Codes erzeugen)', 'MIT'],
          ['jsQR (QR-Codes lesen)', 'Apache License 2.0'],
          ['PDF.js (PDF-Import)', 'Apache License 2.0'],
          ['Deutsche Wortliste (Textprüfung, aus Tesseract langdata_lstm)', 'Apache License 2.0'],
          ['ONNX Runtime Web (eigene Stimmen)', 'MIT'],
          ['piper-phonemize / piper-wasm (Lautschrift für eigene Stimmen)', 'MIT'],
          ['eSpeak NG (Lautschrift, enthalten in piper-wasm)', 'GPL-3.0 – Quelltext: github.com/rhasspy/espeak-ng'],
          ['Piper-Stimmen (werden auf Wunsch geladen)', 'je nach Stimme, siehe Modellkarte bei Hugging Face (Thorsten: CC0)'],
          ['Literata (Leseschrift)', 'SIL Open Font License 1.1'],
          ['Montserrat (Oberflächenschrift)', 'SIL Open Font License 1.1'],
        ].map(([n, l]) => h('li', {}, h('strong', {}, n), h('br'), h('span', { class: 'muted small' }, l)))),
    )),
  );
  root.append(view);
}
