// Bildschirme „Buch senden“ und „Buch empfangen“ (Direktübertragung per WLAN/Hotspot).

import * as db from './db.js';
import { h, icon, iconButton, toast } from './ui.js';
import { createSender, createReceiver, decodeSignal, qrCanvas, startScanner, sendBlob, receiveBlob, wifiPayload } from './transfer.js';

const CONNECT_TIMEOUT = 25000;

function hints() {
  return h('details', { class: 'tr-hints' },
    h('summary', {}, 'Klappt die Verbindung nicht?'),
    h('ul', {},
      h('li', {}, 'Beide Geräte müssen im selben WLAN sein – oder eines macht einen Hotspot auf und das andere verbindet sich damit. Internet ist nicht nötig.'),
      h('li', {}, 'Gäste-WLANs und manche Firmen-/Hotel-WLANs verbieten Verbindungen zwischen Geräten. Dann einen Hotspot verwenden.'),
      h('li', {}, 'VPN auf beiden Geräten ausschalten.'),
      h('li', {}, 'openBook auf beiden Geräten geöffnet lassen, bis die Übertragung fertig ist.'),
    ),
  );
}

function progressBar() {
  const bar = h('div', {});
  const el = h('div', { class: 'tr-progress' }, bar);
  el.set = (r) => { bar.style.width = Math.round(r * 100) + '%'; };
  return el;
}

function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }

// ---------- WLAN-QR (Hotspot teilen) ----------

function wifiCard() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('ob.wifi') || '{}'); } catch (e) { /* */ }
  const ssid = h('input', { class: 'input', placeholder: 'WLAN-/Hotspot-Name', value: saved.ssid || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const pw = h('input', { class: 'input', placeholder: 'Passwort', value: saved.pw || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const out = h('div', { class: 'tr-qrwrap' });
  const show = async () => {
    if (!ssid.value.trim()) { ssid.focus(); return; }
    try { localStorage.setItem('ob.wifi', JSON.stringify({ ssid: ssid.value.trim(), pw: pw.value })); } catch (e) { /* */ }
    out.replaceChildren(await qrCanvas(wifiPayload(ssid.value.trim(), pw.value), 260),
      h('p', { class: 'muted small' }, 'Mit der normalen Kamera-App des anderen Geräts scannen und „Verbinden“ antippen.'));
  };
  return h('details', { class: 'card tr-wifi' },
    h('summary', {}, icon('wifi'), h('span', {}, h('strong', {}, 'Kein gemeinsames WLAN?'), h('br'), h('span', { class: 'muted small' }, 'Hotspot einschalten und das andere Gerät per QR-Code verbinden'))),
    h('ol', { class: 'small' },
      h('li', {}, 'Auf diesem Gerät den persönlichen Hotspot einschalten (Einstellungen → Hotspot). Mobile Daten dürfen aus sein.'),
      h('li', {}, 'Name und Passwort des Hotspots hier eintragen (wird gemerkt).'),
      h('li', {}, 'Das andere Gerät scannt den WLAN-Code mit seiner Kamera-App.'),
    ),
    h('p', { class: 'muted small' }, 'Tipp Android: Unter Einstellungen → Hotspot zeigt Android selbst einen QR-Code an.'),
    ssid, pw,
    h('button', { class: 'btn small', onClick: show }, icon('wifi'), 'WLAN-QR-Code zeigen'),
    out,
  );
}

// ---------- Senden ----------

export async function openSend(root, bookId) {
  const book = await db.getBook(bookId);
  if (!book) { location.hash = '#/'; return; }
  const pages = await db.getPagesMeta(bookId);
  const photoBytes = pages.reduce((s, p) => s + (p.image ? p.image.size + (p.thumb ? p.thumb.size : 0) : 0), 0);
  let photos = localStorage.getItem('ob.sendPhotos') !== '0';
  let sender = null, stopScan = null, warmStream = null, closed = false;

  const stage = h('div', { class: 'stack tr-stage' });
  const photosBox = h('input', { type: 'checkbox', checked: photos && photoBytes > 0, disabled: !photoBytes, onChange: (e) => {
    photos = e.target.checked;
    localStorage.setItem('ob.sendPhotos', photos ? '1' : '0');
  } });
  const view = h('div', { class: 'page transfer' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => { location.hash = `#/book/${bookId}`; }),
      h('h1', { class: 'grow tr-title' }, 'An eigenes Gerät senden'),
    ),
    h('p', { class: 'muted' }, `„${book.title}“ direkt per WLAN übertragen – ohne Internet, ohne Cloud.`),
    wifiCard(),
    stage,
    h('label', { class: 'switch-row card' },
      h('span', {}, h('strong', {}, 'Fotos der Seiten mitsenden'), h('br'),
        h('span', { class: 'muted small' }, photoBytes ? `zusätzlich ca. ${fmtSize(photoBytes)} – nötig für die Originalansicht` : 'Dieses Gerät hat keine Seitenfotos')),
      photosBox),
    hints(),
  );
  root.append(view);

  async function step1() {
    stage.replaceChildren(h('div', { class: 'card tr-wait' }, h('span', { class: 'spinner' }), 'Verbindung wird vorbereitet …'));
    try {
      // Kamera kurz einschalten: Dann geben die Browser die echte WLAN-Adresse frei
      // (sonst verschleiert) – das macht die Direktverbindung zuverlässiger.
      try { warmStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); } catch (e) { /* ohne Kamera geht es evtl. trotzdem */ }
      sender = await createSender();
      if (warmStream) { warmStream.getTracks().forEach((t) => t.stop()); warmStream = null; }
    } catch (e) {
      stage.replaceChildren(h('div', { class: 'card' }, h('strong', {}, 'Direktübertragung wird hier nicht unterstützt.'), h('p', { class: 'muted small' }, e.message)));
      return;
    }
    if (closed) { sender.close(); return; }
    const qr = await qrCanvas(sender.signal, 340);
    stage.replaceChildren(
      h('div', { class: 'card tr-step' },
        h('div', { class: 'tr-num' }, '1'),
        h('div', { class: 'grow' },
          h('strong', {}, 'Auf dem anderen Gerät: openBook → Einstellungen → „Buch empfangen“'),
          h('p', { class: 'muted small' }, 'und diesen Code scannen.')),
      ),
      h('div', { class: 'tr-qrwrap' }, qr),
      h('button', { class: 'btn primary block', onClick: step2 }, icon('camera'), 'Weiter: Antwort-Code scannen'),
    );
    window.__obTransferSender = sender; // für automatische Tests
  }

  async function step2() {
    const video = h('video', { class: 'tr-video', playsinline: true, muted: true });
    const status = h('p', { class: 'muted small' }, 'Den Code auf dem anderen Gerät in den Rahmen halten.');
    stage.replaceChildren(
      h('div', { class: 'card tr-step' }, h('div', { class: 'tr-num' }, '2'), h('div', { class: 'grow' }, h('strong', {}, 'Antwort-Code des anderen Geräts scannen'))),
      h('div', { class: 'tr-camera' }, video, h('div', { class: 'tr-frame' })),
      status,
      h('button', { class: 'btn block', onClick: () => { if (stopScan) stopScan(); step1(); } }, 'Zurück zum eigenen Code'),
    );
    try {
      stopScan = await startScanner(video, async (text) => {
        const sig = await decodeSignal(text).catch(() => null);
        if (!sig) { status.textContent = 'Das ist kein openBook-Code.'; return false; }
        if (sig.kind !== 'a') { status.textContent = 'Das ist der eigene Code – bitte den Antwort-Code des anderen Geräts scannen.'; return false; }
        if (sig.sid !== sender.sid) { status.textContent = 'Der Code gehört zu einer anderen Übertragung. Auf dem anderen Gerät neu scannen.'; return false; }
        connect(sig.sdp);
        return true;
      });
    } catch (e) {
      status.textContent = 'Kamera nicht verfügbar: ' + e.message;
    }
  }

  async function connect(answerSdp) {
    const prog = progressBar();
    const status = h('p', {}, 'Verbinde …');
    stage.replaceChildren(h('div', { class: 'card stack' }, status, prog));
    try {
      await sender.acceptAnswer(answerSdp);
      const dc = await Promise.race([
        sender.opened,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Die Geräte erreichen sich nicht.')), CONNECT_TIMEOUT)),
      ]);
      status.textContent = 'Verbunden – Buch wird gepackt …';
      const { exportBackup } = await import('./backup.js');
      const blob = await exportBackup([bookId], { photos: photos && photoBytes > 0 });
      status.textContent = `Sende ${fmtSize(blob.size)} …`;
      await sendBlob(dc, blob, { title: book.title }, (r) => prog.set(r));
      prog.set(1);
      stage.replaceChildren(h('div', { class: 'card tr-done' }, icon('check'), h('strong', {}, 'Fertig!'), h('p', { class: 'muted' }, `„${book.title}“ ist jetzt auf dem anderen Gerät.`),
        h('a', { class: 'btn', href: `#/book/${bookId}` }, 'Zurück zum Buch')));
      sender.close();
    } catch (e) {
      console.error(e);
      stage.replaceChildren(h('div', { class: 'card stack' },
        h('strong', {}, 'Übertragung fehlgeschlagen'),
        h('p', { class: 'muted small' }, e.message),
        h('button', { class: 'btn primary', onClick: () => { sender && sender.close(); step1(); } }, 'Nochmal versuchen'),
      ));
    }
  }

  step1();
  return () => {
    closed = true;
    if (stopScan) stopScan();
    if (warmStream) warmStream.getTracks().forEach((t) => t.stop());
    if (sender) sender.close();
    delete window.__obTransferSender;
  };
}

// ---------- Empfangen ----------

export async function openReceive(root) {
  let receiver = null, stopScan = null, closed = false;
  const stage = h('div', { class: 'stack tr-stage' });
  const view = h('div', { class: 'page transfer' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Zurück', () => { location.hash = '#/'; }),
      h('h1', { class: 'grow tr-title' }, 'Buch empfangen'),
    ),
    h('p', { class: 'muted' }, 'Auf dem anderen Gerät beim Buch „⋯ → An eigenes Gerät senden“ wählen. Beide Geräte im selben WLAN oder Hotspot – Internet ist nicht nötig.'),
    stage,
    hints(),
  );
  root.append(view);

  async function step1() {
    const video = h('video', { class: 'tr-video', playsinline: true, muted: true });
    const status = h('p', { class: 'muted small' }, 'Den Code des sendenden Geräts in den Rahmen halten.');
    stage.replaceChildren(
      h('div', { class: 'card tr-step' }, h('div', { class: 'tr-num' }, '1'), h('div', { class: 'grow' }, h('strong', {}, 'Code des sendenden Geräts scannen'))),
      h('div', { class: 'tr-camera' }, video, h('div', { class: 'tr-frame' })),
      status,
    );
    try {
      stopScan = await startScanner(video, async (text) => {
        const sig = await decodeSignal(text).catch(() => null);
        if (!sig) { status.textContent = 'Das ist kein openBook-Code.'; return false; }
        if (sig.kind !== 'o') { status.textContent = 'Bitte den Code des sendenden Geräts scannen.'; return false; }
        status.textContent = 'Erkannt – Antwort wird erstellt …';
        // Kamera läuft beim Erstellen der Antwort noch (für eine zuverlässigere Verbindung)
        const ok = await accept(sig);
        if (ok) setTimeout(waitTransfer, 0);
        return ok;
      });
    } catch (e) {
      status.textContent = 'Kamera nicht verfügbar: ' + e.message;
    }
  }

  async function accept(sig) {
    try {
      receiver = await createReceiver(sig.sdp, sig.sid);
    } catch (e) {
      stage.replaceChildren(h('div', { class: 'card' }, h('strong', {}, 'Code konnte nicht verarbeitet werden'), h('p', { class: 'muted small' }, e.message)));
      return true;
    }
    if (closed) { receiver.close(); return true; }
    const qr = await qrCanvas(receiver.signal, 340);
    const status = h('p', { class: 'muted small tr-wait' }, h('span', { class: 'spinner' }), ' Warte auf Verbindung …');
    stage.replaceChildren(
      h('div', { class: 'card tr-step' }, h('div', { class: 'tr-num' }, '2'), h('div', { class: 'grow' },
        h('strong', {}, 'Mit dem sendenden Gerät diesen Code scannen'),
        h('p', { class: 'muted small' }, 'Dort auf „Weiter: Antwort-Code scannen“ tippen.'))),
      h('div', { class: 'tr-qrwrap' }, qr),
      status,
    );
    window.__obTransferReceiver = receiver; // für automatische Tests
    return true;
  }

  async function waitTransfer() {
    if (!receiver) return;
    try {
      const dc = await receiver.channel;
      const prog = progressBar();
      const st = h('p', {}, 'Verbunden – empfange …');
      stage.replaceChildren(h('div', { class: 'card stack' }, st, prog));
      const result = await receiveBlob(dc,
        (meta) => { st.textContent = `Empfange „${meta.title}“ (${(meta.size / 1e6).toFixed(1)} MB) …`; },
        (r) => prog.set(r),
        async (blob) => {
          st.textContent = 'Wird gespeichert …';
          const { importBackupDetailed } = await import('./backup.js');
          return importBackupDetailed(blob);
        });
      db.requestPersistence();
      const id = result.bookIds[0];
      const b = id ? await db.getBook(id) : null;
      stage.replaceChildren(h('div', { class: 'card tr-done' }, icon('check'), h('strong', {}, 'Buch empfangen!'),
        b ? h('p', { class: 'muted' }, `„${b.title}“ ist jetzt in deiner Bibliothek.`) : null,
        h('div', { class: 'row gap-s wrap' },
          b ? h('a', { class: 'btn primary', href: `#/read/${id}` }, icon('book'), 'Lesen') : null,
          h('a', { class: 'btn', href: '#/' }, 'Zur Bibliothek'))));
      toast('Buch empfangen');
      receiver.close();
    } catch (e) {
      console.error(e);
      stage.replaceChildren(h('div', { class: 'card stack' },
        h('strong', {}, 'Übertragung fehlgeschlagen'),
        h('p', { class: 'muted small' }, e.message),
        h('button', { class: 'btn primary', onClick: () => { receiver && receiver.close(); step1(); } }, 'Nochmal versuchen'),
      ));
    }
  }

  step1();
  return () => {
    closed = true;
    if (stopScan) stopScan();
    if (receiver) receiver.close();
    delete window.__obTransferReceiver;
  };
}
