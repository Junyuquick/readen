/* Stores PDF bytes (ArrayBuffer) in IndexedDB, falling back to memory if IndexedDB is unavailable.
 * Small records (progress, bookmarks, settings) live in localStorage; see app.js. ES5. */
(function (root) {
  'use strict';
  var DB = 'readen', STORE = 'pdf', memory = {}, db = null, tried = false, failed = false, waiting = [];

  function open(cb) {
    if (db) return cb(db);
    if (failed || !root.indexedDB) { failed = true; return cb(null); }
    waiting.push(cb);
    if (tried) return;
    tried = true;
    var req;
    try { req = root.indexedDB.open(DB, 1); } catch (e) { failed = true; return flush(null); }
    req.onupgradeneeded = function () { var d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    req.onsuccess = function () { db = req.result; flush(db); };
    req.onerror = req.onblocked = function () { failed = true; flush(null); };
  }
  function flush(d) { var w = waiting; waiting = []; for (var i = 0; i < w.length; i++) w[i](d); }

  root.RStore = {
    /** true once we know the browser can keep PDFs between visits */
    isPersistent: function () { return !failed; },
    put: function (hash, bytes, cb) {
      open(function (d) {
        if (!d) { memory[hash] = bytes; return cb(null, false); }
        try {
          var tx = d.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes, hash);
          tx.oncomplete = function () { cb(null, true); };
          tx.onerror = tx.onabort = function () { memory[hash] = bytes; cb({ code: 'storage', message: 'There is not enough space to keep this PDF on the device.' }, false); };
        } catch (e) { memory[hash] = bytes; cb({ code: 'storage', message: 'This browser could not store the PDF.' }, false); }
      });
    },
    get: function (hash, cb) {
      if (memory[hash]) return cb(null, memory[hash]);
      open(function (d) {
        if (!d) return cb(null, null);
        try {
          var r = d.transaction(STORE, 'readonly').objectStore(STORE).get(hash);
          r.onsuccess = function () { cb(null, r.result ? new Uint8Array(r.result) : null); };
          r.onerror = function () { cb(null, null); };
        } catch (e) { cb(null, null); }
      });
    },
    del: function (hash, cb) {
      delete memory[hash];
      open(function (d) {
        if (!d) return cb && cb();
        try { var tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(hash); tx.oncomplete = tx.onerror = function () { cb && cb(); }; } catch (e) { cb && cb(); }
      });
    }
  };
}(this));
