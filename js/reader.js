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
    this.lastScroll = 0; this.selectMode = false;
    this._onScroll = function () { self.lastScroll = Date.now(); if (self.selectMode) self.setSelectMode(false); self._soon(); self._positionSoon(); };
    this._onResize = function () { if (self.zoomMode === 'fitWidth' && self.pdf) { var p = self.getPosition(); self._layout(); self.scrollTo(p); } };
    this.pinch = null;
    this._onTS = function (e) { self._touchStart(e); };
    this._onTM = function (e) { self._touchMove(e); };
    this._onTE = function (e) { self._touchEnd(e); };
    scroller.addEventListener('scroll', this._onScroll, false);
    scroller.addEventListener('touchstart', this._onTS, false);
    scroller.addEventListener('touchend', this._onTE, false);
    scroller.addEventListener('touchcancel', this._onTE, false);
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
      if (p.tl && Math.abs(p.tlScale - this.scale) > 0.001) this._dropText(p);
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
    this.timer = setTimeout(function () { self.timer = null; self._renderVisible(); }, 20);
  };

  var SETTLE_MS = 150;       // TEST: no page drawing until the scroll has been still this long (delete the 'still' check in _renderVisible to undo)
  var BUDGET_PX = 30000000;   // total canvas pixels kept alive (~120 MB): fine for a 512 MB iPad mini 1, generous elsewhere

  /** Renders the page nearest the viewport that isn't drawn yet, looking a few screens ahead and behind (ahead is favoured
   * because that's where reading goes), then keeps going one page at a time while idle. Far pages are released to stay in budget. */
  Reader.prototype._renderVisible = function () {
    if (this.destroyed || !this.pdf || this.pinch) return;
    var still = Date.now() - this.lastScroll;                          // drawing a page blocks the thread that scrolls, so wait for the scroll to settle
    if (still < SETTLE_MS) { var me = this; if (!this.timer) this.timer = setTimeout(function () { me.timer = null; me._renderVisible(); }, SETTLE_MS - still); return; }
    this._ensureText();
    if (this.rendering) { this._soon(); return; }
    var st = this.scroller.scrollTop, vh = this.scroller.clientHeight, mid = st + vh / 2, best = null, bestD = 1e12, i, p, used = 0, drawn = [];
    var ahead = 5 * vh, behind = 2 * vh;
    for (i = 0; i < this.n; i++) {
      p = this.pages[i];
      var pt = p.top + 10, pc = pt + p.hpx / 2, d = pc - mid;
      if (p.canvas) { used += p.canvas.width * p.canvas.height; drawn.push(p); }
      var inRange = d >= 0 ? (pt - (st + vh) < ahead) : ((st - (pt + p.hpx)) < behind);
      if (inRange && (!p.canvas || Math.abs(p.scale - this.scale) > 0.001)) {
        var score = d < 0 ? -d * 1.6 : d;                              // pages behind count as farther away
        if (score < bestD) { bestD = score; best = p; }
      }
      if (!p.canvas && !p.page && inRange && i < this.n && !p.fetching) this._prefetch(p);
    }
    if (used > BUDGET_PX) {                                            // drop the drawn pages farthest from the viewport
      drawn.sort(function (x, y) { return Math.abs((y.top + y.hpx / 2) - mid) - Math.abs((x.top + x.hpx / 2) - mid); });
      for (i = 0; i < drawn.length && used > BUDGET_PX * 0.8; i++) { if (drawn[i] === best) continue; used -= drawn[i].canvas.width * drawn[i].canvas.height; this._release(drawn[i]); }
    }
    if (best) this._renderPage(best);
  };

  /** Fetching a page object is cheap; do it early so the render itself starts at once. */
  Reader.prototype._prefetch = function (p) {
    if (p.fetching || p.page) return;
    p.fetching = true;
    this.pdf.getPage(p.i + 1).then(function (page) { p.page = page; p.fetching = false; }, function () { p.fetching = false; });
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
        p.el.insertBefore(canvas, p.tl || null);          // the text layer stays on top of the picture
        self._soon();
      }, function (err) { self.rendering = false; p.scale = scale; self._report('render page ' + (p.i + 1), err); self._soon(); });
    };
    if (p.page) go(p.page); else this.pdf.getPage(p.i + 1).then(function (page) { p.page = page; go(page); }, function (err) { self.rendering = false; p.scale = scale; self._report('load page ' + (p.i + 1), err); });
  };

  /** Invisible, selectable text laid over a page, so words can be selected, looked up in the system dictionary and sent to Ask AI.
   * It is kept for the pages on screen and one on each side (not tied to the picture being drawn), so a passage that runs onto the
   * next page can be selected across the page break. Best effort: a PDF without text (a scan) simply has nothing to select. */
  Reader.prototype._dropText = function (p) { if (p.tl) { if (p.tl.parentNode) p.tl.parentNode.removeChild(p.tl); p.tl = null; } p.tlScale = 0; };

  /** The text layer exists only in select mode, which the app turns on when asked and which ends at the next scroll. With the text spans in place
   * old Safari (iPad mini 1) tracks every touch against them and dragging lags, even when they are hidden only once the scroll starts. */
  Reader.prototype.setSelectMode = function (on) {
    if (this.selectMode === on) return;
    this.selectMode = on;
    if (on) this._soon(); else for (var i = 0; i < this.n; i++) this._dropText(this.pages[i]);
    if (this.cb.onSelectMode) this.cb.onSelectMode(on);
  };

  Reader.prototype._ensureText = function () {
    if (!this.selectMode || !root.pdfjsLib.renderTextLayer) return;
    var st = this.scroller.scrollTop, vh = this.scroller.clientHeight, i, p, first = -1, last = -1;
    for (i = 0; i < this.n; i++) { p = this.pages[i]; if (p.top + 10 + p.hpx >= st && p.top + 10 <= st + vh) { if (first < 0) first = i; last = i; } }
    if (first < 0) return;
    var from = Math.max(0, first - 1), to = Math.min(this.n - 1, last + 1);
    for (i = 0; i < this.n; i++) {
      p = this.pages[i];
      if (i < from - 1 || i > to + 1) { if (p.tl) this._dropText(p); continue; }
      if (i >= from && i <= to && !p.tl && !p.textBusy && !this.textActive) this._textLayer(p);   // one at a time: each is a burst of DOM work
    }
  };

  Reader.prototype._textLayer = function (p) {
    var self = this, scale = this.scale; p.textBusy = true; this.textActive = true;
    var done = function () { p.textBusy = false; self.textActive = false; };
    var go = function (page) {
      page.getTextContent().then(function (tc) {
        done();
        if (self.destroyed || p.tl || !self.selectMode || Math.abs(scale - self.scale) > 0.001) { if (!self.destroyed && !p.tl && self.selectMode) self._soon(); return; }
        var div = document.createElement('div'); div.className = 'textLayer';
        var end = document.createElement('div'); end.className = 'endOfContent';
        p.el.appendChild(div); p.tl = div; p.tlScale = scale;
        root.pdfjsLib.renderTextLayer({ textContent: tc, container: div, viewport: page.getViewport(scale), textDivs: [] });
        div.appendChild(end);
        self._soon();                                                   // next page's text, if any
      }, done);
    };
    if (p.page) go(p.page); else this.pdf.getPage(p.i + 1).then(function (page) { p.page = page; go(page); }, done);
  };

  /** The plain text of one page (for "Add the next page" in Ask AI). cb(text). */
  Reader.prototype.pageText = function (i, cb) {
    if (!this.pdf || i < 0 || i >= this.n) return cb('');
    this.pdf.getPage(i + 1).then(function (page) { return page.getTextContent(); }).then(function (tc) {
      var parts = [], k; for (k = 0; k < tc.items.length; k++) parts.push(tc.items[k].str);
      cb(parts.join(' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''));
    }, function () { cb(''); });
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

  // ---- pinch to zoom (two fingers). During the gesture the whole page column is scaled with a CSS transform (instant, no rendering);
  // on release the real zoom is applied and pages re-render sharp at the new size, keeping the spot under your fingers in place. ----
  function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }

  Reader.prototype._touchStart = function (e) {
    if (!this.pdf || !e.touches || e.touches.length !== 2) return;
    var r = this.scroller.getBoundingClientRect(), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    this.pinch = { d0: dist(e.touches), ratio: 1, cx: cx, cy: cy, x0: this.scroller.scrollLeft + cx, y0: this.scroller.scrollTop + cy, scale0: this.scale };
    this.host.style.webkitTransformOrigin = this.host.style.transformOrigin = this.pinch.x0 + 'px ' + this.pinch.y0 + 'px';
    this.scroller.addEventListener('touchmove', this._onTM, false);   // only while pinching: a touchmove listener makes old Safari wait for the page before every scroll step
  };
  Reader.prototype._touchMove = function (e) {
    var pc = this.pinch; if (!pc || !e.touches || e.touches.length < 2) return;
    if (e.preventDefault) e.preventDefault();                        // no native scroll/zoom while pinching
    var ratio = dist(e.touches) / (pc.d0 || 1), s = Math.max(0.2, Math.min(5, pc.scale0 * ratio));
    pc.ratio = s / pc.scale0;
    this.host.style.webkitTransform = this.host.style.transform = 'scale(' + pc.ratio + ')';
  };
  Reader.prototype._touchEnd = function (e) {
    var pc = this.pinch; if (!pc) return;
    if (e.touches && e.touches.length >= 2) return;                   // still pinching
    this.pinch = null;
    this.scroller.removeEventListener('touchmove', this._onTM, false);
    this.host.style.webkitTransform = this.host.style.transform = '';
    this.host.style.webkitTransformOrigin = this.host.style.transformOrigin = '';
    if (Math.abs(pc.ratio - 1) < 0.02) { this._soon(); return; }
    this.zoomAt(pc.scale0 * pc.ratio, pc.cx, pc.cy, pc.x0, pc.y0);
  };
  /** Sets a custom zoom so the point at scroller-relative (cx, cy), previously at content (x0, y0), stays under the same spot. */
  Reader.prototype.zoomAt = function (scale, cx, cy, x0, y0) {
    var oldScale = this.scale, st = y0, i = this.currentIndexAt(st), p = this.pages[i], offY = (st - (p.top + 10)) / oldScale;
    this.zoomMode = 'custom'; this.scale = Math.max(0.2, Math.min(5, scale));
    var ratio = this.scale / oldScale;
    this.restoring = true;
    this._layout();
    this.scroller.scrollTop = Math.max(0, p.top + 10 + offY * this.scale - cy);
    this.scroller.scrollLeft = Math.max(0, x0 * ratio - cx);
    var self = this; setTimeout(function () { self.restoring = false; }, 250);
    this._soon();
    if (this.cb.onPosition) this.cb.onPosition(this.getPosition());
  };
  Reader.prototype.currentIndexAt = function (y) {
    var lo = 0, hi = this.n - 1, mid;
    while (lo < hi) { mid = (lo + hi + 1) >> 1; if (this.pages[mid].top + 10 <= y) lo = mid; else hi = mid - 1; }
    return lo;
  };

  Reader.prototype.destroy = function () {
    this.destroyed = true;
    this.scroller.removeEventListener('scroll', this._onScroll, false);
    this.scroller.removeEventListener('touchstart', this._onTS, false); this.scroller.removeEventListener('touchmove', this._onTM, false);
    this.scroller.removeEventListener('touchend', this._onTE, false); this.scroller.removeEventListener('touchcancel', this._onTE, false);
    root.removeEventListener('resize', this._onResize, false);
    if (this.timer) clearTimeout(this.timer); if (this.posTimer) clearTimeout(this.posTimer);
    for (var i = 0; i < this.pages.length; i++) { this._release(this.pages[i]); this._dropText(this.pages[i]); }
    this.host.innerHTML = '';
    if (this.pdf) { try { this.pdf.destroy(); } catch (e) { } }
    this.pdf = null; this.pages = [];
  };

  root.RReader = Reader;
}(this));
