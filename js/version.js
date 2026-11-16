// Versionsnummer der App (bei jeder Veröffentlichung anpassen, zusammen mit VERSION in sw.js)
export const VERSION = '2.0';
export const BUILD = 'v20';
export const DATE = '2026-11-16';

// Kurzfassung für den Hinweis nach einem Update
export const HEADLINE = 'Natürliche Vorlesestimmen · Textprüfung fürs ganze Buch · deutlich genauere Texterkennung';

// „Was ist neu“ – neueste Version zuerst
export const NOTES = [
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
