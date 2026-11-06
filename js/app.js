/* app.js — interfaz del escáner de tarjetas */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const Core = window.ScanCore;
  const MAX_SIDE_PX = 3200;       // se reduce la foto original si es más grande (rapidez y memoria)
  const DPI = 300;
  const LABEL = { front: 'Anverso', back: 'Reverso' };
  const SIG_MAX_PX = 1600;        // la foto de la firma se trabaja a este tamaño máximo
  const SIG_COLOR = [27, 54, 166]; // azul de bolígrafo
  const DEFAULTS = {
    paper: 'letter', layout: 'one', mode: 'gray', contrast: 55,
    radiusMode: 'auto', radiusMm: 3.18, sizePreset: 'id1', customW: 85.6, customH: 54, border: true,
    sigSens: 50, sigWidth: 55
  };

  let cv = null;
  let serviceWorkerReady = Promise.resolve(false);
  let settings = loadSettings();
  let active = 'front';
  let pdfBlob = null;
  const sides = { front: newSide(), back: newSide() };
  // firma: src = foto original, crop = recuadro en px de la foto, result = canvas RGBA (fondo transparente, tinta azul)
  const sig = { src: null, crop: null, result: null, aspect: 1 };

  function newSide() {
    return { canvas: null, mat: null, w: 0, h: 0, corners: null, k: 0, method: '', result: null, resultCanvas: null };
  }

  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('escaner.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem('escaner.settings', JSON.stringify(settings)); } catch (e) { /* sin almacenamiento */ }
  }

  // ------------------------------------------------------------ utilidades de interfaz

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 4200);
  }
  function busy(on, text) {
    $('#busy').hidden = !on;
    if (text) $('#busyText').textContent = text;
  }
  const nextFrame = () => new Promise(r => setTimeout(r, 30));

  function cardSize() {
    if (settings.sizePreset === 'custom') {
      const a = Math.max(20, Number(settings.customW) || 85.6), b = Math.max(20, Number(settings.customH) || 54);
      return { w: Math.max(a, b), h: Math.min(a, b), r: Core.ID1.r };
    }
    return Core.ID1;
  }

  // ------------------------------------------------------------ motor (OpenCV)

  let engineLoading = false;
  function engineProgress(percent, message) {
    const bar = $('#engineProgress');
    const label = $('#engineMessage');
    label.textContent = message;
    if (percent == null) bar.removeAttribute('value');
    else bar.value = percent;
  }

  async function loadEngine() {
    // Espera brevemente a que el SW quede al mando para que la misma descarga
    // que alimenta OpenCV también se guarde para el próximo uso sin conexión.
    if (!navigator.serviceWorker?.controller) {
      await Promise.race([serviceWorkerReady, new Promise(resolve => setTimeout(resolve, 10000))]);
    }
    const controller = new AbortController();
    const downloadTimeout = setTimeout(() => controller.abort(), 180000);
    let response;
    try {
      response = await fetch(new URL('vendor/opencv.js', document.baseURI), { signal: controller.signal });
    } catch (e) {
      clearTimeout(downloadTimeout);
      if (e.name === 'AbortError') throw new Error('La descarga del motor tardó más de 3 minutos. Revisa tu conexión y reintenta.');
      throw new Error('No se pudo descargar vendor/opencv.js. Revisa que el archivo esté en GitHub y que la URL de Pages sea correcta.');
    }
    if (!response.ok) {
      clearTimeout(downloadTimeout);
      throw new Error('GitHub respondió ' + response.status + ' al descargar vendor/opencv.js. Confirma que el archivo esté publicado.');
    }

    let scriptBlob;
    try {
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body && response.body.getReader ? response.body.getReader() : null;
      if (!reader) {
        engineProgress(null, 'Descargando motor de imagen…');
        scriptBlob = await response.blob();
      } else {
        const chunks = [];
        let received = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          chunks.push(part.value);
          received += part.value.byteLength;
          const mb = (received / 1048576).toFixed(1);
          const pct = total ? Math.min(99, Math.floor(received / total * 100)) : null;
          engineProgress(pct, total
            ? `Descargando motor de imagen… ${pct}% (${mb} MB)`
            : `Descargando motor de imagen… ${mb} MB`);
        }
        scriptBlob = new Blob(chunks, { type: 'text/javascript' });
      }
    } catch (e) {
      clearTimeout(downloadTimeout);
      if (e.name === 'AbortError') throw new Error('La descarga del motor tardó más de 3 minutos. Revisa tu conexión y reintenta.');
      throw e;
    }
    clearTimeout(downloadTimeout);
    engineProgress(100, 'Descarga completa. Iniciando el motor de imagen…');

    return new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      const src = URL.createObjectURL(scriptBlob);
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimeout);
        URL.revokeObjectURL(src);
        sc.remove();
        if (err) reject(err); else resolve(value);
      };
      const initTimeout = setTimeout(() => finish(new Error('OpenCV se descargó, pero no terminó de inicializarse. Reintenta; si vuelve a ocurrir, comprueba que vendor/opencv.js se haya subido completo.')), 120000);
      sc.async = true;
      sc.src = src;
      sc.onerror = () => finish(new Error('Se descargó OpenCV, pero el navegador no pudo ejecutarlo. Prueba recargar la página.'));
      sc.onload = () => {
        const runtime = window.cv;
        if (!runtime) return finish(new Error('OpenCV se descargó, pero no creó window.cv.'));
        Promise.resolve(runtime).then(c => {
          if (!c || !c.Mat) throw new Error('OpenCV terminó de cargar sin exponer cv.Mat.');
          finish(null, c);
        }).catch(e => finish(new Error('Falló la inicialización de OpenCV: ' + (e && e.message ? e.message : e))));
      };
      document.head.appendChild(sc);
    });
  }

  async function startEngine() {
    if (engineLoading || cv) return;
    engineLoading = true;
    const banner = $('#engineStatus');
    const retry = $('#engineRetry');
    banner.hidden = false;
    banner.classList.remove('ready', 'error');
    retry.hidden = true;
    $('#engineProgress').hidden = false;
    engineProgress(0, 'Descargando motor de imagen (unos 13 MB, solo la primera vez)…');
    try {
      cv = await loadEngine();
      banner.classList.add('ready');
      engineProgress(100, 'Motor de imagen listo.');
      setTimeout(() => { banner.hidden = true; }, 3500);
      syncPickButtons();
    } catch (e) {
      console.error(e);
      banner.classList.add('error');
      $('#engineProgress').hidden = true;
      engineProgress(null, 'No se pudo iniciar el motor de imagen: ' + e.message);
      retry.hidden = false;
    } finally {
      engineLoading = false;
    }
  }

  function syncPickButtons() {
    const ok = active === 'sign' || !!cv;   // la firma se procesa sin OpenCV
    $('#btnCamera').disabled = !ok;
    $('#btnPick').disabled = !ok;
  }

  // ------------------------------------------------------------ carga de imágenes

  async function fileToCanvas(file) {
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('No se pudo leer la imagen.'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
    const sc = Math.min(1, MAX_SIDE_PX / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  async function loadFile(file) {
    if (!file) return;
    if (active === 'sign') return loadSignatureFile(file);
    if (!cv) return;
    const name = active;
    busy(true, 'Leyendo imagen…');
    await nextFrame();
    try {
      const canvas = await fileToCanvas(file);
      const s = sides[name];
      if (s.mat) { s.mat.delete(); s.mat = null; }
      s.canvas = canvas; s.w = canvas.width; s.h = canvas.height;
      s.mat = cv.imread(canvas);
      busy(true, 'Detectando la tarjeta…');
      await nextFrame();
      runDetect(name);
      busy(true, 'Aplicando efecto fotocopia…');
      await nextFrame();
      processSide(name);
      refreshAll();
      if (sides[name].method === 'manual') toast('No pude detectar los bordes con seguridad. Arrastra los 4 puntos a las esquinas de la tarjeta.', 6500);
      else if (name === 'front' && !sides.back.mat) toast('Listo. Ahora el reverso.', 3200);
    } catch (e) {
      console.error(e);
      toast('No se pudo procesar la imagen: ' + (e && e.message ? e.message : e), 6000);
    } finally {
      busy(false);
    }
  }

  function runDetect(name) {
    const s = sides[name], size = cardSize();
    const det = Core.detectCard(cv, s.mat, { aspect: size.w / size.h });
    s.corners = det.corners; s.method = det.method; s.k = Core.autoK(det.corners);
  }

  // ------------------------------------------------------------ procesado

  function resultToCanvas(r) {
    const c = document.createElement('canvas');
    c.width = r.width; c.height = r.height;
    c.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
    return c;
  }

  function processSide(name) {
    const s = sides[name];
    if (!s.mat || !s.corners) return;
    const r = Core.renderCard(cv, s.mat, s.corners, s.k, {
      size: cardSize(), dpi: DPI, mode: settings.mode, contrast: settings.contrast,
      radiusMode: settings.radiusMode,
      radiusMm: settings.radiusMm, border: settings.border
    });
    s.result = r; s.resultCanvas = resultToCanvas(r);
    pdfBlob = null;
  }

  let reTimer = null;
  function scheduleReprocessAll() {
    clearTimeout(reTimer);
    reTimer = setTimeout(async () => {
      if (!cv) return;
      const has = Object.values(sides).some(s => s.mat);
      if (!has) { refreshAll(); return; }
      busy(true, 'Actualizando…');
      await nextFrame();
      try { Object.keys(sides).forEach(processSide); } catch (e) { console.error(e); toast('Error al procesar: ' + e.message, 6000); }
      busy(false);
      refreshAll();
    }, 250);
  }

  // ------------------------------------------------------------ editor de esquinas

  const editor = $('#editor');
  const ectx = editor.getContext('2d');
  let drag = null;       // { idx }
  let view = { f: 1 };   // factor imagen->pixeles de canvas

  function drawEditor() {
    const s = sides[active];
    const has = !!s.canvas;
    $('#placeholder').hidden = has;
    editor.hidden = !has;
    $('#editorHint').hidden = !has;
    $('#editorActions').hidden = !has;
    $('#phSide').textContent = LABEL[active];
    if (!has) return;

    const wrapW = $('#editorWrap').clientWidth || 320;
    const maxH = Math.round(window.innerHeight * 0.62);
    const cssScale = Math.min(wrapW / s.w, maxH / s.h);
    const cssW = Math.round(s.w * cssScale), cssH = Math.round(s.h * cssScale);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    editor.style.width = cssW + 'px'; editor.style.height = cssH + 'px';
    editor.width = Math.round(cssW * dpr); editor.height = Math.round(cssH * dpr);
    const f = editor.width / s.w; view.f = f;
    ectx.drawImage(s.canvas, 0, 0, editor.width, editor.height);

    if (!s.corners) return;
    const c = s.corners.map(p => ({ x: p.x * f, y: p.y * f }));
    ectx.save();
    ectx.lineJoin = 'round';
    ectx.beginPath();
    c.forEach((p, i) => (i ? ectx.lineTo(p.x, p.y) : ectx.moveTo(p.x, p.y)));
    ectx.closePath();
    ectx.fillStyle = 'rgba(29,78,216,0.12)'; ectx.fill();
    ectx.lineWidth = 2.5 * dpr; ectx.strokeStyle = '#1d4ed8'; ectx.stroke();

    // borde que quedará arriba en el resultado
    const cc = Core.cycle(c, s.k);
    ectx.beginPath(); ectx.moveTo(cc[0].x, cc[0].y); ectx.lineTo(cc[1].x, cc[1].y);
    ectx.lineWidth = 4.5 * dpr; ectx.strokeStyle = '#f97316'; ectx.stroke();

    c.forEach(p => {
      ectx.beginPath(); ectx.arc(p.x, p.y, 11 * dpr, 0, Math.PI * 2);
      ectx.fillStyle = '#fff'; ectx.fill();
      ectx.lineWidth = 3 * dpr; ectx.strokeStyle = '#1d4ed8'; ectx.stroke();
    });
    ectx.restore();
  }

  function pointerToImage(ev) {
    const r = editor.getBoundingClientRect();
    const s = sides[active];
    return { x: (ev.clientX - r.left) / r.width * s.w, y: (ev.clientY - r.top) / r.height * s.h };
  }

  editor.addEventListener('pointerdown', ev => {
    const s = sides[active];
    if (!s.corners) return;
    const p = pointerToImage(ev);
    const r = editor.getBoundingClientRect();
    const hit = 30 * (s.w / r.width);   // 30 px de pantalla
    let best = -1, bd = Infinity;
    s.corners.forEach((c, i) => { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd <= hit) {
      drag = { idx: best };
      editor.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });

  editor.addEventListener('pointermove', ev => {
    if (!drag) return;
    const s = sides[active], p = pointerToImage(ev);
    s.corners[drag.idx] = { x: Math.min(s.w, Math.max(0, p.x)), y: Math.min(s.h, Math.max(0, p.y)) };
    s.method = 'manual';
    drawEditor();
  });

  const endDrag = async ev => {
    if (!drag) return;
    drag = null;
    try { editor.releasePointerCapture(ev.pointerId); } catch (e) { /* ya liberado */ }
    const name = active;
    busy(true, 'Actualizando…');
    await nextFrame();
    try { processSide(name); } catch (e) { toast('Error al procesar: ' + e.message, 6000); }
    busy(false);
    refreshAll();
  };
  editor.addEventListener('pointerup', endDrag);
  editor.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ hoja (vista previa y PDF)

  function pageItems() {
    const size = cardSize();
    return ['front', 'back'].map(n => {
      const r = sides[n].result;
      return r ? { name: n, mmW: r.mmW, mmH: r.mmH, res: r } : { name: n, mmW: size.w, mmH: size.h, res: null };
    });
  }

  function drawPage() {
    const cvs = $('#page'), ctx = cvs.getContext('2d');
    const items = pageItems();
    const have = items.filter(i => i.res);
    const lay = Core.layoutPages(settings.paper, items, settings.layout);
    const P = lay.paper;
    const wrapW = Math.min(520, ($('.pagewrap').clientWidth || 360) - 28);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(220, wrapW), cssH = Math.round(cssW * P.h / P.w);
    cvs.style.width = cssW + 'px'; cvs.style.height = cssH + 'px';
    cvs.width = Math.round(cssW * dpr); cvs.height = Math.round(cssH * dpr);
    const f = cvs.width / P.w;       // px por mm
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cvs.width, cvs.height);

    // con "dos hojas" solo se muestra la primera en la vista previa
    const page0 = lay.pages[0];
    page0.forEach(pl => {
      const it = items[pl.i];
      const x = pl.x * f, y = pl.y * f, w = pl.w * f, h = pl.h * f;
      if (it.res) {
        const sc = sides[it.name].resultCanvas;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(sc, x, y, w, h);
      } else {
        ctx.save();
        ctx.setLineDash([6 * dpr, 5 * dpr]); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#94a3b8';
        const r = 3.18 * f;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
        ctx.stroke();
        ctx.fillStyle = '#94a3b8'; ctx.font = `${13 * dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(LABEL[it.name] + ' (falta)', x + w / 2, y + h / 2);
        ctx.restore();
      }
    });

    // firma: centrada entre anverso y reverso
    const spot = sig.result ? Core.signatureSpot(lay, settings.layout, sig.aspect, settings.sigWidth) : null;
    if (spot) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sig.result, spot.x * f, spot.y * f, spot.w * f, spot.h * f);
    }

    $('#btnPdf').disabled = have.length === 0;
    $('#btnOpen').disabled = have.length === 0;
    const info = $('#info');
    info.hidden = have.length === 0;
    if (have.length) {
      const bits = have.map(i => {
        const r = i.res;
        const rad = r.radiusMm === 0 ? 'esquinas rectas' : `esquinas de ${r.radiusMm.toFixed(2).replace('.', ',')} mm`;
        return `${LABEL[i.name]}: ${r.mmW.toFixed(1).replace('.', ',')} × ${r.mmH.toFixed(1).replace('.', ',')} mm, ${rad}`;
      });
      const pages = lay.pages.length > 1 ? ` (${lay.pages.length} hojas)` : '';
      const sigTxt = sig.result && !spot ? ' · La firma no se coloca con «una hoja por cada lado»: usa «Anverso y reverso en una sola hoja».' : '';
      info.textContent = bits.join(' · ') + pages + sigTxt;
    }
    if (active === 'sign' && sig.src) drawSignPreview();   // actualiza el aviso si cambió la disposición
  }

  const mm2pt = mm => mm * 72 / 25.4;

  // PNG tal cual (conserva la transparencia), para la firma
  function canvasToPng(canvas) {
    return new Promise((res, rej) => canvas.toBlob(b => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('No se pudo codificar la firma'))), 'image/png'));
  }

  function flattenToPng(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(canvas, 0, 0);
    return new Promise((res, rej) => c.toBlob(b => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('No se pudo codificar la imagen'))), 'image/png'));
  }

  async function buildPdf() {
    if (pdfBlob) return pdfBlob;
    const { PDFDocument } = window.PDFLib;
    const items = pageItems().filter(i => i.res);
    const lay = Core.layoutPages(settings.paper, items, settings.layout);
    const doc = await PDFDocument.create();
    doc.setTitle('Tarjeta escaneada');
    doc.setCreator('FOTOCOPIADORA');
    doc.setProducer('FOTOCOPIADORA');
    const imgs = [];
    for (const it of items) imgs.push(await doc.embedPng(await flattenToPng(sides[it.name].resultCanvas)));
    const spot = sig.result ? Core.signatureSpot(lay, settings.layout, sig.aspect, settings.sigWidth) : null;
    const sigImg = spot ? await doc.embedPng(await canvasToPng(sig.result)) : null;
    for (const placements of lay.pages) {
      const page = doc.addPage([mm2pt(lay.paper.w), mm2pt(lay.paper.h)]);
      for (const pl of placements) {
        page.drawImage(imgs[pl.i], { x: mm2pt(pl.x), y: mm2pt(lay.paper.h - pl.y - pl.h), width: mm2pt(pl.w), height: mm2pt(pl.h) });
      }
      if (sigImg) {   // la firma va después de las tarjetas, con su transparencia
        page.drawImage(sigImg, { x: mm2pt(spot.x), y: mm2pt(lay.paper.h - spot.y - spot.h), width: mm2pt(spot.w), height: mm2pt(spot.h) });
      }
    }
    const bytes = await doc.save();
    pdfBlob = new Blob([bytes], { type: 'application/pdf' });
    return pdfBlob;
  }

  function pdfName() {
    const d = new Date(), z = n => String(n).padStart(2, '0');
    return `tarjeta-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.pdf`;
  }

  async function withPdf(fn) {
    busy(true, 'Generando PDF…');
    await nextFrame();
    try { const b = await buildPdf(); await fn(b); }
    catch (e) { console.error(e); toast('No se pudo crear el PDF: ' + e.message, 6000); }
    finally { busy(false); }
  }

  $('#btnPdf').addEventListener('click', () => withPdf(b => {
    const url = URL.createObjectURL(b), a = document.createElement('a');
    a.href = url; a.download = pdfName(); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }));

  $('#btnOpen').addEventListener('click', () => withPdf(b => {
    const url = URL.createObjectURL(b);
    const w = window.open(url, '_blank');
    if (!w) location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }));

  $('#btnShare').addEventListener('click', () => withPdf(async b => {
    const file = new File([b], pdfName(), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Tarjeta escaneada' });
    else toast('Tu navegador no permite compartir archivos. Usa "Descargar PDF".');
  }));

  // ------------------------------------------------------------ pestañas, botones, ajustes

  function refreshTabs() {
    ['front', 'back', 'sign'].forEach(n => {
      const t = $('#tab-' + n);
      t.classList.toggle('active', n === active);
      t.setAttribute('aria-selected', n === active ? 'true' : 'false');
      t.querySelector('.ok').hidden = n === 'sign' ? !sig.result : !sides[n].result;
    });
    $('#sidePanel').hidden = active === 'sign';
    $('#signPanel').hidden = active !== 'sign';
    syncPickButtons();
  }
  function redrawActive() { if (active === 'sign') drawSignCrop(); else drawEditor(); }
  function refreshAll() { refreshTabs(); redrawActive(); drawPage(); }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { active = t.dataset.side; refreshAll(); }));

  $('#btnCamera').addEventListener('click', () => $('#inCamera').click());
  $('#btnPick').addEventListener('click', () => $('#inPick').click());
  ['#inCamera', '#inPick'].forEach(id => $(id).addEventListener('change', ev => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) loadFile(f);
  }));

  $('#btnDetect').addEventListener('click', async () => {
    const s = sides[active];
    if (!s.mat) return;
    busy(true, 'Detectando la tarjeta…'); await nextFrame();
    try { runDetect(active); processSide(active); } catch (e) { toast('Error: ' + e.message, 6000); }
    busy(false); refreshAll();
    if (s.method === 'manual') toast('No pude detectar los bordes con seguridad. Ajusta los 4 puntos a mano.', 6000);
  });

  $('#btnRotate').addEventListener('click', async () => {
    const s = sides[active];
    if (!s.mat) return;
    s.k = (s.k + 1) % 4;
    busy(true, 'Girando…'); await nextFrame();
    try { processSide(active); } catch (e) { toast('Error: ' + e.message, 6000); }
    busy(false); refreshAll();
  });

  $('#btnClear').addEventListener('click', () => {
    const s = sides[active];
    if (s.mat) s.mat.delete();
    sides[active] = newSide(); pdfBlob = null;
    refreshAll();
  });

  function syncSettingsUi() {
    $('#sPaper').value = settings.paper;
    $('#sLayout').value = settings.layout;
    $('#sMode').value = settings.mode;
    $('#sContrast').value = settings.contrast; $('#oContrast').textContent = settings.contrast;
    $('#sRadius').value = settings.radiusMode;
    $('#sRadiusMm').value = settings.radiusMm;
    $('#lRadiusMm').hidden = settings.radiusMode !== 'manual';
    $('#sSize').value = settings.sizePreset;
    $('#customSize').hidden = settings.sizePreset !== 'custom';
    $('#sW').value = settings.customW; $('#sH').value = settings.customH;
    $('#sBorder').checked = !!settings.border;
    $('#sSignSens').value = settings.sigSens; $('#oSignSens').textContent = settings.sigSens;
    $('#sSignW').value = settings.sigWidth; $('#oSignW').textContent = settings.sigWidth + ' mm';
  }

  function bind(id, key, conv, reprocess) {
    $(id).addEventListener('input', ev => {
      const el = ev.target;
      settings[key] = conv ? conv(el) : el.value;
      saveSettings(); pdfBlob = null; syncSettingsUi();
      if (reprocess) scheduleReprocessAll(); else { drawPage(); }
    });
  }
  bind('#sPaper', 'paper', null, false);
  bind('#sLayout', 'layout', null, false);
  bind('#sMode', 'mode', null, true);
  bind('#sContrast', 'contrast', el => Number(el.value), true);
  bind('#sRadius', 'radiusMode', null, true);
  bind('#sRadiusMm', 'radiusMm', el => Number(el.value) || 0, true);
  bind('#sSize', 'sizePreset', null, true);
  bind('#sW', 'customW', el => Number(el.value) || 85.6, true);
  bind('#sH', 'customH', el => Number(el.value) || 54, true);
  bind('#sBorder', 'border', el => el.checked, true);

  window.addEventListener('resize', () => { redrawActive(); drawPage(); });

  const settingsDialog = $('#settingsDialog');
  $('#settingsButton').addEventListener('click', () => settingsDialog.showModal());
  $('#closeSettings').addEventListener('click', () => settingsDialog.close());
  settingsDialog.addEventListener('click', ev => {
    if (ev.target === settingsDialog) settingsDialog.close();
  });

  // ------------------------------------------------------------ firma

  const signCanvas = $('#signCrop');
  const sctx = signCanvas.getContext('2d');
  let sdrag = null;          // { idx } esquina que se arrastra: 0 TL, 1 TR, 2 BR, 3 BL
  let sview = { f: 1, pad: 0 };  // px de canvas por px de foto, y margen alrededor de la foto

  function signCorners() {
    const c = sig.crop;
    return [{ x: c.x0, y: c.y0 }, { x: c.x1, y: c.y0 }, { x: c.x1, y: c.y1 }, { x: c.x0, y: c.y1 }];
  }

  function processSignature() {
    if (!sig.src || !sig.crop) return;
    const c = sig.crop, cw = Math.max(1, Math.round(c.x1 - c.x0)), ch = Math.max(1, Math.round(c.y1 - c.y0));
    const k = Math.min(1, SIG_MAX_PX / Math.max(cw, ch));
    const w = Math.max(1, Math.round(cw * k)), h = Math.max(1, Math.round(ch * k));
    const work = document.createElement('canvas');
    work.width = w; work.height = h;
    const g = work.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);        // un PNG transparente cuenta como papel blanco
    g.imageSmoothingQuality = 'high';
    g.drawImage(sig.src, c.x0, c.y0, cw, ch, 0, 0, w, h);
    const r = Core.signatureFromImage(g.getImageData(0, 0, w, h), { sensitivity: settings.sigSens, color: SIG_COLOR });
    if (r) {
      const out = document.createElement('canvas');
      out.width = r.width; out.height = r.height;
      out.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
      sig.result = out; sig.aspect = r.width / r.height;
    } else {
      sig.result = null;
    }
    pdfBlob = null;
  }

  async function loadSignatureFile(file) {
    busy(true, 'Leyendo la firma…');
    await nextFrame();
    try {
      sig.src = await fileToCanvas(file);
      sig.crop = { x0: 0, y0: 0, x1: sig.src.width, y1: sig.src.height };
      busy(true, 'Quitando el fondo…');
      await nextFrame();
      processSignature();
      refreshAll();
      if (sig.result) toast('Firma lista. Si salió con manchas, recorta mejor o baja la sensibilidad.', 4800);
      else toast('No encontré trazos en la foto. Sube la sensibilidad o recorta la firma.', 6000);
    } catch (e) {
      console.error(e);
      toast('No se pudo procesar la firma: ' + (e && e.message ? e.message : e), 6000);
    } finally {
      busy(false);
    }
  }

  let sigTimer = null;
  function scheduleSignature() {
    clearTimeout(sigTimer);
    sigTimer = setTimeout(() => {
      try { processSignature(); } catch (e) { console.error(e); toast('Error al procesar la firma: ' + e.message, 6000); }
      refreshAll();
    }, 160);
  }

  function drawSignCrop() {
    const has = !!sig.src;
    $('#signPlaceholder').hidden = has;
    signCanvas.hidden = !has;
    $('#signHint').hidden = !has;
    $('#signControls').hidden = !has;
    if (!has) return;

    const PAD = 14;   // margen (px CSS) para que las esquinas del recuadro se vean y se puedan tomar en el borde
    const wrapW = ($('#signWrap').clientWidth || 320) - 2 * PAD;
    const maxH = Math.round(window.innerHeight * 0.5);
    const sw = sig.src.width, sh = sig.src.height;
    const cssScale = Math.min(wrapW / sw, maxH / sh);
    const imgW = Math.round(sw * cssScale), imgH = Math.round(sh * cssScale);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    signCanvas.style.width = (imgW + 2 * PAD) + 'px'; signCanvas.style.height = (imgH + 2 * PAD) + 'px';
    signCanvas.width = Math.round((imgW + 2 * PAD) * dpr); signCanvas.height = Math.round((imgH + 2 * PAD) * dpr);
    const pad = Math.round(PAD * dpr), iw = signCanvas.width - 2 * pad, ih = signCanvas.height - 2 * pad;
    const f = iw / sw; sview = { f, pad };
    sctx.clearRect(0, 0, signCanvas.width, signCanvas.height);
    sctx.drawImage(sig.src, pad, pad, iw, ih);

    const c = sig.crop, x0 = pad + c.x0 * f, y0 = pad + c.y0 * f, x1 = pad + c.x1 * f, y1 = pad + c.y1 * f;
    sctx.save();
    sctx.fillStyle = 'rgba(15,23,42,0.5)';           // oscurece lo que queda fuera del recuadro
    sctx.fillRect(pad, pad, iw, ih);
    sctx.drawImage(sig.src, c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0, x0, y0, x1 - x0, y1 - y0);
    sctx.lineWidth = 2.5 * dpr; sctx.strokeStyle = '#1d4ed8';
    sctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y]) => {
      sctx.beginPath(); sctx.arc(x, y, 11 * dpr, 0, Math.PI * 2);
      sctx.fillStyle = '#fff'; sctx.fill();
      sctx.lineWidth = 3 * dpr; sctx.strokeStyle = '#1d4ed8'; sctx.stroke();
    });
    sctx.restore();

    drawSignPreview();
  }

  function drawSignPreview() {
    const cvs = $('#signPrev'), none = $('#signNone');
    $('#signPrevWrap').hidden = !sig.result;
    none.hidden = !!sig.result;
    $('#btnSignPng').disabled = !sig.result;
    const note = $('#signNote');
    if (!sig.result) { note.textContent = ''; return; }
    const wrapW = Math.min(460, ($('#signWrap').clientWidth || 320) - 24);
    const k = Math.min(wrapW / sig.result.width, 150 / sig.result.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(30, Math.round(sig.result.width * k)), cssH = Math.max(12, Math.round(sig.result.height * k));
    cvs.style.width = cssW + 'px'; cvs.style.height = cssH + 'px';
    cvs.width = Math.round(cssW * dpr); cvs.height = Math.round(cssH * dpr);
    const g = cvs.getContext('2d');
    g.clearRect(0, 0, cvs.width, cvs.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(sig.result, 0, 0, cvs.width, cvs.height);

    const lay = Core.layoutPages(settings.paper, pageItems(), settings.layout);
    note.textContent = Core.signatureSpot(lay, settings.layout, sig.aspect, settings.sigWidth)
      ? 'Se coloca centrada entre el anverso y el reverso.'
      : 'Para que la firma salga en el PDF, elige en Ajustes «Anverso y reverso en una sola hoja».';
  }

  function signPointer(ev) {
    const r = signCanvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width * signCanvas.width - sview.pad) / sview.f,
      y: ((ev.clientY - r.top) / r.height * signCanvas.height - sview.pad) / sview.f
    };
  }

  signCanvas.addEventListener('pointerdown', ev => {
    if (!sig.src) return;
    const p = signPointer(ev), r = signCanvas.getBoundingClientRect();
    const hit = 34 * (signCanvas.width / r.width) / sview.f;   // 34 px de pantalla, en px de foto
    let best = -1, bd = Infinity;
    signCorners().forEach((c, i) => { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd <= hit) {
      sdrag = { idx: best };
      signCanvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });

  signCanvas.addEventListener('pointermove', ev => {
    if (!sdrag) return;
    const p = signPointer(ev), c = sig.crop, min = Math.max(20, 0.04 * Math.max(sig.src.width, sig.src.height));
    const x = Math.min(sig.src.width, Math.max(0, p.x)), y = Math.min(sig.src.height, Math.max(0, p.y));
    if (sdrag.idx === 0 || sdrag.idx === 3) c.x0 = Math.min(x, c.x1 - min); else c.x1 = Math.max(x, c.x0 + min);
    if (sdrag.idx === 0 || sdrag.idx === 1) c.y0 = Math.min(y, c.y1 - min); else c.y1 = Math.max(y, c.y0 + min);
    drawSignCrop();
  });

  const endSignDrag = async ev => {
    if (!sdrag) return;
    sdrag = null;
    try { signCanvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ya liberado */ }
    busy(true, 'Quitando el fondo…');
    await nextFrame();
    try { processSignature(); } catch (e) { toast('Error al procesar la firma: ' + e.message, 6000); }
    busy(false);
    refreshAll();
  };
  signCanvas.addEventListener('pointerup', endSignDrag);
  signCanvas.addEventListener('pointercancel', endSignDrag);

  $('#sSignSens').addEventListener('input', ev => {
    settings.sigSens = Number(ev.target.value); saveSettings(); syncSettingsUi(); scheduleSignature();
  });
  $('#sSignW').addEventListener('input', ev => {
    settings.sigWidth = Number(ev.target.value); saveSettings(); pdfBlob = null; syncSettingsUi();
    drawPage();
  });

  $('#btnSignRotate').addEventListener('click', async () => {
    if (!sig.src) return;
    const o = sig.src, r = document.createElement('canvas');
    r.width = o.height; r.height = o.width;
    const g = r.getContext('2d');
    g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(o, 0, 0);
    sig.src = r; sig.crop = { x0: 0, y0: 0, x1: r.width, y1: r.height };
    busy(true, 'Girando…'); await nextFrame();
    try { processSignature(); } catch (e) { toast('Error al procesar la firma: ' + e.message, 6000); }
    busy(false); refreshAll();
  });

  $('#btnSignPng').addEventListener('click', () => {
    if (!sig.result) return;
    sig.result.toBlob(b => {
      if (!b) { toast('No se pudo crear el PNG.'); return; }
      const url = URL.createObjectURL(b), a = document.createElement('a');
      a.href = url; a.download = 'firma-azul.png'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }, 'image/png');
  });

  $('#btnSignClear').addEventListener('click', () => {
    sig.src = null; sig.crop = null; sig.result = null; pdfBlob = null;
    refreshAll();
  });

  // ------------------------------------------------------------ arranque

  syncSettingsUi();
  drawPage();
  if (navigator.canShare && typeof File === 'function') $('#btnShare').hidden = false;

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    serviceWorkerReady = navigator.serviceWorker.register(new URL('sw.js', document.baseURI))
      .then(() => navigator.serviceWorker.ready)
      .then(() => new Promise(resolve => {
        if (navigator.serviceWorker.controller) return resolve(true);
        const timer = setTimeout(() => resolve(!!navigator.serviceWorker.controller), 3000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
      }))
      .catch(() => false);
  }
  $('#engineRetry').addEventListener('click', startEngine);
  startEngine();
}());
