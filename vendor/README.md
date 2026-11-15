# Mitgelieferte Bibliotheken

Damit openBook komplett offline funktioniert, liegen diese Dateien direkt im Repository (kein CDN):

| Ordner | Quelle | Lizenz |
|---|---|---|
| `tesseract/` | [tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 + tesseract.js-core (nur LSTM-Builds) | Apache-2.0 |
| `tesseract/lang/` | `@tesseract.js-data/deu` und `eng`, Variante `4.0.0_best_int` | Apache-2.0 |
| `jszip/` | [JSZip](https://stuk.github.io/jszip/) 3.10.1 | MIT / GPLv3 |
| `fonts/` | [Literata](https://github.com/googlefonts/literata) über @fontsource | SIL OFL 1.1 |

Weitere Sprachen für die Texterkennung: die passende `xxx.traineddata.gz` von `@tesseract.js-data/xxx` (Ordner `4.0.0_best_int`) nach `tesseract/lang/` kopieren und `LANGS` in `js/ocr.js` erweitern, z. B. `deu+eng+fra`.
