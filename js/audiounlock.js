// Ton auf iOS freigeben: muss synchron in einer Tipp-Geste aufgerufen werden (ohne await davor).
// Spielt ein stummes WAV über das gemeinsame <audio>-Element (window.__obAudioEl), das die
// eigenen Stimmen später nutzen, und weckt die Sprachausgabe des Geräts.

function silentWav() {
  const n = 2205, dv = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 22050, true); dv.setUint32(28, 44100, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

export function audioElement() {
  if (!window.__obAudioEl) {
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    window.__obAudioEl = el;
  }
  return window.__obAudioEl;
}

export function unlockAudio({ speech = false } = {}) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const el = audioElement();
    if (!el.__unlocked) {
      const u = URL.createObjectURL(silentWav());
      el.src = u;
      const p = el.play();
      if (p && p.then) p.then(() => { el.__unlocked = true; }).catch(() => {});
      setTimeout(() => URL.revokeObjectURL(u), 3000);
    }
    if (speech && window.speechSynthesis && window.SpeechSynthesisUtterance && !window.__obSpeechUnlocked) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      window.__obSpeechUnlocked = true;
    }
  } catch (e) { /* */ }
  return window.__obAudioEl || null;
}
