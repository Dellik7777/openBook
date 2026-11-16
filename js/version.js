// Versionsnummer der App (bei jeder Veröffentlichung anpassen, zusammen mit VERSION in sw.js)
export const VERSION = '3.0';
export const BUILD = 'v30';
export const DATE = '2026-11-17';

// Kurzfassung für den Hinweis nach einem Update
export const HEADLINE = 'Scan 3.0: einfach umblättern – Lesepixel fotografiert, prüft und meldet „S. 45 ✓“. Mit Fertig-Prüfung am Ende.';

// „Was ist neu“ – neueste Version zuerst
export const NOTES = [
  ['3.0', [
    'Blättermodus: Handy ruhig halten und einfach umblättern – jede neue Seite wird automatisch fotografiert',
    'Einzel- und Doppelseiten werden automatisch erkannt und geteilt',
    'Live-Rückmeldung mit Ton und Vibration: „S. 45 ✓“ nach jeder erkannten Seite',
    'Doppelt fotografierte Seiten werden automatisch verworfen; Hinweise bei Finger im Bild und angeschnittener Seite',
    'Fertig-Prüfung nach dem Scannen: fehlende Seiten (direkt nachscannen), Dubletten, Reihenfolge, Fotoqualität und Textprüfung – oder „Alles vollständig“',
  ]],
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
