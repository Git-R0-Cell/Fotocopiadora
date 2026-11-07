/* core.js — motor de imagen del escáner de tarjetas.
 * Recibe OpenCV (cv) por parámetro, así funciona igual en el navegador y en Node (pruebas).
 * Pasos: detectar tarjeta -> corregir perspectiva -> efecto fotocopia -> máscara de esquinas redondeadas.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScanCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tarjeta ISO/IEC 7810 ID-1 (cédulas, licencias, tarjetas bancarias): 85,60 x 53,98 mm, radio de esquina 3,18 mm
  const ID1 = { w: 85.6, h: 53.98, r: 3.18 };
  // Resolución máxima de la copia (ppp). Más alto = más detalle pero PDF más pesado.
  const MAX_DPI = 450;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const odd = n => { n = Math.round(n); return n % 2 === 0 ? n + 1 : n; };

  function polygonArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  // Ordena 4 puntos en sentido horario empezando por la esquina superior izquierda: TL, TR, BR, BL
  function orderCorners(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let start = 0, best = Infinity;
    sorted.forEach((p, i) => { const s = p.x + p.y; if (s < best) { best = s; start = i; } });
    return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
  }

  const cycle = (c, k) => [0, 1, 2, 3].map(i => c[(((i + k) % 4) + 4) % 4]);

  function quadSides(c) {
    return {
      w: (dist(c[0], c[1]) + dist(c[3], c[2])) / 2,
      h: (dist(c[0], c[3]) + dist(c[1], c[2])) / 2
    };
  }

  // k inicial para que la tarjeta quede horizontal
  function autoK(corners) {
    const s = quadSides(corners);
    return s.w >= s.h ? 0 : 1;
  }

  // Dimensiones en mm de la tarjeta según su orientación (k) — size = {w,h} con w >= h
  function cardDimsMm(corners, k, size) {
    size = size || ID1;
    const long = Math.max(size.w, size.h), short = Math.min(size.w, size.h);
    const s = quadSides(cycle(corners, k));
    return s.w >= s.h ? { mmW: long, mmH: short } : { mmW: short, mmH: long };
  }

  function median(u8) {
    const h = new Uint32Array(256);
    for (let i = 0; i < u8.length; i++) h[u8[i]]++;
    let acc = 0; const half = u8.length / 2;
    for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= half) return v; }
    return 128;
  }

  // ---------------------------------------------------------------- detección

  function contourPoints(cnt) {
    const d = cnt.data32S, out = [];
    for (let i = 0; i + 1 < d.length; i += 2) out.push({ x: d[i], y: d[i + 1] });
    return out;
  }

  function quadFromHull(cv, hull) {
    const peri = cv.arcLength(hull, true);
    for (let e = 0.01; e <= 0.09; e += 0.005) {
      const ap = new cv.Mat();
      cv.approxPolyDP(hull, ap, e * peri, true);
      if (ap.rows === 4) {
        const d = ap.data32S;
        const q = [0, 1, 2, 3].map(i => ({ x: d[i * 2], y: d[i * 2 + 1] }));
        ap.delete();
        return q;
      }
      ap.delete();
    }
    const rect = cv.minAreaRect(hull);
    const v = cv.RotatedRect.points(rect);
    return v.map(p => ({ x: p.x, y: p.y }));
  }

  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: { x: mx, y: my }, d: { x: Math.cos(ang), y: Math.sin(ang) } };
  }

  function intersect(l1, l2) {
    const cr = (a, b) => a.x * b.y - a.y * b.x;
    const den = cr(l1.d, l2.d);
    if (Math.abs(den) < 1e-6) return null;
    const t = cr({ x: l2.p.x - l1.p.x, y: l2.p.y - l1.p.y }, l2.d) / den;
    return { x: l1.p.x + t * l1.d.x, y: l1.p.y + t * l1.d.y };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Recta robusta (RANSAC determinista): la que más puntos de borde alinea, con dirección parecida a u0.
  function robustLine(pts, u0, thr) {
    const n = pts.length, rnd = mulberry32(1234567);
    let bestCnt = -1, best = null;
    for (let it = 0; it < 220; it++) {
      const p = pts[(rnd() * n) | 0], q = pts[(rnd() * n) | 0];
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy);
      if (L < 20) continue;
      const dx1 = dx / L, dy1 = dy / L;
      if (Math.abs(dx1 * u0.y - dy1 * u0.x) > 0.17) continue; // máx. ~10° de la dirección esperada
      let cnt = 0;
      for (let j = 0; j < n; j++) {
        if (Math.abs((pts[j].x - p.x) * -dy1 + (pts[j].y - p.y) * dx1) < thr) cnt++;
      }
      if (cnt > bestCnt) { bestCnt = cnt; best = { p, d: { x: dx1, y: dy1 } }; }
    }
    if (!best || bestCnt < 12) return null;
    for (let pass = 0; pass < 2; pass++) {
      const nx = -best.d.y, ny = best.d.x;
      const inl = pts.filter(q => Math.abs((q.x - best.p.x) * nx + (q.y - best.p.y) * ny) < thr * 1.2);
      if (inl.length < 12) break;
      best = fitLine(inl);
      if (best.d.x * u0.x + best.d.y * u0.y < 0) best.d = { x: -best.d.x, y: -best.d.y };
    }
    return best;
  }

  // Ajusta una recta robusta a cada lado usando solo la parte central de cada borde
  // (los bordes reales de la foto) y vuelve a intersectarlas: devuelve las esquinas "afiladas"
  // aunque la tarjeta tenga esquinas redondeadas, texto cerca del borde o sombra.
  function refineQuad(quad, pts) {
    const s = quadSides(quad);
    const base = Math.max(5, 0.06 * Math.min(s.w, s.h));
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const len = dist(a, b);
      if (len < 10) return quad;
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const n = { x: -u.y, y: u.x };
      const sel = [];
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        const t = ((p.x - a.x) * u.x + (p.y - a.y) * u.y) / len;
        if (t < 0.2 || t > 0.8) continue;
        if (Math.abs((p.x - a.x) * n.x + (p.y - a.y) * n.y) < base) sel.push(p);
      }
      if (sel.length < 12) return quad;
      const line = robustLine(sel, u, 1.6);
      if (!line) return quad;
      lines.push(line);
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(lines[(i + 3) % 4], lines[i]);
      if (!p || dist(p, quad[i]) > base * 3) return quad;
      out.push(p);
    }
    return out;
  }

  // Fracción del perímetro del cuadrilátero que coincide con bordes marcados de la foto
  function edgeSupport(q, sup, W, H) {
    let hit = 0, tot = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      for (let k = 0; k < 40; k++) {
        const t = 0.1 + 0.8 * k / 39;
        const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
        tot++;
        if (x >= 0 && y >= 0 && x < W && y < H && sup[y * W + x]) hit++;
      }
    }
    return hit / tot;
  }

  function scoreQuad(q, W, H, target, sup) {
    const area = polygonArea(q) / (W * H);
    if (area < 0.06 || area > 0.97) return -1;
    const s = quadSides(q);
    const ar = Math.max(s.w, s.h) / Math.max(1, Math.min(s.w, s.h));
    const pen = Math.abs(Math.log(ar / target));
    if (pen > 0.45) return -1;
    const support = sup ? edgeSupport(q, sup, W, H) : 1;
    return Math.min(area, 0.6) * Math.exp(-3 * pen) * (0.15 + support);
  }

  function detectCard(cv, src, opts) {
    opts = opts || {};
    const target = opts.aspect || ID1.w / ID1.h;
    const trash = [];
    const T = m => { trash.push(m); return m; };
    try {
      const maxDim = 900;
      const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
      const small = T(new cv.Mat());
      cv.resize(src, small, new cv.Size(Math.max(1, Math.round(src.cols * scale)), Math.max(1, Math.round(src.rows * scale))), 0, 0, cv.INTER_AREA);
      const W = small.cols, H = small.rows;
      const gray = T(new cv.Mat());
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

      let best = null;
      let edgePts = [];

      // Bordes marcados (umbral estricto) para medir cuánto respalda la foto a cada candidato
      const blur = T(new cv.Mat());
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      const strict = T(new cv.Mat());
      cv.Canny(blur, strict, 30, 90);
      const strictD = T(new cv.Mat());
      cv.dilate(strict, strictD, T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))));
      const supMask = strictD.data;

      const consider = (bin, method) => {
        const contours = T(new cv.MatVector());
        const hier = T(new cv.Mat());
        cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const list = [];
        for (let i = 0; i < contours.size(); i++) {
          const cnt = contours.get(i);
          list.push({ cnt, area: cv.contourArea(cnt) });
        }
        list.sort((a, b) => b.area - a.area);
        list.slice(0, 6).forEach(({ cnt, area }) => {
          if (area < 0.03 * W * H) return;
          const hull = new cv.Mat();
          cv.convexHull(cnt, hull, false, true);
          const q0 = quadFromHull(cv, hull);
          hull.delete();
          if (!q0) return;
          const quad = orderCorners(q0);
          const pts = edgePts.length > 200 ? edgePts : contourPoints(cnt);
          let refined = refineQuad(quad, pts);
          let sc = scoreQuad(refined, W, H, target, supMask);
          if (sc < 0) { refined = quad; sc = scoreQuad(quad, W, H, target, supMask); }
          if (opts.debugList) opts.debugList.push({ method, area: +(area / (W * H)).toFixed(3), score: +sc.toFixed(3), quad: refined.map(p => [Math.round(p.x / scale), Math.round(p.y / scale)]), raw: quad.map(p => [Math.round(p.x / scale), Math.round(p.y / scale)]), npts: pts.length });
          if (sc > 0 && (!best || sc > best.score)) best = { quad: refined, score: sc, method };
        });
        list.forEach(l => l.cnt.delete());
      };

      // Estrategia A: bordes (Canny) cerrados morfológicamente, con umbrales alto y bajo
      // (el bajo ayuda cuando la tarjeta es clara sobre una mesa blanca)
      for (const [lo, hi] of [[30, 90], [10, 30]]) {
        const edges = T(new cv.Mat());
        cv.Canny(blur, edges, lo, hi);
        const ed = edges.data;
        edgePts = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ed[y * W + x]) edgePts.push({ x, y });
        for (const ks of [7, 15]) {
          const kern = T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ks, ks)));
          const closed = T(new cv.Mat());
          cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kern);
          consider(closed, 'bordes');
        }
      }

      // Estrategia B: distancia de color al fondo (se estima con el borde de la foto)
      {
        const e2 = T(new cv.Mat());
        cv.Canny(blur, e2, 20, 60);
        edgePts = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (e2.data[y * W + x]) edgePts.push({ x, y });
        const rgb = T(new cv.Mat()), lab = T(new cv.Mat());
        cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
        cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
        const ld = lab.data;
        const ring = Math.max(4, Math.round(0.03 * Math.min(W, H)));
        const samples = [[], [], []];
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (x < ring || y < ring || x >= W - ring || y >= H - ring) {
              const i = (y * W + x) * 3;
              samples[0].push(ld[i]); samples[1].push(ld[i + 1]); samples[2].push(ld[i + 2]);
            }
          }
        }
        const med3 = samples.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
        const dm = T(new cv.Mat(H, W, cv.CV_8UC1));
        const dd = dm.data;
        for (let i = 0, j = 0; i < dd.length; i++, j += 3) {
          const dl = ld[j] - med3[0], da = ld[j + 1] - med3[1], db = ld[j + 2] - med3[2];
          dd[i] = Math.min(255, Math.round(Math.sqrt(dl * dl + da * da + db * db) * 3));
        }
        const bl = T(new cv.Mat());
        cv.GaussianBlur(dm, bl, new cv.Size(7, 7), 0);
        const bin = T(new cv.Mat());
        cv.threshold(bl, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        const k9 = T(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
        cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k9);
        cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k9);
        consider(bin, 'color');
      }

      if (best) {
        return {
          corners: best.quad.map(p => ({ x: p.x / scale, y: p.y / scale })),
          method: best.method,
          confidence: best.score
        };
      }
      // Sin detección: rectángulo centrado con la proporción de la tarjeta
      let w = 0.8 * src.cols, h = w / target;
      if (h > 0.8 * src.rows) { h = 0.8 * src.rows; w = h * target; }
      const x0 = (src.cols - w) / 2, y0 = (src.rows - h) / 2;
      return {
        corners: [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }],
        method: 'manual',
        confidence: 0
      };
    } finally {
      trash.forEach(m => { try { m.delete(); } catch (e) { /* ya liberado */ } });
    }
  }

  // ---------------------------------------------------------------- enderezado

  function warpCard(cv, src, corners, k, mmW, mmH, dpi, marginPx) {
    const c = cycle(corners, k);
    const W = Math.round(mmW / 25.4 * dpi), H = Math.round(mmH / 25.4 * dpi), m = marginPx || 0;
    const srcT = cv.matFromArray(4, 1, cv.CV_32FC2, [c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y]);
    const dstT = cv.matFromArray(4, 1, cv.CV_32FC2, [m, m, m + W, m, m + W, m + H, m, m + H]);
    const M = cv.getPerspectiveTransform(srcT, dstT);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(W + 2 * m, H + 2 * m), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    srcT.delete(); dstT.delete(); M.delete();
    return { mat: out, W, H };
  }

  // ---------------------------------------------------------------- efecto fotocopia

  function percentile(hist, total, p) {
    const target = total * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  // Devuelve { data: Uint8ClampedArray RGBA, width, height }
  function photocopy(cv, warped, opts) {
    const mode = opts.mode || 'gray';
    const c = clamp((opts.contrast == null ? 55 : opts.contrast) / 100, 0, 1);
    const dpi = opts.dpi || 300;
    const W = warped.cols, H = warped.rows, N = W * H;
    const trash = [];
    const T = m => { trash.push(m); return m; };
    try {
      const rgb = T(new cv.Mat());
      cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);
      const gray = T(new cv.Mat());
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

      // Iluminación de fondo: mediana local (a baja resolución) = brillo dominante de la zona.
      // La ganancia solo se aplica donde la zona es "papel" (clara); las zonas oscuras reales
      // (foto, fondos impresos) no se tocan, así no aparecen halos alrededor del texto.
      const q = 4;
      const sm = T(new cv.Mat());
      cv.resize(gray, sm, new cv.Size(Math.max(8, Math.round(W / q)), Math.max(8, Math.round(H / q))), 0, 0, cv.INTER_AREA);
      cv.medianBlur(sm, sm, odd(dpi * 0.28 / q));
      cv.GaussianBlur(sm, sm, new cv.Size(9, 9), 0);
      const bg = T(new cv.Mat());
      cv.resize(sm, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);

      const bgd = bg.data, gd = gray.data, rd = rgb.data;
      const bh = new Uint32Array(256);
      for (let i = 0; i < N; i++) bh[bgd[i]]++;
      const ref = Math.max(150, percentile(bh, N, 0.9));
      const gain = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const m = Math.max(1, bgd[i]);
        const g = clamp(ref / m, 1, 1.5);
        const u = clamp((m - 0.45 * ref) / (0.2 * ref), 0, 1);
        gain[i] = 1 + (g - 1) * u * u * (3 - 2 * u);
      }

      // luminancia corregida
      const lum = new Uint8ClampedArray(N);
      const lh = new Uint32Array(256);
      for (let i = 0; i < N; i++) { const v = Math.min(255, gd[i] * gain[i]); lum[i] = v; lh[Math.round(v)]++; }
      const black = Math.min(90, percentile(lh, N, 0.01));
      let white = clamp(percentile(lh, N, 0.5) * 0.97, 165, 245);
      if (white - black < 40) white = black + 40;
      const gamma = 1 + 0.35 * c;
      const t = 0.9 * c;
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        const lin = clamp((v - black) / (white - black), 0, 1);
        const s = lin * lin * (3 - 2 * lin);
        lut[v] = Math.round(255 * Math.pow(lin * (1 - t) + s * t, gamma));
      }

      const out = new Uint8ClampedArray(N * 4);
      if (mode === 'bw') {
        const lm = T(new cv.Mat(H, W, cv.CV_8UC1));
        lm.data.set(lum);
        // Texto y líneas: umbral adaptativo (queda nítido).
        const bin = T(new cv.Mat());
        cv.adaptiveThreshold(lm, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, odd(dpi * 0.1), 18 - 10 * c);
        const bd = bin.data;
        const tLow = black + 0.3 * (white - black), tHigh = black + 0.82 * (white - black);

        // Zonas suaves (fotos, sombreados): un umbral duro las deja en manchas, así que ahí se usa
        // tramado por difusión de error (como una copiadora) y la foto conserva su detalle.
        // Zonas con bordes fuertes (texto, líneas, contornos): umbral adaptativo, nítido.
        // Tonos de foto: niveles suaves (los del documento mandan los claros a blanco y borran las caras).
        const bP = Math.min(60, percentile(lh, N, 0.002)), wP = Math.max(200, percentile(lh, N, 0.998));
        const lutP = new Uint8ClampedArray(256), tp = 0.5 * c;
        for (let v = 0; v < 256; v++) {
          const lin = clamp((v - bP * c) / Math.max(1, (255 - (255 - wP) * c) - bP * c), 0, 1);
          lutP[v] = Math.round(255 * (lin * (1 - tp) + lin * lin * (3 - 2 * lin) * tp));
        }
        const tm = T(new cv.Mat(H, W, cv.CV_8UC1)), tmd = tm.data;
        for (let i = 0; i < N; i++) tmd[i] = lutP[Math.round(lum[i])];
        const rk = odd(Math.max(3, dpi * 0.017));
        const kr = T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(rk, rk)));
        const dil = T(new cv.Mat()), ero = T(new cv.Mat());
        cv.dilate(tm, dil, kr); cv.erode(tm, ero, kr);
        const dd = dil.data, ed = ero.data;

        // difusión de error Floyd–Steinberg (recorrido en zigzag) sobre la luminancia con contraste
        const tone = new Float32Array(N);
        for (let i = 0; i < N; i++) tone[i] = Math.min(255, tmd[i] * 255 / 238);   // los casi-blancos son papel: sin puntitos
        const res = new Uint8Array(N);
        for (let y = 0; y < H; y++) {
          const ltr = (y & 1) === 0, row = y * W;
          for (let n = 0; n < W; n++) {
            const x = ltr ? n : W - 1 - n, i = row + x;
            const old = tone[i], nv = old < 128 ? 0 : 255, err = old - nv;
            res[i] = nv;
            const dx = ltr ? 1 : -1;
            if (x + dx >= 0 && x + dx < W) tone[i + dx] += err * 7 / 16;
            if (y + 1 < H) {
              if (x - dx >= 0 && x - dx < W) tone[i + W - dx] += err * 3 / 16;
              tone[i + W] += err * 5 / 16;
              if (x + dx >= 0 && x + dx < W) tone[i + W + dx] += err * 1 / 16;
            }
          }
        }
        for (let i = 0; i < N; i++) {
          let v;
          if (dd[i] - ed[i] < 60) v = res[i];                 // zona suave: tramado
          else { v = bd[i]; if (lum[i] < tLow) v = 0; else if (lum[i] > tHigh) v = 255; }
          out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
        }
      } else if (mode === 'color') {
        // "Color limpio" respeta los colores de la tarjeta: sin recortar blancos por la mediana
        // (eso aplastaba tarjetas de color). Con contraste 0 queda casi igual a la foto.
        const bC = Math.min(60, percentile(lh, N, 0.002));
        const wC = Math.max(190, percentile(lh, N, 0.998));
        const lo = bC * c, hi = 255 - (255 - wC) * c, tc = 0.5 * c;
        const lutC = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) {
          const lin = clamp((v - lo) / Math.max(1, hi - lo), 0, 1);
          const sc = lin * lin * (3 - 2 * lin);
          lutC[v] = Math.round(255 * (lin * (1 - tc) + sc * tc));
        }
        const gs = 0.3 + 0.7 * c;                       // fuerza de la corrección de sombras
        for (let i = 0; i < N; i++) {
          const g = 1 + (gain[i] - 1) * gs;
          out[i * 4] = lutC[Math.min(255, Math.round(rd[i * 3] * g))];
          out[i * 4 + 1] = lutC[Math.min(255, Math.round(rd[i * 3 + 1] * g))];
          out[i * 4 + 2] = lutC[Math.min(255, Math.round(rd[i * 3 + 2] * g))];
          out[i * 4 + 3] = 255;
        }
      } else {
        for (let i = 0; i < N; i++) {
          const v = lut[Math.round(lum[i])];
          out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
        }
      }
      return { data: out, width: W, height: H };
    } finally {
      trash.forEach(m => { try { m.delete(); } catch (e) { /* ya liberado */ } });
    }
  }

  // ---------------------------------------------------------------- esquinas redondeadas

  // Mide el radio real de las esquinas (en mm) a partir de la foto. Devuelve null si no es fiable.
  function measureRadius(cv, src, corners, k, dims, dpi) {
    const m = Math.round(0.07 * dims.mmW / 25.4 * dpi);
    const w = warpCard(cv, src, corners, k, dims.mmW, dims.mmH, dpi, m);
    const trash = [w.mat];
    const T = x => { trash.push(x); return x; };
    try {
      const W = w.W, H = w.H, FW = W + 2 * m, FH = H + 2 * m;
      const rgb = T(new cv.Mat()), lab = T(new cv.Mat());
      cv.cvtColor(w.mat, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const ld = lab.data;
      const band = Math.round(m * 0.6);
      const samples = [[], [], []];
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          if (x < band || y < band || x >= FW - band || y >= FH - band) {
            const i = (y * FW + x) * 3;
            samples[0].push(ld[i]); samples[1].push(ld[i + 1]); samples[2].push(ld[i + 2]);
          }
        }
      }
      const md = samples.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
      const dm = T(new cv.Mat(FH, FW, cv.CV_8UC1));
      const dd = dm.data;
      for (let i = 0, j = 0; i < dd.length; i++, j += 3) {
        const dl = ld[j] - md[0], da = ld[j + 1] - md[1], db = ld[j + 2] - md[2];
        dd[i] = Math.min(255, Math.round(Math.sqrt(dl * dl + da * da + db * db) * 3));
      }
      const bl = T(new cv.Mat());
      cv.GaussianBlur(dm, bl, new cv.Size(3, 3), 0);
      const bin = T(new cv.Mat());
      cv.threshold(bl, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const bd = bin.data;

      // el fondo debe ser mayormente fondo y el interior mayormente tarjeta
      let inFg = 0, inN = 0, outFg = 0, outN = 0;
      for (let y = 0; y < FH; y += 3) {
        for (let x = 0; x < FW; x += 3) {
          const inside = x > m + 0.05 * W && x < m + 0.95 * W && y > m + 0.05 * H && y < m + 0.95 * H;
          const outside = x < band || y < band || x >= FW - band || y >= FH - band;
          if (inside) { inN++; if (bd[y * FW + x]) inFg++; }
          else if (outside) { outN++; if (bd[y * FW + x]) outFg++; }
        }
      }
      if (inN === 0 || outN === 0 || inFg / inN < 0.85 || outFg / outN > 0.1) return null;

      const cs = [[m, m, 1, 1], [m + W, m, -1, 1], [m + W, m + H, -1, -1], [m, m + H, 1, -1]];
      const maxT = 0.25 * Math.min(W, H);
      const rs = [];
      for (const [cx, cy, sx, sy] of cs) {
        let found = null, run = 0;
        for (let t = -0.4 * m; t < maxT; t += 0.5) {
          const px = Math.round(cx + sx * t), py = Math.round(cy + sy * t);
          if (px < 0 || py < 0 || px >= FW || py >= FH) continue;
          if (bd[py * FW + px]) { run++; if (run >= 3) { found = t - 1; break; } } else run = 0;
        }
        if (found == null) return null;
        rs.push(Math.max(0, found) * 3.414 / dpi * 25.4);
      }
      const mean = rs.reduce((a, b) => a + b, 0) / 4;
      if (mean <= 0 || Math.max(...rs) - Math.min(...rs) > 0.6 * mean + 0.6) return null;
      return mean;
    } finally {
      trash.forEach(x => { try { x.delete(); } catch (e) { /* ya liberado */ } });
    }
  }

  // Aplica en sitio: alfa de rectángulo redondeado (borde suavizado de 1 px) y borde fino opcional
  function applyCardMask(img, radiusPx, trimPx, borderPx, borderGray) {
    const W = img.width, H = img.height, d = img.data;
    const cx = W / 2, cy = H / 2;
    const hx = W / 2 - trimPx, hy = H / 2 - trimPx;
    const r = Math.max(0, Math.min(radiusPx, hx, hy));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const qx = Math.abs(x + 0.5 - cx) - (hx - r);
        const qy = Math.abs(y + 0.5 - cy) - (hy - r);
        const dd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; // <0 dentro
        const a = clamp(0.5 - dd, 0, 1);
        const i = (y * W + x) * 4;
        if (borderPx > 0) {
          const mix = clamp(borderPx - (-dd) + 0.5, 0, 1);
          if (mix > 0) {
            d[i] = d[i] * (1 - mix) + borderGray * mix;
            d[i + 1] = d[i + 1] * (1 - mix) + borderGray * mix;
            d[i + 2] = d[i + 2] * (1 - mix) + borderGray * mix;
          }
        }
        d[i + 3] = Math.round(a * 255);
      }
    }
    return img;
  }

  // Máscara de nitidez suave: recupera el detalle que se pierde al enderezar/reescalar la foto.
  function sharpen(cv, mat, dpi, amount) {
    if (!(amount > 0)) return;
    const blur = new cv.Mat();
    try {
      cv.GaussianBlur(mat, blur, new cv.Size(0, 0), Math.max(0.8, dpi * 0.0055));
      cv.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
    } finally { blur.delete(); }
  }

  // Proceso completo de una cara. size = {w,h,r} (mm)
  function renderCard(cv, src, corners, k, opts) {
    const size = opts.size || ID1;
    const baseDpi = opts.dpi || 300;
    const dims = cardDimsMm(corners, k, size);
    // Resolución: la de la foto (sin inventar más), entre 300 y MAX_DPI ppp.
    const natural = quadSides(cycle(corners, k)).w / (dims.mmW / 25.4);
    const dpi = Math.round(clamp(natural, baseDpi, Math.max(baseDpi, MAX_DPI)));
    // Si la foto tiene bastante más resolución, se endereza al doble y se reduce con INTER_AREA
    // (reducir de golpe con la transformación de perspectiva produce dientes de sierra).
    const warpDpi = natural > dpi * 1.25 ? Math.min(Math.round(natural), dpi * 2) : dpi;
    const warped = warpCard(cv, src, corners, k, dims.mmW, dims.mmH, warpDpi, 0);
    try {
      if (warpDpi !== dpi) {
        const small = new cv.Mat();
        cv.resize(warped.mat, small, new cv.Size(Math.round(dims.mmW / 25.4 * dpi), Math.round(dims.mmH / 25.4 * dpi)), 0, 0, cv.INTER_AREA);
        warped.mat.delete(); warped.mat = small;
      }
      sharpen(cv, warped.mat, dpi, opts.sharpen == null ? 0.5 : opts.sharpen);
      const img = photocopy(cv, warped.mat, { mode: opts.mode, contrast: opts.contrast, dpi });
      const std = size.r != null ? size.r : ID1.r;
      const mode = opts.radiusMode || 'auto';
      let measured = null, rMm = std;
      if (mode === 'auto') {
        try { measured = measureRadius(cv, src, corners, k, dims, baseDpi); } catch (e) { measured = null; }
        rMm = measured == null ? std : clamp(measured, 0.7 * std, 1.4 * std);
      } else if (mode === 'manual') {
        rMm = Math.max(0, opts.radiusMm || 0);
      } else if (mode === 'none') {
        rMm = 0;
      }
      const px = mm => mm / 25.4 * dpi;
      applyCardMask(img, px(rMm), px(opts.trimMm == null ? 0.15 : opts.trimMm), opts.border === false ? 0 : Math.max(1, px(0.25)), 150);
      return { data: img.data, width: img.width, height: img.height, radiusMm: rMm, measuredMm: measured, mmW: dims.mmW, mmH: dims.mmH, dpi };
    } finally {
      warped.mat.delete();
    }
  }

  // ---------------------------------------------------------------- hoja (PDF)

  const PAPERS = { letter: { w: 215.9, h: 279.4 }, a4: { w: 210, h: 297 } };

  // items: [{mmW, mmH}] -> páginas con posiciones en mm (origen arriba-izquierda)
  function layoutPages(paper, items, layout) {
    const P = PAPERS[paper] || PAPERS.letter;
    const gap = 50;
    const total = items.reduce((s, it) => s + it.mmH, 0) + gap * (items.length - 1);
    const fitsOne = items.every(it => it.mmW <= P.w - 10 && it.mmH <= P.h - 10) && total <= P.h - 10;
    if (layout !== 'two' && fitsOne) {
      let y = (P.h - total) / 2;
      return { paper: P, pages: [items.map((it, i) => { const r = { i, x: (P.w - it.mmW) / 2, y, w: it.mmW, h: it.mmH }; y += it.mmH + gap; return r; })] };
    }
    return { paper: P, pages: items.map((it, i) => [{ i, x: (P.w - it.mmW) / 2, y: (P.h - it.mmH) / 2, w: it.mmW, h: it.mmH }]) };
  }

  // ---------------------------------------------------------------- firma

  const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // Brillo del "papel" en cada punto de la foto. Se toma un percentil alto por bloques (la tinta es
  // oscura y ocupa poco), se extiende con un máximo 3x3 para que las zonas muy cargadas de trazos
  // hereden el papel vecino, y se interpola. Así sombras y luz despareja no se confunden con tinta.
  function paperLevel(lum, W, H) {
    const block = clamp(Math.round(Math.max(W, H) / 20), 12, 80);
    const gw = Math.max(2, Math.ceil(W / block)), gh = Math.max(2, Math.ceil(H / block));
    const g = new Float32Array(gw * gh), hist = new Uint32Array(256);
    for (let by = 0; by < gh; by++) {
      for (let bx = 0; bx < gw; bx++) {
        hist.fill(0);
        const x0 = bx * block, x1 = Math.min(W, x0 + block), y0 = by * block, y1 = Math.min(H, y0 + block);
        let cnt = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[lum[y * W + x]]++; cnt++; }
        const target = cnt * 0.9;
        let acc = 0, v = 255;
        for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= target) { v = k; break; } }
        g[by * gw + bx] = v;
      }
    }
    const nb = (arr, fn) => {
      const out = new Float32Array(arr.length);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const vals = [];
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) vals.push(arr[yy * gw + xx]);
          }
          out[y * gw + x] = fn(vals);
        }
      }
      return out;
    };
    const grid = nb(nb(g, v => Math.max.apply(null, v)), v => v.reduce((a, b) => a + b, 0) / v.length);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const fy = clamp((y + 0.5) / block - 0.5, 0, gh - 1), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = clamp((x + 0.5) / block - 0.5, 0, gw - 1), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
        const a = grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx;
        const b = grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx;
        out[y * W + x] = a * (1 - ty) + b * ty;
      }
    }
    return out;
  }

  // Histéresis: lo tenue solo se conserva si está pegado a un trazo firme (borde suave de la tinta).
  // Las manchas tenues sin un núcleo firme (sombras, arrugas del papel) desaparecen.
  function keepNearStrong(alpha, W, H, r) {
    const N = W * H, a = new Uint8Array(N), b = new Uint8Array(N);
    for (let i = 0; i < N; i++) a[i] = alpha[i] >= 0.6 ? 1 : 0;
    for (let y = 0; y < H; y++) {            // dilatación horizontal
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
        let v = 0;
        for (let k = x0; k <= x1; k++) if (a[y * W + k]) { v = 1; break; }
        b[y * W + x] = v;
      }
    }
    for (let y = 0; y < H; y++) {            // dilatación vertical
      const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let k = y0; k <= y1; k++) if (b[k * W + x]) { v = 1; break; }
        if (!v && alpha[y * W + x] < 0.6) alpha[y * W + x] = 0;
      }
    }
  }

  // Borra las manchas sueltas (grano del papel, polvo) que quedan tras el umbral.
  function removeSpecks(alpha, W, H, minArea) {
    const N = W * H, seen = new Uint8Array(N), stack = new Int32Array(N), comp = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      if (seen[i] || alpha[i] < 0.5) continue;
      let sp = 0, n = 0;
      stack[sp++] = i; seen[i] = 1;
      while (sp) {
        const p = stack[--sp];
        comp[n++] = p;
        const px = p % W, py = (p / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx;
            if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            if (!seen[q] && alpha[q] > 0.25) { seen[q] = 1; stack[sp++] = q; }
          }
        }
      }
      if (n < minArea) {
        for (let k = 0; k < n; k++) {
          const p = comp[k], px = p % W, py = (p / W) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx, yy = py + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) alpha[yy * W + xx] = 0;
          }
        }
      }
    }
  }

  // Convierte la foto de una firma (tinta sobre papel claro) en una imagen con fondo transparente
  // y tinta de un solo color. img = {data: RGBA, width, height}; devuelve null si no hay trazos.
  // opts: sensitivity 0..100 (más alto = capta trazos más tenues), color [r,g,b].
  function signatureFromImage(img, opts) {
    opts = opts || {};
    const W = img.width, H = img.height, N = W * H, src = img.data;
    const s = clamp((opts.sensitivity == null ? 50 : opts.sensitivity) / 100, 0, 1);
    const color = opts.color || [27, 54, 166];
    const lum = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) lum[i] = (src[i * 4] * 77 + src[i * 4 + 1] * 150 + src[i * 4 + 2] * 29) >> 8;
    const bg = paperLevel(lum, W, H);
    const lo = 0.22 - 0.18 * s, hi = lo + 0.28;
    const alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const d = clamp(1 - lum[i] / Math.max(1, bg[i]), 0, 1);
      alpha[i] = smoothstep(lo, hi, d);
    }
    keepNearStrong(alpha, W, H, Math.max(2, Math.round(Math.max(W, H) / 400)));
    removeSpecks(alpha, W, H, Math.max(8, Math.round(N * 0.00002)));

    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (alpha[y * W + x] >= 0.2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return null;
    const pad = Math.round(0.03 * Math.max(x1 - x0, y1 - y0)) + 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const ow = x1 - x0 + 1, oh = y1 - y0 + 1, out = new Uint8ClampedArray(ow * oh * 4);
    let ink = 0;
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const a = alpha[(y + y0) * W + (x + x0)], j = (y * ow + x) * 4;
        out[j] = color[0]; out[j + 1] = color[1]; out[j + 2] = color[2];
        out[j + 3] = Math.round(a * 255);
        ink += a;
      }
    }
    return { data: out, width: ow, height: oh, ink: ink / (ow * oh) };
  }

  // Dónde va la firma en la hoja (mm, origen arriba-izquierda): centrada en el hueco entre el
  // anverso y el reverso. Devuelve null si no hay un lugar claro (una hoja por cada lado, etc.).
  function signatureSpot(lay, layout, aspect, widthMm) {
    if (layout === 'two' || !lay || lay.pages.length !== 1 || !(aspect > 0)) return null;
    const P = lay.paper, page = lay.pages[0];
    if (!page.length) return null;
    const top = page[0].y + page[0].h;
    const bottom = page.length >= 2 ? page[1].y : top + 50;   // con una sola cara: debajo de ella
    const gapH = bottom - top;
    if (gapH < 14 || bottom > P.h - 4) return null;
    const maxH = gapH - 10;
    const w = Math.max(5, Math.min(widthMm || 55, maxH * aspect, P.w - 20));
    const h = w / aspect;
    return { x: (P.w - w) / 2, y: top + (gapH - h) / 2, w, h };
  }

  return { ID1, PAPERS, orderCorners, cycle, autoK, cardDimsMm, detectCard, warpCard, photocopy, measureRadius, applyCardMask, renderCard, layoutPages, signatureFromImage, signatureSpot };
}));
