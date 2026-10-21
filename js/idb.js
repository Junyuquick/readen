/* Stores PDF bytes. Every save is READ BACK to prove it really persisted, errors keep their real text (shown to the user and in diag.html),
 * and an IndexedDB that never answers is given up on after a few seconds. If IndexedDB can't be used, PDFs live in memory only and the caller
 * is told so. If IndexedDB is ever caught LOSING a PDF the app knew about, new PDFs are also kept in WebSQL (old iOS has it) from then on.
 * Small records (progress, bookmarks, settings) live in localStorage (app.js). ES5. */
(function (root) {
  'use strict';
  var DB = 'readen', STORE = 'pdf', memory = {}, db = null, tried = false, failed = false, waiting = [], lastError = null;

  function note(what, e) {
    lastError = what + (e ? ': ' + (e.name ? e.name + ' ' : '') + (e.message || e) : '');
    try { localStorage.setItem('readen.lastStoreError', lastError + ' (' + new Date().toISOString() + ')'); } catch (x) { }
  }
  function flush(d) { var w = waiting; waiting = []; for (var i = 0; i < w.length; i++) w[i](d); }

  // ---------- IndexedDB ----------
  function open(cb) {
    if (db) return cb(db);
    if (failed || !root.indexedDB) { if (!failed) note('IndexedDB is not available in this browser'); failed = true; return cb(null); }
    waiting.push(cb);
    if (tried) return;
    tried = true;
    var req, timer = setTimeout(function () { if (!db && !failed) { failed = true; note('IndexedDB did not answer within 8 seconds'); flush(null); } }, 8000);
    try { req = root.indexedDB.open(DB, 1); } catch (e) { clearTimeout(timer); failed = true; note('IndexedDB could not be opened', e); return flush(null); }
    req.onupgradeneeded = function () { var d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    req.onsuccess = function () { clearTimeout(timer); if (failed) return; db = req.result; db.onversionchange = function () { try { db.close(); } catch (e) { } db = null; tried = false; }; flush(db); };
    req.onerror = req.onblocked = function () { clearTimeout(timer); failed = true; note('IndexedDB open failed', req.error); flush(null); };
  }
  function readBack(d, hash, expectLen, cb) {
    try {
      var r = d.transaction(STORE, 'readonly').objectStore(STORE).get(hash);
      r.onsuccess = function () { cb(!!r.result && r.result.byteLength === expectLen); };
      r.onerror = function () { cb(false); };
    } catch (e) { cb(false); }
  }
  function idbPut(hash, bytes, cb) {
    var copy = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    open(function (d) {
      memory[hash] = bytes;                                             // usable in this session no matter what
      if (!d) return cb({ code: 'storage', message: 'This browser can\'t keep PDFs between visits (' + (lastError || 'IndexedDB unavailable') + ').' }, false);
      var settled = false;
      function fail(msg, e) { if (settled) return; settled = true; note(msg, e); cb({ code: 'storage', message: 'Couldn\'t keep this PDF on the device (' + lastError + ').' }, false); }
      try {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(copy, hash);
        tx.oncomplete = function () {
          readBack(d, hash, copy.byteLength, function (ok) {
            if (settled) return;
            if (!ok) return fail('Saved but could not be read back');
            settled = true; delete memory[hash]; cb(null, true);
          });
        };
        tx.onerror = tx.onabort = function () { fail('Write failed', tx.error); };
      } catch (e) { fail('Write threw', e); }
    });
  }
  function idbGet(hash, cb, onMiss) {
    open(function (d) {
      if (!d) return cb(null, null);
      try {
        var r = d.transaction(STORE, 'readonly').objectStore(STORE).get(hash);
        r.onsuccess = function () { if (r.result) return cb(null, new Uint8Array(r.result)); if (onMiss) onMiss(); cb(null, null); };
        r.onerror = function () { note('Read failed', r.error); cb(null, null); };
      } catch (e) { note('Read threw', e); cb(null, null); }
    });
  }
  function idbDel(hash, cb) {
    open(function (d) {
      if (!d) return cb && cb();
      try { var tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(hash); tx.oncomplete = tx.onerror = function () { cb && cb(); }; } catch (e) { cb && cb(); }
    });
  }

  // ---------- WebSQL (only after IndexedDB lost a PDF the app knew about; every save is read back) ----------
  var SQL_KEY = 'readen.store.sql', SQL_CHUNK = 196608, sqlDb = null, sqlFailed = false;
  function oldIOS() { var m = /OS (\d+)_\d+(_\d+)? like Mac OS X/.exec((root.navigator && root.navigator.userAgent) || ''); return !!m && parseInt(m[1], 10) <= 9; }   // iOS 9 IndexedDB drops big files; WebSQL keeps them
  function sqlOn() { if (typeof root.openDatabase === 'function' && (!root.indexedDB || oldIOS())) return true; try { return localStorage.getItem(SQL_KEY) === '1'; } catch (e) { return false; } }
  function sqlAvailable() { return typeof root.openDatabase === 'function' && !sqlFailed; }
  function sqlOpen() {
    if (sqlDb) return sqlDb;
    if (!sqlAvailable()) return null;
    try {
      sqlDb = root.openDatabase('readen-files', '1.0', 'Readen PDFs', 100 * 1024 * 1024);
      sqlDb.transaction(function (tx) { tx.executeSql('CREATE TABLE IF NOT EXISTS pdf (hash TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (hash, idx))'); }, function (e) { sqlFailed = true; sqlDb = null; note('WebSQL create failed', e); });
    } catch (e) { sqlFailed = true; sqlDb = null; note('WebSQL could not be opened', e); }
    return sqlDb;
  }
  function sqlPut(hash, bytes, cb) {
    var d = sqlOpen(); if (!d) return cb(false);
    var n = Math.max(1, Math.ceil(bytes.length / SQL_CHUNK)), rows = [], i, want = 0;
    for (i = 0; i < n; i++) { rows.push(root.RCrypto.b64encode(bytes.subarray(i * SQL_CHUNK, Math.min((i + 1) * SQL_CHUNK, bytes.length)))); want += rows[i].length; }
    d.transaction(function (tx) {
      tx.executeSql('DELETE FROM pdf WHERE hash = ?', [hash]);
      for (var k = 0; k < rows.length; k++) tx.executeSql('INSERT OR REPLACE INTO pdf (hash, idx, data) VALUES (?, ?, ?)', [hash, k, rows[k]]);
    }, function (e) { note('WebSQL write failed', e); cb(false); }, function () {
      d.readTransaction(function (tx) {
        tx.executeSql('SELECT COUNT(*) AS c, SUM(LENGTH(data)) AS l FROM pdf WHERE hash = ?', [hash], function (t, r) {
          var ok = r.rows.length === 1 && r.rows.item(0).c === rows.length && r.rows.item(0).l === want;
          if (!ok) note('WebSQL saved but could not be read back');
          cb(ok);
        });
      }, function (e) { note('WebSQL read-back failed', e); cb(false); });
    });
  }
  function sqlGet(hash, cb) {
    var d = sqlOpen(); if (!d) return cb(null);
    d.readTransaction(function (tx) {
      tx.executeSql('SELECT data FROM pdf WHERE hash = ? ORDER BY idx', [hash], function (t, r) {
        if (!r.rows.length) return cb(null);
        var parts = [], total = 0, i, u;
        for (i = 0; i < r.rows.length; i++) { u = root.RCrypto.b64decode(r.rows.item(i).data); parts.push(u); total += u.length; }
        var out = new Uint8Array(total), off = 0; for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
        cb(out);
      });
    }, function (e) { note('WebSQL read failed', e); cb(null); });
  }
  function sqlDel(hash, cb) {
    var d = sqlOn() ? sqlOpen() : null; if (!d) return cb();
    d.transaction(function (tx) { tx.executeSql('DELETE FROM pdf WHERE hash = ?', [hash]); }, function () { cb(); }, function () { cb(); });
  }
  function markLoss() {
    note('IndexedDB lost a stored PDF');
    if (sqlAvailable()) { try { localStorage.setItem(SQL_KEY, '1'); } catch (e) { } }
  }

  root.RStore = {
    /** true unless IndexedDB is known to be unusable */
    isPersistent: function () { return !failed || (sqlOn() && sqlAvailable()); },
    /** {persistent, lastError, mode, websql}: shown to the user when something goes wrong */
    status: function () { return { persistent: !failed || (sqlOn() && sqlAvailable()), lastError: lastError, mode: sqlOn() ? 'indexeddb+websql' : 'indexeddb', websql: typeof root.openDatabase === 'function' }; },
    put: function (hash, bytes, cb) {
      if (sqlOn() && sqlAvailable()) {
        memory[hash] = bytes;
        return sqlPut(hash, bytes, function (sqlOk) {
          if (sqlOk) { delete memory[hash]; cb(null, true); if (root.indexedDB) idbPut(hash, bytes, function () { }); return; }   // WebSQL is primary now; IndexedDB keeps a best-effort second copy
          idbPut(hash, bytes, cb);                                                                        // WebSQL failed: behave exactly as before
        });
      }
      idbPut(hash, bytes, cb);
    },
    get: function (hash, cb) {
      if (memory[hash]) return cb(null, memory[hash]);
      if (sqlOn() && sqlAvailable()) return sqlGet(hash, function (b) { b ? cb(null, b) : idbGet(hash, cb, markLoss); });
      idbGet(hash, cb, markLoss);
    },
    del: function (hash, cb) {
      delete memory[hash];
      sqlDel(hash, function () { idbDel(hash, cb); });
    }
  };
}(this));
