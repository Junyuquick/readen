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
      say('info', 'pdf.js: ' + (window.pdfjsLib ? window.pdfjsLib.version : 'NOT LOADED') + ', Readen build ' + (window.READEN_VERSION || '?'));
      var le = null; try { le = localStorage.getItem('readen.lastStoreError'); } catch (e) { }
      say(le ? 'fail' : 'info', 'last storage error recorded by the app: ' + (le || 'none'));
      done(true);
    });

    add('can this app keep data after you close it?', function (done) {
      say('info', 'Installed Home Screen app: ' + (navigator.standalone === true ? 'yes' : navigator.standalone === false ? 'no (opened in the browser)' : 'unknown'));
      var KEY = 'readen.diag.marker', prevLS = null;
      try { prevLS = JSON.parse(localStorage.getItem(KEY) || 'null'); localStorage.setItem(KEY, JSON.stringify({ t: new Date().getTime() })); } catch (e) { say('fail', 'localStorage: ' + msg(e)); }
      function age(m) { var s = Math.round((new Date().getTime() - m.t) / 1000); return s < 120 ? s + ' seconds' : s < 7200 ? Math.round(s / 60) + ' minutes' : Math.round(s / 3600) + ' hours'; }
      say('info', 'localStorage marker from an earlier run: ' + (prevLS ? 'found (' + age(prevLS) + ' ago)' : 'none (first run, or it was cleared)'));
      if (!window.indexedDB) { say('fail', 'no IndexedDB'); return done(false); }
      var req = indexedDB.open('readen-diag-persist', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('t'); };
      req.onerror = function () { say('fail', 'IndexedDB persistence db: ' + msg(req.error)); done(false); };
      req.onsuccess = function () {
        var db = req.result, g = db.transaction('t', 'readonly').objectStore('t').get('marker');
        g.onsuccess = function () {
          var prev = g.result, n = new Uint8Array(1048576); n[0] = 7;
          var okSoFar = true;
          if (prev) say('info', 'IndexedDB marker from an earlier run: found (' + (prev.t ? age(prev) + ' ago' : 'old format') + ', ' + (prev.b ? prev.b.byteLength : 0) + ' bytes kept)');
          else say('info', 'IndexedDB marker from an earlier run: none');
          if (prevLS && !prev) { say('fail', 'IndexedDB LOST its data since the last run while localStorage kept its data. This is why PDFs disappear. Send me this.'); okSoFar = false; }
          else if (prevLS && prev && !(prev.b && prev.b.byteLength === 1048576)) { say('fail', 'IndexedDB kept the marker but lost the 1 MB of data in it.'); okSoFar = false; }
          else if (prevLS && prev) say('ok', 'IndexedDB kept its data since the last run');
          var tx = db.transaction('t', 'readwrite'); tx.objectStore('t').put({ t: new Date().getTime(), b: n.buffer }, 'marker');
          tx.oncomplete = function () { say('info', 'Now close this app completely (double-press Home, swipe it up), open it again and run diagnostics again. The lines above will then show whether data survived.'); db.close(); done(okSoFar); };
          tx.onerror = tx.onabort = function () { say('fail', 'IndexedDB write: ' + msg(tx.error)); done(false); };
        };
        g.onerror = function () { say('fail', 'IndexedDB read: ' + msg(g.error)); done(false); };
      };
    });

    add('WebSQL (the backup storage method)', function (done) {
      if (typeof window.openDatabase !== 'function') { say('info', 'WebSQL is not available here (normal on modern iOS).'); return done(true); }
      try {
        var d = openDatabase('readen-diag-sql', '1.0', 'diag', 5 * 1024 * 1024);
        d.transaction(function (tx) {
          tx.executeSql('CREATE TABLE IF NOT EXISTS m (k TEXT PRIMARY KEY, t INTEGER, v TEXT)');
          tx.executeSql('SELECT t, LENGTH(v) AS l FROM m WHERE k = ?', ['marker'], function (t, r) {
            var prev = r.rows.length ? r.rows.item(0) : null;
            say('info', 'WebSQL marker from an earlier run: ' + (prev ? 'found (' + Math.round((new Date().getTime() - prev.t) / 1000) + ' seconds ago, ' + prev.l + ' characters kept)' : 'none'));
            var big = new Array(262145).join('x');
            tx.executeSql('INSERT OR REPLACE INTO m (k, t, v) VALUES (?, ?, ?)', ['marker', new Date().getTime(), big]);
          });
        }, function (e) { say('fail', 'WebSQL: ' + msg(e)); done(false); }, function () { say('ok', 'WebSQL works (wrote 256 KB)'); done(true); });
      } catch (e) { say('fail', 'WebSQL: ' + msg(e)); done(false); }
    });

    add('Can this device reach GitHub (cloud sync)?', function (done) {
      function probe(label, headers, next) {
        var x = new XMLHttpRequest(), t0 = new Date().getTime(), ended = false;
        function end(kind) { if (ended) return; ended = true; var ms = new Date().getTime() - t0;
          if (kind === 'load') say(x.status > 0 ? 'ok' : 'fail', label + ': answered HTTP ' + x.status + ' in ' + ms + ' ms');
          else say('fail', label + ': ' + kind + ' after ' + ms + ' ms (readyState ' + x.readyState + ', status ' + x.status + ')'); next(kind === 'load' && x.status > 0); }
        try { x.open('GET', 'https://api.github.com/zen', true); for (var k in headers) x.setRequestHeader(k, headers[k]); } catch (e) { say('fail', label + ': ' + msg(e)); return next(false); }
        x.timeout = 15000; x.onload = function () { end('load'); }; x.onerror = function () { end('network error'); }; x.ontimeout = function () { end('timeout'); }; x.onabort = function () { end('aborted'); };
        x.send(null);
      }
      probe('plain request to api.github.com', {}, function (a) {
        probe('request with Authorization header (needs a CORS check)', { Authorization: 'Bearer github_pat_test', 'X-GitHub-Api-Version': '2022-11-28' }, function (b) {
          if (!a) say('info', 'The first test failing usually means this old iPad does not trust the connection to api.github.com (certificate or TLS), not Wi-Fi.');
          else if (!b) say('info', 'Plain works but the Authorization request fails: the browser is blocking the cross-site check.');
          done(a && b);
        });
      });
    });

    add('Can this device reach the relay (optional)?', function (done) {
      var relay = '', m = /relay=([^&]+)/.exec(location.hash || ''), box = document.getElementById('relay');
      if (box && box.value.replace(/\s+/g, '')) relay = box.value.replace(/\s+/g, ''); else if (m) relay = decodeURIComponent(m[1]); else { try { var st = JSON.parse(localStorage.getItem('readen.state.v1') || '{}'); if (st.cloud && st.cloud.api && st.cloud.api.indexOf('api.github.com') < 0) relay = st.cloud.api; } catch (e) { } }
      relay = relay.replace(/\/+$/, '');
      if (!/^https:\/\/[\w.\-]+\.(workers\.dev|val\.run|netlify\.app)$/.test(relay)) { say('info', 'No relay set. To test one, type its address in the box at the top, then tap Run again'); return done(true); }
      var x = new XMLHttpRequest(), t0 = new Date().getTime();
      function end(what) { var ms = new Date().getTime() - t0; if (what === 'load' && x.status === 200) { say('ok', 'relay answered HTTP 200 in ' + ms + ' ms'); return done(true); } say('fail', 'relay ' + (what === 'load' ? 'answered HTTP ' + x.status : what) + ' after ' + ms + ' ms'); done(false); }
      try { x.open('GET', relay + '/zen', true); } catch (e) { say('fail', 'relay: ' + msg(e)); return done(false); }
      x.timeout = 15000; x.onload = function () { end('load'); }; x.onerror = function () { end('network error'); }; x.ontimeout = function () { end('timeout'); };
      x.send(null);
    });

    add('JavaScript features', function (done) {
      var f = [['Promise', typeof Promise], ['Map', typeof Map], ['Set', typeof Set], ['Symbol', typeof Symbol], ['Uint8Array', typeof Uint8Array],
        ['Uint8Array.slice', typeof (window.Uint8Array && Uint8Array.prototype.slice)], ['Uint8Array.fill', typeof (window.Uint8Array && Uint8Array.prototype.fill)],
        ['Uint8Array.subarray', typeof (window.Uint8Array && Uint8Array.prototype.subarray)], ['Array.from', typeof Array.from], ['Object.assign', typeof Object.assign],
        ['URL ctor', typeof URL], ['Blob', typeof Blob], ['FileReader', typeof FileReader], ['Worker', typeof Worker], ['fetch', typeof fetch],
        ['IndexedDB', typeof window.indexedDB], ['WebSQL', typeof window.openDatabase], ['localStorage', typeof window.localStorage], ['serviceWorker', typeof navigator.serviceWorker], ['TextDecoder', typeof window.TextDecoder]];
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
