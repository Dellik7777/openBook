# Mitgelieferte Bibliotheken

Damit Lesepixel komplett offline funktioniert, liegen diese Dateien direkt im Repository (kein CDN):

| Ordner | Quelle | Lizenz |
|---|---|---|
| `tesseract/` | [tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 + tesseract.js-core (nur LSTM-Builds) | Apache-2.0 |
| `tesseract/lang/` | `@tesseract.js-data/deu` und `eng`, Variante `4.0.0_best_int` | Apache-2.0 |
| `jszip/` | [JSZip](https://stuk.github.io/jszip/) 3.10.1 | MIT / GPLv3 |
| `qr/qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 | MIT |
| `qr/jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (QR-Codes lesen, wenn der Browser keinen eingebauten Leser hat) | Apache-2.0 |
| `pdfjs/` | [PDF.js](https://github.com/mozilla/pdf.js) 4.10.38 (`pdfjs-dist`, Legacy-Build; PDF-Import, wird erst bei Bedarf geladen) | Apache-2.0 (`LICENSE`) |
| `ort/` | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.18.0 (`onnxruntime-web`, nur `ort.wasm.min.js` + `ort-wasm-simd.wasm`; eigene Stimmen, wird erst bei Bedarf geladen) | MIT |
| `piper/` | [piper-wasm](https://github.com/diffusionstudio/piper-wasm) 1.0.0 (Build von [piper-phonemize](https://github.com/rhasspy/piper-phonemize) mit [eSpeak NG](https://github.com/rhasspy/espeak-ng) und dessen Sprachdaten); `phonemize.js` ist der Lade-Code aus [vits-web](https://github.com/diffusionstudio/vits-web) 1.0.3 | MIT; eSpeak NG: GPL-3.0 (unverändert, Quelltext unter dem Link) |
| `fonts/literata-*` | [Literata](https://github.com/googlefonts/literata) über @fontsource | SIL OFL 1.1 |
| `fonts/montserrat-*` | [Montserrat](https://github.com/JulietaUla/Montserrat) | SIL OFL 1.1 (`OFL-Montserrat.txt`) |

Weitere Sprachen für die Texterkennung: die passende `xxx.traineddata.gz` von `@tesseract.js-data/xxx` (Ordner `4.0.0_best_int`) nach `tesseract/lang/` kopieren und `LANGS` in `js/ocr.js` erweitern, z. B. `deu+eng+fra`.

Die Piper-Stimmen selbst (ca. 60–115 MB) liegen nicht im Repository. Sie werden auf Wunsch von [Hugging Face – rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) geladen und im Cache `ob-voices-v1` des Browsers aufbewahrt.
