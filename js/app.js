/* Readen web app: pairing, library, reader glue, bookmarks, sync. ES5, no frameworks (must run on iOS 9 Safari). */
(function () {
  'use strict';
  var C = window.RCrypto, Api = window.RApi, L = window.RLogic, Store = window.RStore, RCloud = window.RCloud;
  var KEY = 'readen.state.v1';
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
  var client = new Api.Client({ transport: Api.xhrTransport(state.macBase || ''), state: state, save: save });
  var ui = { cloudSyncing: false, cloudErr: null, cloudObj: null, cloudLast: 0, backing: {}, autoDl: false, sameOrigin: null, tab: 'local', macDocs: null, macError: null, syncing: false, status: 'idle', openHash: null, reader: null, pendingRemote: null, busy: {}, pairSession: null, lastErr: null };

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
  function deviceLabel() { var u = navigator.userAgent || ''; return /iPad/.test(u) ? 'iPad' : /iPhone|iPod/.test(u) ? 'iPhone' : 'Web browser'; }
  function show(id) { var v = document.querySelectorAll('.view'), i; for (i = 0; i < v.length; i++) v[i].className = 'view' + (v[i].id === id ? ' on' : ''); }

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
    var chip = $('status-chip'), cls = 'chip', t, cloud = cloudCfg(), paired = client.isPaired();
    var last = Math.max(paired ? (state.lastSync || 0) : 0, cloud ? (state.cloud.lastSync || 0) : 0);
    var bad = (paired && ui.status === 'error') || (ui.cloudErr && ui.cloudErr.code !== 'network');
    if (!paired && !cloud) t = 'Offline reader';
    else if (ui.syncing || ui.cloudSyncing) t = 'Syncing...';
    else if (bad) { t = 'Needs attention'; cls += ' warn'; }
    else if (paired && !cloud && ui.status === 'offline') { t = 'Mac unreachable'; cls += ' warn'; }
    else if (last) { t = 'Synced ' + agoShort(last); cls += ' ok'; }
    else t = cloud && !paired ? 'Cloud ready' : 'Connected';
    chip.className = cls; chip.textContent = t;
  }

  // ---------- pairing ----------
  function pairUI(stage, msg) {
    $('pair-code-box').hidden = stage !== 'code' && stage !== 'waiting';
    $('pair-start').hidden = stage !== 'start';
    $('pair-confirm').hidden = stage !== 'code';
    $('pair-cancel').hidden = stage !== 'code';
    $('pair-back').hidden = stage !== 'start';
    $('pair-title').textContent = stage === 'code' || stage === 'waiting' ? 'Check the code' : 'Connect to your Mac';
    $('pair-body').textContent = stage === 'code' ? ''
      : stage === 'waiting' ? '' : 'This page is served by Readen on your Mac. Pair once to sync your reading position and move PDFs between devices.';
    var err = $('pair-error'); err.hidden = !msg; if (msg) err.querySelector('.txt').textContent = msg;
    $('pair-local').textContent = 'Mac: ' + (state.macBase ? state.macBase.replace(/^https?:\/\//, '') : location.host);
    if (stage === 'waiting') $('pair-code-help').textContent = 'Waiting for you to approve on the Mac...';
    if (stage === 'code') $('pair-code-help').textContent = 'The same six digits should be showing on your Mac. If they match, tap Codes match here, then approve on the Mac. If they differ, tap Cancel.';
  }
  function startPairing() {
    pairUI('start'); $('pair-start').disabled = true;
    client.beginPairing(deviceLabel(), function (err, session) {
      $('pair-start').disabled = false;
      if (err) return pairUI('start', err.message);
      ui.pairSession = session;
      $('pair-code').textContent = session.code.substr(0, 3) + ' ' + session.code.substr(3);
      pairUI('code');
    });
  }
  $('pair-start').addEventListener('click', startPairing, false);
  $('pair-confirm').addEventListener('click', function () {
    var s = ui.pairSession; if (!s) return; pairUI('waiting');
    s.confirm(true, function (err) {
      ui.pairSession = null;
      if (err) return pairUI('start', err.message);
      state.lastSync = 0; save(); toast('Paired with ' + (state.serverName || 'your Mac')); enterLibrary();
    });
  }, false);
  $('pair-back').addEventListener('click', function () { show('view-library'); renderLibrary(); }, false);
  $('pair-cancel').addEventListener('click', function () {
    var s = ui.pairSession; ui.pairSession = null; pairUI('start');
    if (s) s.confirm(false, function () { });
  }, false);

  // ---------- library ----------
  function progressOf(hash) { var p = state.progress[hash]; return p ? p : null; }

  function renderLibrary() {
    renderStatus();
    if (!client.isPaired() && ui.tab === 'mac') ui.tab = 'local';
    if (!cloudCfg() && ui.tab === 'cloud') ui.tab = 'local';
    $('tab-mac').hidden = !client.isPaired(); $('tab-cloud').hidden = !cloudCfg();
    $('tab-local').className = ui.tab === 'local' ? 'on' : ''; $('tab-mac').className = ui.tab === 'mac' ? 'on' : ''; $('tab-cloud').className = ui.tab === 'cloud' ? 'on' : '';
    var list = $('lib-list'), empty = $('lib-empty'); clear(list); empty.hidden = true;
    var banner = $('lib-banner'); clear(banner);
    if (ui.lastErr) {
      var errBox = h('div', { class: 'banner err', role: 'alert' }, [h('span', { class: 'txt', text: ui.lastErr })]);
      if (ui.fallback) errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Open in browser viewer', onclick: function () { openInBrowserViewer(ui.fallback.name, ui.fallback.bytes); } }));
      errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Diagnostics', onclick: function () { location.href = 'diag.html'; } }));
      errBox.appendChild(h('button', { class: 'btn quiet', type: 'button', text: 'Dismiss', onclick: function () { ui.lastErr = null; ui.fallback = null; renderLibrary(); } }));
      banner.appendChild(errBox);
    }
    if (ui.cloudErr && ui.cloudErr.code !== 'network') {
      banner.appendChild(h('div', { class: 'banner err', role: 'alert' }, [h('span', { class: 'txt', text: 'Cloud sync: ' + ui.cloudErr.message }),
        h('button', { class: 'btn quiet', type: 'button', text: 'Cloud settings', onclick: openCloudSheet })]));
    }
    if (!Store.isPersistent() && ui.tab === 'local') banner.appendChild(h('div', { class: 'banner' }, [h('span', { class: 'txt', text: 'This browser can\'t keep PDFs between visits, so they may disappear when you close it.' })]));
    if (ui.tab === 'local') renderLocal(list, empty); else if (ui.tab === 'cloud') renderCloud(list, empty); else renderMac(list, empty);
  }

  function emptyState(box, title, text, actions) {
    clear(box); box.hidden = false;
    box.appendChild(h('h2', { text: title })); box.appendChild(h('p', { text: text }));
    for (var i = 0; i < actions.length; i++) box.appendChild(actions[i]);
  }

  function renderLocal(list, empty) {
    var docs = L.sortedDocs(state).sort(function (a, b) { return (b.opened || 0) - (a.opened || 0) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1); });
    if (!docs.length) {
      var paired = client.isPaired();
      return emptyState(empty, 'No PDFs on this device yet', paired ? 'Download one from your Mac, or add a PDF from this device.' : 'Add a PDF from this device. Everything works offline. Connect to your Mac whenever you want to sync or move PDFs.', [
        h('button', { class: 'btn primary', type: 'button', text: 'Add a PDF', onclick: function () { $('file-input').click(); } }),
        document.createTextNode(' '),
        paired ? h('button', { class: 'btn', type: 'button', text: 'Show the Mac library', onclick: function () { ui.tab = 'mac'; renderLibrary(); loadMac(); } })
               : h('button', { class: 'btn', type: 'button', text: 'Connect to a Mac', onclick: openMacSheet })]);
    }
    var onMac = {}; if (ui.macDocs) for (var m = 0; m < ui.macDocs.length; m++) onMac[ui.macDocs[m].hash] = true;
    docs.forEach(function (d) {
      var p = progressOf(d.hash), meta = (d.pages ? d.pages + (d.pages === 1 ? ' page' : ' pages') + ', ' : '') + fmtSize(d.size) + (p ? ', on page ' + (p.pageIndex + 1) : '') + (cloudCfg() && state.cloudUploaded && state.cloudUploaded[d.hash] ? ', in the cloud' : '');
      var busy = ui.busy[d.hash], row = h('li', { class: 'item' });
      row.appendChild(h('span', { class: 'ico' }, [icon('file-pdf')]));
      var main = h('button', { class: 'main', type: 'button', onclick: function () { openReader(d.hash); } }, [h('span', { class: 'name', text: d.name }), h('span', { class: 'meta num', text: busy ? busy.text : meta })]);
      if (busy && busy.total) main.appendChild(h('div', { class: 'bar-progress' }, [h('i', { style: 'width:' + Math.round(100 * busy.done / busy.total) + '%' })]));
      row.appendChild(main);
      if (!busy && client.isPaired() && ui.macDocs && !onMac[d.hash]) row.appendChild(h('button', { class: 'tool side', type: 'button', 'aria-label': 'Send ' + d.name + ' to the Mac', onclick: function () { sendToMac(d); } }, [icon('upload-simple')]));
      if (!busy) row.appendChild(h('button', { class: 'tool side', type: 'button', 'aria-label': 'Remove ' + d.name + ' from this device', onclick: function () { confirmRemove(d); } }, [icon('trash')]));
      list.appendChild(row);
    });
  }

  function renderMac(list, empty) {
    if (!client.isPaired()) return emptyState(empty, 'Not paired', 'Connect to your Mac to see its library.', [h('button', { class: 'btn primary', type: 'button', text: 'Connect to a Mac', onclick: openMacSheet })]);
    if (ui.macDocs === null) return emptyState(empty, ui.macError ? 'Can\'t reach the Mac' : 'Loading...', ui.macError || 'Asking your Mac for its library.', ui.macError ? [h('button', { class: 'btn primary', type: 'button', text: 'Try again', onclick: loadMac })] : []);
    if (!ui.macDocs.length) return emptyState(empty, 'The Mac library is empty', 'Import a PDF in Readen on the Mac and it will show up here.', []);
    ui.macDocs.forEach(function (d) {
      var have = !!state.docs[d.hash], busy = ui.busy[d.hash], row = h('li', { class: 'item' });
      row.appendChild(h('span', { class: 'ico' }, [icon('file-pdf')]));
      var main = h('div', { class: 'main' }, [h('span', { class: 'name', text: d.name }), h('span', { class: 'meta num', text: busy ? busy.text : (d.pages ? d.pages + ' pages, ' : '') + fmtSize(d.size) })]);
      if (busy && busy.total) main.appendChild(h('div', { class: 'bar-progress' }, [h('i', { style: 'width:' + Math.round(100 * busy.done / busy.total) + '%' })]));
      row.appendChild(main);
      if (have) row.appendChild(h('button', { class: 'btn quiet side', type: 'button', text: 'Open', onclick: function () { openReader(d.hash); } }));
      else if (!busy) row.appendChild(h('button', { class: 'btn side', type: 'button', 'aria-label': 'Download ' + d.name, onclick: function () { download(d); } }, [icon('download-simple')]));
      list.appendChild(row);
    });
  }

  $('tab-local').addEventListener('click', function () { ui.tab = 'local'; renderLibrary(); }, false);
  $('tab-mac').addEventListener('click', function () { ui.tab = 'mac'; renderLibrary(); loadMac(); }, false);
  $('tab-cloud').addEventListener('click', function () { ui.tab = 'cloud'; renderLibrary(); cloudSyncNow(); }, false);

  function loadMac(cb) {
    if (!client.isPaired()) return;
    client.library(function (err, data) {
      if (err) { ui.macError = err.message; if (err.code === 'unpaired') return unpaired(); if (!ui.macDocs) ui.macDocs = null; }
      else { ui.macDocs = data.docs; ui.macError = null; }
      renderLibrary(); if (cb) cb();
    });
  }

  function setBusy(hash, v) { if (v) ui.busy[hash] = v; else delete ui.busy[hash]; renderLibrary(); }

  function download(d) {
    setBusy(d.hash, { text: 'Downloading...', done: 0, total: d.size });
    var last = 0;
    client.download(d.hash, d.size, function (n, total) { if (Date.now() - last > 150) { last = Date.now(); ui.busy[d.hash] = { text: 'Downloading ' + Math.round(100 * n / total) + '%', done: n, total: total }; renderLibrary(); } }, function (err, bytes) {
      if (err) { setBusy(d.hash, null); return toast(err.message, true); }
      Store.put(d.hash, bytes, function (e2) {
        setBusy(d.hash, null);
        if (e2) toast(e2.message, true);
        L.upsertDoc(state, { hash: d.hash, name: d.name, size: d.size, pages: d.pages || null, added: Date.now(), opened: null });
        save(); renderLibrary(); toast('Downloaded ' + d.name);
      });
    });
  }

  function sendToMac(d) {
    Store.get(d.hash, function (e, bytes) {
      if (!bytes) return toast('That PDF is no longer stored on this device.', true);
      setBusy(d.hash, { text: 'Asking the Mac...', done: 0, total: 0 });
      client.upload(bytes, d.name, d.hash, function (n, total) { ui.busy[d.hash] = { text: 'Sending ' + Math.round(100 * n / total) + '%', done: n, total: total }; renderLibrary(); },
        function (s) { ui.busy[d.hash] = { text: s === 'waiting' ? 'Waiting for approval on the Mac...' : 'Sending...', done: 0, total: 0 }; renderLibrary(); },
        function (err, res) {
          setBusy(d.hash, null);
          if (err) return toast(err.message, true);
          toast(res.state === 'duplicate' ? 'The Mac already has this PDF.' : 'Sent to the Mac');
          loadMac();
        });
    });
  }

  function confirmRemove(d) {
    openSheet('Remove from this device?', function (body) {
      body.appendChild(h('p', { text: '"' + d.name + '" will be removed from this device. Your Mac keeps its copy, and your reading position and bookmarks are kept.' }));
      body.appendChild(h('div', { class: 'row-actions' }, [
        h('button', { class: 'btn danger', type: 'button', text: 'Remove', onclick: function () { closeSheet(); Store.del(d.hash, function () { delete state.docs[d.hash]; save(); renderLibrary(); toast('Removed ' + d.name, false, 'trash'); }); } }),
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
          if (e2) return toast(e2.message, true);
          L.upsertDoc(state, { hash: hash, name: f.name, size: bytes.length, pages: null, added: Date.now(), opened: null });
          save(); ui.tab = 'local'; renderLibrary(); toast('Added ' + f.name);
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
    btn.className = 'tool' + (has ? ' on' : ''); btn.setAttribute('aria-label', has ? 'Replace the bookmark on this page' : 'Bookmark this page');
    btn.setAttribute('aria-pressed', has ? 'true' : 'false');
  }

  function openReader(hash) {
    var d = state.docs[hash]; if (!d) return;
    toast('Opening...', false, 'file-pdf');
    Store.get(hash, function (e, bytes) {
      if (!bytes) { toast('This PDF is no longer stored on the device. Download it again from the Mac.', true); return; }
      show('view-reader'); ui.openHash = hash; $('rd-title').textContent = d.name; $('rd-page').textContent = '';
      $('remote-banner').hidden = true; ui.pendingRemote = null;
      ui.openBytes = bytes; $('reader-error').hidden = true;
      var reader = new window.RReader($('reader-scroll'), $('pages'), { onPosition: onPosition, onError: function (stage, detail) { showReaderError('A page could not be drawn (' + stage + '): ' + detail); } });
      ui.reader = reader;
      reader.load(bytes, function (err, info) {
        if (err) {
          var fallback = { name: d.name, bytes: bytes };
          closeReader(true);
          ui.lastErr = err.message + ' Details: ' + (err.detail || 'none') + '.'; ui.fallback = fallback; renderLibrary();
          return toast(err.message, true);
        }
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; } $('toast-pill').className = 'pill';     // dismiss "Opening..."
        d.pages = info.pages; d.opened = Date.now(); save();
        var p = progressOf(hash);
        if (p) { if (p.zoomMode === 'custom' && p.zoomScale) reader.setZoomSilently('custom', p.zoomScale); reader.scrollTo(p); }
        updatePageLabel();
      });
    });
  }
  function showReaderError(text) {
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
  $('rd-err-viewer').addEventListener('click', function () { if (ui.openBytes) openInBrowserViewer('', ui.openBytes); }, false);
  $('rd-err-diag').addEventListener('click', function () { location.href = 'diag.html'; }, false);

  // restore without emitting a position change
  window.RReader.prototype.setZoomSilently = function (mode, scale) { this.zoomMode = mode; if (mode === 'custom') this.scale = Math.max(0.2, Math.min(5, scale)); this._layout(); };

  var saveTimer = null;
  function onPosition(pos) {
    if (!pos || !ui.openHash) return;
    updatePageLabel();
    var existing = state.progress[ui.openHash];
    pos.readingMode = existing ? existing.readingMode : 'continuous';       // the web reader is continuous; never overwrite the Mac's mode choice
    L.saveProgress(state, ui.openHash, pos); save(); scheduleSync(2500);
  }

  function closeReader(skipSave) {
    var r = ui.reader;
    if (r && !skipSave && ui.openHash) { var pos = r.getPosition(); if (pos) onPosition(pos); }
    if (r) r.destroy();
    ui.reader = null; ui.openHash = null; show('view-library'); renderLibrary(); syncNow();
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
  function scheduleSync(ms) { if (syncTimer) clearTimeout(syncTimer); syncTimer = setTimeout(function () { syncTimer = null; syncNow(); cloudSyncNow(); }, ms); }

  function syncNow(manual) {
    if (!client.isPaired() || ui.syncing) return;
    ui.syncing = true; renderStatus();
    var open = ui.openHash, before = open ? state.progress[open] : null;
    L.syncOnce(client, state, function (err) {
      ui.syncing = false;
      if (err) {
        if (err.code === 'unpaired') return unpaired();
        ui.status = err.code === 'network' ? 'offline' : 'error'; ui.lastErr = err.code === 'network' ? null : err.message;
        renderStatus(); if (manual) toast(err.message, true); return;
      }
      ui.status = 'ok'; ui.lastErr = null; save();
      checkRemoteJump(open, before, 'Your Mac');
      renderStatus(); if ($('view-library').className.indexOf('on') >= 0) renderLibrary();
      if (manual) toast('Synced with ' + (state.serverName || 'your Mac'));
    });
  }
  $('btn-sync').addEventListener('click', function () { syncNow(true); loadMac(); cloudSyncNow(true); }, false);
  $('btn-cloud').addEventListener('click', function () { openCloudSheet(); }, false);

  function unpaired() {
    client.forget(); ui.macDocs = null; ui.syncing = false; save();
    if (ui.reader) { ui.reader.destroy(); ui.reader = null; ui.openHash = null; }
    ui.lastErr = 'The Mac no longer recognises this device, so syncing is off. Your PDFs, positions and bookmarks on this device are still here. Open "Your Mac" to connect again.';
    show('view-library'); renderLibrary();
  }

  function normaliseBase(input) {
    var v = String(input || '').replace(/^\s+|\s+$/g, '');
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    var m = v.match(/^(https?:\/\/)([A-Za-z0-9.\-]+)(:\d+)?\/?$/);
    if (!m) return null;
    var host = m[2].toLowerCase(); if (!/\.local$/.test(host)) host += '.local';
    var scheme = m[1].toLowerCase();
    return { base: scheme + host + (m[3] || (scheme === 'https://' ? ':8724' : '')), host: host, scheme: scheme };
  }

  function connectForm(body) {
    if (ui.sameOrigin) {
      body.appendChild(h('p', { text: 'This page is served by your Mac, so it can pair directly.' }));
      body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Pair with this Mac', onclick: function () {
        state.macBase = ''; client.transport = Api.xhrTransport(''); save(); closeSheet(); show('view-pair'); pairUI('start'); } })]));
      return;
    }
    body.appendChild(h('p', { text: 'Connect to Readen on your Mac to sync and move PDFs. Reading never needs the Mac.' }));
    body.appendChild(h('label', { class: 'note', for: 'mac-addr', text: 'Your Mac\'s address' }));
    var input = h('input', { id: 'mac-addr', type: 'text', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'your-mac.local', value: state.macBase ? state.macBase.replace(/^https?:\/\//, '') : '' });
    input.style.cssText = 'width:100%;min-height:44px;font-size:16px;padding:8px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--text);';
    body.appendChild(input);
    var msg = h('p', { class: 'note', role: 'alert' });
    body.appendChild(msg);
    body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Connect', onclick: function () {
      var n = normaliseBase(input.value);
      if (!n) { msg.textContent = 'Type the address shown in Readen on the Mac, for example your-mac.local'; return; }
      if (location.protocol === 'https:' && n.scheme !== 'https://') { msg.textContent = 'This page is secure, so it can only talk to the Mac over HTTPS. Turn on "Secure link" in Readen on the Mac.'; return; }
      msg.textContent = 'Checking...';
      Api.ping(n.base, function (err) {
        if (err) { msg.textContent = 'Can\'t reach ' + n.base.replace(/^https?:\/\//, '') + '. Check that the Mac is on and on the same Wi-Fi, that "Secure link" is on in Readen, and that this device trusts the Mac\'s certificate (open http://' + n.host + ':8723/ca in Safari for the steps).'; return; }
        state.macBase = n.base; client.transport = Api.xhrTransport(n.base); save(); closeSheet(); show('view-pair'); pairUI('start');
      });
    } })]));
  }

  function openMacSheet() {
    openSheet('Your Mac', function (body) {
      if (!client.isPaired()) return connectForm(body);
      body.appendChild(h('p', { text: 'Paired with ' + (state.serverName || 'your Mac') + '.' }));
      body.appendChild(h('p', { class: 'note', text: state.lastSync ? 'Last sync: ' + fmtStamp(state.lastSync) : 'Not synced yet.' }));
      body.appendChild(h('p', { class: 'note', text: Store.isPersistent() ? 'PDFs you add or download are kept on this device and work offline.' : 'This browser can\'t keep PDFs between visits.' }));
      body.appendChild(h('p', { class: 'note', text: 'Mac: ' + (state.macBase ? state.macBase.replace(/^https?:\/\//, '') : location.host) }));
      var acts = h('div', { class: 'row-actions' });
      acts.appendChild(h('button', { class: 'btn primary', type: 'button', text: 'Sync now', onclick: function () { closeSheet(); syncNow(true); } }));
      acts.appendChild(h('button', { class: 'btn danger', type: 'button', text: 'Forget this Mac', onclick: function () {
        clear(body);
        body.appendChild(h('p', { text: 'Forget this Mac? This device will stop syncing and can\'t download or send PDFs until you pair again. PDFs already on this device stay.' }));
        body.appendChild(h('div', { class: 'row-actions' }, [
          h('button', { class: 'btn danger', type: 'button', text: 'Forget', onclick: function () { closeSheet(); client.rpc('unpair', {}, function () { client.forget(); ui.macDocs = null; ui.lastErr = null; save(); renderLibrary(); }); } }),
          h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeSheet })]));
      } }));
      body.appendChild(acts);
    });
  }
  $('btn-mac').addEventListener('click', openMacSheet, false);

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
      backupPdfs(); autoDownload();
      if (manual) toast(res.adopted ? 'Synced. Picked up changes from your other devices.' : 'Synced with the cloud');
    });
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
        if (e2) toast(e2.message, true);
        L.upsertDoc(state, { hash: d.hash, name: d.name, size: d.size || bytes.length, pages: d.pages || null, added: Date.now(), opened: null });
        state.cloudUploaded = state.cloudUploaded || {}; state.cloudUploaded[d.hash] = true;
        save(); renderLibrary(); toast('Downloaded ' + d.name); if (done) done();
      });
    });
  }

  function renderCloud(list, empty) {
    var docs = RCloud.cloudDocs(state);
    if (!docs.length) return emptyState(empty, 'Nothing in the cloud yet', 'PDFs you add on any device are backed up here, encrypted, and show up on your other devices.', [
      h('button', { class: 'btn primary', type: 'button', text: 'Sync now', onclick: function () { cloudSyncNow(true); } })]);
    docs.forEach(function (d) {
      var have = !!state.docs[d.hash], busy = ui.busy[d.hash], row = h('li', { class: 'item' });
      row.appendChild(h('span', { class: 'ico' }, [icon('file-pdf')]));
      var main = h('div', { class: 'main' }, [h('span', { class: 'name', text: d.name }), h('span', { class: 'meta num', text: busy ? busy.text : (d.pages ? d.pages + ' pages, ' : '') + fmtSize(d.size || 0) + (have ? ', on this device' : '') })]);
      if (busy && busy.total) main.appendChild(h('div', { class: 'bar-progress' }, [h('i', { style: 'width:' + Math.round(100 * busy.done / busy.total) + '%' })]));
      row.appendChild(main);
      if (have) row.appendChild(h('button', { class: 'btn quiet side', type: 'button', text: 'Open', onclick: function () { openReader(d.hash); } }));
      else if (!busy) row.appendChild(h('button', { class: 'btn side', type: 'button', 'aria-label': 'Download ' + d.name, onclick: function () { downloadFromCloud(d); } }, [icon('download-simple')]));
      if (!busy) row.appendChild(h('button', { class: 'tool side', type: 'button', 'aria-label': 'Delete ' + d.name + ' from the cloud', onclick: function () { confirmDeleteCloud(d); } }, [icon('trash')]));
      list.appendChild(row);
    });
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
    var msg1 = h('p', { class: 'note', role: 'alert' }); body.appendChild(msg1);
    body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Start cloud sync', onclick: function () {
      var repo = $('cl-repo').value.replace(/^\s+|\s+$/g, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''), token = $('cl-token').value.replace(/\s+/g, '');
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) { msg1.textContent = 'Type the repository as owner/name, for example yourname/readen-data.'; return; }
      if (token.length < 20) { msg1.textContent = 'Paste the access token from GitHub.'; return; }
      activateCloud({ repo: repo, token: token, key: RCloud.newKey(), api: 'https://api.github.com' }, msg1, function () { closeSheet(); openCloudSheet(); });
    } })]));
    body.appendChild(h('h3', { text: 'I already set it up on another device' }));
    body.appendChild(h('p', { class: 'note', text: 'On that device open Cloud sync, choose "Show setup code", copy it (Messages or Notes work), and paste it here.' }));
    var ta = h('textarea', { id: 'cl-code', rows: '3', placeholder: 'RDN1....', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }); ta.className = 'field';
    body.appendChild(ta);
    var msg2 = h('p', { class: 'note', role: 'alert' }); body.appendChild(msg2);
    body.appendChild(h('div', { class: 'row-actions' }, [h('button', { class: 'btn primary', type: 'button', text: 'Join', onclick: function () {
      var cfg = RCloud.parseSetupCode(ta.value);
      if (!cfg) { msg2.textContent = 'That doesn\'t look like a Readen setup code. Copy the whole code, starting with RDN1.'; return; }
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
      var c = cloudCfg();
      if (!c) return cloudSetupForm(body);
      body.appendChild(h('p', { text: 'Connected to ' + c.repo + '.' }));
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
  function enterLibrary() { show('view-library'); renderLibrary(); syncNow(); loadMac(); }

  setInterval(function () { if (!document.hidden && !document.webkitHidden) { if (client.isPaired() && !ui.syncing && !ui.openHash) { syncNow(); loadMac(); } cloudSyncNow(); renderStatus(); } }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { syncNow(); cloudSyncNow(); } }, false);
  window.addEventListener('online', function () { syncNow(); cloudSyncNow(true); }, false);
  window.addEventListener('pagehide', function () { if (ui.reader && ui.openHash) { var p = ui.reader.getPosition(); if (p) onPosition(p); } }, false);

  // The reader works with no Mac at all. If this page happens to be served by a Mac, remember that (same-origin pairing).
  Api.ping('', function (err) { ui.sameOrigin = !err; });
  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) { } }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      var had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (had) toast('Updated. Close and reopen Readen to use the new version.', false, 'arrows-clockwise'); had = true; });
    }, function () { });
  }
  show('view-library'); renderLibrary();
  if (client.isPaired()) { syncNow(); loadMac(); }
  if (cloudCfg()) cloudSyncNow(true);
  handleSetupFragment();
}());
