/* Readen web app: library, reader glue, bookmarks, cloud sync. ES5, no frameworks (must run on iOS 9 Safari). */
(function () {
  'use strict';
  var C = window.RCrypto, L = window.RLogic, Store = window.RStore, RCloud = window.RCloud, RCover = window.RCover, RScene = window.RScene;
  var KEY = 'readen.state.v1';
  var VERSION_LABEL = window.READEN_VERSION || 'dev';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- state ----------
  function loadState() {
    var base = L.newState(), s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { s = null; }
    if (s && typeof s === 'object') for (var k in s) base[k] = s[k];
    return base;
  }
  var state = L.ensureIdentity(loadState());
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('This browser is out of storage, so your latest changes may not be kept.', true); } }
  var ui = { shelfAnim: true, cloudSyncing: false, cloudErr: null, cloudObj: null, cloudLast: 0, backing: {}, autoDl: false, tab: 'local', openHash: null, reader: null, pendingRemote: null, busy: {}, lastErr: null };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function h(tag, props, kids) {
    var e = document.createElement(tag), k, i;
    for (k in (props || {})) {
      if (k === 'class') e.className = props[k]; else if (k === 'text') e.textContent = props[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), props[k], false); else e.setAttribute(k, props[k]);
    }
    kids = kids || [];
    for (i = 0; i < kids.length; i++) if (kids[i] != null) e.appendChild(typeof kids[i] === 'string' ? document.createTextNode(kids[i]) : kids[i]);
    return e;
  }
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name); use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name);
    svg.appendChild(use); return svg;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return Math.round(n / 1024) + ' KB'; return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtStamp(ms) {
    var d = new Date(ms), hr = d.getHours(), ap = hr >= 12 ? 'PM' : 'AM';
    hr = hr % 12; if (hr === 0) hr = 12;
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + hr + ':' + pad2(d.getMinutes()) + ' ' + ap;
  }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) return 'just now'; if (s < 60) return s + ' seconds ago';
    var m = Math.round(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var hh = Math.round(m / 60); if (hh < 24) return hh + (hh === 1 ? ' hour ago' : ' hours ago');
    return fmtStamp(ms);
  }
  function agoShort(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 10) return 'just now'; if (s < 60) return s + 's ago';
    var m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    var hh = Math.round(m / 60); if (hh < 24) return hh + ' h ago';
    return Math.round(hh / 24) + ' d ago';
  }
  function show(id) { var v = document.querySelectorAll('.view'), i; for (i = 0; i < v.length; i++) v[i].className = 'view' + (v[i].id === id ? ' on' : ''); document.documentElement.setAttribute('data-view', id); }

  // ---------- toast ----------
  var toastTimer = null;
  function toast(text, warn, iconName) {
    var pill = $('toast-pill');
    clear(pill); pill.appendChild(icon(iconName || (warn ? 'warning' : 'check-circle'))); pill.appendChild(document.createTextNode(text));
    pill.className = 'pill on' + (warn ? ' warn' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { pill.className = 'pill' + (warn ? ' warn' : ''); }, warn ? 4200 : 2300);
  }
  function bump(btn) { btn.className = btn.className.replace(' bump', ''); void btn.offsetWidth; btn.className += ' bump'; }

  // ---------- press feedback ----------
  // iOS 9 Safari shows :active late and drops it on release, so a quick tap on a button never looked pressed. Mark the control on touch/mouse down and keep
  // the mark long enough to see (PRESS_MIN). Release or a cap clears it, so a scroll that starts on a button cannot leave it stuck. Style: .pressed in app.css.
  (function () {
    var PRESS_MIN = 140, PRESS_MAX = 450, cur = null, since = 0, minT = null, maxT = null, lastTouch = 0;
    function find(t) {
      while (t && t !== document) {
        var c = t.getAttribute && t.getAttribute('class');                  // getAttribute: an svg's className is not a string
        if (c && /(^| )(tool|round|btn|go)( |$)/.test(c) && !t.disabled) return t;
        t = t.parentNode;
      }
      return null;
    }
    function release() { clearTimeout(minT); clearTimeout(maxT); if (cur) cur.classList.remove('pressed'); cur = null; }
    function down(e) {
      var c = find(e.target); if (!c) return;
      release(); cur = c; since = Date.now(); c.classList.add('pressed');
      maxT = setTimeout(release, PRESS_MAX);
    }
    function up() { if (!cur) return; clearTimeout(minT); minT = setTimeout(release, Math.max(0, PRESS_MIN - (Date.now() - since))); }
    document.addEventListener('touchstart', function (e) { lastTouch = Date.now(); down(e); }, true);
    document.addEventListener('touchend', function () { lastTouch = Date.now(); up(); }, true);
    document.addEventListener('touchcancel', up, true);
    document.addEventListener('mousedown', function (e) { if (Date.now() - lastTouch > 800) down(e); }, true);   // iOS replays touches as mouse events
    document.addEventListener('mouseup', up, true);
  }());

  // ---------- sheet ----------
  function openSheet(title, build) {
    $('sheet-title').textContent = title; var body = $('sheet-body'); clear(body); build(body);
    $('shade').className = 'on'; $('sheet').className = 'on'; document.body.className = 'sheet-open'; $('sheet-close').focus();
  }
  function closeSheet() { $('shade').className = ''; $('sheet').className = ''; document.body.className = ''; }
  $('shade').addEventListener('click', closeSheet, false);
  $('sheet-close').addEventListener('click', closeSheet, false);
  document.addEventListener('keydown', function (e) { if (e.keyCode === 27) closeSheet(); }, false);

  // ---------- status chip ----------
  function renderStatus() {
    var chip = $('status-chip'), cls = 'chip', t, cloud = cloudCfg();
    var last = cloud ? (state.cloud.lastSync || 0) : 0;
    var bad = ui.cloudErr && ui.cloudErr.code !== 'network';
    if (!cloud) t = 'Offline reader';
    else if (ui.cloudSyncing) t = 'Syncing...';
    else if (bad) { t = 'Needs attention'; cls += ' warn'; }
    else if (last) { t = 'Synced ' + agoShort(last); cls += ' ok'; }
    else t = 'Cloud ready';
    chip.className = cls; chip.textContent = t;
    var sb = $('btn-sync'); if (ui.cloudSyncing) sb.classList.add('spin'); else sb.classList.remove('spin');
  }

  // ---------- library ----------
  function progressOf(hash) { var p = state.progress[hash]; return p ? p : null; }

  function renderLibrary() {
    renderStatus();
    if (!cloudCfg() && ui.tab === 'cloud') ui.tab = 'local';
    $('tab-cloud').hidden = !cloudCfg(); document.querySelector('.tabs').hidden = !cloudCfg();
    $('tab-local').className = ui.tab === 'local' ? 'on' : ''; $('tab-cloud').className = ui.tab === 'cloud' ? 'on' : '';
    var list = $('shelves'), empty = $('lib-empty'); clear(list); empty.hidden = true; list.className = ui.shelfAnim ? 'anim' : ''; ui.shelfAnim = false;
    var banner = $('lib-banner'); clear(banner);
    if (ui.lastErr) {
      var errBox = h('div', { class: 'banner err', role: 'alert' }, [h('span', { class: 'txt', text: ui.lastErr })]);
      if (ui.missingHash && state.docs[ui.missingHash]) errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Download again', onclick: function () { redownload(ui.missingHash); } }));
      if (ui.fallback) errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Open in browser viewer', onclick: function () { openInBrowserViewer(ui.fallback.name, ui.fallback.bytes); } }));
      errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Diagnostics', onclick: function () { location.href = 'diag.html'; } }));
      errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Dismiss', onclick: function () { ui.lastErr = null; ui.fallback = null; ui.missingHash = null; renderLibrary(); } }));
      banner.appendChild(errBox);
    }
    if (ui.cloudErr && ui.cloudErr.code !== 'network') {
      banner.appendChild(h('div', { class: 'banner err', role: 'alert' }, [h('span', { class: 'txt', text: 'Cloud sync: ' + ui.cloudErr.message }),
        h('button', { class: 'btn quiet', type: 'button', text: 'Cloud settings', onclick: openCloudSheet })]));
    }
    if (!Store.isPersistent() && ui.tab === 'local') banner.appendChild(h('div', { class: 'banner' }, [h('span', { class: 'txt', text: 'This browser can\'t keep PDFs between visits, so they may disappear when you close it.' })]));
    if (ui.tab === 'cloud') renderCloud(list, empty); else renderLocal(list, empty);
  }

  function emptyState(box, title, text, actions) {
    clear(box); box.hidden = false;
    box.appendChild(h('h2', { text: title })); box.appendChild(h('p', { text: text }));
    for (var i = 0; i < actions.length; i++) box.appendChild(actions[i]);
  }

  // ---------- shelves: books lean on a plank, each with a paper label ----------
  var LEANS = [-2.5, 1.4, -1, 2.4, -1.8, 1, -2.2, 1.6];
  function bookName(d) { return String(d.name || '').replace(/\.pdf$/i, ''); }
  function perRow() { var w = $('shelves').clientWidth || window.innerWidth; return Math.max(2, Math.min(5, Math.floor(w / 170))); }
  function pctOf(d) { var p = progressOf(d.hash); return (p && d.pages) ? Math.max(0, Math.min(100, Math.round(100 * (p.pageIndex + 1) / d.pages))) : null; }
  function rot(el, deg) { el.style.webkitTransform = 'rotate(' + deg + 'deg)'; el.style.transform = 'rotate(' + deg + 'deg)'; }
  function stitchRow(pct, n, cls) { var row = h('div', { class: cls || 'st', 'aria-hidden': 'true' }), on = Math.round(n * pct / 100); for (var i = 0; i < n; i++) row.appendChild(h('b', { class: i < on ? 'on' : '' })); return row; }
  function coverNode(hash, name) {
    var cv = h('span', { class: 'cv' }), c = RCover.get(hash);
    if (c && c !== 'x') cv.appendChild(h('img', { src: c.url, alt: '', draggable: 'false' }));
    else cv.appendChild(h('span', { class: 'phc', style: 'background:' + RCover.cloth(hash) }, [h('span', { text: name })]));
    return cv;
  }
  function wantCovers(docs) {
    docs.forEach(function (d) { if (!RCover.get(d.hash)) RCover.request(d.hash, function (cb) { Store.get(d.hash, function (e, b) { cb(b || null); }); }); });
  }
  function labelNode(o, idx) {
    var lt = h('span', { class: 'lt' }, [h('span', { class: 'nm', text: o.name })]);
    if (o.busy) { lt.appendChild(h('small', { text: o.busy.text })); if (o.busy.total) lt.appendChild(h('div', { class: 'bar-progress' }, [h('i', { style: 'width:' + Math.round(100 * o.busy.done / o.busy.total) + '%' })])); }
    else if (o.pct != null) lt.appendChild(stitchRow(o.pct, 20));
    else if (o.small) lt.appendChild(h('small', { text: o.small }));
    var el = h('div', { class: 'label' }, [lt]); rot(el, idx % 2 ? 0.7 : -0.6);
    if (o.x && !o.busy) el.appendChild(h('button', { class: 'x', type: 'button', 'aria-label': o.x.label, onclick: function (e) { e.stopPropagation(); o.x.fn(); } }, [icon('trash')]));
    return el;
  }
  /** o: {hash, name, aria, open, ghost, label:{...}, ribbon} -> a slot holding one book and its label. */
  function slotNode(o, k, widthPct) {
    var slot = h('div', { class: 'slot' }), lean = LEANS[k % LEANS.length], bk = h('button', { class: o.ghost ? 'bk ghost' : 'bk', type: 'button', 'aria-label': o.aria, onclick: o.open });
    if (widthPct) slot.style.width = widthPct + '%';
    bk.style.setProperty('--lean', lean + 'deg'); bk.style.webkitAnimationDelay = (k * 70) + 'ms'; bk.style.animationDelay = (k * 70) + 'ms';
    if (o.ghost) bk.appendChild(h('span', { class: 'gcv' }, [coverNode(o.hash, o.name)])), bk.appendChild(h('span', { class: 'ic' }, [icon('download-simple')]));
    else { bk.appendChild(coverNode(o.hash, o.name)); bk.appendChild(h('i', { class: 'pages' })); bk.appendChild(h('i', { class: 'drop' })); if (o.ribbon) bk.appendChild(h('i', { class: 'ribtail' })); }
    slot.appendChild(bk); slot.appendChild(h('div', { class: 'lip' }, [labelNode(o.label, k)]));
    return slot;
  }
  function shelvesInto(list, items, startK) {
    var n = perRow(), i, row, slots;
    for (i = 0; i < items.length; i += n) {
      row = h('div', { class: 'shelf' }); slots = h('div', { class: 'slots' });
      items.slice(i, i + n).forEach(function (o, j) { slots.appendChild(slotNode(o, startK + i + j, 100 / n)); });
      row.appendChild(slots); row.appendChild(h('i', { class: 'plank' })); list.appendChild(row);
    }
  }
  function localItem(d, ribbon) {
    var busy = ui.busy[d.hash], p = progressOf(d.hash), pct = pctOf(d);
    return { hash: d.hash, name: bookName(d), aria: 'Open ' + bookName(d), open: function () { openReader(d.hash); }, ribbon: ribbon,
      label: { name: bookName(d), busy: busy, pct: pct, small: p ? 'On page ' + (p.pageIndex + 1) : 'Not started',
               x: { label: 'Remove ' + bookName(d) + ' from this device', fn: function () { confirmRemove(d); } } } };
  }

  function renderLocal(list, empty) {
    var docs = L.sortedDocs(state).sort(function (a, b) { return (b.opened || 0) - (a.opened || 0) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1); });
    if (!docs.length) {
      return emptyState(empty, 'No PDFs on this device yet', 'Add a PDF from this device. Everything works offline. Turn on cloud sync to share PDFs, positions and bookmarks with your other devices.', [
        h('button', { class: 'btn primary', type: 'button', text: 'Add a PDF', onclick: function () { $('file-input').click(); } }),
        document.createTextNode(' '),
        h('button', { class: 'btn', type: 'button', text: cloudCfg() ? 'Show the cloud' : 'Set up cloud sync', onclick: function () { if (cloudCfg()) { ui.tab = 'cloud'; renderLibrary(); cloudSyncNow(true); } else openCloudSheet(); } })]);
    }
    wantCovers(docs);
    var d0 = docs[0], p0 = progressOf(d0.hash), pct0 = pctOf(d0), hero = h('div', { class: 'shelf hero' });
    var o0 = localItem(d0, !!p0); o0.label.x = null;
    hero.appendChild(slotNode(o0, 0, null));
    hero.appendChild(h('div', { class: 'info' }, [h('h2', { text: bookName(d0) }),
      h('div', { class: 'by', text: (d0.pages ? d0.pages + (d0.pages === 1 ? ' page' : ' pages') + ' · ' : '') + fmtSize(d0.size) }),
      pct0 != null ? stitchRow(pct0, 24, 'stt') : null,
      h('div', { class: 'meta num', text: p0 ? (d0.pages ? 'Page ' + (p0.pageIndex + 1) + ' of ' + d0.pages + ' · ' + pct0 + '% read' : 'On page ' + (p0.pageIndex + 1)) : 'Not started' }),
      h('button', { class: 'go', type: 'button', text: p0 ? 'Continue reading' : 'Start reading', onclick: function () { openReader(d0.hash); } })]));
    hero.appendChild(h('i', { class: 'plank' }));
    list.appendChild(hero);
    shelvesInto(list, docs.slice(1).map(function (d) { return localItem(d, false); }), 1);
  }

  $('tab-local').addEventListener('click', function () { ui.tab = 'local'; ui.shelfAnim = true; renderLibrary(); }, false);
  $('tab-cloud').addEventListener('click', function () { ui.tab = 'cloud'; ui.shelfAnim = true; renderLibrary(); cloudSyncNow(); }, false);

  function setBusy(hash, v) { if (v) ui.busy[hash] = v; else delete ui.busy[hash]; renderLibrary(); }

  /** The PDF's file is gone from device storage but the library entry remains: fetch it again from the cloud. */
  function redownload(hash) {
    var cd = state.cloudDocs && state.cloudDocs[hash] && !state.cloudDocs[hash].deleted ? state.cloudDocs[hash] : null;
    ui.lastErr = null; ui.missingHash = null;
    if (cd && cloudCfg()) { delete state.docs[hash]; save(); return downloadFromCloud(cd); }
    toast('Not found in the cloud. Remove it here and add it again.', true);
    renderLibrary();
  }

  function confirmRemove(d) {
    openSheet('Remove from this device?', function (body) {
      body.appendChild(h('p', { text: '"' + d.name + '" will be removed from this device. Your reading position and bookmarks are kept, and if it is in the cloud you can download it again.' }));
      body.appendChild(h('div', { class: 'row-actions' }, [
        h('button', { class: 'btn danger', type: 'button', text: 'Remove', onclick: function () { closeSheet(); Store.del(d.hash, function () { delete state.docs[d.hash]; RCover.del(d.hash); save(); renderLibrary(); toast('Removed ' + d.name, false, 'trash'); }); } }),
        h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeSheet })]));
    });
  }

  // ---------- adding a PDF from this device ----------
  $('btn-add').addEventListener('click', function () { $('file-input').click(); }, false);
  $('file-input').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = ''; if (!f) return;
    toast('Reading ' + f.name + '...', false, 'file-pdf');
    var fr = new FileReader();
    fr.onerror = function () { toast('Could not read that file.', true); };
    fr.onload = function () {
      var bytes = new Uint8Array(fr.result);
      var head = ''; for (var i = 0; i < Math.min(1024, bytes.length); i++) head += String.fromCharCode(bytes[i]);
      if (head.indexOf('%PDF-') < 0) return toast('That file is not a PDF.', true);
      var hs = C.hasher(), pos = 0;
      (function step() {
        var end = Math.min(pos + 1048576, bytes.length); hs.update(bytes.subarray(pos, end)); pos = end;
        if (pos < bytes.length) return setTimeout(step, 0);
        var hash = C.hex(hs.finish());
        if (state.docs[hash]) return toast('That PDF is already on this device.', true);
        Store.put(hash, bytes, function (e2) {
          if (e2) { ui.lastErr = e2.message + ' It will work until you close the app.'; ui.fallback = null; }
          L.upsertDoc(state, { hash: hash, name: f.name, size: bytes.length, pages: null, added: Date.now(), opened: null });
          save(); ui.tab = 'local'; ui.shelfAnim = true; RCover.makeFrom(hash, bytes); renderLibrary(); toast('Added ' + f.name);
        });
      })();
    };
    fr.readAsArrayBuffer(f);
  }, false);

  // ---------- reader ----------
  function updatePageLabel() {
    var r = ui.reader; if (!r || !r.n) return;
    var i = r.currentIndex(); $('rd-page').textContent = (i + 1) + ' / ' + r.n; updateBookmarkIcon(i);
  }
  function updateBookmarkIcon(i) {
    var has = ui.openHash && L.liveBookmarks(state, ui.openHash, i).length > 0, use = $('rd-bookmark-use'), btn = $('rd-bookmark');
    var ref = has ? '#i-bookmark-simple-fill' : '#i-bookmark-simple';
    use.setAttribute('href', ref); use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', ref);
    if (has) btn.classList.add('on'); else btn.classList.remove('on');           // not className: that would also drop .pressed while the tap is still showing
    btn.setAttribute('aria-label', has ? 'Replace the bookmark on this page' : 'Bookmark this page');
    btn.setAttribute('aria-pressed', has ? 'true' : 'false');
  }

  function openReader(hash) {
    var d = state.docs[hash]; if (!d) return;
    toast('Opening...', false, 'file-pdf'); RCover.pause();
    Store.get(hash, function (e, bytes) {
      if (!bytes) {
        var st = Store.status();
        ui.lastErr = '"' + d.name + '" is listed here but its file is no longer stored on this device' + (st.lastError ? ' (' + st.lastError + ')' : '') + '. Download it again' +
          (cloudCfg() ? ' from the cloud tab.' : ', or add it again with +.');
        ui.fallback = null; ui.missingHash = hash; RCover.resume(); renderLibrary(); return;
      }
      setBare(false); ui.lastSel = ''; ui.lastSelPage = -1; show('view-reader'); ui.openHash = hash; $('rd-title').textContent = bookName(d); $('rd-page').textContent = '';
      $('remote-banner').hidden = true; ui.pendingRemote = null;
      ui.openBytes = bytes; $('reader-error').hidden = true;
      var reader = new window.RReader($('reader-scroll'), $('pages'), { onPosition: onPosition, onSelectMode: onSelectMode, onError: function (stage, detail) { showReaderError('A page could not be drawn (' + stage + '): ' + detail); } });
      ui.reader = reader;
      reader.load(bytes, function (err, info) {
        if (err) {
          var fallback = { name: d.name, bytes: bytes };
          closeReader(true);
          ui.lastErr = err.message + ' Details: ' + (err.detail || 'none') + '.'; ui.fallback = fallback; renderLibrary();
          return toast(err.message, true);
        }
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; } $('toast-pill').className = 'pill';     // dismiss "Opening..."
        ui.openBytes = null;                                                // pdf.js has its own copy now; the viewer button below reloads it from storage if needed
        d.pages = info.pages; d.opened = Date.now(); save();
        var p = progressOf(hash);
        if (p) { if (p.zoomMode === 'custom' && p.zoomScale) reader.setZoomSilently('custom', p.zoomScale); reader.scrollTo(p); }
        updatePageLabel();
      });
    });
  }
  function showReaderError(text) {
    setBare(false);
    $('reader-error-text').textContent = text + ' Details help me fix it: tap Diagnostics.';
    $('reader-error').hidden = false;
  }

  /** Last resort for devices where pdf.js can't run: hand the file to the browser's own PDF viewer (no position tracking). */
  function openInBrowserViewer(name, bytes) {
    try {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      var w = window.open(url, '_blank');
      if (!w) location.href = url;
    } catch (e) { toast('This browser could not open the PDF either.', true); }
  }
  $('rd-err-viewer').addEventListener('click', function () {
    if (ui.openBytes) openInBrowserViewer('', ui.openBytes);
    else if (ui.openHash) Store.get(ui.openHash, function (e, b) { if (b) openInBrowserViewer('', b); });
  }, false);
  $('rd-err-diag').addEventListener('click', function () { location.href = 'diag.html'; }, false);

  // restore without emitting a position change
  window.RReader.prototype.setZoomSilently = function (mode, scale) { this.zoomMode = mode; if (mode === 'custom') this.scale = Math.max(0.2, Math.min(5, scale)); this._layout(); };

  var saveTimer = null;
  function onPosition(pos) {
    if (!pos || !ui.openHash) return;
    updatePageLabel();
    var existing = state.progress[ui.openHash];
    pos.readingMode = existing ? existing.readingMode : 'continuous';       // the web reader is continuous; never overwrite the Mac's mode choice
    L.saveProgress(state, ui.openHash, pos);
    if (saveTimer) clearTimeout(saveTimer);                              // writing the whole state to localStorage blocks scrolling, so wait until it settles
    saveTimer = setTimeout(flushSave, 600);
  }
  function flushSave() { if (!saveTimer) return; clearTimeout(saveTimer); saveTimer = null; save(); scheduleSync(2500); }

  function closeReader(skipSave) {
    var r = ui.reader;
    if (r && !skipSave && ui.openHash) { var pos = r.getPosition(); if (pos) onPosition(pos); }
    flushSave();
    if (r) r.destroy();
    $('rd-ask').classList.remove('on');
    setBare(false); ui.lastSel = ''; ui.lastSelPage = -1;
    ui.reader = null; ui.openHash = null; show('view-library'); ui.shelfAnim = true; renderLibrary(); RCover.resume(); cloudSyncNow();
  }
  $('rd-back').addEventListener('click', function () { closeReader(false); }, false);
  $('rd-zoom-in').addEventListener('click', function () { ui.reader && ui.reader.zoomBy(1.25); }, false);
  $('rd-zoom-out').addEventListener('click', function () { ui.reader && ui.reader.zoomBy(0.8); }, false);

  $('rd-bookmark').addEventListener('click', function () {
    var r = ui.reader; if (!r || !ui.openHash) return;
    var page = r.currentIndex(), res = L.saveBookmark(state, ui.openHash, page, 'Page ' + (page + 1));
    save(); updateBookmarkIcon(page); bump($('rd-bookmark')); scheduleSync(1500);
    toast(res.replaced ? 'Bookmark on page ' + (page + 1) + ' replaced' : 'Bookmarked page ' + (page + 1), false, 'bookmark-simple-fill');
  }, false);

  $('rd-menu').addEventListener('click', function () {
    var r = ui.reader; if (!r) return;
    openSheet('Bookmarks', function (body) {
      var bms = L.liveBookmarks(state, ui.openHash).sort(function (a, b) { return a.pageIndex - b.pageIndex; });
      if (!bms.length) body.appendChild(h('p', { class: 'note', text: 'No bookmarks yet. Tap the bookmark button to mark a page.' }));
      bms.forEach(function (b) {
        body.appendChild(h('div', { class: 'bm' }, [
          h('button', { class: 'main', type: 'button', onclick: function () { closeSheet(); r.scrollTo({ pageIndex: b.pageIndex, anchorY: null }); } }, [
            h('span', { class: 't', text: b.title }), h('span', { class: 's num', text: 'Page ' + (b.pageIndex + 1) + ', ' + fmtStamp(b.updatedAtMs) })]),
          h('button', { class: 'tool', type: 'button', 'aria-label': 'Delete bookmark on page ' + (b.pageIndex + 1), onclick: function () {
            L.deleteBookmark(state, b.id); save(); updatePageLabel(); scheduleSync(1500); closeSheet(); toast('Bookmark on page ' + (b.pageIndex + 1) + ' removed', false, 'trash'); } }, [icon('trash')])]));
      });
      body.appendChild(h('h3', { text: 'View' }));
      body.appendChild(h('div', { class: 'zoomrow' }, [
        h('button', { class: 'btn', type: 'button', text: 'Zoom out', onclick: function () { r.zoomBy(0.8); } }),
        h('button', { class: 'btn', type: 'button', text: 'Fit width', onclick: function () { r.setZoom('fitWidth'); } }),
        h('button', { class: 'btn', type: 'button', text: 'Zoom in', onclick: function () { r.zoomBy(1.25); } })]));
    });
  }, false);


  // ---------- tap the page to hide or show the top bar ----------
  // The bar floats over the page, so hiding or showing it never moves the PDF.
  function setBare(on) {
    var v = $('view-reader'); if (on) v.classList.add('bare'); else v.classList.remove('bare');
  }
  function isBare() { return $('view-reader').classList.contains('bare'); }
  function hasSelection() { var sel = window.getSelection && window.getSelection(); return !!(sel && String(sel).length); }
  var downHadSel = false;
  function noteDown() { downHadSel = hasSelection(); }
  $('reader-scroll').addEventListener('touchstart', noteDown, true);
  $('reader-scroll').addEventListener('mousedown', noteDown, true);
  $('reader-scroll').addEventListener('click', function (e) {
    var t = e.target; while (t && t !== this) { if (t.tagName === 'A' || t.tagName === 'BUTTON') return; t = t.parentNode; }
    if (downHadSel || hasSelection() || (ui.reader && ui.reader.pinch)) return;
    setBare(!isBare());
  }, false);

  // While the mouse is down inside a page's text, the "end of content" strip covers the page so a drag between lines doesn't leap away.
  $('pages').addEventListener('mousedown', function (e) { var l = e.target; while (l && l !== this && !(l.classList && l.classList.contains('textLayer'))) l = l.parentNode; var end = l && l.classList ? l.querySelector('.endOfContent') : null; if (end) end.classList.add('active'); }, false);
  document.addEventListener('mouseup', function () { var a = document.querySelectorAll('.endOfContent.active'), i; for (i = 0; i < a.length; i++) a[i].classList.remove('active'); }, false);

  // ---------- selected text (kept so Ask AI still has it after the tap on its button clears the highlight) ----------
  document.addEventListener('selectionchange', function () {
    if (!ui.reader) return;
    var sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount || !String(sel) || !sel.anchorNode) return;
    var n = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
    if (!n || !$('pages').contains(n)) return;
    var info = {}, txt = RAsk.selectedText(sel, $('pages'), info);
    if (txt) { ui.lastSel = txt; ui.lastEndDiv = info.last || null; var pg = n; while (pg && pg.className !== 'pg') pg = pg.parentNode; ui.lastSelPage = pg ? Array.prototype.indexOf.call($('pages').children, pg) : -1; }
    if (txt && isBare()) setBare(false);                   // selecting text brings the top bar back, so the AI button is there without reselecting
  }, false);

  // ---------- Ask AI ----------
  var askJob = null;
  // The page text is selectable only in "select mode" (reader.js): always on, it makes dragging lag on an iPad mini 1. The sparkle button turns it on
  // when nothing is selected; the next scroll turns it off again and forgets the remembered selection.
  function onSelectMode(on) {
    var b = $('rd-ask'); if (on) b.classList.add('on'); else b.classList.remove('on');
    if (!on) { ui.lastSel = ''; ui.lastSelPage = -1; ui.lastEndDiv = null; }
  }
  $('rd-ask').addEventListener('click', function () {
    var r = ui.reader;
    if (r && !ui.lastSel && !r.selectMode) { r.setSelectMode(true); toast('Long-press a word to select it. Scrolling turns this off.', false, 'sparkle-star'); return; }
    openAsk();
  }, false);

  /** Saved explanations are shared through the cloud whenever cloud sync is set up (sealed with the sync key). Silent on failure: they sync next time. */
  function syncExplain(done) {
    var cl = cloudClient();
    if (!cl) { if (done) done(null, null); return; }
    cl.syncExplain(RAsk, state.deviceId, function (err, res) { if (done) done(err, res); });
  }

  function openAsk() {
    var d = state.docs[ui.openHash]; if (!d) return;
    var cfg = RAsk.load(), picked = ui.lastSel || ''; ui.nextPage = undefined; ui.cursorDiv = null;
    openSheet('Explain with AI', function (body) {
      var passage = h('textarea', { class: 'field prose', id: 'ask-passage', placeholder: 'Select text in the book first, or paste it here', rows: '4' });
      passage.value = picked;
      var title = h('input', { class: 'field', id: 'ask-title', type: 'text', maxlength: '200', 'aria-label': 'Book title' }); title.value = bookName(d);
      var note = h('input', { class: 'field', id: 'ask-note', type: 'text', maxlength: '600', placeholder: 'Anything else to know? (author, era, what confuses you)', 'aria-label': 'Extra context' });
      var out = h('div', { class: 'ask-out', hidden: 'hidden', 'aria-live': 'polite' });
      var go = h('button', { class: 'btn primary go', type: 'button', text: 'Explain' });
      function fail(msg) { out.hidden = false; out.className = 'ask-out err'; out.textContent = msg; }
      var moreLine = h('button', { class: 'btn quiet', type: 'button', text: 'Add next line', onclick: function () {
        var from = ui.cursorDiv || ui.lastEndDiv;
        if (!from) { toast('Select some text in the book first', true); return; }
        var line = RAsk.nextLine($('pages'), from);
        if (!line) { toast('No further text on screen. Try "Add next page"', true); return; }
        var cur = passage.value;
        if (/\w-$/.test(cur) && /^[a-z]/.test(line.text)) passage.value = cur.slice(0, -1) + line.text;
        else passage.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + line.text;
        ui.cursorDiv = line.last;
      } });
      var more = h('button', { class: 'btn quiet', type: 'button', text: 'Add next page', onclick: function () {
        var from = (typeof ui.nextPage === 'number') ? ui.nextPage : (ui.lastSelPage >= 0 ? ui.lastSelPage + 1 : (ui.reader ? ui.reader.currentIndex() + 1 : -1));
        if (!ui.reader || from < 0 || from >= ui.reader.n) { toast('There is no next page', true); return; }
        ui.reader.pageText(from, function (t) {
          if (!t) { toast('That page has no text to add', true); return; }
          passage.value = (passage.value ? passage.value + '\n\n' : '') + t; ui.nextPage = from + 1; ui.cursorDiv = null;
        });
      } });
      body.appendChild(h('h3', { text: 'Passage' })); body.appendChild(passage);
      body.appendChild(h('div', { class: 'row-actions pair' }, [moreLine, more]));

      // everything about the book and the key sits behind "Advanced"
      var panel = h('div', { class: 'adv-panel', hidden: 'hidden' }), adv = h('button', { class: 'adv', type: 'button', 'aria-expanded': 'false' }, [
        h('span', { class: 'lbl' }, ['Advanced', h('small', { text: 'book, OpenAI key, model' })]), icon('caret-left')]);
      function setAdv(on) { panel.hidden = !on; adv.setAttribute('aria-expanded', on ? 'true' : 'false'); }
      adv.addEventListener('click', function () { setAdv(panel.hidden); }, false);
      panel.appendChild(h('h3', { text: 'Book' })); panel.appendChild(title); panel.appendChild(note);
      var keyBox = h('div'), keyIn = null, modelIn = null;
      function drawKey(editing) {
        clear(keyBox);
        if (cfg.key && !editing) {
          keyBox.appendChild(h('p', { class: 'note', text: 'OpenAI key saved (' + RAsk.mask(cfg.key) + '), model ' + cfg.model + '.' + (cfg.sync ? ' Shared with your other devices through cloud sync.' : ' On this device only.') }));
          keyBox.appendChild(h('div', { class: 'row-actions' }, [
            h('button', { class: 'btn', type: 'button', text: 'Change key', onclick: function () { drawKey(true); } }),
            h('button', { class: 'btn danger', type: 'button', text: 'Remove key', onclick: function () {
              var shared = cfg.sync; RAsk.clear(); cfg = RAsk.load(); drawKey(true); if (shared) syncAiKey(null);
              toast(shared ? 'Key removed here and from your synced devices' : 'Key removed from this device', false, 'trash'); } })]));
        } else {
          keyIn = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'OpenAI API key (starts with sk-)', 'aria-label': 'OpenAI API key' });
          modelIn = h('input', { class: 'field', type: 'text', autocapitalize: 'off', autocorrect: 'off', 'aria-label': 'Model' }); modelIn.value = cfg.model;
          keyBox.appendChild(h('h3', { text: 'OpenAI key' })); keyBox.appendChild(keyIn); keyBox.appendChild(modelIn);
        }
        if (cloudCfg()) {
          var box = h('input', { type: 'checkbox', id: 'ask-sync' }); box.checked = !!cfg.sync;
          box.addEventListener('change', function () {
            RAsk.setSync(box.checked); cfg = RAsk.load();
            if (box.checked) syncAiKey(function (err) {
              cfg = RAsk.load();
              if (err) toast('Could not reach the cloud just now. It will share the key on the next sync.', true);
              else { toast(cfg.key ? 'Key shared with your other devices' : 'Picked up no key yet: add it on any device'); }
              if (cfg.key && !keyIn) drawKey(false); else if (cfg.key && keyIn && !keyIn.value) drawKey(false);
            });
          }, false);
          keyBox.appendChild(h('label', { class: 'note', for: 'ask-sync', style: 'display:block' }, [box, ' Sync this key to my other devices (stored in your cloud, encrypted with your cloud sync key)']));
        } else keyBox.appendChild(h('p', { class: 'note', text: 'Set up cloud sync if you want to enter the key once and use it on all your devices.' }));
      }
      drawKey(!cfg.key); panel.appendChild(keyBox);
      if (cfg.sync) syncAiKey(function () { cfg = RAsk.load(); if (cfg.key && keyIn && !keyIn.value) drawKey(false); });
      panel.appendChild(h('p', { class: 'note', text: 'Sends the passage and book title to OpenAI using your key. The key is never shown again, and is only shared through cloud sync if you tick the box above.' }));
      setAdv(!cfg.key);                                                        // no key yet: the key field is needed, so start open
      body.appendChild(adv); body.appendChild(panel);
      body.appendChild(go); body.appendChild(out);
      var saved = RAsk.liveExplain(ui.openHash).length;
      if (saved || cloudCfg()) body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn quiet', type: 'button', text: saved ? 'Saved explanations (' + saved + ')' : 'Saved explanations', onclick: openSaved })]));
      go.addEventListener('click', function () {
        var text = passage.value.replace(/^\s+|\s+$/g, '');
        if (!text) { fail('Select some text in the book, or paste a passage above.'); return; }
        if (keyIn) {
          if (!keyIn.value && !cfg.key) { setAdv(true); fail('Enter your OpenAI API key first.'); return; }
          if (keyIn.value) {
            if (!RAsk.save(keyIn.value, modelIn.value)) { setAdv(true); fail('That does not look like an API key. Paste it again without spaces.'); return; }
            keyIn.value = ''; cfg = RAsk.load(); drawKey(false); syncAiKey(null);
          } else if (RAsk.cleanModel(modelIn.value) !== cfg.model) { RAsk.setModel(modelIn.value); cfg = RAsk.load(); syncAiKey(null); }
        }
        if (askJob) askJob.abort();
        go.disabled = true; go.textContent = 'Thinking...'; out.hidden = false; out.className = 'ask-out'; out.textContent = '';
        askJob = RAsk.explain(cfg, { passage: text, title: title.value, note: note.value }, function (r) {
          askJob = null; go.disabled = false; go.textContent = 'Explain';
          if (!r.ok) { fail(r.message); return; }
          var rec = RAsk.addExplain({ hash: ui.openHash, book: title.value, page: ui.lastSelPage >= 0 ? ui.lastSelPage : (ui.reader ? ui.reader.currentIndex() : 0), passage: text, text: r.text, model: cfg.model });
          closeSheet(); showCard(rec); syncExplain(null);
        });
      }, false);
    });
  }
  $('sheet-close').addEventListener('click', function () { if (askJob) { askJob.abort(); askJob = null; } }, false);
  $('shade').addEventListener('click', function () { if (askJob) { askJob.abort(); askJob = null; } }, false);

  /** This book's saved explanations (from every device that shares the cloud), newest first. */
  function openSaved() {
    function draw(body) {
      clear(body);
      var list = RAsk.liveExplain(ui.openHash);
      body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn quiet', type: 'button', text: 'Back', onclick: openAsk })]));
      if (!list.length) body.appendChild(h('p', { class: 'note', text: cloudCfg() ? 'Nothing saved for this book yet. Explanations are kept here and in your cloud.' : 'Nothing saved for this book yet. Set up cloud sync to keep them on all your devices.' }));
      list.forEach(function (r) {
        body.appendChild(h('div', { class: 'bm' }, [
          h('button', { class: 'main', type: 'button', onclick: function () { closeSheet(); showCard(r); } }, [
            h('span', { class: 't', text: r.passage.replace(/\s+/g, ' ').slice(0, 80) || 'Explanation' }), h('span', { class: 's num', text: 'Page ' + (r.page + 1) + ', ' + fmtStamp(r.createdAtMs) })]),
          h('button', { class: 'tool', type: 'button', 'aria-label': 'Delete this explanation', onclick: function () { deleteExplanation(r.id); draw(body); } }, [icon('trash')])]));
      });
    }
    openSheet('Saved explanations', function (body) {
      draw(body);
      syncExplain(function (err, res) { if (!err && res && res.pulled && $('sheet-title').textContent === 'Saved explanations') draw(body); });
    });
  }
  function deleteExplanation(id) { RAsk.removeExplain(id); syncExplain(null); toast('Explanation deleted', false, 'trash'); }

  // ---------- the explanation card, laid over the page ----------
  function closeCard() { var o = $('ai-overlay'); clear(o); o.hidden = true; }
  document.addEventListener('keydown', function (e) { if (e.keyCode === 27 && !$('ai-overlay').hidden) closeCard(); }, false);
  function inline(text) {
    var parts = text.split(/\*\*(.+?)\*\*/), kids = [], i;
    for (i = 0; i < parts.length; i++) if (parts[i]) kids.push(i % 2 ? h('strong', { text: parts[i] }) : parts[i]);
    return kids;
  }
  function showCard(rec) {
    var o = $('ai-overlay'); clear(o);
    var paras = String(rec.text || '').replace(/^#{1,6}\s*/gm, '').split(/\n{2,}/), text = h('div', { class: 'ai-text' }), i;
    for (i = 0; i < paras.length; i++) { var t = paras[i].replace(/^\s+|\s+$/g, ''); if (t) text.appendChild(h('p', {}, inline(t))); }
    var done = h('button', { class: 'go', type: 'button', text: 'Done', onclick: closeCard });
    var card = h('div', { class: 'ai-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ai-card-title' }, [
      h('i', { class: 'ai-rib', 'aria-hidden': 'true' }),
      h('div', { class: 'ai-eyebrow' }, [icon('sparkle-star'), 'AI explanation']),
      h('h2', { id: 'ai-card-title', text: 'In plain words' }),
      h('div', { class: 'ai-meta', text: (rec.book ? rec.book + ' · ' : '') + 'page ' + (rec.page + 1) + ' · ' + agoShort(rec.createdAtMs) }),
      rec.passage ? h('blockquote', { class: 'ai-quote' }, [h('span', { text: '“' + rec.passage.replace(/\s+/g, ' ') + '”' })]) : null,
      text,
      h('div', { class: 'ai-act' }, [done, h('span', { class: 'sp' }),
        h('button', { class: 'btn quiet', type: 'button', text: 'Ask again', onclick: function () { closeCard(); ui.lastSel = rec.passage; ui.lastSelPage = rec.page; ui.lastEndDiv = null; openAsk(); } }),
        h('button', { class: 'btn quiet danger', type: 'button', 'aria-label': 'Delete this explanation', onclick: function () { closeCard(); deleteExplanation(rec.id); } }, [icon('trash'), 'Delete'])])]);
    o.addEventListener('click', function (e) { if (e.target === o) closeCard(); }, false);
    o.appendChild(card); o.hidden = false;
  }

  $('remote-jump').addEventListener('click', function () { var p = ui.pendingRemote; $('remote-banner').hidden = true; ui.pendingRemote = null; if (p && ui.reader) { ui.reader.scrollTo(p); } }, false);
  $('remote-stay').addEventListener('click', function () { $('remote-banner').hidden = true; ui.pendingRemote = null; }, false);

  // ---------- sync ----------
  function checkRemoteJump(open, before, who) {
    var now = open ? state.progress[open] : null;
    if (open && ui.reader && now && now !== before && now.originDeviceId !== state.deviceId && now.pageIndex !== ui.reader.currentIndex()) {
      ui.pendingRemote = now; $('remote-text').textContent = who + ' is on page ' + (now.pageIndex + 1) + '.'; $('remote-banner').hidden = false;
    }
  }
  var syncTimer = null;
  function scheduleSync(ms) { if (syncTimer) clearTimeout(syncTimer); syncTimer = setTimeout(function () { syncTimer = null; cloudSyncNow(); }, ms); }

  $('btn-sync').addEventListener('click', function () {
    if (!cloudClient()) { toast('Cloud sync is not set up yet. Tap the cloud button.', true); return; }     // a tap must never do nothing
    if (ui.cloudSyncing) { toast('Already syncing', false, 'arrows-clockwise'); return; }
    cloudSyncNow(true);
  }, false);
  $('btn-cloud').addEventListener('click', function () { openCloudSheet(); }, false);

  function diagButton(body) {
    body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn quiet', type: 'button', text: 'Run diagnostics', onclick: function () { location.href = 'diag.html'; } })]));
    body.appendChild(h('p', { class: 'note', text: 'Version ' + VERSION_LABEL + (navigator.standalone ? ', installed app' : ', in the browser') + '.' }));
  }

  // ---------- cloud sync (end-to-end encrypted mailbox in the user's own private GitHub repository) ----------
  function cloudCfg() { var c = state.cloud; return c && c.repo && c.token && c.key ? c : null; }
  function cloudClient() {
    var c = cloudCfg(); if (!c) return null;
    if (!ui.cloudObj || ui.cloudObj.cfg !== c) ui.cloudObj = new RCloud.Cloud(c);
    return ui.cloudObj;
  }

  function cloudSyncNow(manual) {
    var cl = cloudClient();
    if (!cl || ui.cloudSyncing) return;
    if (!manual && Date.now() - ui.cloudLast < 8000) return;           // be polite to the API
    ui.cloudSyncing = true; ui.cloudLast = Date.now(); renderStatus();
    var open = ui.openHash, before = open ? state.progress[open] : null;
    state.cloudUploaded = state.cloudUploaded || {};
    cl.sync(state, function (err, res) {
      ui.cloudSyncing = false;
      if (err) { ui.cloudErr = err; renderStatus(); if ($('view-library').className.indexOf('on') >= 0) renderLibrary(); if (manual) toast(err.message, true); return; }
      ui.cloudErr = null; state.cloud.lastSync = Date.now(); save();
      checkRemoteJump(open, before, 'Another device');
      renderStatus(); if ($('view-library').className.indexOf('on') >= 0) renderLibrary();
      backupPdfs(); autoDownload(); syncAiKey(null); syncExplain(null);
      if (manual) toast(res.adopted ? 'Synced. Picked up changes from your other devices.' : 'Synced with the cloud');
    });
  }

  /** Shares the OpenAI key through the cloud when this device opted in. Silent: a hiccup here never disturbs reading sync. */
  function syncAiKey(done) {
    var cl = cloudClient();
    if (!cl || !RAsk.load().sync) { if (done) done(null); return; }
    cl.syncAi(RAsk, state.deviceId, function (err, res) { if (done) done(err, res); });
  }

  function cloudBusy(hash, text, done, total) { ui.busy[hash] = { text: text, done: done || 0, total: total || 0 }; if ($('view-library').className.indexOf('on') >= 0) renderLibrary(); }
  function cloudIdle(hash) { delete ui.busy[hash]; if ($('view-library').className.indexOf('on') >= 0) renderLibrary(); }

  /** Back up PDFs this device has that the cloud doesn't, one at a time (resumable: finished chunks are skipped). */
  function backupPdfs() {
    var cl = cloudClient(); if (!cl || state.cloud.auto === false) return;
    state.cloudUploaded = state.cloudUploaded || {};
    L.sortedDocs(state).forEach(function (d) {
      if (state.cloudUploaded[d.hash] || ui.backing[d.hash] || ui.busy[d.hash]) return;
      ui.backing[d.hash] = true;
      Store.get(d.hash, function (e, bytes) {
        if (!bytes) { delete ui.backing[d.hash]; return; }
        cloudBusy(d.hash, 'Backing up...', 0, bytes.length);
        var last = 0;
        cl.uploadPdf(d, bytes, function (done, total) { if (Date.now() - last > 250) { last = Date.now(); cloudBusy(d.hash, 'Backing up ' + Math.round(100 * done / total) + '%', done, total); } }, function (err) {
          delete ui.backing[d.hash]; cloudIdle(d.hash);
          if (err) { ui.cloudErr = err; renderStatus(); return; }
          state.cloudUploaded[d.hash] = true; save(); renderLibrary();
        });
      });
    });
  }

  function autoDownload() {
    var cl = cloudClient(); if (!cl || !state.cloud.autoDownload || ui.autoDl) return;
    var next = RCloud.cloudDocs(state).filter(function (d) { return !state.docs[d.hash] && !ui.busy[d.hash]; })[0];
    if (!next) return;
    ui.autoDl = true; downloadFromCloud(next, function () { ui.autoDl = false; autoDownload(); });
  }

  function downloadFromCloud(d, done) {
    var cl = cloudClient(); if (!cl) return;
    cloudBusy(d.hash, 'Downloading...', 0, d.size);
    var last = 0;
    cl.downloadPdf(d.hash, function (n, total) { if (Date.now() - last > 250) { last = Date.now(); cloudBusy(d.hash, 'Downloading ' + Math.round(100 * n / total) + '%', n, total); } }, function (err, bytes) {
      if (err) { cloudIdle(d.hash); toast(err.code === 'not-in-cloud' ? 'Not uploaded yet. The other device may still be backing it up.' : err.message, true); if (done) done(); return; }
      Store.put(d.hash, bytes, function (e2) {
        cloudIdle(d.hash);
        if (e2) { ui.lastErr = e2.message + ' It will work until you close the app, then you would need to download it again.'; ui.fallback = null; }
        L.upsertDoc(state, { hash: d.hash, name: d.name, size: d.size || bytes.length, pages: d.pages || null, added: Date.now(), opened: null });
        state.cloudUploaded = state.cloudUploaded || {}; state.cloudUploaded[d.hash] = true;
        save(); RCover.makeFrom(d.hash, bytes); renderLibrary(); toast('Downloaded ' + d.name); if (done) done();
      });
    });
  }

  function renderCloud(list, empty) {
    var docs = RCloud.cloudDocs(state);
    if (!docs.length) return emptyState(empty, 'Nothing in the cloud yet', 'PDFs you add on any device are backed up here, encrypted, and show up on your other devices.', [
      h('button', { class: 'btn primary', type: 'button', text: 'Sync now', onclick: function () { cloudSyncNow(true); } })]);
    wantCovers(docs.filter(function (d) { return !!state.docs[d.hash]; }));
    shelvesInto(list, docs.map(function (d) {
      var have = !!state.docs[d.hash], busy = ui.busy[d.hash], name = bookName(d);
      return { hash: d.hash, name: name, ghost: !have, aria: (have ? 'Open ' : 'Download ') + name,
        open: function () { if (have) openReader(d.hash); else if (!busy) downloadFromCloud(d); },
        label: { name: name, busy: busy, small: (d.pages ? d.pages + ' pages · ' : '') + fmtSize(d.size || 0) + (have ? ' · on this device' : ' · tap to download'),
                 x: { label: 'Delete ' + name + ' from the cloud', fn: function () { confirmDeleteCloud(d); } } } };
    }), 0);
  }

  function confirmDeleteCloud(d) {
    openSheet('Delete from the cloud?', function (body) {
      body.appendChild(h('p', { text: '"' + d.name + '" will be removed from the cloud for all your devices. Copies already on a device stay there.' }));
      body.appendChild(h('div', { class: 'row-actions' }, [
        h('button', { class: 'btn danger', type: 'button', text: 'Delete from cloud', onclick: function () {
          closeSheet(); var cl = cloudClient(); if (!cl) return; cloudBusy(d.hash, 'Deleting...');
          cl.deletePdf(d.hash, function (err) {
            cloudIdle(d.hash); if (err) return toast(err.message, true);
            RCloud.markDeleted(state, d.hash); if (state.cloudUploaded) delete state.cloudUploaded[d.hash]; save(); renderLibrary(); cloudSyncNow(true); toast('Deleted from the cloud', false, 'trash');
          });
        } }),
        h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeSheet })]));
    });
  }

  function C_hex8(keyB64) { var C = window.RCrypto; return C.hex(C.sha256(C.b64decode(keyB64))).slice(0, 8); }

  function cloudField(id, label, type, placeholder) {
    var input = h('input', { id: id, type: type, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', placeholder: placeholder || '' });
    input.className = 'field';
    return [h('label', { class: 'note', for: id, text: label }), input];
  }

  /** Validates, stores and starts syncing with this configuration. */
  function activateCloud(cfg, msg, then) {
    msg.textContent = 'Checking the repository and token...';
    var probe = new RCloud.Cloud(cfg);
    probe.check(function (err) {
      if (err) { msg.textContent = err.message; return; }
      state.cloud = { repo: cfg.repo, token: cfg.token, key: cfg.key, api: cfg.api, auto: true, autoDownload: false };
      state.cloudUploaded = {}; ui.cloudObj = null; ui.cloudErr = null; save();
      cloudSyncNow(true); then();
    });
  }

  function cloudSetupForm(body) {
    body.appendChild(h('p', { text: 'Keep your reading position, bookmarks and PDFs in step across devices, even when they are never online at the same time. Everything is encrypted on your devices before it goes to your own private GitHub repository.' }));
    body.appendChild(h('h3', { text: 'This is my first device' }));
    body.appendChild(h('p', { class: 'note', text: 'On GitHub: create a private repository (for example "readen-data"), then create a fine-grained access token for only that repository with "Contents: Read and write". Enter both here.' }));
    cloudField('cl-repo', 'Repository (owner/name)', 'text', 'yourname/readen-data').forEach(function (n) { body.appendChild(n); });
    cloudField('cl-token', 'Access token', 'password', 'github_pat_...').forEach(function (n) { body.appendChild(n); });
    cloudField('cl-relay1', 'Relay address (leave empty unless this device can\'t reach GitHub)', 'text', 'https://yourname-readen.netlify.app').forEach(function (n) { body.appendChild(n); });
    var msg1 = h('p', { class: 'note', role: 'alert' }); body.appendChild(msg1);
    body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Start cloud sync', onclick: function () {
      var repo = $('cl-repo').value.replace(/^\s+|\s+$/g, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''), token = $('cl-token').value.replace(/\s+/g, '');
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) { msg1.textContent = 'Type the repository as owner/name, for example yourname/readen-data.'; return; }
      if (token.length < 20) { msg1.textContent = 'Paste the access token from GitHub.'; return; }
      var relay1 = $('cl-relay1').value.replace(/\s+/g, '').replace(/\/+$/, '');
      if (relay1 && !/^https:\/\/[\w.\-]+\.(workers\.dev|val\.run|netlify\.app)$/.test(relay1)) { msg1.textContent = 'The relay address should look like https://yourname-readen.netlify.app'; return; }
      activateCloud({ repo: repo, token: token, key: RCloud.newKey(), api: relay1 || 'https://api.github.com' }, msg1, function () { closeSheet(); openCloudSheet(); });
    } })]));
    body.appendChild(h('h3', { text: 'I already set it up on another device' }));
    body.appendChild(h('p', { class: 'note', text: 'On that device open Cloud sync, choose "Show setup code", copy it (Messages or Notes work), and paste it here.' }));
    var ta = h('textarea', { id: 'cl-code', rows: '3', placeholder: 'RDN1....', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }); ta.className = 'field';
    body.appendChild(ta);
    cloudField('cl-relay', 'Relay address (leave empty unless this device can\'t reach GitHub)', 'text', 'https://yourname-readen.netlify.app').forEach(function (n) { body.appendChild(n); });
    var msg2 = h('p', { class: 'note', role: 'alert' }); body.appendChild(msg2);
    body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Join', onclick: function () {
      var cfg = RCloud.parseSetupCode(ta.value);
      if (!cfg) { msg2.textContent = 'That doesn\'t look like a Readen setup code. Copy the whole code, starting with RDN1.'; return; }
      var relay = $('cl-relay').value.replace(/\s+/g, '').replace(/\/+$/, '');
      if (relay) { if (!/^https:\/\/[\w.\-]+\.(workers\.dev|val\.run|netlify\.app)$/.test(relay)) { msg2.textContent = 'The relay address should look like https://yourname-readen.netlify.app'; return; } cfg.api = relay; }
      activateCloud(cfg, msg2, function () { closeSheet(); openCloudSheet(); });
    } })]));
  }

  function toggleRow(label, checked, onChange) {
    var input = h('input', { type: 'checkbox' }); input.checked = checked;
    input.addEventListener('change', function () { onChange(input.checked); }, false);
    return h('label', { class: 'toggle' }, [input, h('span', { text: label })]);
  }

  function openCloudSheet() {
    openSheet('Cloud sync', function (body) {
      diagButton(body);
      var c = cloudCfg();
      if (!c) return cloudSetupForm(body);
      body.appendChild(h('p', { text: 'Connected to ' + c.repo + '.' }));
      try { body.appendChild(h('p', { class: 'note', text: 'Key fingerprint: ' + C_hex8(c.key) + (c.api && c.api.indexOf('api.github.com') < 0 ? ' · via relay ' + c.api.replace(/^https:\/\//, '') : '') + ' (same on every device that shares this cloud)' })); } catch (e) { }
      body.appendChild(h('p', { class: 'note', text: c.lastSync ? 'Last sync: ' + fmtStamp(c.lastSync) : 'Not synced yet.' }));
      if (ui.cloudErr) body.appendChild(h('p', { class: 'note', role: 'alert', text: ui.cloudErr.message }));
      body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Sync now', onclick: function () { closeSheet(); cloudSyncNow(true); } })]));
      body.appendChild(toggleRow('Back up my PDFs automatically', c.auto !== false, function (v) { c.auto = v; save(); if (v) backupPdfs(); }));
      body.appendChild(toggleRow('Download new PDFs from my other devices automatically', !!c.autoDownload, function (v) { c.autoDownload = v; save(); if (v) autoDownload(); }));
      body.appendChild(h('p', { class: 'note', text: 'Automatic backup uses mobile data when you are not on Wi-Fi. Large PDFs are sent in small encrypted pieces and resume if interrupted.' }));
      var codeBox = h('div');
      body.appendChild(h('div', { class: 'row-actions' }, [
        h('button', { class: 'btn', type: 'button', text: 'Show setup code for another device', onclick: function () {
          clear(codeBox);
          codeBox.appendChild(h('p', { class: 'note', text: 'Treat this code like a password: it contains the encryption key and the access token. Send it only to your own devices (Messages or Notes to yourself), then paste it into Cloud sync on the other device.' }));
          var ta = h('textarea', { rows: '4', readonly: 'readonly' }); ta.className = 'field'; ta.value = RCloud.makeSetupCode(c); codeBox.appendChild(ta);
          codeBox.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn', type: 'button', text: 'Select and copy', onclick: function () {
            ta.focus(); ta.select(); try { ta.setSelectionRange(0, ta.value.length); document.execCommand('copy'); toast('Copied. If nothing happened, touch and hold the code and choose Copy.', false, 'copy'); } catch (e) { toast('Touch and hold the code, then choose Copy.', false, 'copy'); }
          } })]));
        } }),
        h('button', { class: 'btn danger', type: 'button', text: 'Turn off on this device', onclick: function () {
          clear(body);
          body.appendChild(h('p', { text: 'Turn off cloud sync on this device? Your PDFs, positions and bookmarks here stay. What is in the cloud stays too, and other devices keep syncing.' }));
          body.appendChild(h('div', { class: 'row-actions' }, [
            h('button', { class: 'btn danger', type: 'button', text: 'Turn off', onclick: function () { closeSheet(); state.cloud = null; ui.cloudObj = null; ui.cloudErr = null; save(); renderLibrary(); } }),
            h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeSheet })]));
        } })]));
      body.appendChild(codeBox);
    });
  }

  /** A setup code can also arrive as a link fragment (#sync=...). */
  function handleSetupFragment() {
    var m = /[#&]sync=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    var code = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
    if (!RCloud.parseSetupCode(code)) { toast('That setup link is not valid.', true); return; }
    openSheet('Set up cloud sync here?', function (body) {
      var msg = h('p', { class: 'note', role: 'alert' });
      body.appendChild(h('p', { text: 'This link carries the settings for your cloud sync. If you did not create it yourself, do not continue.' }));
      body.appendChild(msg);
      body.appendChild(h('div', { class: 'row-actions' }, [
        h('button', { class: 'btn primary', type: 'button', text: 'Set up', onclick: function () { activateCloud(RCloud.parseSetupCode(code), msg, function () { closeSheet(); }); } }),
        h('button', { class: 'btn', type: 'button', text: 'Not now', onclick: closeSheet })]));
    });
  }

  // ---------- boot ----------
  setInterval(function () { if (!document.hidden && !document.webkitHidden) { cloudSyncNow(); renderStatus(); } }, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) cloudSyncNow();
    else if (ui.reader && ui.openHash) { var p = ui.reader.getPosition(); if (p) onPosition(p); flushSave(); }   // pagehide does not always fire when the app is sent to the background
  }, false);
  window.addEventListener('online', function () { cloudSyncNow(true); }, false);
  window.addEventListener('pagehide', function () { if (ui.reader && ui.openHash) { var p = ui.reader.getPosition(); if (p) onPosition(p); } flushSave(); }, false);

  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) { } }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      var had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (had) toast('Updated. Close and reopen Readen to use the new version.', false, 'arrows-clockwise'); had = true; });
    }, function () { });
  }
  RScene.mount($('scene'));
  var coverTimer = null;
  RCover.onDone(function (hash, res) {
    if (res && res.pages && state.docs[hash] && !state.docs[hash].pages) { state.docs[hash].pages = res.pages; save(); }
    if (coverTimer) return;
    coverTimer = setTimeout(function () { coverTimer = null; if ($('view-library').className.indexOf('on') >= 0 && !ui.openHash) renderLibrary(); }, 120);
  });
  var resizeTimer = null;
  window.addEventListener('resize', function () { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { resizeTimer = null; if ($('view-library').className.indexOf('on') >= 0) renderLibrary(); }, 200); }, false);
  show('view-library'); renderLibrary();
  if (cloudCfg()) cloudSyncNow(true);
  handleSetupFragment();
  // AppCache (iOS 9) downloads a new version in the background but only uses it on the next launch; swap in at once when not reading.
  (function () {
    var ac = window.applicationCache; if (!ac || !ac.addEventListener) return;
    ac.addEventListener('updateready', function () {
      try { ac.swapCache(); } catch (e) { return; }
      if (!ui.reader) window.location.reload();
    }, false);
    if (ac.status === ac.UPDATEREADY) { try { ac.swapCache(); } catch (e) { } if (!ui.reader) window.location.reload(); }
  }());
}());
