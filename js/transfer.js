// Direktübertragung zwischen zwei Geräten im selben WLAN (oder Hotspot) – ohne Internet.
//
// Ablauf (WebRTC-Datenkanal, Verbindungsaufbau über QR-Codes statt über einen Server):
//   Sender:    Angebot erzeugen → als QR-Code zeigen
//   Empfänger: QR scannen → Antwort erzeugen → als QR-Code zeigen
//   Sender:    Antwort scannen → direkte Verbindung → Buch (ZIP) in Stücken senden

const QR_BASE = new URL('../vendor/qr/', import.meta.url).href;
const CHUNK = 16 * 1024;
const PREFIX = 'OBK1';

const scripts = {};
function loadScript(name) {
  if (!scripts[name]) {
    scripts[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = QR_BASE + name;
      s.onload = resolve;
      s.onerror = () => { delete scripts[name]; reject(new Error(name + ' konnte nicht geladen werden')); };
      document.head.appendChild(s);
    });
  }
  return scripts[name];
}

// ---------- Signal (SDP) kompakt kodieren ----------

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deflate(text) {
  const data = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return { z: false, bytes: data };
  const cs = new CompressionStream('deflate-raw');
  const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
  return { z: true, bytes: new Uint8Array(buf) };
}
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// Für den Datenkanal überflüssige SDP-Zeilen weglassen (kleinerer QR-Code)
function slimSdp(sdp) {
  return sdp.split(/\r?\n/).filter((l) => l && !/^a=(extmap|rtcp|ssrc|msid|rtpmap|fmtp)/.test(l)).join('\r\n') + '\r\n';
}

// kind: 'o' (Angebot) oder 'a' (Antwort); sid verknüpft Angebot und Antwort
export async function encodeSignal(kind, sid, sdp) {
  const { z, bytes } = await deflate(slimSdp(sdp));
  return `${PREFIX}${kind}${z ? 'z' : 'p'}${sid}.${b64url(bytes)}`;
}

export async function decodeSignal(text) {
  const m = /^OBK1([oa])([zp])([A-Za-z0-9]{6})\.([A-Za-z0-9_-]+)$/.exec((text || '').trim());
  if (!m) return null;
  const bytes = unb64url(m[4]);
  const sdp = m[2] === 'z' ? await inflate(bytes) : new TextDecoder().decode(bytes);
  return { kind: m[1], sid: m[3], sdp };
}

// ---------- QR-Codes ----------

export async function qrCanvas(text, px = 320) {
  await loadScript('qrcode.js');
  const qr = window.qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.max(2, Math.floor(px / (n + 2 * quiet)));
  const size = (n + 2 * quiet) * scale;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  c.className = 'qr';
  return c;
}

// WLAN-QR-Code (Standardformat, das die Kamera-Apps von iOS und Android verstehen)
export function wifiPayload(ssid, password) {
  const esc = (s) => s.replace(/([\\;,:"])/g, '\\$1');
  return password ? `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;` : `WIFI:T:nopass;S:${esc(ssid)};;`;
}

// Kamera öffnen und QR-Codes lesen, bis onCode true zurückgibt
export async function startScanner(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});
  let detector = null;
  try {
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch (e) { /* Fallback jsQR */ }
  if (!detector) await loadScript('jsQR.js');
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let stopped = false, busy = false;
  const tick = async () => {
    if (stopped) return;
    if (!busy && video.videoWidth) {
      busy = true;
      try {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0] && codes[0].rawValue;
        } else {
          const scale = Math.min(1, 900 / Math.max(video.videoWidth, video.videoHeight));
          c.width = Math.round(video.videoWidth * scale);
          c.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const r = window.jsQR(img.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
          text = r && r.data;
        }
        if (text && (await onCode(text))) { stop(); return; }
      } catch (e) { console.warn(e); }
      busy = false;
    }
    setTimeout(tick, 120);
  };
  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  tick();
  return stop;
}

// ---------- Verbindung ----------

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

function newPeer() {
  // Keine STUN/TURN-Server: Verbindung nur im lokalen Netz, funktioniert ohne Internet
  return new RTCPeerConnection({ iceServers: [] });
}

export function sessionId() {
  const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(6));
  for (const x of r) s += a[x % a.length];
  return s;
}

// Sender: erzeugt Angebot; acceptAnswer(sdp) vervollständigt; channel wird offen gemeldet
export async function createSender() {
  const pc = newPeer();
  const dc = pc.createDataChannel('openbook', { ordered: true });
  dc.binaryType = 'arraybuffer';
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);
  const sid = sessionId();
  const signal = await encodeSignal('o', sid, pc.localDescription.sdp);
  const opened = new Promise((resolve, reject) => {
    dc.onopen = () => resolve(dc);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') reject(new Error('Verbindung fehlgeschlagen'));
    });
  });
  return {
    pc, dc, sid, signal, opened,
    async acceptAnswer(sdp) { await pc.setRemoteDescription({ type: 'answer', sdp }); },
    close() { try { dc.close(); } catch (e) { /* */ } try { pc.close(); } catch (e) { /* */ } },
  };
}

// Empfänger: nimmt Angebot an, liefert Antwort-Signal und den Datenkanal
export async function createReceiver(offerSdp, sid) {
  const pc = newPeer();
  const channel = new Promise((resolve, reject) => {
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      if (dc.readyState === 'open') resolve(dc); else dc.onopen = () => resolve(dc);
    };
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') reject(new Error('Verbindung fehlgeschlagen'));
    });
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIce(pc);
  const signal = await encodeSignal('a', sid, pc.localDescription.sdp);
  return {
    pc, signal, channel,
    close() { try { pc.close(); } catch (e) { /* */ } },
  };
}

// ---------- Datenübertragung ----------

export async function sendBlob(dc, blob, meta, onProgress) {
  dc.bufferedAmountLowThreshold = 512 * 1024;
  dc.send(JSON.stringify({ t: 'meta', size: blob.size, ...meta }));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let sent = 0;
  while (sent < buf.length) {
    if (dc.readyState !== 'open') throw new Error('Verbindung unterbrochen');
    if (dc.bufferedAmount > 2 * 1024 * 1024) {
      await new Promise((res) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; res(); }; });
      continue;
    }
    const end = Math.min(buf.length, sent + CHUNK);
    dc.send(buf.slice(sent, end));
    sent = end;
    onProgress && onProgress(sent / buf.length);
  }
  dc.send(JSON.stringify({ t: 'end' }));
  // Bestätigung abwarten
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Keine Bestätigung vom anderen Gerät')), 120000);
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      if (msg.t === 'ok') { clearTimeout(t); resolve(msg); }
      if (msg.t === 'error') { clearTimeout(t); reject(new Error(msg.message || 'Fehler beim Empfänger')); }
    };
  });
}

// Empfängt eine Datei; handle(blob, meta) verarbeitet sie, Ergebnis wird bestätigt
export function receiveBlob(dc, onMeta, onProgress, handle) {
  return new Promise((resolve, reject) => {
    let meta = null, parts = [], got = 0;
    dc.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.t === 'meta') { meta = msg; parts = []; got = 0; onMeta && onMeta(meta); }
        if (msg.t === 'end') {
          try {
            const blob = new Blob(parts, { type: 'application/zip' });
            if (meta && blob.size !== meta.size) throw new Error('Unvollständig empfangen');
            const result = await handle(blob, meta);
            dc.send(JSON.stringify({ t: 'ok' }));
            resolve(result);
          } catch (err) {
            try { dc.send(JSON.stringify({ t: 'error', message: err.message })); } catch (x) { /* */ }
            reject(err);
          }
        }
        return;
      }
      parts.push(e.data);
      got += e.data.byteLength;
      if (meta && onProgress) onProgress(got / meta.size);
    };
    dc.onclose = () => { if (!meta || got < meta.size) reject(new Error('Verbindung unterbrochen')); };
  });
}
