// Versionsnummer der App (bei jeder Veröffentlichung anpassen, zusammen mit VERSION in sw.js)
export const VERSION = '2.1';
export const BUILD = 'v21';
export const DATE = '2026-11-17';

// Kurzfassung für den Hinweis nach einem Update
export const HEADLINE = 'Hörbuch-Modus mit Sperrbildschirm-Steuerung · Namen-Register · Weiterlesen-Karte · Zitate als Bild teilen · Umblättern wie ein Buch';

// „Was ist neu“ – neueste Version zuerst
export const NOTES = [
  ['2.1', [
    'Hörbuch-Modus: großer Player mit Cover, Kapitel, Restzeit, ±30 Sekunden und Kapitelsprüngen – steuerbar vom Sperrbildschirm und mit AirPods (eigene Stimmen)',
    'Namen-Register: Personen und Orte im Buch werden automatisch erkannt, mit allen Fundstellen (Inhalt → Namen)',
    'Weiterlesen-Karte in der Bibliothek: aktuelles Buch mit Fortschritt, Restzeit im Kapitel und „Anhören“',
    'Zitate als gestaltete Bildkarte teilen (Papier, Nacht, Orange)',
    'Umblättern wie ein Buch, neues Farbschema „Buch“ mit Papierstruktur, Fortschrittslinie fürs Kapitel',
  ]],
  ['2.0', [
    'Eigene natürliche Vorlesestimmen (Thorsten, Kerstin, Ramona, Eva) – einmal laden, dann offline',
    'Textprüfung fürs ganze Buch: eindeutige Lesefehler werden automatisch korrigiert, der Rest kommt in eine Prüfliste mit Foto-Ausschnitt',
    'Deutlich genauere Texterkennung: Silbentrennung, Satzzeichen, Anführungszeichen, Seitenzahlen, Kursivschrift',
    'Kapitelüberschriften in Großbuchstaben werden erkannt',
    'Nachschlagen: gespeichert für offline und Fundstellen im Buch',
    'Stimmenauswahl mit Hörprobe, Speicherschutz-Hinweis fürs iPhone',
  ]],
];

export const dateText = () => new Date(DATE + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
