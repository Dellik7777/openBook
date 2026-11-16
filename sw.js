// Service Worker: macht Lesepixel offline nutzbar.
// App-Dateien: zuerst aus dem Cache, im Hintergrund aktualisieren.
// OCR-Engine & Sprachdaten (groß, ändern sich nie): Cache zuerst.

const VERSION = 'v20'; // zusammen mit BUILD in js/version.js anpassen
const SHELL = `openbook-shell-${VERSION}`;
const VENDOR = 'openbook-vendor-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/ui.js',
  'js/ocr.js',
  'js/textproc.js',
  'js/imageproc.js',
  'js/scanner.js',
  'js/reader.js',
  'js/pageeditor.js',
  'js/epub.js',
  'js/backup.js',
  'js/zip.js',
  'js/profiles.js',
  'js/pagecheck.js',
  'js/rich.js',
  'js/fontstyle.js',
  'js/transfer.js',
  'js/transferview.js',
  'js/legal.js',
  'js/legalview.js',
  'js/lock.js',
  'js/search.js',
  'js/storage.js',
  'js/stats.js',
  'js/statsview.js',
  'js/pagedetect.js',
  'js/pdf.js',
  'js/barcode.js',
  'js/isbn.js',
  'js/importer.js',
  'js/zoom.js',
  'js/lookup.js',
  'js/cards.js',
  'js/cardsview.js',
  'js/vault.js',
  'js/dewarp.js',
  'js/corners.js',
  'js/piper.js',
  'js/piper-worker.js',
  'js/proofread.js',
  'js/proofview.js',
  'js/names.js',
  'js/config.js',
  'js/version.js',
  'js/sync/sync.js',
  'js/sync/oauth.js',
  'js/sync/google.js',
  'js/sync/onedrive.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'vendor/fonts/literata-latin-400-normal.woff2',
  'vendor/fonts/montserrat-regular.woff2',
  'vendor/fonts/montserrat-semibold.woff2',
  'vendor/fonts/montserrat-bold.woff2',
  'icons/icon-512.png',
];

// Werden nach der Installation im Hintergrund geladen, damit OCR auch offline klappt
const VENDOR_FILES = [
  'vendor/tesseract/tesseract.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract/lang/deu.traineddata.gz',
  'vendor/tesseract/lang/eng.traineddata.gz',
  'vendor/jszip/jszip.min.js',
  'vendor/qr/qrcode.js',
  'vendor/qr/jsQR.js',
  'vendor/wordlist/deu.txt',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('openbook-') && k !== SHELL && k !== VENDOR) await caches.delete(k);
    }
    await self.clients.claim();
    // Große Dateien vorab laden (nicht blockierend)
    const v = await caches.open(VENDOR);
    for (const f of VENDOR_FILES) {
      if (!(await v.match(f))) v.add(f).catch(() => {});
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      const c = await caches.open(VENDOR);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Stale-while-revalidate für die App selbst
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? './' : req;
    const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then((res) => {
      if (res.ok) c.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    return res || new Response('Offline', { status: 503 });
  })());
});
