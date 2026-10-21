/* Book covers: the first page of each PDF, drawn once with pdf.js, kept as a small JPEG in localStorage (one key per PDF).
 * Covers are made one at a time while the library is showing, never while a book is open. A PDF that can't be drawn keeps a quiet
 * placeholder. ES5. */
(function (root) {
  'use strict';
  var PREFIX = 'readen.cover.1.', WIDTH = 240, QUALITY = 0.72, queue = [], queued = {}, busy = false, paused = false, onDone = null;

  /** "ratio|data:image/jpeg;base64,..." (ratio = height / width), or 'x' once drawing failed for good. Returns null, 'x' or {url, ratio}. */
  function parse(v) {
    if (!v) return null; if (v === 'x') return 'x';
    var i = v.indexOf('|'); if (i < 1) return null;
    var ratio = parseFloat(v.slice(0, i)); if (!(ratio > 0.2 && ratio < 5)) return null;
    return { url: v.slice(i + 1), ratio: ratio };
  }
  function get(hash) { try { return parse(localStorage.getItem(PREFIX + hash)); } catch (e) { return null; } }
  function put(hash, url, ratio) { try { localStorage.setItem(PREFIX + hash, ratio.toFixed(4) + '|' + url); return true; } catch (e) { return false; } }
  function fail(hash) { try { localStorage.setItem(PREFIX + hash, 'x'); } catch (e) { } }
  function del(hash) { try { localStorage.removeItem(PREFIX + hash); } catch (e) { } }

  /** A deterministic cloth colour for a PDF with no cover yet (the same PDF always gets the same colour on every device). */
  var CLOTH = ['#3a3466', '#6a2a4a', '#1f5c63', '#7a4a12', '#2f5a45', '#4a3a66', '#6b3a3a', '#2d4a6e'];
  function cloth(hash) { var n = 0; for (var i = 0; i < Math.min(8, hash.length); i++) n = (n * 31 + hash.charCodeAt(i)) % 997; return CLOTH[n % CLOTH.length]; }

  /** Draws page 1 as a JPEG. cb(err, {url, ratio, pages}). */
  function draw(bytes, cb) {
    var lib = root.pdfjsLib; if (!lib) return cb(new Error('pdf.js is not loaded'));
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    var pdfRef = null;
    lib.getDocument({ data: bytes, isEvalSupported: false }).then(function (pdf) {
      pdfRef = pdf;
      return pdf.getPage(1).then(function (page) {
        var v0 = page.getViewport(1), scale = WIDTH / v0.width, vp = page.getViewport(scale);
        var canvas = document.createElement('canvas'); canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
        var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        return page.render({ canvasContext: ctx, viewport: vp }).then(function () {
          var url = canvas.toDataURL('image/jpeg', QUALITY), ratio = canvas.height / canvas.width, pages = pdf.numPages;
          canvas.width = 0; canvas.height = 0; try { pdf.destroy(); } catch (e) { }
          cb(null, { url: url, ratio: ratio, pages: pages });
        });
      });
    }).then(null, function (e) { if (pdfRef) { try { pdfRef.destroy(); } catch (x) { } } cb(e || new Error('could not draw the cover')); });
  }

  function pump() {
    if (busy || paused || !queue.length) return;
    var job = queue.shift(); busy = true;
    job.load(function (bytes) {
      if (!bytes) { busy = false; delete queued[job.hash]; return pump(); }
      draw(bytes, function (err, res) {
        busy = false; delete queued[job.hash];
        if (err) fail(job.hash); else put(job.hash, res.url, res.ratio);
        if (onDone) onDone(job.hash, err ? null : res);
        setTimeout(pump, 30);
      });
    });
  }
  /** Ask for a cover. `load(cb)` hands over the PDF's bytes (or null). Does nothing when one exists or is already queued. */
  function request(hash, load) { if (get(hash) || queued[hash]) return; queued[hash] = true; queue.push({ hash: hash, load: load }); pump(); }
  /** Make one now from bytes we already hold (just added or downloaded). */
  function makeFrom(hash, bytes) { if (get(hash)) return; request(hash, function (cb) { cb(bytes); }); }

  root.RCover = {
    parse: parse, get: get, put: put, del: del, cloth: cloth, request: request, makeFrom: makeFrom,
    pause: function () { paused = true; }, resume: function () { paused = false; pump(); },
    onDone: function (f) { onDone = f; }, WIDTH: WIDTH
  };
}(this));
