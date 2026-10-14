/* Readen web client: talks to the Mac's WebService (docs/WEB_PROTOCOL.md). ES5, callback style (old Safari friendly).
 * `transport(path, bodyObject, timeoutMs, cb(err, {status, json}))` is injected: XHR in browsers, http in node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crypto.js'));
  else root.RApi = factory(root.RCrypto);
}(this, function (C) {
  'use strict';
  var CHUNK = 128 * 1024;

  function fail(code, message) { return { code: code, message: message || code }; }

  function xhrTransport(base) {
    return function (path, body, timeout, cb) {
      var x = new XMLHttpRequest(), done = false;
      function finish(err, res) { if (!done) { done = true; cb(err, res); } }
      x.open('POST', base + path, true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = timeout || 60000;
      x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) { } finish(null, { status: x.status, json: j }); };
      x.onerror = x.ontimeout = x.onabort = function () { finish(fail('network', "Can't reach the Mac. Check that it is on the same Wi-Fi and that Readen's web access is on.")); };
      x.send(JSON.stringify(body));
    };
  }

  /** Plain GET (used only for /api/v1/ping). cb(err, {status, json}) */
  function xhrGet(url, timeout, cb) {
    var x = new XMLHttpRequest(), done = false;
    function finish(err, res) { if (!done) { done = true; cb(err, res); } }
    try { x.open('GET', url, true); } catch (e) { return finish(fail('network', 'Bad address.')); }
    x.timeout = timeout || 6000;
    x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) { } finish(null, { status: x.status, json: j }); };
    x.onerror = x.ontimeout = x.onabort = function () { finish(fail('network', "Can't reach that address.")); };
    x.send();
  }
  /** Asks `base` (or this page's own origin when base is '') whether a Readen Mac answers there. */
  function ping(base, cb) {
    xhrGet(base + '/api/v1/ping', 6000, function (err, r) {
      if (err) return cb(err);
      if (r.status === 200 && r.json && r.json.readen) return cb(null, r.json);
      cb(fail('not-readen', 'That address did not answer like a Readen Mac.'));
    });
  }

  function Client(opts) {
    this.transport = opts.transport;
    this.state = opts.state;                 // {deviceId, secret(b64), ctr, serverId, serverName}
    this.save = opts.save || function () { };
    this._queue = []; this._busy = false; this._keys = null;
  }

  Client.prototype.isPaired = function () { return !!(this.state.secret && this.state.serverId); };

  // ---- pairing ----
  Client.prototype.beginPairing = function (name, cb) {
    var self = this, st = this.state;
    if (!st.deviceId) { st.deviceId = C.hex(C.randomBytes(16)); this.save(); }
    var kp = C.keyPair(), nonceC = C.randomBytes(16), id = st.deviceId;
    var post = this.transport;
    post('/api/v1/pair/request', { v: 1, id: id, name: name, commit: C.b64encode(C.Pairing.commitment(kp.publicKey, nonceC)) }, 15000, function (err, r) {
      if (err) return cb(err);
      if (!r.json || !r.json.ok) return cb(fail(r.json && r.json.error || 'refused', r.json && r.json.error === 'pairing-off'
        ? 'The Mac isn\'t accepting new devices right now. Turn on "Visible to nearby devices" in Readen on the Mac.' : 'The Mac refused the pairing request.'));
      var pubS = C.b64decode(r.json.pub), nonceS = C.b64decode(r.json.nonce), serverId = r.json.serverId, serverName = r.json.serverName, pairId = r.json.pairId;
      post('/api/v1/pair/reveal', { pairId: pairId, pub: C.b64encode(kp.publicKey), nonce: C.b64encode(nonceC) }, 15000, function (err2, r2) {
        if (err2) return cb(err2);
        if (!r2.json || !r2.json.ok) return cb(fail('mismatch', 'Pairing failed. Please try again.'));
        var keys = C.Pairing.derive(C.x25519(kp.secretKey, pubS), id, serverId, kp.publicKey, pubS, nonceC, nonceS);
        cb(null, {
          code: keys.code, serverName: serverName,
          confirm: function (accepted, done) {
            post('/api/v1/pair/confirm', { pairId: pairId, ok: !!accepted, mac: accepted ? C.b64encode(keys.mac('C')) : '' }, 135000, function (err3, r3) {
              if (err3) return done(err3);
              if (!r3.json || !r3.json.ok) return done(fail('declined', accepted ? 'The pairing was declined on the Mac.' : 'Pairing cancelled.'));
              if (!C.equal(C.b64decode(r3.json.mac || ''), keys.mac('S'))) return done(fail('mismatch', 'The Mac could not be verified. Pairing was not completed.'));
              st.serverId = serverId; st.serverName = r3.json.serverName || serverName; st.secret = C.b64encode(keys.secret); st.ctr = 0;
              self._keys = null; self.save(); done(null);
            });
          }
        });
      });
    });
  };

  Client.prototype.forget = function () {
    var st = this.state; st.secret = null; st.serverId = null; st.serverName = null; st.ctr = 0; this._keys = null; this.save();
  };

  // ---- authenticated RPC (one request at a time so the replay counter stays strictly increasing) ----
  Client.prototype.rpc = function (op, args, cb) {
    var self = this;
    this._queue.push(function (next) { self._rpc(op, args || {}, function (e, d) { next(); cb(e, d); }); });
    this._pump();
  };
  Client.prototype._pump = function () {
    var self = this;
    if (this._busy || !this._queue.length) return;
    this._busy = true;
    var job = this._queue.shift();
    job(function () { self._busy = false; self._pump(); });
  };
  Client.prototype._rpc = function (op, args, cb) {
    var st = this.state;
    if (!this.isPaired()) return cb(fail('not-paired', 'Not paired with a Mac yet.'));
    var keys = this._keys || (this._keys = C.Session.keys(C.b64decode(st.secret)));
    st.ctr = (st.ctr || 0) + 1; this.save();          // persisted before sending: a counter is never reused
    var ctr = st.ctr, env = C.Session.seal(keys.c2s, { ctr: ctr, op: op, args: args });
    this.transport('/api/v1/rpc', { id: st.deviceId, n: env.n, c: env.c }, 70000, function (err, r) {
      if (err) return cb(err);
      if (r.status === 401) return cb(fail('unpaired', 'The Mac no longer recognises this device. Pair it again.'));
      if (r.status === 429) return cb(fail('busy', 'Too many requests. Wait a moment.'));
      if (r.status !== 200 || !r.json) return cb(fail('http-' + r.status, 'The Mac returned an error (' + r.status + ').'));
      var plain = C.Session.open(keys.s2c, r.json.n, r.json.c);
      if (!plain || plain.ctr !== ctr) return cb(fail('bad-response', 'The reply could not be verified.'));
      if (!plain.ok) return cb(fail(plain.error, plain.message));
      cb(null, plain.data);
    });
  };

  // ---- convenience operations ----
  Client.prototype.sync = function (ack, changes, cb) { this.rpc('sync', { ack: ack, changes: changes }, cb); };
  Client.prototype.library = function (cb) { this.rpc('library', {}, cb); };

  /** Downloads and verifies (SHA-256) a PDF. onProgress(bytes, total). */
  Client.prototype.download = function (hash, size, onProgress, cb) {
    var self = this, buf = new Uint8Array(size), off = 0;
    function step() {
      self.rpc('download', { hash: hash, offset: off, length: 192 * 1024 }, function (err, d) {
        if (err) return cb(err);
        var bytes = C.b64decode(d.data);
        if (off + bytes.length > size) return cb(fail('size', 'The file is larger than expected.'));
        buf.set(bytes, off); off += bytes.length;
        if (onProgress) onProgress(off, size);
        if (d.eof || off >= size) {
          if (off !== size) return cb(fail('size', 'The file arrived incomplete.'));
          if (C.hex(C.sha256(buf)) !== hash) return cb(fail('hash', 'The download failed its integrity check. Try again.'));
          return cb(null, buf);
        }
        if (!bytes.length) return cb(fail('size', 'The download stalled.'));
        step();
      });
    }
    step();
  };

  /** Uploads bytes; the Mac user must approve. cb(err, {state:'done'|'duplicate', hash}). onState('waiting'|'sending'). */
  Client.prototype.upload = function (bytes, name, hash, onProgress, onState, cb) {
    var self = this, uploadId, started = Date.now();
    self.rpc('offerUpload', { hash: hash, name: name, size: bytes.length }, function (err, o) {
      if (err) return cb(err);
      if (o.state === 'duplicate') return cb(null, { state: 'duplicate', hash: hash });
      uploadId = o.uploadId;
      if (onState) onState('waiting');
      function poll() {
        self.rpc('uploadStatus', { uploadId: uploadId }, function (e, s) {
          if (e) return cb(e);
          if (s.state === 'declined') return cb(fail('declined', 'The Mac declined the file.'));
          if (s.state === 'failed' || s.state === 'cancelled') return cb(fail('failed', 'The Mac could not accept the file.'));
          if (s.state === 'accepted') { if (onState) onState('sending'); return send(s.received || 0); }
          if (Date.now() - started > 600000) return cb(fail('timeout', 'Nobody approved the file on the Mac in time.'));
          setTimeout(poll, 1200);
        });
      }
      function send(off) {
        if (off >= bytes.length) return finish();
        var end = Math.min(off + CHUNK, bytes.length);
        self.rpc('upload', { uploadId: uploadId, offset: off, data: C.b64encode(bytes.subarray(off, end)) }, function (e) {
          if (e) return cb(e);
          if (onProgress) onProgress(end, bytes.length);
          send(end);
        });
      }
      function finish() {
        self.rpc('finishUpload', { uploadId: uploadId }, function (e, d) { if (e) return cb(e); cb(null, { state: 'done', hash: d.hash }); });
      }
      poll();
    });
  };

  return { Client: Client, xhrTransport: xhrTransport, xhrGet: xhrGet, ping: ping, fail: fail };
}));
