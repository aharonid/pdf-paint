// PDF Paint — rasterize a PDF, then paint on it like a tiny MS Paint.
// Everything runs locally: pdf.js rasterizes, canvas edits the pixels, pdf-lib repacks.

import * as pdfjsLib from './vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

const PALETTE = [
  '#000000', '#4d4d4d', '#8c8c8c', '#c8c8c8', '#ffffff', '#7f0000', '#ff0000', '#ff6a00',
  '#ffd800', '#4cff00', '#00a86b', '#00b7ff', '#0026ff', '#6a00ff', '#b200ff', '#ff00dc',
];

const state = {
  pages: [],           // { base, ctx, orig, wPt, hPt, undo[], redo[], thumb }
  index: 0,
  zoom: 1,
  tool: 'pencil',
  size: 6,
  alpha: 1,
  primary: '#111111',
  secondary: '#ffffff',
  activeSlot: 'primary',
  shapeStyle: 'stroke',
  tolerance: 32,
  fontSize: 16,
  fontFamily: 'Helvetica, Arial, sans-serif',
  fileName: 'untitled',
  dirty: false,
};

const view = $('view');
const vctx = view.getContext('2d', { willReadFrequently: true });
let drag = null;                                  // in-progress stroke/shape
let sel = { rect: null, float: null, ox: 0, oy: 0 }; // selection + floating pixels

const page = () => state.pages[state.index];

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

const rgbToHex = (r, g, b) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/* ------------------------------------------------------------------ loading */

async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const dpi = Number($('dpi').value);
  busy(true, 'Rasterizing…');

  try {
    for (const file of files) {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        await addPdf(file, dpi);
      } else {
        await addImage(file, dpi);
      }
      if (state.fileName === 'untitled') state.fileName = file.name.replace(/\.[^.]+$/, '');
    }
    $('dropzone').hidden = true;
    $('stage').hidden = false;
    state.index = Math.min(state.index, state.pages.length - 1);
    buildThumbs();
    paintView();
    zoomFit();
    setStatus(`${state.fileName} · ${state.pages.length} page${state.pages.length === 1 ? '' : 's'}`, 'file');
    flash('Ready — pick a tool and paint.');
  } catch (err) {
    console.error(err);
    flash(`Could not open that file: ${err.message}`);
  } finally {
    busy(false);
  }
}

async function addPdf(file, dpi) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data,
    // Fetched on demand, and only for PDFs that need them: CJK encodings and the
    // 14 standard fonts that PDFs are allowed to reference without embedding.
    cMapUrl: new URL('vendor/cmaps/', document.baseURI).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('vendor/standard_fonts/', document.baseURI).href,
  });
  const pdf = await task.promise;
  const scale = dpi / 72;

  for (let n = 1; n <= pdf.numPages; n++) {
    flash(`Rendering page ${n} of ${pdf.numPages}…`);
    const pg = await pdf.getPage(n);
    const viewport = pg.getViewport({ scale });
    const unit = pg.getViewport({ scale: 1 });

    const base = document.createElement('canvas');
    base.width = Math.round(viewport.width);
    base.height = Math.round(viewport.height);
    const ctx = base.getContext('2d', { willReadFrequently: true });
    // PDF pages render with a transparent backdrop; paint one so edits behave like paper.
    await pg.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;

    state.pages.push(makePage(base, unit.width, unit.height));
  }
  await task.destroy(); // frees the worker's copy of the file; the bitmaps are ours now
}

async function addImage(file, dpi) {
  const bitmap = await createImageBitmap(file);
  const base = document.createElement('canvas');
  base.width = bitmap.width;
  base.height = bitmap.height;
  const ctx = base.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, base.width, base.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Treat the image as if it were scanned at the chosen DPI.
  state.pages.push(makePage(base, (base.width * 72) / dpi, (base.height * 72) / dpi));
}

function makePage(base, wPt, hPt) {
  const orig = document.createElement('canvas');
  orig.width = base.width;
  orig.height = base.height;
  orig.getContext('2d').drawImage(base, 0, 0);
  return {
    base,
    ctx: base.getContext('2d', { willReadFrequently: true }),
    orig,
    wPt,
    hPt,
    undo: [],
    redo: [],
    thumb: null,
  };
}

/* ------------------------------------------------------------------ history */

const MAX_UNDO = 20;

function snapshot(p = page()) {
  const c = document.createElement('canvas');
  c.width = p.base.width;
  c.height = p.base.height;
  c.getContext('2d').drawImage(p.base, 0, 0);
  return c;
}

function pushUndo() {
  const p = page();
  p.undo.push(snapshot(p));
  if (p.undo.length > MAX_UNDO) p.undo.shift();
  p.redo.length = 0;
  state.dirty = true;
  syncHistoryButtons();
}

function undo() {
  const p = page();
  if (!p.undo.length) return;
  dropSelection(false);
  p.redo.push(snapshot(p));
  restore(p, p.undo.pop());
}

function redo() {
  const p = page();
  if (!p.redo.length) return;
  dropSelection(false);
  p.undo.push(snapshot(p));
  restore(p, p.redo.pop());
}

function restore(p, canvas) {
  p.ctx.clearRect(0, 0, p.base.width, p.base.height);
  p.ctx.drawImage(canvas, 0, 0);
  paintView();
  queueThumb();
  syncHistoryButtons();
}

function syncHistoryButtons() {
  const p = page();
  $('btn-undo').disabled = !p || !p.undo.length;
  $('btn-redo').disabled = !p || !p.redo.length;
}

/* ------------------------------------------------------------------ painting */

function toDoc(e) {
  const r = view.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / state.zoom,
    y: (e.clientY - r.top) / state.zoom,
  };
}

function strokeColor(e) {
  return e.button === 2 || e.buttons === 2 ? state.secondary : state.primary;
}

function applyBrush(ctx, color) {
  ctx.globalAlpha = state.alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = state.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

view.addEventListener('contextmenu', (e) => e.preventDefault());

view.addEventListener('pointerdown', (e) => {
  if (!state.pages.length || e.button > 2) return;
  commitText(); // a click anywhere lands any text that was still being typed
  view.setPointerCapture(e.pointerId);
  const pt = toDoc(e);
  const color = strokeColor(e);
  const p = page();

  switch (state.tool) {
    case 'picker': {
      const d = p.ctx.getImageData(Math.floor(pt.x), Math.floor(pt.y), 1, 1).data;
      setColor(rgbToHex(d[0], d[1], d[2]));
      flash(`Picked ${rgbToHex(d[0], d[1], d[2])}`);
      return;
    }
    case 'fill': {
      pushUndo();
      floodFill(p.ctx, Math.floor(pt.x), Math.floor(pt.y), color, state.tolerance, state.alpha);
      paintView();
      queueThumb();
      return;
    }
    case 'text': {
      // Suppress the default focus shift, which would blur (and close) the box we just opened.
      e.preventDefault();
      openTextEntry(pt);
      return;
    }
    case 'select': {
      startSelect(pt, e);
      return;
    }
    case 'pencil':
    case 'marker':
    case 'eraser': {
      pushUndo();
      const ctx = p.ctx;
      ctx.save();
      applyBrush(ctx, state.tool === 'eraser' ? state.secondary : color);
      if (state.tool === 'marker') ctx.globalCompositeOperation = 'multiply';
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x + 0.01, pt.y); // a click alone still lays down a dot
      ctx.stroke();
      drag = { kind: 'free', ctx, last: pt };
      paintView();
      return;
    }
    default: {
      // line / rect / ellipse — preview until release
      drag = { kind: 'shape', start: pt, end: pt, color, shift: e.shiftKey };
    }
  }
});

view.addEventListener('pointermove', (e) => {
  if (!state.pages.length) return;
  const pt = toDoc(e);
  setStatus(`${Math.round(pt.x)}, ${Math.round(pt.y)} px`, 'pos');
  if (!drag) return;

  if (drag.kind === 'free') {
    drag.ctx.lineTo(pt.x, pt.y);
    drag.ctx.stroke();
    drag.last = pt;
    paintView();
  } else if (drag.kind === 'shape') {
    drag.end = pt;
    drag.shift = e.shiftKey;
    paintView((ctx) => drawShape(ctx, drag));
  } else if (drag.kind === 'select-new') {
    sel.rect = normRect(drag.start, pt);
    paintView();
  } else if (drag.kind === 'select-move') {
    sel.ox = drag.baseOx + (pt.x - drag.start.x);
    sel.oy = drag.baseOy + (pt.y - drag.start.y);
    paintView();
  }
});

view.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const p = page();

  if (drag.kind === 'free') {
    drag.ctx.restore();
    queueThumb();
  } else if (drag.kind === 'shape') {
    drag.end = toDoc(e);
    drag.shift = e.shiftKey;
    pushUndo();
    p.ctx.save();
    drawShape(p.ctx, drag);
    p.ctx.restore();
    queueThumb();
  } else if (drag.kind === 'select-new') {
    if (!sel.rect || sel.rect.w < 2 || sel.rect.h < 2) sel.rect = null;
  }

  drag = null;
  paintView();
});

function drawShape(ctx, d) {
  let { x: x0, y: y0 } = d.start;
  let { x: x1, y: y1 } = d.end;

  if (d.shift) {
    // Constrain: 45° for lines, square/circle for boxes.
    if (state.tool === 'line') {
      const dx = x1 - x0;
      const dy = y1 - y0;
      if (Math.abs(dx) > Math.abs(dy) * 2) y1 = y0;
      else if (Math.abs(dy) > Math.abs(dx) * 2) x1 = x0;
      else {
        const s = Math.min(Math.abs(dx), Math.abs(dy));
        x1 = x0 + Math.sign(dx) * s;
        y1 = y0 + Math.sign(dy) * s;
      }
    } else {
      const s = Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0) * s;
      y1 = y0 + Math.sign(y1 - y0) * s;
    }
  }

  applyBrush(ctx, d.color);
  const secondary = state.secondary;

  if (state.tool === 'line') {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  if (state.tool === 'rect') {
    ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else {
    ctx.ellipse(
      (x0 + x1) / 2, (y0 + y1) / 2,
      Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2,
      0, 0, Math.PI * 2,
    );
  }
  if (state.shapeStyle !== 'stroke') {
    ctx.fillStyle = state.shapeStyle === 'both' ? secondary : d.color;
    ctx.fill();
  }
  if (state.shapeStyle !== 'fill') ctx.stroke();
}

/* --------------------------------------------------------------- flood fill */

function floodFill(ctx, x, y, hex, tolerance, alpha) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (x < 0 || y < 0 || x >= w || y >= h) return;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (px, py) => (py * w + px) * 4;
  const start = at(x, y);
  const [sr, sg, sb, sa] = [d[start], d[start + 1], d[start + 2], d[start + 3]];
  const { r, g, b } = hexToRgb(hex);
  if (Math.abs(sr - r) < 2 && Math.abs(sg - g) < 2 && Math.abs(sb - b) < 2 && sa === 255 && alpha === 1) return;

  const tol = tolerance * tolerance * 3;
  const match = (i) => {
    const dr = d[i] - sr;
    const dg = d[i + 1] - sg;
    const db = d[i + 2] - sb;
    const da = d[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  const seen = new Uint8Array(w * h);
  const stack = [[x, y]];

  while (stack.length) {
    const [cx, cy] = stack.pop();
    let left = cx;
    while (left > 0 && !seen[cy * w + (left - 1)] && match(at(left - 1, cy))) left--;
    let right = cx;
    while (right < w - 1 && !seen[cy * w + (right + 1)] && match(at(right + 1, cy))) right++;

    for (let px = left; px <= right; px++) {
      const i = at(px, cy);
      const k = cy * w + px;
      if (seen[k]) continue;
      seen[k] = 1;
      d[i] = Math.round(d[i] * (1 - alpha) + r * alpha);
      d[i + 1] = Math.round(d[i + 1] * (1 - alpha) + g * alpha);
      d[i + 2] = Math.round(d[i + 2] * (1 - alpha) + b * alpha);
      d[i + 3] = Math.round(d[i + 3] * (1 - alpha) + 255 * alpha);

      if (cy > 0 && !seen[(cy - 1) * w + px] && match(at(px, cy - 1))) stack.push([px, cy - 1]);
      if (cy < h - 1 && !seen[(cy + 1) * w + px] && match(at(px, cy + 1))) stack.push([px, cy + 1]);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------------------------------------------------------------- selection */

function startSelect(pt, e) {
  if (sel.rect && inRect(pt, movedRect())) {
    if (!sel.float) liftSelection(e.altKey);
    drag = { kind: 'select-move', start: pt, baseOx: sel.ox, baseOy: sel.oy };
  } else {
    dropSelection(true);
    drag = { kind: 'select-new', start: pt };
    sel = { rect: null, float: null, ox: 0, oy: 0 };
  }
}

// Copy the selected pixels onto a floating layer; unless duplicating, blank the source.
function liftSelection(duplicate) {
  const p = page();
  const r = sel.rect;
  pushUndo();
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w));
  c.height = Math.max(1, Math.round(r.h));
  c.getContext('2d').drawImage(p.base, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  if (!duplicate) {
    p.ctx.save();
    p.ctx.fillStyle = state.secondary;
    p.ctx.fillRect(r.x, r.y, r.w, r.h);
    p.ctx.restore();
  }
  sel.float = c;
}

// Stamp a floating selection back into the page.
function dropSelection(keepHistory = true) {
  if (sel.float) {
    const p = page();
    const r = movedRect();
    p.ctx.drawImage(sel.float, r.x, r.y, r.w, r.h);
    if (keepHistory) state.dirty = true;
    queueThumb();
  }
  sel = { rect: null, float: null, ox: 0, oy: 0 };
}

const movedRect = () => ({ x: sel.rect.x + sel.ox, y: sel.rect.y + sel.oy, w: sel.rect.w, h: sel.rect.h });
const inRect = (pt, r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;

function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/* --------------------------------------------------------------- text entry */

function openTextEntry(pt) {
  const box = $('text-entry');
  box.hidden = false;
  box.value = '';
  box.dataset.x = pt.x;
  box.dataset.y = pt.y;
  box.style.left = `${pt.x * state.zoom}px`;
  box.style.top = `${pt.y * state.zoom}px`;
  box.style.width = `${Math.max(120, (view.width - pt.x * 1) * state.zoom * 0.5)}px`;
  box.style.height = `${state.fontSize * 1.4 * state.zoom}px`;
  box.style.font = `${state.fontSize * state.zoom}px ${state.fontFamily}`;
  box.style.color = state.primary;
  box.focus();
}

function commitText() {
  const box = $('text-entry');
  if (box.hidden) return;
  const text = box.value;
  box.hidden = true;
  if (!text.trim()) return;

  const p = page();
  pushUndo();
  const ctx = p.ctx;
  ctx.save();
  ctx.globalAlpha = state.alpha;
  ctx.fillStyle = state.primary;
  ctx.textBaseline = 'top';
  ctx.font = `${state.fontSize}px ${state.fontFamily}`;
  const x = Number(box.dataset.x);
  const y = Number(box.dataset.y);
  text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * state.fontSize * 1.15));
  ctx.restore();
  paintView();
  queueThumb();
}

$('text-entry').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitText();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    $('text-entry').hidden = true;
  }
  e.stopPropagation();
});
$('text-entry').addEventListener('blur', commitText);

/* ------------------------------------------------------------------- render */

function paintView(preview) {
  const p = page();
  if (!p) return;
  if (view.width !== p.base.width || view.height !== p.base.height) {
    view.width = p.base.width;
    view.height = p.base.height;
    applyZoom();
  }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.globalAlpha = 1;
  vctx.globalCompositeOperation = 'source-over';
  vctx.clearRect(0, 0, view.width, view.height);
  vctx.drawImage(p.base, 0, 0);

  if (sel.float) {
    const r = movedRect();
    vctx.drawImage(sel.float, r.x, r.y, r.w, r.h);
  }
  if (preview) {
    vctx.save();
    preview(vctx);
    vctx.restore();
  }
  if (sel.rect) {
    const r = movedRect();
    vctx.save();
    vctx.globalAlpha = 1;
    vctx.lineWidth = Math.max(1, 1 / state.zoom);
    vctx.strokeStyle = '#000';
    vctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    vctx.strokeRect(r.x, r.y, r.w, r.h);
    vctx.strokeStyle = '#fff';
    vctx.lineDashOffset = 6 / state.zoom;
    vctx.strokeRect(r.x, r.y, r.w, r.h);
    vctx.restore();
  }
}

function applyZoom() {
  const p = page();
  if (!p) return;
  view.style.width = `${p.base.width * state.zoom}px`;
  view.style.height = `${p.base.height * state.zoom}px`;
  $('zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
  $('text-entry').hidden = true;
}

function setZoom(z) {
  state.zoom = Math.min(8, Math.max(0.05, z));
  applyZoom();
}

function zoomFit() {
  const p = page();
  if (!p) return;
  const ws = $('workspace');
  setZoom(Math.min(
    (ws.clientWidth - 56) / p.base.width,
    (ws.clientHeight - 56) / p.base.height,
  ));
}

/* --------------------------------------------------------------- thumbnails */

function buildThumbs() {
  const wrap = $('thumbs');
  wrap.innerHTML = '';
  state.pages.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = `thumb${i === state.index ? ' is-active' : ''}`;
    const c = document.createElement('canvas');
    const w = 120;
    c.width = w;
    c.height = Math.round((p.base.height / p.base.width) * w);
    btn.append(c);
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = i + 1;
    btn.append(label);
    btn.addEventListener('click', () => goToPage(i));
    wrap.append(btn);
    p.thumb = c;
    drawThumb(p);
  });
  setStatus(`Page ${state.index + 1} / ${state.pages.length}`, 'page');
}

function drawThumb(p) {
  if (!p.thumb) return;
  const ctx = p.thumb.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, p.thumb.width, p.thumb.height);
  ctx.drawImage(p.base, 0, 0, p.thumb.width, p.thumb.height);
}

let thumbTimer = null;
function queueThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => drawThumb(page()), 250);
}

function goToPage(i) {
  if (i === state.index) return;
  dropSelection();
  commitText();
  state.index = i;
  [...$('thumbs').children].forEach((el, n) => el.classList.toggle('is-active', n === i));
  paintView();
  applyZoom(); // keep the current zoom across pages, the way a paint app does
  setStatus(`Page ${i + 1} / ${state.pages.length}`, 'page');
  syncHistoryButtons();
}

/* ------------------------------------------------------------------ exports */

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// pdf-lib is only needed when someone exports, so it stays off the critical path.
let pdfLibLoader = null;
function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (!pdfLibLoader) {
    pdfLibLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf-lib.min.js';
      s.onload = () => resolve(window.PDFLib);
      s.onerror = () => {
        pdfLibLoader = null;
        reject(new Error('could not load the PDF writer'));
      };
      document.head.append(s);
    });
  }
  return pdfLibLoader;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function savePng() {
  if (!state.pages.length) return;
  dropSelection();
  download(await canvasToBlob(page().base), `${state.fileName}-p${state.index + 1}.png`);
  flash('Saved PNG.');
}

async function savePdf() {
  if (!state.pages.length) return;
  dropSelection();
  busy(true, 'Building PDF…');
  try {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    for (const p of state.pages) {
      const blob = await canvasToBlob(p.base);
      const png = await doc.embedPng(await blob.arrayBuffer());
      const pdfPage = doc.addPage([p.wPt, p.hPt]);
      pdfPage.drawImage(png, { x: 0, y: 0, width: p.wPt, height: p.hPt });
    }
    const bytes = await doc.save();
    download(new Blob([bytes], { type: 'application/pdf' }), `${state.fileName}-edited.pdf`);
    state.dirty = false;
    flash('Saved PDF.');
  } catch (err) {
    console.error(err);
    flash(`PDF export failed: ${err.message}`);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------------------ chrome  */

function setTool(tool) {
  commitText();
  if (tool !== 'select') dropSelection();
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
  $('opt-shape').hidden = !['rect', 'ellipse'].includes(tool);
  $('opt-text').hidden = tool !== 'text';
  $('opt-fill').hidden = tool !== 'fill';
  view.style.cursor = tool === 'picker' ? 'copy' : tool === 'select' ? 'default' : 'crosshair';
  paintView();
}

function setColor(hex) {
  state[state.activeSlot] = hex;
  $('color-input').value = hex;
  renderChips();
}

function renderChips() {
  $('primary-chip').style.background = state.primary;
  $('secondary-chip').style.background = state.secondary;
  $('slot-primary').classList.toggle('is-active', state.activeSlot === 'primary');
  $('slot-secondary').classList.toggle('is-active', state.activeSlot === 'secondary');
}

function setStatus(text, which) {
  $(`status-${which}`).textContent = text;
}

let flashTimer = null;
function flash(msg) {
  setStatus(msg, 'msg');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setStatus('', 'msg'), 4000);
}

function busy(on, msg = '') {
  document.body.classList.toggle('busy', on);
  if (on && msg) setStatus(msg, 'msg');
}

/* -------------------------------------------------------------------- wiring */

$('btn-open').addEventListener('click', () => $('file-input').click());
$('btn-open-2').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  openFiles(e.target.files);
  e.target.value = '';
});

$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('.tool');
  if (b) setTool(b.dataset.tool);
});

$('size').addEventListener('input', (e) => {
  state.size = Number(e.target.value);
  $('size-readout').textContent = state.size;
});
$('alpha').addEventListener('input', (e) => {
  state.alpha = Number(e.target.value) / 100;
  $('alpha-readout').textContent = `${e.target.value}%`;
});
$('tolerance').addEventListener('input', (e) => {
  state.tolerance = Number(e.target.value);
  $('tol-readout').textContent = state.tolerance;
});
$('font-size').addEventListener('input', (e) => { state.fontSize = Number(e.target.value) || 16; });
$('font-family').addEventListener('change', (e) => { state.fontFamily = e.target.value; });

$('shape-style').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.shapeStyle = b.dataset.style;
  [...e.currentTarget.children].forEach((el) => el.classList.toggle('is-active', el === b));
});

$('slot-primary').addEventListener('click', () => {
  state.activeSlot = 'primary';
  $('color-input').value = state.primary;
  renderChips();
});
$('slot-secondary').addEventListener('click', () => {
  state.activeSlot = 'secondary';
  $('color-input').value = state.secondary;
  renderChips();
});
$('color-input').addEventListener('input', (e) => setColor(e.target.value));

PALETTE.forEach((hex) => {
  const b = document.createElement('button');
  b.style.background = hex;
  b.title = hex;
  b.addEventListener('click', () => setColor(hex));
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    state.secondary = hex;
    renderChips();
  });
  $('palette').append(b);
});

$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
$('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
$('btn-zoom-fit').addEventListener('click', zoomFit);
$('btn-save-png').addEventListener('click', savePng);
$('btn-save-pdf').addEventListener('click', savePdf);

$('btn-clear').addEventListener('click', () => {
  if (!state.pages.length) return;
  dropSelection(false);
  pushUndo();
  const p = page();
  p.ctx.save();
  p.ctx.globalAlpha = 1;
  p.ctx.fillStyle = state.secondary;
  p.ctx.fillRect(0, 0, p.base.width, p.base.height);
  p.ctx.restore();
  paintView();
  queueThumb();
});

$('btn-revert').addEventListener('click', () => {
  if (!state.pages.length) return;
  dropSelection(false);
  pushUndo();
  const p = page();
  p.ctx.clearRect(0, 0, p.base.width, p.base.height);
  p.ctx.drawImage(p.orig, 0, 0);
  paintView();
  queueThumb();
  flash('Page reverted to the original render.');
});

// Ctrl/⌘ + wheel zooms, like every other canvas app.
$('workspace').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

const SHORTCUTS = {
  b: 'pencil', m: 'marker', e: 'eraser', l: 'line', r: 'rect',
  o: 'ellipse', g: 'fill', t: 'text', i: 'picker', s: 'select',
};

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    savePdf();
    return;
  }
  if (meta) return;

  if (e.key === 'Escape') { dropSelection(); paintView(); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && sel.rect) {
    e.preventDefault();
    const p = page();
    if (sel.float) { sel.float = null; sel.rect = null; }
    else {
      pushUndo();
      p.ctx.save();
      p.ctx.fillStyle = state.secondary;
      p.ctx.fillRect(sel.rect.x, sel.rect.y, sel.rect.w, sel.rect.h);
      p.ctx.restore();
      sel.rect = null;
    }
    paintView();
    queueThumb();
    return;
  }
  if (e.key === '[' || e.key === ']') {
    const next = Math.min(80, Math.max(1, state.size + (e.key === ']' ? 1 : -1)));
    state.size = next;
    $('size').value = next;
    $('size-readout').textContent = next;
    return;
  }
  if (e.key === '+' || e.key === '=') { setZoom(state.zoom * 1.25); return; }
  if (e.key === '-') { setZoom(state.zoom / 1.25); return; }
  if (e.key === '0') { zoomFit(); return; }
  if (e.key === 'PageDown' || e.key === 'ArrowRight') { goToPage(Math.min(state.pages.length - 1, state.index + 1)); return; }
  if (e.key === 'PageUp' || e.key === 'ArrowLeft') { goToPage(Math.max(0, state.index - 1)); return; }
  if (e.key === 'x') { // swap colors, Paint-style
    [state.primary, state.secondary] = [state.secondary, state.primary];
    $('color-input').value = state[state.activeSlot];
    renderChips();
    return;
  }
  const tool = SHORTCUTS[e.key.toLowerCase()];
  if (tool) setTool(tool);
});

// Drag and drop anywhere in the window.
const dz = $('dropzone');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('is-hot');
});
window.addEventListener('dragleave', () => dz.classList.remove('is-hot'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('is-hot');
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

window.addEventListener('resize', () => { if (state.pages.length) applyZoom(); });
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

renderChips();
syncHistoryButtons();

// Offline support. Caches the app's own files; user documents never touch it.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode is optional */ });
  });
}
