/* Readen cloud sync: an END-TO-END ENCRYPTED mailbox in the user's own private GitHub repository, so devices that are never online
 * at the same time (iPhone, iPad, anything with a browser) can still converge. GitHub only ever sees ciphertext and sizes.
 *
 * Layout in the repo (all files are binary ciphertext, NaCl secretbox, key = the 32-byte "sync key" that never leaves the devices):
 *   readen/v1/state.bin                    library list + reading positions + bookmarks (merged with the same rules as everywhere)
 *   readen/v1/pdf/<keyed id>/meta.bin      written LAST: its existence means the PDF is complete in the cloud (<keyed id> = HMAC(key, sha256), so
 *                                          the repository can't be searched for a known file)
 *   readen/v1/pdf/<keyed id>/NNNN.bin      1 MiB chunks, each bound to (hash, index) so chunks can't be swapped between files
 * ES5; callbacks; no WebCrypto (works over plain HTTP and on old Safari). Documented in docs/CLOUD_SYNC.md. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crypto.js'), require('./logic.js'));
  else root.RCloud = factory(root.RCrypto, root.RLogic);
}(this, function (C, L) {
  'use strict';
  var CHUNK = 1048576, BASE = 'readen/v1', TEXT_SNIFF = 8192;

  function fail(code, message, extra) { var e = { code: code, message: message || code }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }

  // ---------- helpers ----------
  function stable(v) {                                    // deterministic JSON (sorted keys) so two devices compare equal states equal
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function digest(v) { return C.hex(C.sha256(C.utf8(stable(v)))); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function pad4(n) { var s = String(n); while (s.length < 4) s = '0' + s; return s; }
  function u32(n) { return new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
  function b64url(s) { return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; }

  // ---------- setup code (carries repo, token and key to another device; treat it like a password) ----------
  function makeSetupCode(cfg) {
    return 'RDN1.' + b64url(C.b64encode(C.utf8(JSON.stringify({ r: cfg.repo, t: cfg.token, k: cfg.key, a: cfg.api && cfg.api !== 'https://api.github.com' ? cfg.api : undefined })))) + '~';
  }
  function decodeSetupBody(body) {
    try {
      var o = JSON.parse(C.utf8decode(C.b64decode(unb64url(body))));
      if (!o || !/^[\w.\-]+\/[\w.\-]+$/.test(o.r) || typeof o.t !== 'string' || o.t.length < 20 || C.b64decode(o.k).length !== 32) return null;
      return { repo: o.r, token: o.t, key: o.k, api: o.a || 'https://api.github.com' };
    } catch (e) { return null; }
  }
  /** Accepts the code pasted with anything around it (chat text, line breaks). The code ends at "~"; without it, trailing junk is trimmed. */
  function parseSetupCode(text) {
    var t = String(text || ''), at = t.indexOf('RDN1.');
    if (at < 0) return null;
    var rest = t.slice(at + 5), end = rest.indexOf('~'), body, r, i;
    if (end >= 0) return decodeSetupBody(rest.slice(0, end).replace(/\s+/g, ''));
    body = (rest.match(/^[A-Za-z0-9_\-\s]*/) || [''])[0].replace(/\s+/g, '');
    for (i = 0; i < 80 && body.length > 20; i++, body = body.slice(0, -1)) { r = decodeSetupBody(body); if (r) return r; }
    return null;
  }
  function newKey() { return C.b64encode(C.randomBytes(32)); }

  // ---------- transport (XHR in browsers; tests inject their own) ----------
  function xhrTransport(method, url, opts, cb) {
    var x = new XMLHttpRequest(), done = false, k;
    function finish(err, res) { if (!done) { done = true; cb(err, res); } }
    try { x.open(method, url, true); } catch (e) { return finish(fail('network', 'Bad address.')); }
    for (k in (opts.headers || {})) x.setRequestHeader(k, opts.headers[k]);
    x.responseType = opts.binary ? 'arraybuffer' : 'text';
    x.timeout = opts.timeout || 60000;
    x.onload = function () {
      var headers = {}, raw = x.getAllResponseHeaders() || '', lines = raw.split(/\r?\n/), i, ix;
      for (i = 0; i < lines.length; i++) { ix = lines[i].indexOf(':'); if (ix > 0) headers[lines[i].slice(0, ix).toLowerCase()] = lines[i].slice(ix + 1).replace(/^\s+/, ''); }
      finish(null, { status: x.status, headers: headers, body: x.response });
    };
    x.onerror = x.ontimeout = x.onabort = function () { finish(fail('network', "Can't reach GitHub. Check your internet connection." + (/\/\/api\.github\.com\//.test(url) ? ' If other sites load, this device may not trust GitHub\'s certificate: join again and fill in the Relay address (see docs/RELAY.md).' : ' The relay at ' + url.replace(/^(https:\/\/[^\/]+).*$/, '$1') + ' did not answer.'))); };
    x.send(opts.body === undefined ? null : opts.body);
  }

  // ---------- the client ----------
  function Cloud(cfg, transport) {
    this.cfg = cfg; this.transport = transport || xhrTransport; this.key = C.b64decode(cfg.key);
    this.api = (cfg.api || 'https://api.github.com').replace(/\/$/, '');
    this._queue = []; this._busy = false;
  }

  /** Runs one cloud operation at a time (state sync and uploads must not interleave). */
  Cloud.prototype.enqueue = function (job) { var self = this; this._queue.push(job); (function pump() {
    if (self._busy || !self._queue.length) return; self._busy = true; var j = self._queue.shift();
    j(function () { self._busy = false; pump(); }); })(); };

  Cloud.prototype._request = function (method, path, opts, cb, attempt) {
    var self = this, url = this.api + '/repos/' + this.cfg.repo + path;
    attempt = attempt || 0;
    opts = opts || {};
    var headers = { 'Authorization': 'Bearer ' + this.cfg.token, 'X-GitHub-Api-Version': '2022-11-28', 'Accept': opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    if (opts.json) headers['Content-Type'] = 'application/json';
    this.transport(method, url, { headers: headers, body: opts.json ? JSON.stringify(opts.json) : undefined, binary: !!opts.raw, timeout: opts.timeout }, function (err, res) {
      if (err) return cb(err);
      var s = res.status;
      if (s === 403 || s === 429) {                               // rate limits: wait as GitHub asks, a few times, then report
        var wait = parseInt(res.headers['retry-after'], 10);
        var reset = parseInt(res.headers['x-ratelimit-reset'], 10), remaining = res.headers['x-ratelimit-remaining'];
        if (isNaN(wait) && remaining === '0' && !isNaN(reset)) wait = Math.max(1, reset - Math.floor(Date.now() / 1000));
        if (!isNaN(wait)) {
          if (attempt < 3 && wait <= (self.cfg.maxWaitSeconds || 90)) return setTimeout(function () { self._request(method, path, opts, cb, attempt + 1); }, wait * 1000);
          return cb(fail('rate-limit', 'GitHub asked us to slow down. Try again in about ' + Math.max(1, Math.ceil(wait / 60)) + ' minute(s).', { retryAfter: wait }));
        }
      }
      if (s === 401) return cb(fail('auth', 'GitHub rejected the access token. It may have expired or been revoked. Make a new one and set up again.'));
      cb(null, res);
    });
  };

  function bodyText(res) { return typeof res.body === 'string' ? res.body : ''; }
  function jsonOf(res) { try { return JSON.parse(bodyText(res)); } catch (e) { return null; } }

  /** Checks the repository and token. cb(err, {private:true}). Refuses public repositories and read-only tokens. */
  Cloud.prototype.check = function (cb) {
    this._request('GET', '', {}, function (err, res) {
      if (err) return cb(err);
      if (res.status === 404) return cb(fail('repo', 'Repository not found, or the token can\'t see it. Check the name (owner/repo) and that the token was given access to this repository.'));
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      var j = jsonOf(res) || {};
      if (j.private !== true) return cb(fail('public-repo', 'That repository is public. Use a private repository (your data is encrypted either way, but nothing here should be public).'));
      if (j.permissions && j.permissions.push === false) return cb(fail('read-only', 'The token can only read this repository. It needs Contents: read and write.'));
      cb(null, { private: true });
    });
  };

  // ---------- sealing ----------
  /** GitHub's Contents API hands back a file that looks like text (no zero byte) as UTF-8 text, which silently corrupts random ciphertext.
   *  Only small files can lack a zero byte, so those get a fresh nonce until they contain one. */
  Cloud.prototype._seal = function (plain) {
    var out, s, i, tries = 0, nul;
    do {
      s = C.Session.sealBytes(this.key, plain); out = C.concat(s.n, s.c);
      nul = false; for (i = 0; i < out.length && i < TEXT_SNIFF; i++) if (out[i] === 0) { nul = true; break; }
    } while (!nul && out.length <= TEXT_SNIFF && ++tries < 1000);
    return out;
  };
  Cloud.prototype._open = function (bytes) {
    if (bytes.length < 24 + 16) return null;
    return C.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), this.key);
  };

  Cloud.prototype._putFile = function (path, bytes, sha, cb) {
    var body = { message: 'sync', content: C.b64encode(bytes) }; if (sha) body.sha = sha;
    this._request('PUT', '/contents/' + path, { json: body, timeout: 120000 }, function (err, res) {
      if (err) return cb(err);
      if (res.status === 200 || res.status === 201) { var j = jsonOf(res) || {}; return cb(null, { sha: j.content && j.content.sha, created: res.status === 201 }); }
      if (res.status === 409 || res.status === 422) return cb(fail('conflict', 'The file changed on GitHub meanwhile.'));
      if (res.status === 404) return cb(fail('repo', 'Repository not found or not writable.'));
      cb(fail('http-' + res.status, 'GitHub answered ' + res.status + ' while saving.'));
    });
  };

  Cloud.prototype._getRaw = function (path, cb) {
    this._request('GET', '/contents/' + path, { raw: true, timeout: 120000 }, function (err, res) {
      if (err) return cb(err);
      if (res.status === 404) return cb(null, null);
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      cb(null, new Uint8Array(res.body));
    });
  };

  /** The bytes of a file from a Contents API answer. A length different from `size` means GitHub mangled it as text (files written before
   *  _seal avoided that), so the blob itself is fetched instead. */
  Cloud.prototype._bytesOf = function (j, cb) {
    var bytes = j.content ? C.b64decode(j.content) : null;
    if (bytes && (typeof j.size !== 'number' || bytes.length === j.size)) return cb(null, bytes);
    if (typeof j.sha !== 'string') return cb(fail('corrupt', 'The file could not be read.'));
    this._request('GET', '/git/blobs/' + j.sha, { raw: true, timeout: 120000 }, function (err, res) {
      if (err) return cb(err);
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + ' while reading a file.' + (res.status === 404 ? ' If you use a relay, redeploy it from relay/ so it forwards file blobs.' : '')));
      var b = new Uint8Array(res.body);
      if (typeof j.size === 'number' && b.length !== j.size) return cb(fail('corrupt', 'The file arrived damaged (' + b.length + ' of ' + j.size + ' bytes).'));
      cb(null, b);
    });
  };

  /** Like _getRaw but safe for small files (see _bytesOf). */
  Cloud.prototype._getSmall = function (path, cb) {
    var self = this;
    this._request('GET', '/contents/' + path, { timeout: 120000 }, function (err, res) {
      if (err) return cb(err);
      if (res.status === 404) return cb(null, null);
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      var j = jsonOf(res); if (!j) return cb(fail('corrupt', 'The file could not be read.'));
      self._bytesOf(j, cb);
    });
  };

  Cloud.prototype._list = function (dir, cb) {
    this._request('GET', '/contents/' + dir, {}, function (err, res) {
      if (err) return cb(err);
      if (res.status === 404) return cb(null, []);
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      cb(null, jsonOf(res) || []);
    });
  };

  // ---------- state ----------
  /** cb(err, {exists, notModified, state, sha, etag}) */
  Cloud.prototype.getState = function (etag, cb) {
    var self = this;
    this._request('GET', '/contents/' + BASE + '/state.bin', { etag: etag }, function (err, res) {
      if (err) return cb(err);
      if (res.status === 304) return cb(null, { exists: true, notModified: true });
      if (res.status === 404) return cb(null, { exists: false });
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      var j = jsonOf(res); if (!j || !j.content) return cb(fail('corrupt', 'The saved state could not be read.'));
      self._bytesOf(j, function (e2, bytes) {
        if (e2) return cb(e2);
        var plain = self._open(bytes);
        if (!plain) return cb(fail('bad-key', 'This device\'s encryption key does not match the data in the repository. Nothing was changed. Set up again with the code from your first device.'));
        var state; try { state = JSON.parse(C.utf8decode(plain)); } catch (e) { return cb(fail('corrupt', 'The saved state is damaged.')); }
        cb(null, { exists: true, state: state, sha: j.sha, etag: res.headers.etag });
      });
    });
  };

  function coreOf(s) { return { docs: s.docs || {}, progress: s.progress || {}, bookmarks: s.bookmarks || {} }; }

  /** Everything this device knows, in the cloud format. */
  function exportState(local) {
    var out = { docs: clone(local.cloudDocs || {}), progress: {}, bookmarks: {} }, k, d, e;
    for (k in local.docs) {
      d = local.docs[k]; e = out.docs[k];
      if (!e || (e.deleted && (d.added || 0) > (e.updatedAtMs || 0)) || (!e.deleted && e.name !== d.name && (d.added || 0) > (e.updatedAtMs || 0))) {
        out.docs[k] = { hash: d.hash, name: d.name, size: d.size, pages: d.pages || null, added: d.added || Date.now(), updatedAtMs: Math.max(d.added || 0, e ? (e.updatedAtMs || 0) + 1 : 0) || Date.now() };
      }
    }
    for (k in local.progress) { var p = clone(local.progress[k]); delete p.seq; out.progress[k] = p; }
    for (k in local.bookmarks) { var b = clone(local.bookmarks[k]); delete b.seq; out.bookmarks[k] = b; }
    return out;
  }

  /** Merge what's in the cloud into this device. Returns the number of records adopted. */
  function mergeRemote(local, remote) {
    var cs = { progress: [], bookmarks: [] }, k, h, r, l;
    for (k in (remote.progress || {})) cs.progress.push(remote.progress[k]);
    for (k in (remote.bookmarks || {})) cs.bookmarks.push(remote.bookmarks[k]);
    var adopted = L.applyRemote(local, cs);
    local.cloudDocs = local.cloudDocs || {};
    for (h in (remote.docs || {})) {
      r = remote.docs[h]; l = local.cloudDocs[h];
      if (!l || (r.updatedAtMs || 0) > (l.updatedAtMs || 0)) local.cloudDocs[h] = r;
    }
    return adopted;
  }

  /** One full sync of reading state. `local` is the app state object (logic.js). cb(err, {adopted, pushed}). */
  Cloud.prototype.sync = function (local, cb) {
    var self = this;
    this.enqueue(function (release) {
      function end(err, res) { release(); cb(err, res); }
      local.cloud = local.cloud || {};
      var c = local.cloud, tries = 0;
      (function attempt() {
        if (++tries > 5) return end(fail('conflict', 'Another device kept changing the cloud copy. Try again in a moment.'));
        self.getState(c.etag && c.sha ? c.etag : null, function (err, r) {
          if (err) return end(err);
          var adopted = 0, remoteDigest = null;
          if (r.exists && !r.notModified) { adopted = mergeRemote(local, r.state); c.sha = r.sha; c.etag = r.etag; remoteDigest = digest(coreOf(r.state)); }
          else if (r.exists && r.notModified) remoteDigest = c.pushed || null;
          else { c.sha = null; c.etag = null; }
          var out = exportState(local), d = digest(out);
          if (r.exists && d === remoteDigest) { c.pushed = d; return end(null, { adopted: adopted, pushed: false }); }
          var plain = C.utf8(JSON.stringify({ v: 1, rev: (c.rev || 0) + 1, savedBy: local.deviceId, savedAt: Date.now(), docs: out.docs, progress: out.progress, bookmarks: out.bookmarks }));
          self._putFile(BASE + '/state.bin', self._seal(plain), r.exists ? c.sha : null, function (e2, w) {
            if (e2 && e2.code === 'conflict') { c.etag = null; return attempt(); }
            if (e2) return end(e2);
            c.sha = w.sha; c.etag = null; c.pushed = d; c.rev = (c.rev || 0) + 1;
            end(null, { adopted: adopted, pushed: true });
          });
        });
      })();
    });
  };

  // ---------- the shared OpenAI key (opt-in): one more sealed file, readen/v1/ai.bin, same key and sealing as the state ----------
  /** cb(err, {ai, sha}); ai is null when there is no shared copy yet. The plaintext never leaves this function except as the parsed record. */
  Cloud.prototype.getAi = function (cb) {
    var self = this;
    this._request('GET', '/contents/' + BASE + '/ai.bin', {}, function (err, res) {
      if (err) return cb(err);
      if (res.status === 404) return cb(null, { ai: null, sha: null });
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      var j = jsonOf(res); if (!j || !j.content) return cb(fail('corrupt', 'The shared key could not be read.'));
      self._bytesOf(j, function (e2, bytes) {
        if (e2) return cb(e2);
        var plain = self._open(bytes);
        if (!plain) return cb(fail('bad-key', 'This device\'s encryption key does not match the data in the repository.'));
        var ai; try { ai = JSON.parse(C.utf8decode(plain)); } catch (e) { return cb(fail('corrupt', 'The shared key is damaged.')); }
        if (!ai || ai.v !== 1) return cb(null, { ai: null, sha: j.sha });
        cb(null, { ai: ai, sha: j.sha });
      });
    });
  };

  /** Brings this device and the cloud copy of the OpenAI key into line (last change wins). `ask` is RAsk. cb(err, {action}). */
  Cloud.prototype.syncAi = function (ask, deviceId, cb) {
    var self = this;
    this.enqueue(function (release) {
      function end(err, res) { release(); cb(err, res); }
      var tries = 0;
      (function attempt() {
        if (++tries > 3) return end(fail('conflict', 'Another device kept changing the shared key. Try again in a moment.'));
        self.getAi(function (err, r) {
          if (err) return end(err);
          var local = ask.load(), act = ask.decide(local, r.ai);
          if (act === 'adopt') { ask.applyRemote(r.ai); return end(null, { action: 'adopted' }); }
          if (act !== 'push') return end(null, { action: 'none' });
          self._putFile(BASE + '/ai.bin', self._seal(C.utf8(JSON.stringify(ask.toWire(local, deviceId)))), r.sha || null, function (e2) {
            if (e2 && e2.code === 'conflict') return attempt();
            if (e2) return end(e2);
            end(null, { action: 'pushed' });
          });
        });
      })();
    });
  };

  // ---------- saved AI explanations: readen/v1/explain.bin, sealed like state.bin; records merge by id, newest change wins, deletions are tombstones ----------
  Cloud.prototype.getExplain = function (cb) {
    var self = this;
    this._request('GET', '/contents/' + BASE + '/explain.bin', {}, function (err, res) {
      if (err) return cb(err);
      if (res.status === 404) return cb(null, { list: [], sha: null });
      if (res.status !== 200) return cb(fail('http-' + res.status, 'GitHub answered ' + res.status + '.'));
      var j = jsonOf(res); if (!j || !j.content) return cb(fail('corrupt', 'The saved explanations could not be read.'));
      self._bytesOf(j, function (e2, bytes) {
        if (e2) return cb(e2);
        var plain = self._open(bytes);
        if (!plain) return cb(fail('bad-key', 'This device\'s encryption key does not match the data in the repository.'));
        var o; try { o = JSON.parse(C.utf8decode(plain)); } catch (e) { return cb(fail('corrupt', 'The saved explanations are damaged.')); }
        cb(null, { list: (o && o.v === 1 && o.items instanceof Array) ? o.items : [], sha: j.sha });
      });
    });
  };

  /** Merges this device's saved explanations with the cloud copy and writes back whatever the cloud lacks. `ask` is RAsk. cb(err, {pulled, pushed}). */
  Cloud.prototype.syncExplain = function (ask, deviceId, cb) {
    var self = this;
    this.enqueue(function (release) {
      function end(err, res) { release(); cb(err, res); }
      var tries = 0;
      (function attempt() {
        if (++tries > 3) return end(fail('conflict', 'Another device kept changing the saved explanations. Try again in a moment.'));
        self.getExplain(function (err, r) {
          if (err) return end(err);
          var m = ask.mergeExplain(ask.loadExplain(), r.list);
          if (m.pull) ask.applyExplain(m.list);
          if (!m.push) return end(null, { pulled: m.pull, pushed: false });
          var plain = C.utf8(JSON.stringify({ v: 1, savedBy: deviceId || '', items: m.list }));
          self._putFile(BASE + '/explain.bin', self._seal(plain), r.sha || null, function (e2) {
            if (e2 && e2.code === 'conflict') return attempt();
            if (e2) return end(e2);
            end(null, { pulled: m.pull, pushed: true });
          });
        });
      })();
    });
  };

  // ---------- PDFs ----------
  /** Folder name in the repository: a keyed hash of the PDF's hash, so the repo can't be used to test "does this person have file X?". */
  Cloud.prototype._dir = function (hash) { return BASE + '/pdf/' + C.hex(C.hmac(this.key, C.utf8('readen-pdf-path:' + hash))).slice(0, 32); };

  function chunkPlain(hash, index, data) { return C.concat(C.unhex(hash), u32(index), data); }
  function openChunk(self, hash, index, bytes) {
    var plain = self._open(bytes);
    if (!plain || plain.length < 36) return null;
    var want = C.concat(C.unhex(hash), u32(index));
    return C.equal(plain.subarray(0, 36), want) ? plain.subarray(36) : null;
  }

  /** Uploads a PDF (resumable: chunks already in the cloud are skipped). onProgress(done, total). */
  Cloud.prototype.uploadPdf = function (doc, bytes, onProgress, cb) {
    var self = this, n = Math.max(1, Math.ceil(bytes.length / CHUNK)), dir = this._dir(doc.hash);
    this.enqueue(function (release) {
      function end(err, res) { release(); cb(err, res); }
      self._getRaw(dir + '/meta.bin', function (err, meta) {
        if (err) return end(err);
        if (meta) return end(null, { already: true });
        self._list(dir, function (e2, files) {
          if (e2) return end(e2);
          var have = {}, i; for (i = 0; i < files.length; i++) have[files[i].name] = true;
          i = 0;
          (function next() {
            if (i >= n) {
              var metaPlain = C.utf8(JSON.stringify({ hash: doc.hash, name: doc.name, size: bytes.length, pages: doc.pages || null, chunks: n, chunkSize: CHUNK, v: 1 }));
              return self._putFile(dir + '/meta.bin', self._seal(metaPlain), null, function (e4) { e4 ? end(e4) : end(null, { already: false }); });
            }
            var idx = i++, name = pad4(idx) + '.bin';
            if (have[name]) { if (onProgress) onProgress(Math.min((idx + 1) * CHUNK, bytes.length), bytes.length); return next(); }
            var piece = bytes.subarray(idx * CHUNK, Math.min((idx + 1) * CHUNK, bytes.length));
            self._putFile(dir + '/' + name, self._seal(chunkPlain(doc.hash, idx, piece)), null, function (e3) {
              if (e3 && e3.code === 'conflict') { if (onProgress) onProgress(Math.min((idx + 1) * CHUNK, bytes.length), bytes.length); return next(); }   // already there (resumed elsewhere)
              if (e3) return end(e3);
              if (onProgress) onProgress(Math.min((idx + 1) * CHUNK, bytes.length), bytes.length);
              next();
            });
          })();
        });
      });
    });
  };

  /** Downloads and verifies a PDF. cb(err, Uint8Array). */
  Cloud.prototype.downloadPdf = function (hash, onProgress, cb) {
    var self = this, dir = this._dir(hash);
    this.enqueue(function (release) {
      function end(err, res) { release(); cb(err, res); }
      self._getSmall(dir + '/meta.bin', function (err, metaBytes) {
        if (err) return end(err);
        if (!metaBytes) return end(fail('not-in-cloud', 'That PDF is not (or no longer) in the cloud.'));
        var plain = self._open(metaBytes), meta;
        if (!plain) return end(fail('bad-key', 'Wrong encryption key for this file (received ' + metaBytes.length + ' bytes for its description). Compare the key fingerprint in Cloud sync on each device; if they differ, join again with a fresh setup code from a device that works.'));
        try { meta = JSON.parse(C.utf8decode(plain)); } catch (e) { return end(fail('corrupt', 'The file description is damaged.')); }
        if (meta.hash !== hash || !(meta.size >= 0) || meta.size > 2000000000) return end(fail('corrupt', 'The file description does not match.'));
        var out = new Uint8Array(meta.size), off = 0, i = 0;
        (function next() {
          if (i >= meta.chunks) {
            if (off !== meta.size) return end(fail('corrupt', 'The file is incomplete in the cloud.'));
            if (C.hex(C.sha256(out)) !== hash) return end(fail('hash', 'The downloaded file failed its integrity check.'));
            return end(null, out);
          }
          var idx = i++;
          // only the last part can be small enough for GitHub to mistake for text
          self[idx === meta.chunks - 1 ? '_getSmall' : '_getRaw'](dir + '/' + pad4(idx) + '.bin', function (e2, b) {
            if (e2) return end(e2);
            if (!b) return end(fail('corrupt', 'Part ' + (idx + 1) + ' of ' + meta.chunks + ' is missing in the cloud.'));
            var piece = openChunk(self, hash, idx, b);
            if (!piece) return end(fail('corrupt', 'Part ' + (idx + 1) + ' failed its integrity check.'));
            if (off + piece.length > meta.size) return end(fail('corrupt', 'The file is larger than described.'));
            out.set(piece, off); off += piece.length;
            if (onProgress) onProgress(off, meta.size);
            next();
          });
        })();
      });
    });
  };

  /** Removes a PDF's files from the repository (the caller marks it deleted in the state). */
  Cloud.prototype.deletePdf = function (hash, cb) {
    var self = this, dir = this._dir(hash);
    this.enqueue(function (release) {
      function end(err) { release(); cb(err); }
      self._list(dir, function (err, files) {
        if (err) return end(err);
        var i = 0;
        // meta first: the moment it is gone the PDF counts as not in the cloud, even if we stop halfway
        files.sort(function (a, b) { return a.name === 'meta.bin' ? -1 : b.name === 'meta.bin' ? 1 : 0; });
        (function next() {
          if (i >= files.length) return end(null);
          var f = files[i++];
          self._request('DELETE', '/contents/' + dir + '/' + f.name, { json: { message: 'remove', sha: f.sha } }, function (e2, res) {
            if (e2) return end(e2);
            if (res.status !== 200 && res.status !== 404) return end(fail('http-' + res.status, 'GitHub answered ' + res.status + ' while deleting.'));
            next();
          });
        })();
      });
    });
  };

  /** PDFs currently in the cloud library (not deleted). */
  function cloudDocs(local) {
    var out = [], h, d; for (h in (local.cloudDocs || {})) { d = local.cloudDocs[h]; if (!d.deleted) out.push(d); }
    out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    return out;
  }
  function markDeleted(local, hash) { local.cloudDocs = local.cloudDocs || {}; var d = local.cloudDocs[hash] || { hash: hash, name: hash }; d.deleted = true; d.updatedAtMs = Date.now(); local.cloudDocs[hash] = d; }

  return { Cloud: Cloud, xhrTransport: xhrTransport, makeSetupCode: makeSetupCode, parseSetupCode: parseSetupCode, newKey: newKey, cloudDocs: cloudDocs,
           markDeleted: markDeleted, exportState: exportState, mergeRemote: mergeRemote, stable: stable, digest: digest, CHUNK: CHUNK, fail: fail };
}));
