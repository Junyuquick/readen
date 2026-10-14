/* Readen diagnostics page logic. ES5. Finds out exactly which step fails on an old iPad: storage, workers, canvas, pdf.js, and
 * opening the PDFs already stored by the app. */
(function () {
  'use strict';
  var logEl = document.getElementById('log'), outEl = document.getElementById('out'), lines = [];
  var tiny = document.querySelector('script[data-tiny-pdf]').getAttribute('data-tiny-pdf');

  function say(kind, text) {
    lines.push((kind === 'ok' ? 'OK    ' : kind === 'fail' ? 'FAIL  ' : '      ') + text);
    var span = document.createElement('div'); span.className = kind; span.textContent = (kind === 'ok' ? 'OK  ' : kind === 'fail' ? 'FAIL  ' : '') + text;
    logEl.appendChild(span); outEl.value = lines.join('\n');
  }
  function b64bytes(b64) { var bin = atob(b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function msg(e) { return e ? ((e.name ? e.name + ': ' : '') + (e.message || e)) : 'unknown'; }

  function steps() {
    var list = [];
    function add(name, fn) { list.push({ name: name, fn: fn }); }

    add('device', function (done) {
      say('info', 'User agent: ' + navigator.userAgent);
      say('info', 'Screen ' + screen.width + 'x' + screen.height + ', pixel ratio ' + (window.devicePixelRatio || 1) + ', online ' + navigator.onLine);
      say('info', 'Page: ' + location.href);
      say('info', 'pdf.js: ' + (window.pdfjsLib ? window.pdfjsLib.version : 'NOT LOADED'));
      done(true);
    });

    add('JavaScript features', function (done) {
      var f = [['Promise', typeof Promise], ['Map', typeof Map], ['Set', typeof Set], ['Symbol', typeof Symbol], ['Uint8Array', typeof Uint8Array],
        ['Uint8Array.slice', typeof (window.Uint8Array && Uint8Array.prototype.slice)], ['Uint8Array.fill', typeof (window.Uint8Array && Uint8Array.prototype.fill)],
        ['Uint8Array.subarray', typeof (window.Uint8Array && Uint8Array.prototype.subarray)], ['Array.from', typeof Array.from], ['Object.assign', typeof Object.assign],
        ['URL ctor', typeof URL], ['Blob', typeof Blob], ['FileReader', typeof FileReader], ['Worker', typeof Worker], ['fetch', typeof fetch],
        ['IndexedDB', typeof window.indexedDB], ['localStorage', typeof window.localStorage], ['serviceWorker', typeof navigator.serviceWorker], ['TextDecoder', typeof window.TextDecoder]];
      var missing = [], have = [];
      for (var i = 0; i < f.length; i++) (f[i][1] === 'undefined' ? missing : have).push(f[i][0]);
      say('info', 'present: ' + have.join(', '));
      say(missing.length ? 'info' : 'ok', 'missing: ' + (missing.join(', ') || 'none'));
      done(true);
    });

    add('localStorage write/read', function (done) {
      try { localStorage.setItem('readen.diag', 'x'); var ok = localStorage.getItem('readen.diag') === 'x'; localStorage.removeItem('readen.diag'); say(ok ? 'ok' : 'fail', 'localStorage round trip'); done(ok); }
      catch (e) { say('fail', 'localStorage: ' + msg(e)); done(false); }
    });

    add('IndexedDB store 1 MB and 8 MB', function (done) {
      if (!window.indexedDB) { say('fail', 'IndexedDB is not available'); return done(false); }
      var req = indexedDB.open('readen-diag', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('t'); };
      req.onerror = function () { say('fail', 'IndexedDB open: ' + msg(req.error)); done(false); };
      req.onblocked = function () { say('fail', 'IndexedDB open blocked'); done(false); };
      req.onsuccess = function () {
        var db = req.result, sizes = [1048576, 8388608], i = 0;
        (function next() {
          if (i >= sizes.length) { db.close(); try { indexedDB.deleteDatabase('readen-diag'); } catch (e) { } return done(true); }
          var n = sizes[i++], buf = new Uint8Array(n); for (var k = 0; k < n; k += 4096) buf[k] = k & 255;
          var timer = setTimeout(function () { say('fail', 'IndexedDB ' + (n >> 20) + ' MB: no answer after 15 s'); done(false); }, 15000);
          try {
            var tx = db.transaction('t', 'readwrite'); tx.objectStore('t').put(buf.buffer, 'k' + n);
            tx.oncomplete = function () {
              var g = db.transaction('t', 'readonly').objectStore('t').get('k' + n);
              g.onsuccess = function () {
                clearTimeout(timer);
                var got = g.result ? new Uint8Array(g.result) : null, same = got && got.length === n && got[4096] === (4096 & 255);
                say(same ? 'ok' : 'fail', 'IndexedDB ' + (n >> 20) + ' MB round trip' + (same ? '' : ' (data came back wrong or empty)')); same ? next() : done(false);
              };
              g.onerror = function () { clearTimeout(timer); say('fail', 'IndexedDB read ' + (n >> 20) + ' MB: ' + msg(g.error)); done(false); };
            };
            tx.onerror = tx.onabort = function () { clearTimeout(timer); say('fail', 'IndexedDB write ' + (n >> 20) + ' MB: ' + msg(tx.error)); done(false); };
          } catch (e) { clearTimeout(timer); say('fail', 'IndexedDB ' + (n >> 20) + ' MB: ' + msg(e)); done(false); }
        })();
      };
    });

    add('canvas', function (done) {
      try {
        var c = document.createElement('canvas'); c.width = 1500; c.height = 2000; var x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 10, 10);
        var px = x.getImageData(5, 5, 1, 1).data[0]; say(px === 0 ? 'ok' : 'fail', '3 megapixel canvas draw/read');
        done(px === 0);
      } catch (e) { say('fail', 'canvas: ' + msg(e)); done(false); }
    });

    add('web worker (inline)', function (done) {
      if (!window.Worker) { say('fail', 'no Worker support'); return done(false); }
      try {
        var w = new Worker(URL.createObjectURL(new Blob(['postMessage("hi")'], { type: 'application/javascript' })));
        var t = setTimeout(function () { say('fail', 'inline worker did not answer'); done(false); }, 4000);
        w.onmessage = function () { clearTimeout(t); say('ok', 'inline worker answers'); w.terminate(); done(true); };
        w.onerror = function (e) { clearTimeout(t); say('fail', 'inline worker error: ' + msg(e)); done(false); };
      } catch (e) { say('fail', 'inline worker: ' + msg(e)); done(false); }
    });

    add('web worker (pdf.js file)', function (done) {
      try {
        var w = new Worker('vendor/pdf.worker.min.js'), t = setTimeout(function () { say('ok', 'pdf.js worker file loaded with no error in 2.5 s'); w.terminate(); done(true); }, 2500);
        w.onerror = function (e) { clearTimeout(t); say('fail', 'pdf.js worker file error: ' + (e && e.message ? e.message : 'could not load') + (e && e.filename ? ' at ' + e.filename + ':' + e.lineno : '')); done(false); };
      } catch (e) { say('fail', 'pdf.js worker: ' + msg(e)); done(false); }
    });

    function openAndRender(bytes, label, cb) {
      var t = setTimeout(function () { say('fail', label + ': no answer after 40 s'); cb(false); }, 40000), stage = 'getDocument';
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      window.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).then(function (pdf) {
        stage = 'getPage'; return pdf.getPage(1).then(function (page) {
          stage = 'render'; var vp = page.getViewport(1), c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).then(function () {
            var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, dark = 0; for (var i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
            clearTimeout(t); say(dark > 0 ? 'ok' : 'fail', label + ': ' + pdf.numPages + ' page(s), page 1 drew ' + dark + ' dark pixels' + (dark ? '' : ' (BLANK)')); cb(dark > 0);
          });
        });
      }).then(null, function (e) { clearTimeout(t); say('fail', label + ' failed at "' + stage + '": ' + msg(e)); cb(false); });
    }

    add('pdf.js opens and draws a built-in PDF', function (done) {
      if (!window.pdfjsLib) { say('fail', 'pdf.js did not load'); return done(false); }
      openAndRender(b64bytes(tiny), 'built-in PDF', done);
    });

    add('your stored PDFs', function (done) {
      if (!window.indexedDB || !window.pdfjsLib) return done(true);
      var req = indexedDB.open('readen', 1);
      req.onupgradeneeded = function () { try { req.transaction.abort(); } catch (e) { } };
      req.onerror = function () { say('info', 'no Readen storage on this address yet (open and add a PDF in the app first)'); done(true); };
      req.onsuccess = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('pdf')) { say('info', 'no PDFs stored on this address'); db.close(); return done(true); }
        var keys = db.transaction('pdf', 'readonly').objectStore('pdf').getAllKeys ? null : null, ks = [], cur = db.transaction('pdf', 'readonly').objectStore('pdf').openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (c) { ks.push({ key: c.key, size: c.value ? c.value.byteLength : -1 }); return c.continue(); }
          say('info', 'stored PDFs: ' + ks.length); var i = 0;
          (function next() {
            if (i >= ks.length) { db.close(); return done(true); }
            var k = ks[i++];
            var g = db.transaction('pdf', 'readonly').objectStore('pdf').get(k.key);
            g.onsuccess = function () {
              if (!g.result) { say('fail', String(k.key).slice(0, 10) + ': stored record is empty'); return next(); }
              var bytes = new Uint8Array(g.result), head = String.fromCharCode.apply(null, bytes.subarray(0, 8));
              say('info', String(k.key).slice(0, 10) + '...: ' + bytes.length + ' bytes, starts with "' + head.replace(/[^\x20-\x7e]/g, '?') + '"');
              openAndRender(bytes, 'stored PDF ' + String(k.key).slice(0, 8), next);
            };
            g.onerror = function () { say('fail', 'could not read stored PDF ' + String(k.key).slice(0, 8)); next(); };
          })();
        };
        cur.onerror = function () { say('fail', 'could not list stored PDFs'); done(true); };
      };
    });
    return list;
  }

  function run() {
    lines = []; logEl.innerHTML = ''; outEl.value = '';
    var list = steps(), i = 0, failed = [];
    (function next() {
      if (i >= list.length) { say(failed.length ? 'fail' : 'ok', failed.length ? 'Finished. Problems in: ' + failed.join(', ') : 'Finished. Everything passed.'); return; }
      var s = list[i++], finished = false;
      try { s.fn(function (ok) { if (finished) return; finished = true; if (!ok) failed.push(s.name); setTimeout(next, 30); }); }
      catch (e) { say('fail', s.name + ': ' + msg(e)); failed.push(s.name); setTimeout(next, 30); }
    })();
  }

  document.getElementById('rerun').addEventListener('click', run, false);
  document.getElementById('home').addEventListener('click', function () { location.href = './'; }, false);
  window.addEventListener('error', function (e) { say('fail', 'uncaught: ' + (e.message || e) + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')); }, false);
  run();
}());
