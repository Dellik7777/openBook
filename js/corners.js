// Ecken einer Seite frei einstellen (vier Griffe, Lupe beim Ziehen).
// openCornerEditor(source, quad) → Promise<quad | null>
//   source: Blob, ImageBitmap oder Canvas; quad: [[x,y] ×4] relativ 0..1 (TL, TR, BR, BL) oder null
//   autoDetect(): optional, liefert ein erkanntes Viereck (relativ) oder null

import { h, icon, iconButton, toast } from './ui.js';

const FULL = () => [[0, 0], [1, 0], [1, 1], [0, 1]];

export function openCornerEditor(source, quad, { autoDetect = null, title = 'Ecken anpassen', okLabel = 'Übernehmen', hint = 'Ziehe die vier Ecken auf die Ecken der Seite.' } = {}) {
  return new Promise((resolve) => {
    let q = (quad && quad.length === 4 ? quad : FULL()).map((p) => [...p]);
    let url = null, img = null, bitmap = null;
    const stage = h('div', { class: 'ce-stage' });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'ce-svg');
    const shade = document.createElementNS(svgNS, 'path');
    shade.setAttribute('class', 'ce-shade');
    shade.setAttribute('fill-rule', 'evenodd');
    const poly = document.createElementNS(svgNS, 'polygon');
    poly.setAttribute('class', 'ce-poly');
    svg.append(shade, poly);
    const handles = [0, 1, 2, 3].map((i) => {
      const el = h('button', { class: 'ce-handle', 'aria-label': ['Ecke oben links', 'Ecke oben rechts', 'Ecke unten rechts', 'Ecke unten links'][i] });
      el.dataset.i = i;
      return el;
    });
    const loupe = h('canvas', { class: 'ce-loupe', width: 220, height: 220, hidden: true });
    const done = (val) => {
      ov.remove();
      if (url) URL.revokeObjectURL(url);
      window.removeEventListener('resize', layout);
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const ov = h('div', { class: 'corner-editor', role: 'dialog', 'aria-label': title },
      h('div', { class: 'ce-bar' }, iconButton('close', 'Abbrechen', () => done(null)), h('div', { class: 'grow ce-title' }, title)),
      stage,
      h('p', { class: 'ce-hint' }, hint),
      h('div', { class: 'ce-actions' },
        autoDetect ? h('button', { class: 'btn small', onClick: async () => {
          const d = await autoDetect();
          if (d) { q = d.map((p) => [...p]); draw(); } else toast('Keine Seite erkannt – bitte von Hand einstellen');
        } }, icon('refresh'), 'Automatisch') : null,
        h('button', { class: 'btn small', onClick: () => { q = FULL(); draw(); } }, icon('crop'), 'Ganzes Bild'),
        h('button', { class: 'btn primary', onClick: () => done(q.map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000])) }, icon('check'), okLabel),
      ),
    );
    document.body.append(ov);
    document.addEventListener('keydown', onKey, true);

    let box = { x: 0, y: 0, w: 1, h: 1 }; // Lage des Bilds in der Bühne (Pixel)
    function layout() {
      if (!img) return;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const k = Math.min((sw - 32) / iw, (sh - 32) / ih);
      box = { w: iw * k, h: ih * k, x: (sw - iw * k) / 2, y: (sh - ih * k) / 2 };
      img.style.left = box.x + 'px'; img.style.top = box.y + 'px';
      img.style.width = box.w + 'px'; img.style.height = box.h + 'px';
      svg.setAttribute('width', sw); svg.setAttribute('height', sh);
      draw();
    }
    const px = (p) => [box.x + p[0] * box.w, box.y + p[1] * box.h];
    function draw() {
      const pts = q.map(px);
      poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      const sw = stage.clientWidth, sh = stage.clientHeight;
      shade.setAttribute('d', `M0,0H${sw}V${sh}H0Z M${pts.map((p) => p.join(',')).join(' L')} Z`);
      handles.forEach((el, i) => { el.style.left = pts[i][0] + 'px'; el.style.top = pts[i][1] + 'px'; });
    }
    function showLoupe(i) {
      const [x, y] = px(q[i]);
      const ctx = loupe.getContext('2d');
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const sx = q[i][0] * iw, sy = q[i][1] * ih, r = Math.max(iw, ih) * 0.04;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 220, 220);
      // Lupe aus dem Bild in Originalgröße (Bitmap kann andere Abmessungen haben)
      const bw = bitmap ? bitmap.width : iw, bh = bitmap ? bitmap.height : ih;
      const kx = bw / iw, ky = bh / ih;
      ctx.drawImage(bitmap || img, (sx - r) * kx, (sy - r) * ky, r * 2 * kx, r * 2 * ky, 0, 0, 220, 220);
      ctx.strokeStyle = '#F28C28'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(110, 80); ctx.lineTo(110, 140); ctx.moveTo(80, 110); ctx.lineTo(140, 110); ctx.stroke();
      loupe.hidden = false;
      // Lupe nicht unter dem Finger: oberhalb, am Rand ggf. darunter
      const lw = 110;
      let lx = x - lw / 2, ly = y - lw - 40;
      if (ly < 8) ly = y + 40;
      lx = Math.max(8, Math.min(stage.clientWidth - lw - 8, lx));
      loupe.style.left = lx + 'px'; loupe.style.top = ly + 'px';
    }
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      const hEl = e.target.closest('.ce-handle');
      let i = hEl ? +hEl.dataset.i : -1;
      const r = stage.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (i < 0) {
        // nächste Ecke greifen, wenn nah genug
        let best = 60;
        q.forEach((p, k) => { const [x, y] = px(p); const d = Math.hypot(x - mx, y - my); if (d < best) { best = d; i = k; } });
      }
      if (i < 0) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* */ }
      const [hx, hy] = px(q[i]);
      drag = { i, dx: hx - mx, dy: hy - my };
      handles[i].classList.add('on');
      showLoupe(i);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left + drag.dx - box.x) / box.w, y = (e.clientY - r.top + drag.dy - box.y) / box.h;
      q[drag.i] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
      draw();
      showLoupe(drag.i);
    });
    const end = () => { if (!drag) return; handles[drag.i].classList.remove('on'); drag = null; loupe.hidden = true; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    // Tastatur: Pfeiltasten verschieben die fokussierte Ecke
    handles.forEach((el, i) => el.addEventListener('keydown', (e) => {
      const d = e.shiftKey ? 0.01 : 0.002;
      const m = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      if (!m) return;
      e.preventDefault();
      q[i] = [Math.min(1, Math.max(0, q[i][0] + m[0])), Math.min(1, Math.max(0, q[i][1] + m[1]))];
      draw();
    }));

    (async () => {
      if (source instanceof Blob) {
        url = URL.createObjectURL(source);
        img = new Image();
        img.src = url;
        await img.decode().catch(() => {});
        try { bitmap = await createImageBitmap(source); } catch (e) { bitmap = null; }
      } else {
        // Canvas/ImageBitmap → als Bild anzeigen
        const c = document.createElement('canvas');
        c.width = source.width; c.height = source.height;
        c.getContext('2d').drawImage(source, 0, 0);
        bitmap = c;
        img = new Image();
        url = URL.createObjectURL(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)));
        img.src = url;
        await img.decode().catch(() => {});
      }
      img.className = 'ce-img';
      img.draggable = false;
      stage.append(img, svg, ...handles, loupe);
      window.addEventListener('resize', layout);
      layout();
    })();
  });
}
