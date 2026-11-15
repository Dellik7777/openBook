// Lädt JSZip bei Bedarf (lokal mitgeliefert, funktioniert offline).
let p = null;
export function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/jszip/jszip.min.js', import.meta.url).href;
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { p = null; reject(new Error('ZIP-Modul konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
  }
  return p;
}
