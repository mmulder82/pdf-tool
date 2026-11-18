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
  };
  let nextFileId = 1, nextEntryId = 1;
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
      await page.render({ canvas, viewport: vp }).promise;
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
  }

  /* ---------------- Bestanden laden ---------------- */
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
    const rec = { id, name: file.name, color: COLORS[(id - 1) % COLORS.length], lib, pdf, pageCount: count };
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
      order: state.entries.map((e) => [e, e.rotation]),
      selected: [...state.selected], anchor: state.anchor, focusId: state.focusId,
    };
  }
  function restore(s) {
    for (const e of state.entries) e.alive = false;
    state.entries = s.order.map(([e, r]) => {
      e.alive = true;
      if (e.rotation !== r) { e.rotation = r; afterRotate(e); }
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

  async function buildPdf(title) {
    const { PDFDocument, degrees } = PDFLib;
    const out = await PDFDocument.create();
    // Kopieer per bronbestand in één keer (gedeelde lettertypen/afbeeldingen worden zo maar één keer opgenomen).
    const perFile = new Map();
    for (const e of state.entries) {
      if (!perFile.has(e.fileId)) perFile.set(e.fileId, []);
      perFile.get(e.fileId).push(e.pageIndex);
    }
    const copied = new Map();
    for (const [fileId, indices] of perFile) {
      copied.set(fileId, await out.copyPages(state.files.get(fileId).lib, indices));
    }
    const cursor = new Map();
    for (const e of state.entries) {
      const i = cursor.get(e.fileId) || 0;
      cursor.set(e.fileId, i + 1);
      const page = copied.get(e.fileId)[i];
      if (e.rotation) {
        const angle = (((page.getRotation().angle || 0) + e.rotation) % 360 + 360) % 360;
        page.setRotation(degrees(angle));
      }
      out.addPage(page);
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
    return { bytes: await out.save(), removed };
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
      const { bytes, removed } = await buildPdf(name);
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

    if (mod && !ev.altKey && key.toLowerCase() === 'o') { ev.preventDefault(); openPicker(); return; }
    if (!hasDoc) return;
    if (mod && !ev.altKey && key.toLowerCase() === 's') { ev.preventDefault(); save(ev.shiftKey); return; }
    if (inField) {
      if (key === 'Enter' || key === 'Escape') { ev.target.blur(); }
      return;
    }
    if (els.busy.classList.contains('show')) return;

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