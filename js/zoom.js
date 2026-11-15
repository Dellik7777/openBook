// Zoomen und Verschieben mit zwei Fingern, Doppeltippen, Mausrad – für Abbildungen und Seitenfotos.
// stage: Container mit fester Größe, img: Bild darin. Liefert { reset, destroy }.

export function zoomable(stage, img, { max = 6, onScale } = {}) {
  let s = 1, tx = 0, ty = 0;      // Skalierung und Verschiebung (relativ zur eingepassten Darstellung)
  const pts = new Map();
  let pinch = null, pan = null, lastTap = 0;
  img.style.transformOrigin = '0 0';
  img.style.willChange = 'transform';
  stage.style.touchAction = 'none';

  const base = () => {
    // eingepasste Größe und Lage des Bilds ohne Zoom
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const iw = img.naturalWidth || sw, ih = img.naturalHeight || sh;
    const k = Math.min(sw / iw, sh / ih, 1e9);
    return { sw, sh, w: iw * k, h: ih * k, x: (sw - iw * k) / 2, y: (sh - ih * k) / 2 };
  };
  const clamp = () => {
    const b = base();
    const w = b.w * s, h = b.h * s;
    // Bild darf nicht aus dem Sichtbereich geschoben werden
    const minX = Math.min(b.sw - w - b.x, -b.x + (b.sw - w) / 2), maxX = Math.max(-b.x, -b.x + (b.sw - w) / 2);
    const minY = Math.min(b.sh - h - b.y, -b.y + (b.sh - h) / 2), maxY = Math.max(-b.y, -b.y + (b.sh - h) / 2);
    tx = Math.min(maxX, Math.max(minX, tx));
    ty = Math.min(maxY, Math.max(minY, ty));
  };
  const apply = (animate = false) => {
    clamp();
    const b = base();
    img.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    img.style.position = 'absolute';
    img.style.left = b.x + 'px';
    img.style.top = b.y + 'px';
    img.style.width = b.w + 'px';
    img.style.height = b.h + 'px';
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    stage.classList.toggle('zoomed', s > 1.01);
    onScale && onScale(s);
  };
  // Zoom um einen Punkt (Stage-Koordinaten)
  const zoomAt = (ns, cx, cy, animate) => {
    ns = Math.min(max, Math.max(1, ns));
    const b = base();
    // Punkt unter dem Finger bleibt an Ort und Stelle
    const px = (cx - b.x - tx) / s, py = (cy - b.y - ty) / s;
    tx = cx - b.x - px * ns;
    ty = cy - b.y - py * ns;
    s = ns;
    apply(animate);
  };
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const down = (e) => {
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Ereignisse */ }
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx, ty };
      pan = null;
    } else if (pts.size === 1) {
      const p = local(e);
      pan = { x: p.x, y: p.y, tx, ty, moved: false };
    }
  };
  const move = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      // erst auf Ausgangslage zurück, dann um den Mittelpunkt zoomen und mitverschieben
      s = pinch.s; tx = pinch.tx + (cx - pinch.cx); ty = pinch.ty + (cy - pinch.cy);
      zoomAt(pinch.s * d / pinch.d, cx, cy, false);
    } else if (pan) {
      const p = local(e);
      if (Math.abs(p.x - pan.x) + Math.abs(p.y - pan.y) > 4) pan.moved = true;
      if (s > 1.01) { tx = pan.tx + (p.x - pan.x); ty = pan.ty + (p.y - pan.y); apply(false); }
    }
  };
  const up = (e) => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const q = [...pts.values()][0]; pan = { x: q.x, y: q.y, tx, ty, moved: true }; return; }
    if (!pts.size && pan && !pan.moved && p) {
      const now = Date.now();
      if (now - lastTap < 320) { zoomAt(s > 1.01 ? 1 : 2.5, p.x, p.y, true); lastTap = 0; } else lastTap = now;
    }
    if (!pts.size) pan = null;
  };
  const wheel = (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), p.x, p.y, false);
  };
  stage.addEventListener('pointerdown', down);
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', wheel, { passive: false });
  const onResize = () => apply(false);
  window.addEventListener('resize', onResize);
  if (img.complete && img.naturalWidth) apply(false); else img.addEventListener('load', () => apply(false), { once: true });
  return {
    reset() { s = 1; tx = 0; ty = 0; apply(true); },
    toggle() { const b = base(); zoomAt(s > 1.01 ? 1 : 2.5, b.sw / 2, b.sh / 2, true); },
    scale: () => s,
    destroy() { window.removeEventListener('resize', onResize); },
  };
}
