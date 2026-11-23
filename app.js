// PDF samenvoegen — draait volledig in de browser; bestanden worden nergens naartoe gestuurd.
// De bibliotheken staan in ./lib op deze eigen website (geen externe servers); zie lib/VERSIES.md.
(async () => {
  'use strict';

  const PDFJS_DIR = new URL('lib/pdfjs-dist/', document.baseURI).href;
  const PDFLIB_DIR = new URL('lib/pdf-lib/', document.baseURI).href;
  const COLORS = ['#0a64d6', '#e8590c', '#2b8a3e', '#ae3ec9', '#c2255c', '#0c8599', '#b08800', '#5f3dc4'];
  const THUMB_W = 124, THUMB_H = 156;   // kader waarin een miniatuur past
  const VIEW_SCALE = 1.35;               // px per punt in de grote weergave (max.)
  const MAX_VIEW_PIXELS = 5e6;           // bovengrens per gerenderde pagina
  const LARGE_FILE_MB = 150;             // boven deze grootte eerst waarschuwen

  const $ = (id) => document.getElementById(id);
  const els = {
    empty: $('empty'), framed: $('framed'), framedLink: $('framedLink'),
    body: document.body, fileInput: $('fileInput'), fileName: $('fileName'), docInfo: $('docInfo'),
    btnAdd: $('btnAdd'), btnRotL: $('btnRotL'), btnRotR: $('btnRotR'), btnDelete: $('btnDelete'),
    btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnClose: $('btnClose'), btnSave: $('btnSave'), btnSaveAs: $('btnSaveAs'),
    dropzone: $('dropzone'), btnPick: $('btnPick'), loadError: $('loadError'),
    sidebar: $('sidebar'), thumbs: $('thumbs'), appendZone: $('appendZone'), legendList: $('legendList'),
    viewer: $('viewer'), pages: $('pages'), pageIndicator: $('pageIndicator'),
    dropOverlay: $('dropOverlay'), dropTitle: $('dropTitle'), dropSub: $('dropSub'),
    busy: $('busy'), busyText: $('busyText'), toasts: $('toasts'),
    btnText: $('btnText'), btnSign: $('btnSign'), sigMenu: $('sigMenu'), sigList: $('sigList'),
    btnNewSig: $('btnNewSig'), btnAddDate: $('btnAddDate'),
    sigDialog: $('sigDialog'), sigPad: $('sigPad'), btnClearPad: $('btnClearPad'),
    sigTypeInput: $('sigTypeInput'), sigTypePreview: $('sigTypePreview'),
    sigImageInput: $('sigImageInput'), sigImagePreview: $('sigImagePreview'),
    sigRemember: $('sigRemember'), sigError: $('sigError'), btnSigCancel: $('btnSigCancel'), btnSigUse: $('btnSigUse'),
    pinRow: $('pinRow'), pinFields: $('pinFields'), sigUsePin: $('sigUsePin'), sigPin: $('sigPin'), sigPin2: $('sigPin2'),
    pinDialog: $('pinDialog'), pinInput: $('pinInput'), pinError: $('pinError'), btnPinOk: $('btnPinOk'), btnPinCancel: $('btnPinCancel'),
    btnLockSigs: $('btnLockSigs'),
  };

  // Beveiliging: niet werken binnen een frame van een andere website (tegen clickjacking).
  if (window.top !== window.self) {
    els.empty.hidden = true;
    els.framed.hidden = false;
    els.framedLink.href = location.href;
    return;
  }

  let pdfjsLib, PDFLib;
  try {
    [pdfjsLib, PDFLib] = await Promise.all([
      import(PDFJS_DIR + 'build/pdf.min.mjs'),
      import(PDFLIB_DIR + 'dist/pdf-lib.esm.min.js'),
    ]);
  } catch (err) {
    console.error(err);
    els.loadError.hidden = false;
    els.loadError.textContent = 'De onderdelen om PDF\'s te lezen konden niet worden geladen. Vernieuw de pagina.';
    els.btnPick.disabled = true;
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_DIR + 'build/pdf.worker.min.mjs';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = reduceMotion ? 'auto' : 'smooth';

  /* ---------------- Toestand ---------------- */
  const state = {
    files: new Map(),     // id -> { id, name, color, lib, pdf, pageCount }
    entries: [],          // pagina's in huidige volgorde
    selected: new Set(),  // entry-id's
    anchor: null,         // begin van shift-selectie
    focusId: null,        // laatst aangeklikte/actieve pagina
    current: null,        // pagina die in beeld is in de grote weergave
    sourceId: null,
    sourceHandle: null,   // verwijzing naar het bronbestand op schijf (alleen Edge/Chrome)
    undo: [], redo: [],
    dirty: false,
    saving: false,
    activeAnno: null,     // { e, it }: geselecteerde handtekening of tekstvak
  };
  let nextFileId = 1, nextEntryId = 1, nextAnnoId = 1;
  const byEl = new WeakMap();
  const byId = new Map();

  /* ---------------- Bestandstoegang (File System Access API, Edge/Chrome) ---------------- */
  const fileHandles = new WeakMap();   // File -> FileSystemFileHandle
  const PDF_TYPES = [{ description: 'PDF-document', accept: { 'application/pdf': ['.pdf'] } }];
  const fsAccess = (fn) => typeof window[fn] === 'function' && window.isSecureContext && window.self === window.top;
  // Komt de naam in het titelveld overeen met het bronbestand? Dan schrijft Bewaar terug naar het origineel.
  const savesToOriginal = () => !!state.sourceHandle &&
    sanitizeName(state.sourceHandle.name) === (sanitizeName(els.fileName.value) || 'Samengevoegd');

  async function openPicker() {
    if (!fsAccess('showOpenFilePicker')) { els.fileInput.click(); return; }
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: PDF_TYPES, id: 'pdf-samenvoegen' });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      els.fileInput.click();
      return;
    }
    addFiles(Promise.all(handles.map(async (h) => {
      try { const f = await h.getFile(); fileHandles.set(f, h); return f; } catch (_) { return null; }
    })).then((files) => files.filter(Boolean)));
  }

  /* ---------------- Hulpfuncties ---------------- */
  const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  const baseName = (n) => String(n || '').replace(/\.pdf$/i, '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pagesWord = (n) => plural(n, 'pagina', "pagina's");
  const indexOf = (e) => state.entries.indexOf(e);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const markDirty = () => { state.dirty = true; updateToolbar(); };

  function sanitizeName(s) {
    return String(s || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  function toast(message, type = 'info', action) {
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    if (type === 'error') t.setAttribute('role', 'alert');
    const span = document.createElement('span');
    span.textContent = message;
    t.append(span);
    let timer;
    const remove = () => { clearTimeout(timer); t.remove(); };
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { remove(); action.run(); });
      t.append(b);
    }
    els.toasts.append(t);
    while (els.toasts.children.length > 3) els.toasts.firstElementChild.remove();
    timer = setTimeout(remove, type === 'error' ? 9000 : 4500);
  }

  function setBusy(on, text) {
    if (text) els.busyText.textContent = text;
    els.busy.classList.toggle('show', !!on);
  }

  /* ---------------- Renderen (pdf.js) ---------------- */
  const renderQueue = [];
  let rendering = 0;
  const MAX_PARALLEL = 3;

  function schedule(e, kind) {
    renderQueue.push([e, kind]);
    pump();
  }
  function pump() {
    while (rendering < MAX_PARALLEL && renderQueue.length) {
      const [e, kind] = renderQueue.shift();
      if (!e.alive || !e.visible[kind] || e.busy[kind] || e.rendered[kind] === e.rotation) continue;
      rendering++;
      render(e, kind).finally(() => { rendering--; pump(); });
    }
  }

  async function render(e, kind) {
    if (!e.alive || !e.visible[kind] || e.busy[kind] || e.rendered[kind] === e.rotation || e.failed[kind] === e.rotation) return;
    e.busy[kind] = true;
    const rot = e.rotation;
    const holder = kind === 'thumb' ? e.thumbFrame : e.viewEl;
    try {
      const file = state.files.get(e.fileId);
      const page = await file.pdf.getPage(e.pageIndex + 1);
      // Corrigeer de verhouding als pdf.js een andere paginagrootte ziet.
      const own = page.getViewport({ scale: 1 });
      if (Math.abs(own.width - e.w) > 1 || Math.abs(own.height - e.h) > 1) {
        e.w = own.width; e.h = own.height; layoutEntry(e);
      }
      if (kind === 'view' && file.hasForm && !e.formLoaded) {
        e.formLoaded = true;
        loadFormFields(e, page);
      }
      const totalRot = (page.rotate + rot) % 360;
      const unit = page.getViewport({ scale: 1, rotation: totalRot });
      const cssW = holder.clientWidth || (kind === 'thumb' ? THUMB_W : 800);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let scale = (cssW * dpr) / unit.width;
      if (kind === 'view') scale = Math.min(scale, Math.sqrt(MAX_VIEW_PIXELS / (unit.width * unit.height)));
      const vp = page.getViewport({ scale, rotation: totalRot });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      // Grote weergave van formulieren: velden niet in het plaatje, ze worden er als invulvelden overheen gelegd.
      const annotationMode = kind === 'view' && file.hasForm
        ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE;
      await page.render({ canvas, viewport: vp, annotationMode }).promise;
      if (e.alive && rot === e.rotation && e.visible[kind]) {
        const old = holder.querySelector('canvas');
        if (old) { old.width = 0; old.height = 0; old.remove(); }
        holder.append(canvas);
        e.rendered[kind] = rot;
      } else {
        canvas.width = 0; canvas.height = 0;
      }
    } catch (err) {
      e.failed[kind] = rot;
      if (e.alive) console.warn('Renderen mislukt', err);
    } finally {
      e.busy[kind] = false;
    }
    if (e.alive && e.visible[kind] && e.rendered[kind] !== e.rotation) schedule(e, kind);
  }

  function unload(e, kind) {
    const holder = kind === 'thumb' ? e.thumbFrame : e.viewEl;
    const c = holder.querySelector('canvas');
    if (c) { c.width = 0; c.height = 0; c.remove(); }
    e.rendered[kind] = null;
  }

  function makeObserver(kind, root, margin) {
    return new IntersectionObserver((items) => {
      for (const it of items) {
        const e = byEl.get(it.target);
        if (!e) continue;
        e.visible[kind] = it.isIntersecting;
        if (it.isIntersecting) schedule(e, kind);
        else unload(e, kind);
      }
    }, { root, rootMargin: margin });
  }
  const thumbObs = makeObserver('thumb', els.sidebar, '500px 0px');
  const viewObs = makeObserver('view', els.viewer, '1400px 0px');

  // Bij een flink andere vensterbreedte de grote pagina's scherp opnieuw renderen.
  let lastViewerWidth = 0, resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = els.viewer.clientWidth;
      if (!w) return;
      if (lastViewerWidth && Math.abs(w - lastViewerWidth) / lastViewerWidth > 0.2) {
        for (const e of state.entries) {
          if (e.visible.view && e.rendered.view !== null) { e.rendered.view = null; schedule(e, 'view'); }
        }
      }
      lastViewerWidth = w;
    }, 250);
  }).observe(els.viewer);

  /* ---------------- Pagina's ---------------- */
  function pageDims(p) {
    let box;
    try { box = p.getCropBox(); } catch (_) { box = p.getSize(); }
    let w = Math.abs(box.width) || 612, h = Math.abs(box.height) || 792;
    const r = (((p.getRotation().angle || 0) % 360) + 360) % 360;
    if (r === 90 || r === 270) [w, h] = [h, w];
    return { w, h };
  }

  function createEntry(file, pageIndex, dims) {
    const e = {
      id: nextEntryId++, fileId: file.id, pageIndex, w: dims.w, h: dims.h, rotation: 0, alive: true,
      rendered: { thumb: null, view: null }, busy: { thumb: false, view: false },
      visible: { thumb: false, view: false }, failed: { thumb: null, view: null },
    };
    const t = document.createElement('div');
    t.className = 'thumb';
    t.id = 'thumb-' + e.id;
    t.setAttribute('role', 'option');
    t.draggable = true;
    t.title = `${file.name} — pagina ${pageIndex + 1}`;
    const frame = document.createElement('div');
    frame.className = 'thumb-frame';
    const label = document.createElement('div');
    label.className = 'thumb-label';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = file.color;
    const num = document.createElement('span');
    num.className = 'num';
    label.append(dot, num);
    t.append(frame, label);

    const v = document.createElement('div');
    v.className = 'page';

    e.thumbEl = t; e.thumbFrame = frame; e.numEl = num; e.viewEl = v;
    // Lagen voor formuliervelden en voor handtekeningen/tekstvakken (boven het paginaplaatje).
    e.annos = []; e.annoEls = new Map(); e.formFields = null; e.fieldEls = []; e.formLoaded = false;
    e.formLayer = makeLayer('form-layer');
    e.annoLayer = makeLayer('anno-layer');
    e.thumbAnnoLayer = makeLayer('anno-layer');
    v.append(e.formLayer, e.annoLayer);
    frame.append(e.thumbAnnoLayer);
    byEl.set(t, e); byEl.set(v, e); byId.set(e.id, e);
    layoutEntry(e);
    thumbObs.observe(t);
    viewObs.observe(v);
    return e;
  }

  function layoutEntry(e) {
    const swap = e.rotation % 180 !== 0;
    const w = swap ? e.h : e.w, h = swap ? e.w : e.h;
    const s = Math.min(THUMB_W / w, THUMB_H / h);
    e.thumbFrame.style.width = Math.round(w * s) + 'px';
    e.thumbFrame.style.height = Math.round(h * s) + 'px';
    e.viewEl.style.width = `min(100%, ${Math.round(w * VIEW_SCALE)}px)`;
    e.viewEl.style.aspectRatio = `${w} / ${h}`;
    // px per PDF-punt: paginabreedte (100cqw) gedeeld door de breedte in punten.
    const pt = `calc(100cqw / ${Math.round(w * 1000) / 1000})`;
    for (const layer of [e.formLayer, e.annoLayer, e.thumbAnnoLayer]) layer.style.setProperty('--pt', pt);
    repositionAnnos(e);
    positionFields(e);
  }

  /* ================= Ondertekenen, tekstvakken en formulieren ================= */
  // Elke pagina heeft een "basisruimte": de pagina zoals pdf.js hem zonder extra draaiing toont, in PDF-punten,
  // met (0,0) linksboven. Handtekeningen, tekstvakken en formuliervelden worden daarin bewaard, zodat ze
  // netjes meedraaien als je de pagina draait. `rot` is de draaiing van de inhoud zelf in die basisruimte.
  const INK_BLACK = '#000000', INK_BLUE = '#1a3fa6';
  const TEXT_LINE = 1.2, TEXT_BASELINE = 0.94;   // regelhoogte en basislijn (in em), gelijk aan de CSS

  const viewDims = (e) => (e.rotation % 180 ? [e.h, e.w] : [e.w, e.h]);
  const contentDims = (it) => (it.rot % 180 ? [it.h, it.w] : [it.w, it.h]);
  const ptPx = (e) => (e.viewEl.clientWidth || 1) / viewDims(e)[0];
  const ptExpr = (n) => `calc(var(--pt) * ${Math.round(n * 100) / 100})`;

  function makeLayer(cls) {
    const d = document.createElement('div');
    d.className = 'layer ' + cls;
    return d;
  }
  // basisruimte -> huidige (gedraaide) weergave, en terug
  function b2v(e, x, y) {
    switch (e.rotation) {
      case 90: return [e.h - y, x];
      case 180: return [e.w - x, e.h - y];
      case 270: return [y, e.w - x];
      default: return [x, y];
    }
  }
  function v2b(e, x, y) {
    switch (e.rotation) {
      case 90: return [y, e.h - x];
      case 180: return [e.w - x, e.h - y];
      case 270: return [e.w - y, x];
      default: return [x, y];
    }
  }
  function mapRect(fn, e, r) {
    const [x1, y1] = fn(e, r.x, r.y), [x2, y2] = fn(e, r.x + r.w, r.y + r.h);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  // Zet een vak (basisruimte) op de juiste plek in de weergave; de inhoud draait mee.
  function placeBox(e, boxEl, rect, rot, inner, sizeInner) {
    const r = mapRect(b2v, e, rect);
    boxEl.style.left = ptExpr(r.x);
    boxEl.style.top = ptExpr(r.y);
    boxEl.style.width = ptExpr(r.w);
    boxEl.style.height = ptExpr(r.h);
    if (!inner) return;
    inner.style.transform = `translate(-50%, -50%) rotate(${(rot + e.rotation) % 360}deg)`;
    if (sizeInner) {
      const [cw, ch] = rot % 180 ? [rect.h, rect.w] : [rect.w, rect.h];
      inner.style.width = ptExpr(cw);
      inner.style.height = ptExpr(ch);
    }
  }

  /* ---------- Handtekeningen en tekstvakken op de pagina ---------- */
  function toolBtn(label, title, action, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'anno-tool' + (extraClass ? ' ' + extraClass : '');
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.action = action;
    return b;
  }

  function buildAnnoEl(e, it, interactive) {
    const box = document.createElement('div');
    box.className = `anno anno-${it.type}`;
    let inner;
    if (it.type === 'sig') {
      inner = document.createElement('img');
      inner.src = it.src;
      inner.alt = 'Handtekening';
      inner.draggable = false;
    } else {
      inner = document.createElement('div');
      inner.textContent = it.text;
      inner.style.fontSize = ptExpr(it.size);
      inner.style.color = it.color;
    }
    inner.className = 'anno-inner';
    box.append(inner);
    if (interactive) {
      box.dataset.id = String(it.id);
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', it.type === 'sig' ? 'Handtekening' : `Tekstvak: ${it.text}`);
      const tools = document.createElement('div');
      tools.className = 'anno-tools';
      if (it.type === 'text') {
        tools.append(
          toolBtn('A−', 'Kleinere letters', 'smaller'),
          toolBtn('A+', 'Grotere letters', 'bigger'),
          toolBtn('●', 'Andere kleur (zwart/blauw)', 'color', it.color === INK_BLUE ? '' : 'swatch-blue'),
          toolBtn('Bewerk', 'Tekst bewerken', 'edit'),
        );
      }
      tools.append(toolBtn('✕', 'Verwijderen', 'delete'));
      box.append(tools);
      if (it.type === 'sig') {
        const h = document.createElement('div');
        h.className = 'anno-handle';
        h.title = 'Sleep om groter of kleiner te maken';
        box.append(h);
      }
    }
    placeBox(e, box, it, it.rot, inner, it.type === 'sig');
    return { box, inner };
  }

  function refreshThumbAnnos(e) {
    e.thumbAnnoLayer.replaceChildren(...e.annos.map((it) => buildAnnoEl(e, it, false).box));
  }

  function renderAnnos(e) {
    if (editing) finishEditing();   // eerst de getypte tekst vastleggen, anders gaat die verloren
    e.annoEls = new Map();
    const boxes = [];
    for (const it of e.annos) {
      const v = buildAnnoEl(e, it, true);
      if (state.activeAnno && state.activeAnno.it === it) v.box.classList.add('active');
      e.annoEls.set(it.id, v);
      boxes.push(v.box);
    }
    e.annoLayer.replaceChildren(...boxes);
    refreshThumbAnnos(e);
  }

  function repositionAnnos(e) {
    if (!e.annoEls) return;
    for (const it of e.annos) {
      const v = e.annoEls.get(it.id);
      if (v) placeBox(e, v.box, it, it.rot, v.inner, it.type === 'sig');
    }
    refreshThumbAnnos(e);
  }

  // Meet een tekstvak na (de breedte volgt de tekst) en pas het vak aan.
  function measureText(e, it) {
    const v = e.annoEls.get(it.id);
    if (!v) return;
    const px = ptPx(e);
    const cw = Math.max(v.inner.offsetWidth / px, it.size * 0.5);
    const ch = Math.max(v.inner.offsetHeight / px, it.size * TEXT_LINE);
    [it.w, it.h] = it.rot % 180 ? [ch, cw] : [cw, ch];
    placeBox(e, v.box, it, it.rot, v.inner, false);
  }

  function setActiveAnno(e, it) {
    const prev = state.activeAnno;
    if (prev && prev.it !== it) {
      if (editing && editing.it === prev.it) finishEditing();
      const pv = prev.e.annoEls.get(prev.it.id);
      if (pv) pv.box.classList.remove('active');
    }
    state.activeAnno = it ? { e, it } : null;
    if (it) {
      const v = e.annoEls.get(it.id);
      if (v) v.box.classList.add('active');
    }
  }

  function removeAnno(e, it, withUndo = true) {
    if (withUndo) pushUndo(snapshot());
    if (editing && editing.it === it) editing = null;
    if (state.activeAnno && state.activeAnno.it === it) state.activeAnno = null;
    e.annos = e.annos.filter((x) => x !== it);
    renderAnnos(e);
    markDirty();
  }

  // De pagina waarop een nieuw item komt: de pagina die nu in beeld is.
  function placementTarget() {
    if (!els.viewer.clientHeight) {
      toast('Maak het venster breder om te ondertekenen of tekst toe te voegen.', 'error');
      return null;
    }
    updateCurrent();
    return state.current || state.entries[0] || null;
  }

  function visibleCenter(e) {
    const pr = e.viewEl.getBoundingClientRect(), vr = els.viewer.getBoundingClientRect();
    const px = pr.width / viewDims(e)[0];
    const top = Math.max(pr.top, vr.top), bottom = Math.min(pr.bottom, vr.bottom);
    const cy = top < bottom ? (top + bottom) / 2 : pr.top + pr.height / 2;
    return [pr.width / 2 / px, (cy - pr.top) / px];
  }

  // Voeg een item toe, rechtop en gecentreerd in het zichtbare deel van de pagina. cw/ch in punten.
  function addAnno(e, it, cw, ch) {
    finishEditing();
    const [Wv, Hv] = viewDims(e);
    const [cx, cy] = visibleCenter(e);
    const w = Math.min(cw, Wv), h = Math.min(ch, Hv);
    const vr = { x: clamp(cx - w / 2, 0, Wv - w), y: clamp(cy - h / 2, 0, Hv - h), w, h };
    it.id = nextAnnoId++;
    it.rot = (360 - e.rotation) % 360;
    Object.assign(it, mapRect(v2b, e, vr));
    pushUndo(snapshot());
    e.annos.push(it);
    renderAnnos(e);
    setActiveAnno(e, it);
    markDirty();
    return it;
  }

  function addTextAnno(text) {
    const e = placementTarget();
    if (!e) return;
    const it = addAnno(e, { type: 'text', text, size: 12, color: INK_BLACK }, Math.max(40, text.length * 6.5), 12 * TEXT_LINE);
    measureText(e, it);
    refreshThumbAnnos(e);
    if (!text) startEditing(e, it, true);
  }

  function placeSignature(sig) {
    const e = placementTarget();
    if (!e) return;
    const [Wv] = viewDims(e);
    const aspect = sig.w / sig.h || 3;
    let cw = Math.min(170, Wv * 0.45), ch = cw / aspect;
    if (ch > 80) { ch = 80; cw = ch * aspect; }
    addAnno(e, { type: 'sig', src: sig.src }, cw, ch);
    toast('Sleep de handtekening naar de juiste plek. Met het bolletje rechtsonder maak je hem groter of kleiner.');
  }

  /* Tekst bewerken */
  let editing = null;   // { e, it, before }
  function startEditing(e, it, isNew) {
    const v = e.annoEls.get(it.id);
    if (!v || it.type !== 'text') return;
    setActiveAnno(e, it);
    editing = { e, it, before: isNew ? null : snapshot() };
    v.box.classList.add('editing');
    v.inner.contentEditable = 'plaintext-only';
    if (v.inner.contentEditable !== 'plaintext-only') v.inner.contentEditable = 'true';
    v.inner.dataset.placeholder = 'Typ hier…';
    v.inner.classList.toggle('empty', !it.text);
    v.inner.focus();
    const range = document.createRange();
    range.selectNodeContents(v.inner);
    if (!isNew) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function finishEditing() {
    if (!editing) return;
    const { e, it, before } = editing;
    editing = null;
    const v = e.annoEls.get(it.id);
    const text = v ? v.inner.innerText.replace(/\r/g, '').replace(/\t/g, '    ').replace(/\n+$/, '') : it.text;
    if (v) {
      v.inner.contentEditable = 'false';
      v.inner.classList.remove('empty');
      v.box.classList.remove('editing');
    }
    if (!text.trim()) { removeAnno(e, it, !!before); return; }
    if (text !== it.text) {
      if (before) pushUndo(before);
      it.text = text;
      markDirty();
    }
    if (v) {
      v.inner.textContent = it.text;
      v.box.setAttribute('aria-label', `Tekstvak: ${it.text}`);
      measureText(e, it);
    }
    refreshThumbAnnos(e);
  }

  function annoTool(action, e, it) {
    if (action === 'delete') { removeAnno(e, it); return; }
    if (action === 'edit') { startEditing(e, it, false); return; }
    pushUndo(snapshot());
    const v = e.annoEls.get(it.id);
    if (action === 'smaller' || action === 'bigger') {
      it.size = clamp(Math.round(it.size * (action === 'bigger' ? 1.15 : 1 / 1.15) * 2) / 2, 6, 96);
      v.inner.style.fontSize = ptExpr(it.size);
      measureText(e, it);
    } else if (action === 'color') {
      it.color = it.color === INK_BLUE ? INK_BLACK : INK_BLUE;
      v.inner.style.color = it.color;
      v.box.querySelector('[data-action="color"]').classList.toggle('swatch-blue', it.color !== INK_BLUE);
    }
    refreshThumbAnnos(e);
    markDirty();
  }

  function nudgeAnno(e, it, dx, dy) {
    const [Wv, Hv] = viewDims(e);
    const vr = mapRect(b2v, e, it);
    pushUndo(snapshot());
    vr.x = clamp(vr.x + dx, 0, Wv - vr.w);
    vr.y = clamp(vr.y + dy, 0, Hv - vr.h);
    Object.assign(it, mapRect(v2b, e, vr));
    const v = e.annoEls.get(it.id);
    if (v) placeBox(e, v.box, it, it.rot, v.inner, it.type === 'sig');
    refreshThumbAnnos(e);
    markDirty();
  }

  const annoFromEl = (el) => {
    const boxEl = el && el.closest && el.closest('.anno');
    const pageEl = boxEl && boxEl.closest('.page');
    const e = pageEl && byEl.get(pageEl);
    const it = e && e.annos.find((x) => String(x.id) === boxEl.dataset.id);
    return it ? { e, it, boxEl } : null;
  };

  /* Slepen en schalen */
  let annoDrag = null;
  els.pages.addEventListener('pointerdown', (ev) => {
    const hit = annoFromEl(ev.target);
    if (!hit) return;
    const { e, it, boxEl } = hit;
    if (ev.target.closest('.anno-tools')) { ev.preventDefault(); return; }   // knoppen: focus houden, actie bij klik
    const onHandle = !!ev.target.closest('.anno-handle');
    if (editing && editing.it === it && !onHandle) return;                   // tijdens bewerken: cursor plaatsen
    if (ev.button !== 0) return;
    ev.preventDefault();
    const wasActive = !!state.activeAnno && state.activeAnno.it === it;
    setActiveAnno(e, it);
    annoDrag = {
      e, it, wasActive, resize: onHandle, pointerId: ev.pointerId,
      startX: ev.clientX, startY: ev.clientY, origV: mapRect(b2v, e, it), px: ptPx(e), moved: false,
    };
    try { boxEl.setPointerCapture(ev.pointerId); } catch (_) { /* geen actieve aanwijzer: slepen werkt dan via bubbling */ }
  });
  els.pages.addEventListener('pointermove', (ev) => {
    const d = annoDrag;
    if (!d || ev.pointerId !== d.pointerId) return;
    const dxp = ev.clientX - d.startX, dyp = ev.clientY - d.startY;
    if (!d.moved && Math.hypot(dxp, dyp) < 3) return;
    if (!d.moved) { d.moved = true; pushUndo(snapshot()); }
    const { e, it } = d;
    const [Wv, Hv] = viewDims(e);
    const dx = dxp / d.px, dy = dyp / d.px;
    let vr;
    if (d.resize) {
      const ratio = d.origV.h / d.origV.w;
      const w = Math.min(Math.max(24, d.origV.w + dx), Wv - d.origV.x, (Hv - d.origV.y) / ratio);
      vr = { x: d.origV.x, y: d.origV.y, w, h: w * ratio };
    } else {
      vr = {
        x: clamp(d.origV.x + dx, 0, Wv - d.origV.w), y: clamp(d.origV.y + dy, 0, Hv - d.origV.h),
        w: d.origV.w, h: d.origV.h,
      };
    }
    Object.assign(it, mapRect(v2b, e, vr));
    const v = e.annoEls.get(it.id);
    if (v) placeBox(e, v.box, it, it.rot, v.inner, it.type === 'sig');
  });
  function endAnnoDrag(ev) {
    const d = annoDrag;
    if (!d || ev.pointerId !== d.pointerId) return;
    annoDrag = null;
    if (d.moved) { refreshThumbAnnos(d.e); markDirty(); }
    else if (ev.type === 'pointerup' && d.it.type === 'text' && d.wasActive) startEditing(d.e, d.it, false);
  }
  els.pages.addEventListener('pointerup', endAnnoDrag);
  els.pages.addEventListener('pointercancel', endAnnoDrag);
  els.pages.addEventListener('dblclick', (ev) => {
    const hit = annoFromEl(ev.target);
    if (hit && hit.it.type === 'text' && !editing) startEditing(hit.e, hit.it, false);
  });
  els.pages.addEventListener('input', (ev) => {
    if (!editing || !ev.target.classList || !ev.target.classList.contains('anno-inner')) return;
    ev.target.classList.toggle('empty', !ev.target.textContent);
    measureText(editing.e, editing.it);
  });
  els.pages.addEventListener('focusout', (ev) => {
    if (!editing) return;
    const v = editing.e.annoEls.get(editing.it.id);
    if (v && ev.target === v.inner && !(ev.relatedTarget && v.box.contains(ev.relatedTarget))) finishEditing();
  });
  // Plakken in een tekstvak altijd als platte tekst: geen opmaak, afbeeldingen of links.
  els.pages.addEventListener('paste', (ev) => {
    const inner = editing && ev.target.closest && ev.target.closest('.anno-inner');
    if (!inner) return;
    ev.preventDefault();
    const text = ((ev.clipboardData && ev.clipboardData.getData('text/plain')) || '')
      .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    const sel = window.getSelection();
    if (!text || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    inner.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Iets anders dan bestanden in een tekstvak slepen: niet toestaan (zou opmaak kunnen meenemen).
  els.pages.addEventListener('drop', (ev) => {
    if (editing && ev.target.closest && ev.target.closest('.anno-inner') && !hasFiles(ev)) ev.preventDefault();
  });

  /* ---------- Formuliervelden ---------- */
  async function loadFormFields(e, page) {
    let annots;
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch (err) { console.warn(err); return; }
    if (!e.alive && !state.entries.includes(e)) return;
    const vp = page.getViewport({ scale: 1 });   // basisruimte
    const fields = [];
    for (const a of annots) {
      if (a.annotationType !== pdfjsLib.AnnotationType.WIDGET || !a.fieldName || a.hidden) continue;
      if (a.fieldType === 'Sig' || a.pushButton) continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      if (box.w < 3 || box.h < 3) continue;
      fields.push({ a, box });
    }
    e.formFields = fields;
    renderFormFields(e);
  }

  function renderFormFields(e) {
    const rec = state.files.get(e.fileId);
    e.fieldEls = [];
    const boxes = [];
    for (const f of e.formFields || []) {
      const ctl = makeFieldControl(rec, f);
      if (!ctl) continue;
      const box = document.createElement('div');
      box.className = 'field';
      box.append(ctl);
      placeBox(e, box, f.box, 0, ctl, true);
      e.fieldEls.push({ box, ctl, f });
      boxes.push(box);
    }
    e.formLayer.replaceChildren(...boxes);
  }

  function positionFields(e) {
    for (const x of e.fieldEls || []) placeBox(e, x.box, x.f.box, 0, x.ctl, true);
  }

  function makeFieldControl(rec, f) {
    const a = f.a, name = a.fieldName;
    const cur = rec.formValues.has(name) ? rec.formValues.get(name) : a.fieldValue;
    const da = a.defaultAppearanceData && a.defaultAppearanceData.fontSize;
    const fontSize = da > 0 ? da : clamp(f.box.h * 0.62, 6, 12);
    let el;
    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      if (!a.multiLine) el.type = 'text';
      el.value = typeof cur === 'string' ? cur : '';
      if (a.maxLen > 0) el.maxLength = a.maxLen;
      el.style.fontSize = ptExpr(fontSize);
      el.style.textAlign = ['left', 'center', 'right'][a.textAlignment] || 'left';
      el.addEventListener('input', () => setFieldValue(rec, name, el.value, el));
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.dataset.on = a.exportValue;
      el.checked = cur === a.exportValue;
      el.addEventListener('change', () => setFieldValue(rec, name, el.checked ? a.exportValue : 'Off', el));
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      el = document.createElement('input');
      el.type = 'radio';
      el.name = `veld-${rec.id}-${name}`;
      el.value = a.buttonValue;
      el.checked = cur === a.buttonValue;
      el.addEventListener('change', () => { if (el.checked) setFieldValue(rec, name, a.buttonValue, el); });
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      const vals = Array.isArray(cur) ? cur : (cur != null ? [cur] : []);
      if (a.combo) el.append(new Option('', ''));
      for (const o of a.options || []) {
        const opt = new Option(o.displayValue, o.displayValue);
        opt.selected = vals.includes(o.exportValue) || vals.includes(o.displayValue);
        el.append(opt);
      }
      el.style.fontSize = ptExpr(fontSize);
      el.addEventListener('change', () => setFieldValue(rec, name, el.value, el));
    } else {
      return null;
    }
    el.classList.add('field-ctl');
    el.disabled = !!a.readOnly;
    el.setAttribute('aria-label', a.alternativeText || name);
    if (a.alternativeText) el.title = a.alternativeText;
    if (!rec.formInputs.has(name)) rec.formInputs.set(name, new Set());
    rec.formInputs.get(name).add(el);
    return el;
  }

  // Hetzelfde veld kan op meer plekken staan: houd ze gelijk.
  function setFieldValue(rec, name, value, src) {
    rec.formValues.set(name, value);
    for (const other of rec.formInputs.get(name) || []) {
      if (other === src || !other.isConnected) continue;
      if (other.type === 'checkbox') other.checked = value === other.dataset.on;
      else if (other.type === 'radio') other.checked = other.value === value;
      else other.value = value;
    }
    markDirty();
  }

  /* ---------- Handtekeningen maken en lokaal bewaren ---------- */
  // Bewaard in localStorage van deze website, dus alleen in deze browser op dit apparaat.
  // Met een pincode of wachtwoord wordt de handtekening versleuteld bewaard:
  // AES-GCM 256 bit, met een sleutel afgeleid via PBKDF2-SHA256 (600.000 rondes, eigen salt per handtekening).
  const SIG_KEY = 'pdf-samenvoegen:handtekeningen';
  const MAX_SIGS = 8;
  const PIN_MIN = 6;
  const PBKDF2_ITER = 600000;
  const PNG_PREFIX = 'data:image/png;base64,';
  const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  const sessionSigs = [];       // gebruikt maar niet bewaard
  const unlocked = new Map();   // id -> ontsleutelde afbeelding; alleen in het geheugen, tot het tabblad sluit
  const canEncrypt = () => !!(window.isSecureContext && window.crypto && window.crypto.subtle);

  // Strenge controle van alles wat uit de opslag komt (die kan door iets anders zijn aangepast).
  const validDim = (n) => Number.isInteger(n) && n > 0 && n <= 4000;
  const isB64 = (s, maxLen) => typeof s === 'string' && s.length > 0 && s.length <= maxLen && s.length % 4 === 0 && B64_RE.test(s);
  // Alleen echte PNG-afbeeldingen ('iVBORw0KGgo' = de vaste PNG-kop) van redelijke grootte.
  const isPngDataUrl = (s) => typeof s === 'string' && s.startsWith(PNG_PREFIX + 'iVBORw0KGgo') && isB64(s.slice(PNG_PREFIX.length), 3e6);

  function validStoredSig(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[a-z0-9]{4,40}$/i.test(s.id)) return false;
    if (!validDim(s.w) || !validDim(s.h)) return false;
    if (s.enc) {
      const e = s.enc;
      return !('src' in s) && e.v === 1 && Number.isInteger(e.iter) && e.iter >= 100000 && e.iter <= 5000000
        && isB64(e.salt, 24) && e.salt.length === 24 && isB64(e.iv, 16) && e.iv.length === 16 && isB64(e.data, 4.2e6);
    }
    return isPngDataUrl(s.src);
  }

  function loadSigs() {
    try {
      const list = JSON.parse(localStorage.getItem(SIG_KEY) || '[]');
      return Array.isArray(list) ? list.filter(validStoredSig).slice(0, MAX_SIGS) : [];
    } catch (_) {
      return [];
    }
  }
  function storeSigs(list) {
    try { localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, MAX_SIGS))); return true; } catch (_) { return false; }
  }

  /* Versleuteling (Web Crypto, ingebouwd in de browser) */
  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const utf8 = (s) => new TextEncoder().encode(s);

  async function deriveKey(pin, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', utf8(pin.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }
  async function encryptSig(sig, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt, PBKDF2_ITER);
    // Het id wordt meegewogen, zodat versleutelde gegevens niet tussen handtekeningen kunnen worden verwisseld.
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(sig.id) }, key, utf8(sig.src)));
    return { id: sig.id, w: sig.w, h: sig.h, enc: { v: 1, iter: PBKDF2_ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(data) } };
  }
  // Geeft de afbeelding terug, of null bij een verkeerde code of aangepaste gegevens.
  async function decryptSig(stored, pin) {
    try {
      const e = stored.enc;
      const key = await deriveKey(pin, fromB64(e.salt), e.iter);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(e.iv), additionalData: utf8(stored.id) }, key, fromB64(e.data));
      const src = new TextDecoder().decode(plain);
      return isPngDataUrl(src) ? src : null;
    } catch (_) {
      return null;
    }
  }

  // Laatste controle voor gebruik: is het echt een leesbare afbeelding met de opgegeven afmetingen?
  async function verifySigImage(sig) {
    if (!isPngDataUrl(sig.src)) return false;
    const img = new Image();
    img.src = sig.src;
    try { await img.decode(); } catch (_) { return false; }
    return img.naturalWidth === sig.w && img.naturalHeight === sig.h;
  }
  async function useSignature(sig) {
    if (!(await verifySigImage(sig))) {
      toast('Deze bewaarde handtekening is beschadigd of aangepast en wordt niet gebruikt. Verwijder hem en maak een nieuwe.', 'error');
      return;
    }
    placeSignature(sig);
  }

  function renderSigList() {
    const rows = [
      ...sessionSigs.map((sig) => ({ sig, saved: false, locked: false, secured: false })),
      ...loadSigs().map((s) => {
        if (!s.enc) return { sig: s, saved: true, locked: false, secured: false };
        if (unlocked.has(s.id)) return { sig: { id: s.id, w: s.w, h: s.h, src: unlocked.get(s.id) }, saved: true, locked: false, secured: true };
        return { sig: s, saved: true, locked: true, secured: true };
      }),
    ];
    els.btnLockSigs.hidden = unlocked.size === 0;
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'menu-empty';
      p.textContent = 'Nog geen handtekening.';
      els.sigList.replaceChildren(p);
      return;
    }
    els.sigList.replaceChildren(...rows.map(({ sig, saved, locked, secured }) => {
      const row = document.createElement('div');
      row.className = 'sig-item';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'sig-use';
      use.setAttribute('role', 'menuitem');
      if (locked) {
        use.classList.add('sig-locked');
        const t = document.createElement('span');
        t.textContent = '🔒 Beveiligde handtekening';
        const sub = document.createElement('small');
        sub.textContent = 'Klik en voer je code in';
        use.append(t, sub);
        use.setAttribute('aria-label', 'Beveiligde handtekening ontgrendelen en plaatsen');
        use.addEventListener('click', () => { closeSigMenu(); openPinDialog(sig); });
      } else {
        const img = document.createElement('img');
        img.src = sig.src;
        img.alt = '';
        use.append(img);
        use.setAttribute('aria-label', 'Plaats deze handtekening');
        if (secured) use.title = 'Beveiligd; ontgrendeld tot je dit tabblad sluit';
        use.addEventListener('click', () => { closeSigMenu(); useSignature(sig); });
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sig-del';
      del.textContent = '✕';
      del.title = saved ? 'Verwijder van dit apparaat' : 'Verwijder';
      del.setAttribute('aria-label', del.title);
      del.addEventListener('click', () => {
        if (saved) {
          if (!confirm('Deze handtekening van dit apparaat verwijderen?')) return;
          storeSigs(loadSigs().filter((s) => s.id !== sig.id));
          unlocked.delete(sig.id);
        } else {
          sessionSigs.splice(sessionSigs.indexOf(sig), 1);
        }
        renderSigList();
      });
      row.append(use, del);
      return row;
    }));
  }

  /* Pincode invoeren om een beveiligde handtekening te gebruiken */
  let pinTarget = null, pinFails = 0;
  function openPinDialog(stored) {
    if (!canEncrypt()) {
      toast('Beveiligde handtekeningen kunnen alleen via een beveiligde (https) verbinding worden geopend.', 'error');
      return;
    }
    pinTarget = stored;
    els.pinInput.value = '';
    els.pinError.hidden = true;
    els.pinDialog.showModal();
    els.pinInput.focus();
  }
  async function submitPin() {
    if (!pinTarget || els.btnPinOk.classList.contains('busy') || !els.pinInput.value) return;
    const pin = els.pinInput.value;
    const target = pinTarget;
    els.btnPinOk.classList.add('busy');
    els.btnPinOk.textContent = 'Controleren…';
    const src = await decryptSig(target, pin);
    if (!src) {
      // Na elke verkeerde poging iets langer wachten (tegen raden).
      pinFails++;
      const secs = Math.min(pinFails, 10);
      els.pinError.textContent = `Onjuiste code. Je kunt het over ${secs} ${secs === 1 ? 'seconde' : 'seconden'} opnieuw proberen.`;
      els.pinError.hidden = false;
      els.pinInput.select();
      setTimeout(() => { els.btnPinOk.classList.remove('busy'); els.btnPinOk.textContent = 'Ontgrendel'; }, secs * 1000);
      return;
    }
    pinFails = 0;
    unlocked.set(target.id, src);
    els.btnPinOk.classList.remove('busy');
    els.btnPinOk.textContent = 'Ontgrendel';
    els.pinInput.value = '';
    els.pinDialog.close();
    useSignature({ id: target.id, w: target.w, h: target.h, src });
    // Gemak: dezelfde code ook proberen op andere beveiligde handtekeningen.
    for (const s of loadSigs()) {
      if (s.enc && !unlocked.has(s.id)) {
        const other = await decryptSig(s, pin);
        if (other) unlocked.set(s.id, other);
      }
    }
  }
  els.btnPinOk.addEventListener('click', submitPin);
  els.btnPinCancel.addEventListener('click', () => els.pinDialog.close());
  els.pinDialog.addEventListener('close', () => { pinTarget = null; els.pinInput.value = ''; });
  els.pinInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submitPin(); }
  });
  els.btnLockSigs.addEventListener('click', () => {
    unlocked.clear();
    closeSigMenu();
    toast('Beveiligde handtekeningen zijn weer vergrendeld.');
  });

  function openSigMenu() {
    renderSigList();
    els.sigMenu.hidden = false;
    els.btnSign.setAttribute('aria-expanded', 'true');
    const r = els.btnSign.getBoundingClientRect();
    const mw = els.sigMenu.offsetWidth;
    els.sigMenu.style.top = `${r.bottom + 6}px`;
    els.sigMenu.style.left = `${clamp(r.right - mw, 8, window.innerWidth - mw - 8)}px`;
    const first = els.sigMenu.querySelector('.sig-use, .menu-item');
    if (first) first.focus();
  }
  function closeSigMenu() {
    if (els.sigMenu.hidden) return;
    els.sigMenu.hidden = true;
    els.btnSign.setAttribute('aria-expanded', 'false');
  }
  els.btnSign.addEventListener('click', () => {
    if (!els.sigMenu.hidden) { closeSigMenu(); return; }
    if (!placementTarget()) return;
    if (!loadSigs().length && !sessionSigs.length) openSigDialog();
    else openSigMenu();
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!els.sigMenu.hidden && !els.sigMenu.contains(ev.target) && !els.btnSign.contains(ev.target)) closeSigMenu();
  });
  els.btnNewSig.addEventListener('click', () => { closeSigMenu(); openSigDialog(); });
  els.btnAddDate.addEventListener('click', () => { closeSigMenu(); addTextAnno(new Date().toLocaleDateString('nl-NL')); });
  els.btnText.addEventListener('click', () => addTextAnno(''));

  /* Dialoog: tekenen, typen of afbeelding */
  const pad = { ctx: null, drawing: false, last: null, hasInk: false, ink: '#111111', dpr: 1 };
  let sigTab = 'draw', sigImageCanvas = null;

  function setupPad() {
    const c = els.sigPad;
    pad.dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(c.clientWidth * pad.dpr);
    c.height = Math.round(c.clientHeight * pad.dpr);
    pad.ctx = c.getContext('2d');
    pad.ctx.lineCap = 'round';
    pad.ctx.lineJoin = 'round';
    pad.hasInk = false;
  }
  function padPoint(ev) {
    const r = els.sigPad.getBoundingClientRect();
    return [(ev.clientX - r.left) * pad.dpr, (ev.clientY - r.top) * pad.dpr];
  }
  els.sigPad.addEventListener('pointerdown', (ev) => {
    if (!pad.ctx) setupPad();
    ev.preventDefault();
    try { els.sigPad.setPointerCapture(ev.pointerId); } catch (_) { /* negeer */ }
    pad.drawing = true;
    pad.last = padPoint(ev);
    pad.ctx.strokeStyle = pad.ink;
    pad.ctx.fillStyle = pad.ink;
    pad.ctx.beginPath();
    pad.ctx.arc(pad.last[0], pad.last[1], 1.4 * pad.dpr, 0, Math.PI * 2);
    pad.ctx.fill();
    pad.hasInk = true;
  });
  els.sigPad.addEventListener('pointermove', (ev) => {
    if (!pad.drawing) return;
    const events = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [ev];
    for (const pe of events.length ? events : [ev]) {
      const p = padPoint(pe);
      const pressure = pe.pointerType === 'pen' && pe.pressure > 0 ? pe.pressure : 0.5;
      pad.ctx.lineWidth = (1.6 + pressure * 2.2) * pad.dpr;
      const mid = [(pad.last[0] + p[0]) / 2, (pad.last[1] + p[1]) / 2];
      pad.ctx.beginPath();
      pad.ctx.moveTo(pad.last[0], pad.last[1]);
      pad.ctx.quadraticCurveTo(pad.last[0], pad.last[1], mid[0], mid[1]);
      pad.ctx.lineTo(p[0], p[1]);
      pad.ctx.stroke();
      pad.last = p;
    }
  });
  const stopPad = () => { pad.drawing = false; };
  els.sigPad.addEventListener('pointerup', stopPad);
  els.sigPad.addEventListener('pointercancel', stopPad);
  els.btnClearPad.addEventListener('click', setupPad);
  for (const b of document.querySelectorAll('.ink')) {
    b.addEventListener('click', () => {
      pad.ink = b.dataset.ink;
      for (const o of document.querySelectorAll('.ink')) o.setAttribute('aria-checked', String(o === b));
    });
  }

  function selectSigTab(name) {
    sigTab = name;
    const map = { draw: ['tabDraw', 'panelDraw'], type: ['tabType', 'panelType'], image: ['tabImage', 'panelImage'] };
    for (const [key, [tabId, panelId]] of Object.entries(map)) {
      const on = key === name;
      const tab = $(tabId);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(panelId).hidden = !on;
    }
    els.sigError.hidden = true;
    if (name === 'draw' && !pad.ctx) setupPad();
    if (name === 'type') els.sigTypeInput.focus();
  }
  $('tabDraw').addEventListener('click', () => selectSigTab('draw'));
  $('tabType').addEventListener('click', () => selectSigTab('type'));
  $('tabImage').addEventListener('click', () => selectSigTab('image'));
  document.querySelector('.tabs').addEventListener('keydown', (ev) => {
    const order = ['draw', 'type', 'image'];
    const i = order.indexOf(sigTab);
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const next = order[(i + (ev.key === 'ArrowRight' ? 1 : 2)) % 3];
      selectSigTab(next);
      $({ draw: 'tabDraw', type: 'tabType', image: 'tabImage' }[next]).focus();
    }
  });
  els.sigTypeInput.addEventListener('input', () => { els.sigTypePreview.textContent = els.sigTypeInput.value; });

  els.sigImageInput.addEventListener('change', async () => {
    const file = els.sigImageInput.files && els.sigImageInput.files[0];
    sigImageCanvas = null;
    els.sigImagePreview.replaceChildren();
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > 15 * 1048576) {
      showSigError('Kies een PNG- of JPG-afbeelding van maximaal 15 MB.');
      return;
    }
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      // Witte (lichte) achtergrond doorzichtig maken; zachte overgang voor nette randen.
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum >= 225) d[i + 3] = 0;
        else if (lum > 170) d[i + 3] = Math.round(d[i + 3] * (225 - lum) / 55);
      }
      ctx.putImageData(img, 0, 0);
      sigImageCanvas = c;
      const preview = document.createElement('img');
      preview.alt = 'Voorbeeld van de handtekening';
      preview.src = c.toDataURL('image/png');
      els.sigImagePreview.append(preview);
      els.sigError.hidden = true;
    } catch (err) {
      console.warn(err);
      showSigError('Deze afbeelding kon niet worden gelezen.');
    }
  });

  function showSigError(msg) {
    els.sigError.textContent = msg;
    els.sigError.hidden = false;
  }

  // Snijd lege randen weg en maak een PNG met doorzichtige achtergrond.
  function trimToPng(src) {
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const { width, height } = src;
    const data = ctx.getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const padPx = 4;
    x0 = Math.max(0, x0 - padPx); y0 = Math.max(0, y0 - padPx);
    x1 = Math.min(width - 1, x1 + padPx); y1 = Math.min(height - 1, y1 + padPx);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const scale = Math.min(1, 1200 / w);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    out.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, out.width, out.height);
    return { src: out.toDataURL('image/png'), w: out.width, h: out.height };
  }

  function typedSignatureCanvas(text) {
    const font = `72px ${getComputedStyle(els.sigTypePreview).fontFamily}`;
    const c = document.createElement('canvas');
    let ctx = c.getContext('2d');
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width) + 40;
    c.width = Math.min(width, 4000);
    c.height = 150;
    ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.font = font;
    ctx.fillStyle = '#111111';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 20, 75);
    return c;
  }

  function openSigDialog() {
    els.sigError.hidden = true;
    els.sigTypeInput.value = '';
    els.sigTypePreview.textContent = '';
    els.sigImageInput.value = '';
    els.sigImagePreview.replaceChildren();
    sigImageCanvas = null;
    els.sigUsePin.checked = false;
    els.sigPin.value = '';
    els.sigPin2.value = '';
    updatePinRow();
    els.sigDialog.showModal();
    pad.ctx = null;
    selectSigTab('draw');
  }

  function updatePinRow() {
    els.pinRow.hidden = !els.sigRemember.checked || !canEncrypt();
    els.pinFields.hidden = els.pinRow.hidden || !els.sigUsePin.checked;
  }
  els.sigRemember.addEventListener('change', updatePinRow);
  els.sigUsePin.addEventListener('change', () => {
    updatePinRow();
    if (els.sigUsePin.checked) els.sigPin.focus();
  });
  // Codes niet langer dan nodig in het venster laten staan.
  els.sigDialog.addEventListener('close', () => { els.sigPin.value = ''; els.sigPin2.value = ''; });

  els.btnSigCancel.addEventListener('click', () => els.sigDialog.close());
  els.btnSigUse.addEventListener('click', async () => {
    if (els.btnSigUse.classList.contains('busy')) return;
    const usePin = els.sigRemember.checked && els.sigUsePin.checked && canEncrypt();
    if (usePin) {
      if (els.sigPin.value.length < PIN_MIN) { showSigError(`Kies een code van minimaal ${PIN_MIN} tekens.`); els.sigPin.focus(); return; }
      if (els.sigPin.value !== els.sigPin2.value) { showSigError('De twee codes zijn niet hetzelfde.'); els.sigPin2.focus(); return; }
    }
    let canvas = null;
    if (sigTab === 'draw') {
      if (!pad.hasInk) { showSigError('Teken eerst je handtekening.'); return; }
      canvas = els.sigPad;
    } else if (sigTab === 'type') {
      const text = els.sigTypeInput.value.trim();
      if (!text) { showSigError('Typ eerst je naam.'); return; }
      canvas = typedSignatureCanvas(text);
    } else {
      if (!sigImageCanvas) { showSigError('Kies eerst een afbeelding.'); return; }
      canvas = sigImageCanvas;
    }
    const png = trimToPng(canvas);
    if (!png) { showSigError('Er is geen handtekening te zien.'); return; }
    const rand = toB64(crypto.getRandomValues(new Uint8Array(6))).replace(/[^a-z0-9]/gi, '');
    const sig = { id: `s${Date.now().toString(36)}${rand}`.slice(0, 40), ...png };
    if (els.sigRemember.checked) {
      let entry = sig;
      if (usePin) {
        els.btnSigUse.classList.add('busy');
        els.btnSigUse.textContent = 'Versleutelen…';
        try {
          entry = await encryptSig(sig, els.sigPin.value);
        } catch (err) {
          console.warn(err);
          showSigError('Versleutelen lukte niet. Probeer het opnieuw of bewaar zonder code.');
          return;
        } finally {
          els.btnSigUse.classList.remove('busy');
          els.btnSigUse.textContent = 'Plaats handtekening';
        }
        unlocked.set(sig.id, sig.src);   // deze sessie direct bruikbaar
      }
      if (!storeSigs([entry, ...loadSigs()])) {
        unlocked.delete(sig.id);
        sessionSigs.unshift(sig);
        toast('Bewaren op dit apparaat lukte niet (opslag vol of uitgeschakeld). De handtekening werkt wel zolang dit venster open is.', 'error');
      }
    } else {
      sessionSigs.unshift(sig);
    }
    els.sigDialog.close();
    placeSignature(sig);
  });

  /* ================= Bestanden laden ================= */
  let loadChain = Promise.resolve();
  // `list` mag een FileList, array of een Promise daarvan zijn; de volgorde van aanbieden blijft behouden.
  function addFiles(list) {
    loadChain = loadChain.then(async () => {
      const arr = Array.from((await list) || []);
      if (arr.length) await addFilesNow(arr);
    }).catch((err) => {
      console.error(err);
      toast('Er ging iets mis bij het laden.', 'error');
    });
  }

  async function addFilesNow(list) {
    let pdfs = list.filter(isPdf);
    if (!pdfs.length) { toast('Alleen PDF-bestanden kunnen worden toegevoegd.', 'error'); return; }
    // Zeer grote bestanden kunnen de browser laten vastlopen: eerst vragen.
    const big = pdfs.filter((f) => f.size > LARGE_FILE_MB * 1024 * 1024);
    if (big.length) {
      const names = big.map((f) => `“${f.name}” (${Math.round(f.size / 1048576)} MB)`).join(', ');
      const ok = confirm(`${names} ${big.length === 1 ? 'is' : 'zijn'} erg groot. Openen kan je browser traag maken of laten vastlopen.\n\nToch openen?`);
      if (!ok) pdfs = pdfs.filter((f) => !big.includes(f));
      if (!pdfs.length) return;
    }
    const skipped = list.length - pdfs.length;
    const wasEmpty = state.entries.length === 0;
    const before = wasEmpty ? null : snapshot();
    const added = [], errors = [];
    try {
      for (const f of pdfs) {
        setBusy(true, `“${f.name}” openen…`);
        try { added.push(...await loadFile(f)); }
        catch (err) { errors.push(err.message || String(err)); }
      }
    } finally {
      setBusy(false);
    }
    if (skipped) errors.push(`${plural(skipped, 'bestand is', 'bestanden zijn')} overgeslagen omdat het geen PDF is.`);
    if (!added.length) { if (errors.length) toast(errors.join('\n'), 'error'); return; }

    if (before) pushUndo(before);
    state.entries.push(...added);
    if (wasEmpty) {
      els.body.classList.add('has-doc');
      const first = added[0];
      state.selected = new Set([first.id]);
      state.anchor = state.focusId = first.id;
      state.dirty = pdfs.length > 1;
      sync();
      els.sidebar.scrollTop = 0; els.viewer.scrollTop = 0;
      els.thumbs.focus({ preventScroll: true });
    } else {
      state.selected = new Set(added.map((e) => e.id));
      state.anchor = state.focusId = added[0].id;
      state.dirty = true;
      sync();
      added[0].thumbEl.scrollIntoView({ block: 'nearest', behavior: scrollBehavior });
      scrollViewerTo(added[0]);
      const files = new Set(added.map((e) => e.fileId)).size;
      toast(`${pagesWord(added.length)}${files > 1 ? ` uit ${files} bestanden` : ''} achteraan toegevoegd`, 'info', { label: 'Herstel', run: undo });
    }
    if (errors.length) toast(errors.join('\n'), 'error');
  }

  async function loadFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let lib, libPages;
    try {
      lib = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
      libPages = lib.getPages();
    } catch (err) {
      const msg = String((err && (err.name + ' ' + err.message)) || '');
      if (/encrypt/i.test(msg)) throw new Error(`“${file.name}” is beveiligd (versleuteld) en kan daardoor niet worden samengevoegd.`);
      throw new Error(`“${file.name}” kon niet worden gelezen. Is het een geldig PDF-bestand?`);
    }
    const count = libPages.length;
    if (!count) throw new Error(`“${file.name}” bevat geen pagina's.`);
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        data: bytes.slice(),           // pdf.js neemt de buffer over; pdf-lib houdt het origineel
        useWorkerFetch: true,          // lettertypen en decoders haalt de worker van deze eigen website
        standardFontDataUrl: PDFJS_DIR + 'standard_fonts/',
        wasmUrl: PDFJS_DIR + 'wasm/',
        enableXfa: false,
      }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw new Error(`“${file.name}” is met een wachtwoord beveiligd.`);
      throw new Error(`“${file.name}” kon niet worden weergegeven.`);
    }
    const id = nextFileId++;
    let hasForm = false;
    try {
      hasForm = !!lib.catalog.get(PDFLib.PDFName.of('AcroForm')) && lib.getForm().getFields().length > 0;
    } catch (_) { hasForm = false; }
    const rec = {
      id, name: file.name, color: COLORS[(id - 1) % COLORS.length], lib, pdf, pageCount: count,
      bytes, hasForm, formValues: new Map(), formInputs: new Map(),
    };
    state.files.set(id, rec);
    if (state.sourceId == null) {
      state.sourceId = id;
      state.sourceHandle = fileHandles.get(file) || null;
      els.fileName.value = sanitizeName(file.name) || 'Samengevoegd';
    }
    return libPages.map((p, i) => createEntry(rec, i, pageDims(p)));
  }

  /* ---------------- Weergave bijwerken ---------------- */
  function sync() {
    els.thumbs.replaceChildren(...state.entries.map((e) => e.thumbEl));
    els.pages.replaceChildren(...state.entries.map((e) => e.viewEl));
    state.entries.forEach((e, i) => {
      const f = state.files.get(e.fileId);
      e.numEl.textContent = String(i + 1);
      e.thumbEl.setAttribute('aria-label', `Pagina ${i + 1} – ${f.name}, pagina ${e.pageIndex + 1}`);
    });
    if (state.current && !state.entries.includes(state.current)) state.current = null;
    updateSelection();
    renderLegend();
    updateCurrent(true);
  }

  function updateSelection() {
    for (const e of state.entries) {
      const sel = state.selected.has(e.id);
      e.thumbEl.classList.toggle('selected', sel);
      e.thumbEl.setAttribute('aria-selected', String(sel));
      e.viewEl.classList.toggle('selected', sel && state.selected.size > 1);
    }
    if (state.focusId != null && byId.get(state.focusId) && byId.get(state.focusId).alive) {
      els.thumbs.setAttribute('aria-activedescendant', 'thumb-' + state.focusId);
    } else {
      els.thumbs.removeAttribute('aria-activedescendant');
    }
    updateToolbar();
  }

  function updateToolbar() {
    const n = state.entries.length;
    const fileCount = new Set(state.entries.map((e) => e.fileId)).size;
    const sel = state.selected.size;
    const toOriginal = n > 0 && savesToOriginal();
    let info = pagesWord(n);
    if (fileCount > 1) info += ` · ${fileCount} bestanden`;
    if (sel > 1) info += ` · ${sel} geselecteerd`;
    else if (toOriginal) info += ' · Bewaar werkt het origineel bij';
    els.docInfo.textContent = info;
    els.btnSaveAs.hidden = !fsAccess('showSaveFilePicker');
    els.btnSaveAs.disabled = n === 0;
    els.btnSave.title = toOriginal
      ? `Bewaar in het originele bestand “${state.sourceHandle.name}” (Ctrl/⌘+S)`
      : 'Bewaar het samengevoegde PDF-bestand (Ctrl/⌘+S)';
    els.btnRotL.disabled = els.btnRotR.disabled = sel === 0;
    els.btnDelete.disabled = sel === 0 || sel >= n;
    els.btnUndo.disabled = state.undo.length === 0;
    els.btnRedo.disabled = state.redo.length === 0;
    els.btnSave.disabled = n === 0;
    const name = sanitizeName(els.fileName.value) || 'Samengevoegd';
    document.title = n ? `${state.dirty ? '• ' : ''}${name}.pdf – PDF samenvoegen` : 'PDF samenvoegen';
  }

  function renderLegend() {
    const counts = new Map();
    for (const e of state.entries) counts.set(e.fileId, (counts.get(e.fileId) || 0) + 1);
    const items = [];
    for (const f of state.files.values()) {
      const c = counts.get(f.id);
      if (!c) continue;
      const li = document.createElement('li');
      li.title = f.name;
      const dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = f.color;
      const name = document.createElement('span');
      name.className = 'lname'; name.textContent = f.name;
      li.append(dot, name);
      if (f.id === state.sourceId) {
        const b = document.createElement('span');
        b.className = 'badge'; b.textContent = 'bron';
        li.append(b);
      }
      const cnt = document.createElement('span');
      cnt.className = 'lcount'; cnt.textContent = `${c} p.`;
      li.append(cnt);
      items.push(li);
    }
    els.legendList.replaceChildren(...items);
  }

  /* ---------------- Huidige pagina in de grote weergave ---------------- */
  let scrollRaf = 0, indicatorTimer = 0;
  els.viewer.addEventListener('scroll', () => {
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrent(); });
    els.pageIndicator.classList.add('show');
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => els.pageIndicator.classList.remove('show'), 1200);
  }, { passive: true });

  function updateCurrent(force) {
    const list = state.entries;
    if (!list.length || !els.viewer.clientHeight) return;
    const vr = els.viewer.getBoundingClientRect();
    const probe = vr.top + Math.min(vr.height * 0.35, 260);
    let lo = 0, hi = list.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].viewEl.getBoundingClientRect().top <= probe) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // Helemaal onderaan gescrold: laatste pagina is de huidige.
    if (els.viewer.scrollTop + els.viewer.clientHeight >= els.viewer.scrollHeight - 2) ans = list.length - 1;
    const e = list[ans];
    if (state.current !== e || force) {
      if (state.current) state.current.thumbEl.classList.remove('current');
      state.current = e;
      e.thumbEl.classList.add('current');
    }
    els.pageIndicator.textContent = `Pagina ${ans + 1} van ${list.length}`;
  }

  function scrollViewerTo(e) {
    if (!els.viewer.clientHeight) return;
    const vr = els.viewer.getBoundingClientRect();
    const r = e.viewEl.getBoundingClientRect();
    els.viewer.scrollTo({ top: els.viewer.scrollTop + r.top - vr.top - 20, behavior: scrollBehavior });
  }

  /* ---------------- Selectie ---------------- */
  function selectOnly(e, scroll = true) {
    state.selected = new Set([e.id]);
    state.anchor = state.focusId = e.id;
    updateSelection();
    if (scroll) {
      e.thumbEl.scrollIntoView({ block: 'nearest' });
      scrollViewerTo(e);
    }
  }

  function selectRange(fromId, toId, additive) {
    const a = indexOf(byId.get(fromId)), b = indexOf(byId.get(toId));
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!additive) state.selected = new Set();
    for (let i = lo; i <= hi; i++) state.selected.add(state.entries[i].id);
    state.focusId = toId;
    updateSelection();
  }

  els.thumbs.addEventListener('click', (ev) => {
    const t = ev.target.closest('.thumb');
    if (!t) return;
    setActiveAnno(null, null);   // anders zou Delete een handtekening wissen in plaats van de pagina
    const e = byEl.get(t);
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.shiftKey && state.anchor != null && byId.get(state.anchor) && byId.get(state.anchor).alive) {
      selectRange(state.anchor, e.id, mod);
    } else if (mod) {
      if (state.selected.has(e.id)) state.selected.delete(e.id); else state.selected.add(e.id);
      state.anchor = state.focusId = e.id;
      updateSelection();
    } else {
      selectOnly(e);
    }
    els.thumbs.focus({ preventScroll: true });
  });

  els.pages.addEventListener('click', (ev) => {
    const tool = ev.target.closest('.anno-tool');
    if (tool) {
      const hit = annoFromEl(tool);
      if (hit) annoTool(tool.dataset.action, hit.e, hit.it);
      return;
    }
    if (!ev.target.closest('.anno')) setActiveAnno(null, null);
    if (ev.target.closest('.field')) return;
    const p = ev.target.closest('.page');
    if (!p) return;
    const e = byEl.get(p);
    state.selected = new Set([e.id]);
    state.anchor = state.focusId = e.id;
    updateSelection();
    e.thumbEl.scrollIntoView({ block: 'nearest', behavior: scrollBehavior });
  });

  /* ---------------- Bewerkingen ---------------- */
  function snapshot() {
    return {
      order: state.entries.map((e) => [e, e.rotation, e.annos.map((a) => ({ ...a }))]),
      selected: [...state.selected], anchor: state.anchor, focusId: state.focusId,
    };
  }
  function restore(s) {
    editing = null;
    state.activeAnno = null;
    for (const e of state.entries) e.alive = false;
    state.entries = s.order.map(([e, r, annos]) => {
      e.alive = true;
      if (e.rotation !== r) { e.rotation = r; afterRotate(e); }
      e.annos = annos.map((a) => ({ ...a }));
      renderAnnos(e);
      return e;
    });
    const live = new Set(state.entries.map((e) => e.id));
    state.selected = new Set(s.selected.filter((id) => live.has(id)));
    state.anchor = live.has(s.anchor) ? s.anchor : null;
    state.focusId = live.has(s.focusId) ? s.focusId : null;
    state.dirty = true;
    sync();
    const f = byId.get(state.focusId);
    if (f) f.thumbEl.scrollIntoView({ block: 'nearest' });
  }
  function pushUndo(s) {
    state.undo.push(s);
    if (state.undo.length > 100) state.undo.shift();
    state.redo.length = 0;
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  function afterRotate(e) {
    layoutEntry(e);
    unload(e, 'thumb'); unload(e, 'view');
    schedule(e, 'thumb'); schedule(e, 'view');
  }

  function rotateSelected(delta) {
    if (!state.selected.size) return;
    pushUndo(snapshot());
    for (const e of state.entries) {
      if (!state.selected.has(e.id)) continue;
      e.rotation = (e.rotation + delta + 360) % 360;
      afterRotate(e);
    }
    state.dirty = true;
    updateToolbar();
  }

  function deleteSelected() {
    const n = state.selected.size;
    if (!n) return;
    if (n >= state.entries.length) {
      toast('Je kunt niet alle pagina\'s verwijderen. Kies “Sluiten” om opnieuw te beginnen.', 'error');
      return;
    }
    pushUndo(snapshot());
    const firstIdx = state.entries.findIndex((e) => state.selected.has(e.id));
    for (const e of state.entries) if (state.selected.has(e.id)) e.alive = false;
    state.entries = state.entries.filter((e) => !state.selected.has(e.id));
    const next = state.entries[Math.min(firstIdx, state.entries.length - 1)];
    state.selected = new Set([next.id]);
    state.anchor = state.focusId = next.id;
    state.dirty = true;
    sync();
    next.thumbEl.scrollIntoView({ block: 'nearest' });
    toast(`${pagesWord(n)} verwijderd`, 'info', { label: 'Herstel', run: undo });
  }

  // Verplaats de selectie naar invoegpositie `slot` (0…n, in de huidige volgorde).
  function moveSelectedTo(slot) {
    if (!state.selected.size) return;
    const moving = state.entries.filter((e) => state.selected.has(e.id));
    const rest = state.entries.filter((e) => !state.selected.has(e.id));
    const before = state.entries.slice(0, slot).filter((e) => state.selected.has(e.id)).length;
    const at = Math.max(0, Math.min(rest.length, slot - before));
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((e, i) => e === state.entries[i])) return;
    pushUndo(snapshot());
    state.entries = next;
    state.dirty = true;
    sync();
    const f = byId.get(state.focusId);
    if (f) f.thumbEl.scrollIntoView({ block: 'nearest' });
  }

  function selectAll() {
    state.selected = new Set(state.entries.map((e) => e.id));
    updateSelection();
  }

  function closeDocument(force) {
    if (!force && state.dirty && !confirm('Je wijzigingen zijn nog niet bewaard. Toch sluiten?')) return;
    for (const e of state.entries) e.alive = false;
    for (const e of byId.values()) { e.alive = false; thumbObs.unobserve(e.thumbEl); viewObs.unobserve(e.viewEl); }
    for (const f of state.files.values()) { try { f.pdf.destroy(); } catch (_) { /* negeer */ } }
    renderQueue.length = 0;
    byId.clear();
    state.files.clear();
    state.entries = [];
    state.selected = new Set();
    state.anchor = state.focusId = state.current = state.sourceId = state.sourceHandle = null;
    state.activeAnno = null;
    editing = null;
    closeSigMenu();
    state.undo = []; state.redo = [];
    state.dirty = false;
    els.thumbs.replaceChildren();
    els.pages.replaceChildren();
    els.legendList.replaceChildren();
    els.fileName.value = '';
    els.body.classList.remove('has-doc');
    updateToolbar();
  }

  /* ---------------- Opslaan (pdf-lib) ---------------- */

  // Beveiliging: haal scripts en andere 'actieve' onderdelen uit de pagina's van het resultaat.
  // Gewone links (naar een webadres of naar een pagina) en standaardnavigatie blijven werken.
  // Scripts op documentniveau komen er sowieso niet in: het resultaat is een nieuw document.
  const SAFE_ACTIONS = new Set(['/GoTo', '/URI', '/Named']);

  function isSafeAction(ctx, obj, depth = 0) {
    const { PDFDict, PDFArray, PDFName } = PDFLib;
    const a = ctx.lookup(obj);
    if (depth > 20) return false;
    if (a instanceof PDFArray) {
      for (let i = 0; i < a.size(); i++) if (!isSafeAction(ctx, a.get(i), depth + 1)) return false;
      return true;
    }
    if (!(a instanceof PDFDict)) return true;
    const s = ctx.lookup(a.get(PDFName.of('S')));
    if (!s || !SAFE_ACTIONS.has(s.toString())) return false;
    const next = a.get(PDFName.of('Next'));
    return next ? isSafeAction(ctx, next, depth + 1) : true;
  }

  function stripActiveContent(doc) {
    const { PDFDict, PDFArray, PDFName } = PDFLib;
    const ctx = doc.context;
    const AA = PDFName.of('AA'), A = PDFName.of('A'), ANNOTS = PDFName.of('Annots'), PARENT = PDFName.of('Parent');
    let removed = 0;
    for (const page of doc.getPages()) {
      const node = page.node;
      if (node.has(AA)) { node.delete(AA); removed++; }   // acties bij openen/sluiten van de pagina
      const annots = ctx.lookup(node.get(ANNOTS));
      if (!(annots instanceof PDFArray)) continue;
      for (let i = 0; i < annots.size(); i++) {
        // De annotatie zelf en eventuele bovenliggende formuliervelden.
        let dict = ctx.lookup(annots.get(i));
        for (let depth = 0; dict instanceof PDFDict && depth < 20; depth++) {
          if (dict.has(AA)) { dict.delete(AA); removed++; }
          if (dict.has(A) && !isSafeAction(ctx, dict.get(A))) { dict.delete(A); removed++; }
          dict = ctx.lookup(dict.get(PARENT));
        }
      }
    }
    return removed;
  }

  // Alleen tekens die het standaardlettertype (Helvetica, WinAnsi) kent; de rest wordt een vraagteken.
  function winAnsi(font, str) {
    const set = new Set(font.getCharacterSet());
    let out = '';
    for (const ch of String(str).replace(/\t/g, '    ')) {
      const cp = ch.codePointAt(0);
      out += cp === 10 || set.has(cp) ? ch : '?';
    }
    return out;
  }

  // Ingevulde formulierwaarden in een verse kopie van het bronbestand zetten en de velden "plat" maken,
  // zodat de waarden vast in de pagina staan (en bij samenvoegen niet verloren gaan).
  async function fillForm(rec, issues) {
    const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, StandardFonts } = PDFLib;
    let doc, form;
    try {
      doc = await PDFDocument.load(rec.bytes, { updateMetadata: false });
      form = doc.getForm();
    } catch (err) {
      console.warn(err);
      issues.push(rec.name);
      return rec.lib;
    }
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const [name, value] of rec.formValues) {
      try {
        const field = form.getField(name);
        if (field instanceof PDFTextField) {
          const text = winAnsi(font, value || '');
          field.setText(text || undefined);
        } else if (field instanceof PDFCheckBox) {
          if (value && value !== 'Off') field.check(); else field.uncheck();
        } else if (field instanceof PDFRadioGroup) {
          if (value && value !== 'Off') field.select(value); else field.clear();
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          if (value) field.select(value); else field.clear();
        }
        // Tekst- en keuzevelden opnieuw tekenen; vinkjes en keuzerondjes houden hun eigen uiterlijk.
        if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) {
          field.defaultUpdateAppearances(font);
        }
      } catch (err) {
        console.warn('Veld kon niet worden ingevuld:', name, err);
        issues.push(name);
      }
    }
    flattenForm(form);
    return doc;
  }

  // Zoals pdf-lib's form.flatten(), maar per veld: één vreemd veld laat niet het hele formulier mislukken.
  function flattenForm(form) {
    const { pushGraphicsState, popGraphicsState, translate, drawObject } = PDFLib;
    for (const field of form.getFields()) {
      for (const widget of field.acroField.getWidgets()) {
        try {
          const page = form.findWidgetPage(widget);
          const ref = form.findWidgetAppearanceRef(field, widget);
          const key = page.node.newXObject('FlatWidget', ref);
          const r = widget.getRectangle();
          page.pushOperators(pushGraphicsState(), translate(r.x, r.y), drawObject(key), popGraphicsState());
        } catch (_) { /* veld zonder weergave: niets te tekenen */ }
      }
      try { form.removeField(field); } catch (_) { /* negeer */ }
    }
  }

  // Teken een handtekening of tekstvak op een pagina. p = eigen draaiing van de pagina (zonder onze extra draaiing).
  async function drawAnno(out, page, p, it, font, images) {
    const { degrees, rgb } = PDFLib;
    const box = page.getCropBox();
    const x0 = box.x, y0 = box.y, W = box.width, H = box.height;
    // basisruimte (linksboven, y omlaag) -> PDF-coördinaten (linksonder, y omhoog)
    const toUser = (bx, by) => {
      switch (p) {
        case 90: return [x0 + by, y0 + bx];
        case 180: return [x0 + W - bx, y0 + by];
        case 270: return [x0 + W - by, y0 + H - bx];
        default: return [x0 + bx, y0 + H - by];
      }
    };
    const [cw, ch] = contentDims(it);
    const [cx, cy] = toUser(it.x + it.w / 2, it.y + it.h / 2);
    const theta = ((p - it.rot) % 360 + 360) % 360;   // draaiing tegen de klok in, in PDF-coördinaten
    const cos = Math.round(Math.cos(theta * Math.PI / 180)), sin = Math.round(Math.sin(theta * Math.PI / 180));
    // punt in de inhoud (linksboven, y omlaag) -> PDF-coördinaten
    const local = (lx, ly) => {
      const ux = lx - cw / 2, uy = ch / 2 - ly;
      return [cx + ux * cos - uy * sin, cy + ux * sin + uy * cos];
    };
    if (it.type === 'sig') {
      let img = images.get(it.src);
      if (!img) { img = await out.embedPng(it.src); images.set(it.src, img); }
      const [x, y] = local(0, ch);
      page.drawImage(img, { x, y, width: cw, height: ch, rotate: degrees(theta) });
    } else {
      const n = parseInt(it.color.slice(1), 16);
      const color = rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
      it.text.split('\n').forEach((line, i) => {
        if (!line) return;
        const [x, y] = local(0, (i * TEXT_LINE + TEXT_BASELINE) * it.size);
        page.drawText(winAnsi(font, line), { x, y, size: it.size, font, color, rotate: degrees(theta) });
      });
    }
  }

  async function buildPdf(title) {
    const { PDFDocument, degrees, StandardFonts } = PDFLib;
    finishEditing();
    const out = await PDFDocument.create();
    // Kopieer per bronbestand in één keer (gedeelde lettertypen/afbeeldingen worden zo maar één keer opgenomen).
    const perFile = new Map();
    for (const e of state.entries) {
      if (!perFile.has(e.fileId)) perFile.set(e.fileId, []);
      perFile.get(e.fileId).push(e.pageIndex);
    }
    const formIssues = [];
    const copied = new Map();
    for (const [fileId, indices] of perFile) {
      const rec = state.files.get(fileId);
      const source = rec.formValues.size ? await fillForm(rec, formIssues) : rec.lib;
      copied.set(fileId, await out.copyPages(source, indices));
    }
    const needsFont = state.entries.some((e) => e.annos.some((it) => it.type === 'text'));
    const font = needsFont ? await out.embedFont(StandardFonts.Helvetica) : null;
    const images = new Map();
    const cursor = new Map();
    for (const e of state.entries) {
      const i = cursor.get(e.fileId) || 0;
      cursor.set(e.fileId, i + 1);
      const page = copied.get(e.fileId)[i];
      const ownRotation = (((page.getRotation().angle || 0) % 360) + 360) % 360;
      if (e.rotation) page.setRotation(degrees((ownRotation + e.rotation) % 360));
      out.addPage(page);
      for (const it of e.annos) await drawAnno(out, page, ownRotation, it, font, images);
    }
    const src = state.files.get(state.sourceId);
    const safe = (fn) => { try { return fn(); } catch (_) { return undefined; } };
    const srcTitle = src && safe(() => src.lib.getTitle());
    out.setTitle(srcTitle || title);
    const author = src && safe(() => src.lib.getAuthor());
    if (author) out.setAuthor(author);
    const subject = src && safe(() => src.lib.getSubject());
    if (subject) out.setSubject(subject);
    const created = src && safe(() => src.lib.getCreationDate());
    if (created) out.setCreationDate(created);
    out.setModificationDate(new Date());
    out.setCreator('PDF samenvoegen');
    const removed = stripActiveContent(out);
    return { bytes: await out.save(), removed, formIssues };
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Bewaar: schrijft terug naar het originele bronbestand als dat kan (Edge/Chrome, naam ongewijzigd).
  // Bewaar als (asNew): altijd een nieuw bestand kiezen. Zonder bestandstoegang: download.
  async function save(asNew = false) {
    if (!state.entries.length || state.saving) return;
    const name = sanitizeName(els.fileName.value) || 'Samengevoegd';
    els.fileName.value = name;
    const filename = name + '.pdf';
    const src = state.sourceHandle;
    state.saving = true;
    try {
      let target = null;
      if (!asNew && savesToOriginal()) {
        // De browser vraagt de eerste keer zelf of de pagina dit bestand mag wijzigen.
        let perm = 'denied';
        try { perm = await src.requestPermission({ mode: 'readwrite' }); } catch (_) { perm = 'denied'; }
        if (perm === 'granted') target = src;
        else toast(`Geen toestemming om “${src.name}” te wijzigen. Kies zelf waar je het bewaart.`, 'error');
      }
      if (!target && fsAccess('showSaveFilePicker')) {
        try {
          const opts = { suggestedName: filename, types: PDF_TYPES, id: 'pdf-samenvoegen' };
          if (src) opts.startIn = src;   // begin in de map van het bronbestand
          target = await window.showSaveFilePicker(opts);
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          target = null;
        }
      }
      setBusy(true, 'PDF wordt samengevoegd…');
      // Eerst het hele bestand maken; pas daarna schrijven, zodat het origineel bij een fout heel blijft.
      const { bytes, removed, formIssues } = await buildPdf(name);
      if (target) {
        const w = await target.createWritable();
        try {
          await w.write(bytes);
          await w.close();
        } catch (err) {
          try { await w.abort(); } catch (_) { /* negeer */ }
          throw err;
        }
        if (target === src) {
          toast(`Bewaard in het originele bestand “${src.name}”`);
        } else {
          // Net als bij "Bewaar als" in andere programma's: verder werken in het nieuwe bestand.
          state.sourceHandle = target;
          els.fileName.value = sanitizeName(target.name) || name;
          toast(`Bewaard als “${target.name}”`);
        }
      } else {
        downloadBytes(bytes, filename);
        toast(`“${filename}” is gedownload`);
      }
      if (removed) toast(`Uit veiligheid ${removed === 1 ? 'is 1 script of actief onderdeel' : `zijn ${removed} scripts of actieve onderdelen`} uit het resultaat gehaald.`);
      if (formIssues.length) toast(`Deze formuliervelden konden niet worden ingevuld: ${formIssues.join(', ')}. Controleer het resultaat.`, 'error');
      state.dirty = false;
      updateToolbar();
    } catch (err) {
      console.error(err);
      toast('Bewaren is mislukt: ' + ((err && err.message) || err), 'error');
    } finally {
      setBusy(false);
      state.saving = false;
    }
  }

  /* ---------------- Slepen: bestanden van buiten ---------------- */
  const hasFiles = (ev) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  let dragDepth = 0;

  function showDropOverlay(on) {
    if (on) {
      if (state.entries.length) {
        els.dropTitle.textContent = 'Laat los om achteraan toe te voegen';
        els.dropSub.textContent = `De pagina's komen na pagina ${state.entries.length}`;
      } else {
        els.dropTitle.textContent = 'Laat los om te openen';
        els.dropSub.textContent = 'Het eerste bestand wordt de bron';
      }
    }
    els.dropOverlay.classList.toggle('show', on);
    els.appendZone.classList.toggle('active', on);
  }

  window.addEventListener('dragenter', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth++;
    showDropOverlay(true);
  });
  window.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (ev) => {
    if (!hasFiles(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || !ev.relatedTarget) { dragDepth = 0; showDropOverlay(false); }
  });
  window.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    showDropOverlay(false);
    const dt = ev.dataTransfer;
    // Bestand én schijfverwijzing moeten nu (synchroon) worden opgevraagd; na deze gebeurtenis kan dat niet meer.
    const pending = [];
    for (const item of Array.from(dt.items || [])) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      let handle = null;
      if (window.isSecureContext && typeof item.getAsFileSystemHandle === 'function') {
        try { handle = item.getAsFileSystemHandle(); } catch (_) { handle = null; }
      }
      pending.push([file, handle]);
    }
    if (!pending.length) { addFiles(dt.files); return; }
    addFiles(Promise.all(pending.map(async ([file, handle]) => {
      try {
        const h = handle && await handle;
        if (h && h.kind === 'file') fileHandles.set(file, h);
      } catch (_) { /* geen schijfverwijzing: dan wordt Bewaar een download */ }
      return file;
    })));
  });

  /* ---------------- Slepen: pagina's herschikken ---------------- */
  let dragIds = null, dropSlot = -1, dropMarked = null;

  function clearDropMark() {
    if (dropMarked) dropMarked.classList.remove('drop-before', 'drop-after');
    dropMarked = null;
    dropSlot = -1;
  }

  function slotAt(x, y) {
    const list = state.entries;
    if (!list.length) return 0;
    let multiCol = false;
    if (list.length > 1) {
      const a = list[0].thumbEl.getBoundingClientRect(), b = list[1].thumbEl.getBoundingClientRect();
      multiCol = Math.abs(a.top - b.top) < 4;
    }
    for (let i = 0; i < list.length; i++) {
      const r = list[i].thumbEl.getBoundingClientRect();
      if (y < r.top) return i;
      if (y <= r.bottom) {
        if (multiCol ? x < r.left + r.width / 2 : y < r.top + r.height / 2) return i;
      }
    }
    return list.length;
  }

  els.thumbs.addEventListener('dragstart', (ev) => {
    const t = ev.target.closest && ev.target.closest('.thumb');
    if (!t) return;
    const e = byEl.get(t);
    if (!state.selected.has(e.id)) {
      state.selected = new Set([e.id]);
      state.anchor = state.focusId = e.id;
      updateSelection();
    }
    dragIds = new Set(state.selected);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('application/x-pdf-pagina', String(e.id));
    requestAnimationFrame(() => {
      for (const x of state.entries) if (dragIds && dragIds.has(x.id)) x.thumbEl.classList.add('dragging');
    });
  });

  els.thumbs.addEventListener('dragend', () => {
    for (const x of state.entries) x.thumbEl.classList.remove('dragging');
    clearDropMark();
    dragIds = null;
  });

  els.sidebar.addEventListener('dragover', (ev) => {
    if (!dragIds) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const slot = slotAt(ev.clientX, ev.clientY);
    if (slot !== dropSlot) {
      clearDropMark();
      dropSlot = slot;
      if (slot < state.entries.length) {
        dropMarked = state.entries[slot].thumbEl;
        dropMarked.classList.add('drop-before');
      } else {
        dropMarked = state.entries[state.entries.length - 1].thumbEl;
        dropMarked.classList.add('drop-after');
      }
    }
    // Automatisch scrollen bij de randen
    const r = els.sidebar.getBoundingClientRect();
    if (ev.clientY < r.top + 48) els.sidebar.scrollTop -= 14;
    else if (ev.clientY > r.bottom - 48) els.sidebar.scrollTop += 14;
  });

  els.sidebar.addEventListener('dragleave', (ev) => {
    if (!dragIds) return;
    if (!ev.relatedTarget || !els.sidebar.contains(ev.relatedTarget)) clearDropMark();
  });

  els.sidebar.addEventListener('drop', (ev) => {
    if (!dragIds) return;
    ev.preventDefault();
    const slot = dropSlot >= 0 ? dropSlot : slotAt(ev.clientX, ev.clientY);
    clearDropMark();
    moveSelectedTo(slot);
  });

  /* ---------------- Toetsenbord ---------------- */
  function moveFocus(delta, extend) {
    const list = state.entries;
    if (!list.length) return;
    const cur = byId.get(state.focusId);
    let i = cur && cur.alive ? indexOf(cur) : -1;
    i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
    const e = list[i];
    if (extend && state.anchor != null && byId.get(state.anchor) && byId.get(state.anchor).alive) {
      selectRange(state.anchor, e.id, false);
      e.thumbEl.scrollIntoView({ block: 'nearest' });
      scrollViewerTo(e);
    } else {
      selectOnly(e);
    }
  }

  function moveSelectionBy(delta) {
    const idx = state.entries.map((e, i) => (state.selected.has(e.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    if (delta < 0) moveSelectedTo(Math.max(0, idx[0] - 1));
    else moveSelectedTo(Math.min(state.entries.length, idx[idx.length - 1] + 2));
  }

  document.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key;
    const inField = ev.target instanceof HTMLElement && (ev.target.matches('input, textarea, select') || ev.target.isContentEditable);
    const hasDoc = state.entries.length > 0;

    if (els.sigDialog.open || els.pinDialog.open) return;   // de dialogen regelen hun eigen toetsen
    if (key === 'Escape' && !els.sigMenu.hidden) { closeSigMenu(); els.btnSign.focus(); return; }
    if (mod && !ev.altKey && key.toLowerCase() === 'o') { ev.preventDefault(); openPicker(); return; }
    if (!hasDoc) return;
    if (mod && !ev.altKey && key.toLowerCase() === 's') { ev.preventDefault(); save(ev.shiftKey); return; }
    if (inField) {
      // Enter sluit alleen een gewoon tekstveld af; in tekstvakken en meerregelige velden is het een nieuwe regel.
      const singleLine = ev.target.matches('input:not([type=checkbox]):not([type=radio])');
      if (key === 'Escape' || (key === 'Enter' && singleLine)) ev.target.blur();
      return;
    }
    if (els.busy.classList.contains('show')) return;

    if (state.activeAnno && !mod) {
      const { e, it } = state.activeAnno;
      if (key === 'Delete' || key === 'Backspace') { ev.preventDefault(); removeAnno(e, it); return; }
      if (key === 'Escape') { setActiveAnno(null, null); return; }
      if (key === 'Enter' && it.type === 'text') { ev.preventDefault(); startEditing(e, it, false); return; }
      const step = ev.shiftKey ? 10 : 1;
      const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      if (nudge) { ev.preventDefault(); nudgeAnno(e, it, nudge[0], nudge[1]); return; }
    }

    if (mod && key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if (mod && key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
    if (mod && key.toLowerCase() === 'a') { ev.preventDefault(); selectAll(); return; }
    if (key === 'Delete' || key === 'Backspace') { ev.preventDefault(); deleteSelected(); return; }

    const nav = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, PageDown: 5, PageUp: -5 };
    if (key in nav) {
      ev.preventDefault();
      if (ev.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) moveSelectionBy(nav[key]);
      else moveFocus(nav[key], ev.shiftKey);
      return;
    }
    if (key === 'Home') { ev.preventDefault(); moveFocus(-Infinity, ev.shiftKey); return; }
    if (key === 'End') { ev.preventDefault(); moveFocus(Infinity, ev.shiftKey); return; }
  });

  /* ---------------- Knoppen ---------------- */
  els.btnPick.addEventListener('click', (ev) => { ev.stopPropagation(); openPicker(); });
  els.dropzone.addEventListener('click', () => openPicker());
  els.btnAdd.addEventListener('click', () => openPicker());
  els.appendZone.addEventListener('click', () => openPicker());
  els.fileInput.addEventListener('change', () => {
    const list = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    addFiles(list);
  });
  els.btnRotL.addEventListener('click', () => rotateSelected(-90));
  els.btnRotR.addEventListener('click', () => rotateSelected(90));
  els.btnDelete.addEventListener('click', deleteSelected);
  els.btnUndo.addEventListener('click', undo);
  els.btnRedo.addEventListener('click', redo);
  els.btnSave.addEventListener('click', () => save(false));
  els.btnSaveAs.addEventListener('click', () => save(true));
  els.btnClose.addEventListener('click', () => closeDocument(false));
  els.fileName.addEventListener('input', () => { state.dirty = state.dirty || state.entries.length > 0; updateToolbar(); });
  els.fileName.addEventListener('blur', () => { els.fileName.value = sanitizeName(els.fileName.value) || 'Samengevoegd'; updateToolbar(); });

  window.addEventListener('beforeunload', (ev) => {
    if (state.dirty && state.entries.length) { ev.preventDefault(); ev.returnValue = ''; }
  });

  updateToolbar();
})();