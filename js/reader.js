/* Continuous-scroll PDF reader on top of pdf.js 2.0 (ES5 build). Pages render lazily; far-away canvases are released
 * so an old iPad with 512 MB of memory survives long documents. Position = page index + PDF-space y of the viewport top. */
(function (root) {
  'use strict';

  function Reader(scroller, host, callbacks) {
    this.scroller = scroller; this.host = host; this.cb = callbacks || {};
    this.pdf = null; this.pages = []; this.n = 0; this.scale = 1; this.zoomMode = 'fitWidth';
    this.dpr = Math.min(root.devicePixelRatio || 1, 2);
    this.rendering = false; this.timer = null; this.posTimer = null; this.destroyed = false; this.restoring = false;
    var self = this;
    this._onScroll = function () { self._soon(); self._positionSoon(); };
    this._onResize = function () { if (self.zoomMode === 'fitWidth' && self.pdf) { var p = self.getPosition(); self._layout(); self.scrollTo(p); } };
    scroller.addEventListener('scroll', this._onScroll, false);
    root.addEventListener('resize', this._onResize, false);
  }

  Reader.prototype.load = function (bytes, cb) {
    var self = this;
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    // isEvalSupported:false is required: it neutralises the font-eval script-injection issue in this pdf.js line.
    root.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).then(function (pdf) {
      if (self.destroyed) return;
      self.pdf = pdf; self.n = pdf.numPages;
      return pdf.getPage(1).then(function (p) {
        var vp = p.getViewport(1);
        self.pages = [];
        for (var i = 0; i < self.n; i++) self.pages.push({ i: i, w: vp.width, h: vp.height, el: null, canvas: null, scale: 0, page: i === 0 ? p : null });
        self._build();
        cb(null, { pages: self.n });
      });
    }).then(null, function (e) {
      var detail = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
      cb({ code: 'pdf', detail: detail, message: (e && e.name === 'PasswordException') ? 'This PDF is password protected, which Readen on the web can\'t open yet.' : 'This PDF could not be opened.' });
    });
  };

  Reader.prototype._build = function () {
    var host = this.host; host.innerHTML = '';
    for (var i = 0; i < this.n; i++) {
      var el = document.createElement('div'); el.className = 'pg';
      var ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = String(i + 1);
      el.appendChild(ph); host.appendChild(el); this.pages[i].el = el;
    }
    this._layout();
  };

  Reader.prototype._fitScale = function () {
    var w = this.scroller.clientWidth - 20;
    return Math.max(0.2, w / this.pages[0].w);
  };

  Reader.prototype._layout = function () {
    if (this.zoomMode === 'fitWidth') this.scale = this._fitScale();
    var top = 0, maxW = 0;
    for (var i = 0; i < this.n; i++) {
      var p = this.pages[i], w = Math.round(p.w * this.scale), h = Math.round(p.h * this.scale);
      p.el.style.width = w + 'px'; p.el.style.height = h + 'px'; p.top = top; p.hpx = h; top += h + 10; if (w > maxW) maxW = w;
      if (p.canvas && Math.abs(p.scale - this.scale) > 0.001) this._release(p);
    }
    this.host.style.width = (maxW + 20 > this.scroller.clientWidth) ? (maxW + 20) + 'px' : 'auto';
    this.host.style.paddingTop = '10px';
    this._soon();
  };

  Reader.prototype._release = function (p) {
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; if (p.canvas.parentNode) p.canvas.parentNode.removeChild(p.canvas); p.canvas = null; p.scale = 0; }
  };

  Reader.prototype._soon = function () {
    var self = this; if (this.timer) return;
    this.timer = setTimeout(function () { self.timer = null; self._renderVisible(); }, 60);
  };

  Reader.prototype._renderVisible = function () {
    if (this.destroyed || !this.pdf || this.rendering) { if (this.rendering) this._soon(); return; }
    var st = this.scroller.scrollTop, vh = this.scroller.clientHeight, lo = st - vh, hi = st + 2 * vh, far = 3 * vh, next = null, i, p;
    for (i = 0; i < this.n; i++) {
      p = this.pages[i];
      var pt = p.top + 10, pb = pt + p.hpx;
      if (pb < st - far || pt > st + vh + far) { if (p.canvas) this._release(p); continue; }
      if (!next && pb > lo && pt < hi && (!p.canvas || Math.abs(p.scale - this.scale) > 0.001)) next = p;
    }
    if (next) this._renderPage(next);
  };

  Reader.prototype._renderPage = function (p) {
    var self = this, scale = this.scale;
    this.rendering = true;
    var go = function (page) {
      var vp0 = page.getViewport(1);
      if (Math.abs(vp0.width - p.w) > 0.5 || Math.abs(vp0.height - p.h) > 0.5) { p.w = vp0.width; p.h = vp0.height; self._relayoutKeepingAnchor(); }
      var d = self.dpr, vp = page.getViewport(scale * d);
      while (vp.width * vp.height > 4000000 && d > 0.5) { d -= 0.25; vp = page.getViewport(scale * d); }   // keep canvases small on old devices
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.round(p.w * scale) + 'px'; canvas.style.height = Math.round(p.h * scale) + 'px';
      page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).then(function () {
        self.rendering = false;
        if (self.destroyed) return;
        self._release(p);
        p.canvas = canvas; p.scale = scale;
        var ph = p.el.querySelector('.ph'); if (ph) p.el.removeChild(ph);
        p.el.appendChild(canvas);
        self._soon();
      }, function (err) { self.rendering = false; p.scale = scale; self._report('render page ' + (p.i + 1), err); self._soon(); });
    };
    if (p.page) go(p.page); else this.pdf.getPage(p.i + 1).then(function (page) { p.page = page; go(page); }, function (err) { self.rendering = false; p.scale = scale; self._report('load page ' + (p.i + 1), err); });
  };

  /** Tell the app once (not per page) what went wrong, with the real error text. */
  Reader.prototype._report = function (stage, err) {
    if (this.reported || !this.cb.onError) return;
    this.reported = true;
    this.cb.onError(stage, (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err)));
  };

  Reader.prototype._relayoutKeepingAnchor = function () { var pos = this.getPosition(); this._layout(); this.scrollTo(pos); };

  // ---- position ----
  Reader.prototype.currentIndex = function () {
    var st = this.scroller.scrollTop + 1, lo = 0, hi = this.n - 1, mid;
    while (lo < hi) { mid = (lo + hi + 1) >> 1; if (this.pages[mid].top + 10 <= st) lo = mid; else hi = mid - 1; }
    return lo;
  };
  /** {pageIndex, anchorX:null, anchorY (PDF space, origin bottom-left), zoomScale, zoomMode} */
  Reader.prototype.getPosition = function () {
    if (!this.n) return null;
    var i = this.currentIndex(), p = this.pages[i], offsetPx = Math.max(0, this.scroller.scrollTop - (p.top + 10));
    return { pageIndex: i, anchorX: null, anchorY: Math.max(0, p.h - offsetPx / this.scale), zoomScale: this.scale, zoomMode: this.zoomMode };
  };
  Reader.prototype.scrollTo = function (pos) {
    if (!this.n || !pos) return;
    var i = Math.max(0, Math.min(this.n - 1, pos.pageIndex || 0)), p = this.pages[i];
    var y = (pos.anchorY === null || pos.anchorY === undefined) ? 0 : Math.max(0, (p.h - pos.anchorY) * this.scale);
    this.restoring = true;
    this.scroller.scrollTop = p.top + 10 + y;
    var self = this; setTimeout(function () { self.restoring = false; }, 250);
    this._soon();
  };
  Reader.prototype._positionSoon = function () {
    var self = this; if (this.posTimer || this.restoring) return;
    this.posTimer = setTimeout(function () { self.posTimer = null; if (!self.restoring && self.cb.onPosition) self.cb.onPosition(self.getPosition()); }, 350);
  };

  Reader.prototype.setZoom = function (mode, scale) {
    var pos = this.getPosition();
    this.zoomMode = mode; if (mode === 'custom') this.scale = Math.max(0.2, Math.min(5, scale));
    this._layout(); this.scrollTo(pos);
    if (this.cb.onPosition) this.cb.onPosition(this.getPosition());
  };
  Reader.prototype.zoomBy = function (f) { this.setZoom('custom', this.scale * f); };

  Reader.prototype.destroy = function () {
    this.destroyed = true;
    this.scroller.removeEventListener('scroll', this._onScroll, false);
    root.removeEventListener('resize', this._onResize, false);
    if (this.timer) clearTimeout(this.timer); if (this.posTimer) clearTimeout(this.posTimer);
    for (var i = 0; i < this.pages.length; i++) this._release(this.pages[i]);
    this.host.innerHTML = '';
    if (this.pdf) { try { this.pdf.destroy(); } catch (e) { } }
    this.pdf = null; this.pages = [];
  };

  root.RReader = Reader;
}(this));
