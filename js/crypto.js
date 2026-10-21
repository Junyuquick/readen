/* Readen web client crypto. ES5 only (must run on old Safari). No WebCrypto: pages served over plain HTTP have no
 * crypto.subtle. Primitives come from vetted libraries: tweetnacl-js (X25519, XSalsa20-Poly1305) and js-sha256.
 * HMAC and HKDF are the standard RFC 2104 / RFC 5869 constructions over js-sha256's HMAC and are tested against
 * node's built-in crypto (web/test). Protocol: docs/WEB_PROTOCOL.md. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/nacl-fast.min.js'), require('../vendor/sha256.min.js'));
  } else {
    root.RCrypto = factory(root.nacl, root.sha256);
  }
}(this, function (nacl, sha256) {
  'use strict';

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64REV = (function () { var m = {}; for (var i = 0; i < 64; i++) m[B64.charAt(i)] = i; return m; })();

  function u8(x) {
    if (x instanceof Uint8Array) return x;
    if (typeof x === 'string') return utf8(x);
    var out = new Uint8Array(x.length); for (var i = 0; i < x.length; i++) out[i] = x[i]; return out;
  }

  function utf8(s) {
    var e = unescape(encodeURIComponent(s)), out = new Uint8Array(e.length);
    for (var i = 0; i < e.length; i++) out[i] = e.charCodeAt(i);
    return out;
  }
  function utf8decode(b) {
    var s = '', CH = 8192;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + CH));
    return decodeURIComponent(escape(s));
  }

  function b64encode(b) {
    b = u8(b);
    var parts = [], i, n = b.length;
    for (i = 0; i + 2 < n; i += 3) {
      var v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      parts.push(B64.charAt(v >> 18) + B64.charAt((v >> 12) & 63) + B64.charAt((v >> 6) & 63) + B64.charAt(v & 63));
    }
    if (n - i === 1) { var a = b[i] << 16; parts.push(B64.charAt(a >> 18) + B64.charAt((a >> 12) & 63) + '=='); }
    else if (n - i === 2) { var c = (b[i] << 16) | (b[i + 1] << 8); parts.push(B64.charAt(c >> 18) + B64.charAt((c >> 12) & 63) + B64.charAt((c >> 6) & 63) + '='); }
    return parts.join('');
  }
  function b64decode(s) {
    var clean = String(s).replace(/[^A-Za-z0-9+\/]/g, ''), n = clean.length, out = new Uint8Array(Math.floor(n * 3 / 4)), o = 0, i;
    for (i = 0; i + 3 < n; i += 4) {
      var v = (B64REV[clean.charAt(i)] << 18) | (B64REV[clean.charAt(i + 1)] << 12) | (B64REV[clean.charAt(i + 2)] << 6) | B64REV[clean.charAt(i + 3)];
      out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
    }
    var rem = n - i;
    if (rem === 2) { var a = (B64REV[clean.charAt(i)] << 18) | (B64REV[clean.charAt(i + 1)] << 12); out[o++] = a >> 16; }
    else if (rem === 3) { var b = (B64REV[clean.charAt(i)] << 18) | (B64REV[clean.charAt(i + 1)] << 12) | (B64REV[clean.charAt(i + 2)] << 6); out[o++] = b >> 16; out[o++] = (b >> 8) & 255; }
    return out.subarray(0, o);
  }

  function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function unhex(h) { var out = new Uint8Array(h.length / 2); for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }

  function concat() {
    var n = 0, i, a;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { a = arguments[i]; out.set(a, o); o += a.length; }
    return out;
  }
  function equal(a, b) { if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

  function sha256Bytes(data) { return u8(sha256.array(u8(data))); }
  function hmac(key, msg) { return u8(sha256.hmac.array(u8(key), u8(msg))); }

  function randomBytes(n) { return nacl.randomBytes(n); }

  // ---- sealing: secretbox with a random 24-byte nonce (cloud sync seals every file this way) ----
  var Session = {
    sealBytes: function (key, plain, nonce) {
      nonce = nonce || randomBytes(24);
      return { n: nonce, c: nacl.secretbox(plain, nonce, key) };
    }
  };

  // Incremental SHA-256 for large files.
  function hasher() { var h = sha256.create(); return { update: function (b) { h.update(u8(b)); }, finish: function () { return u8(h.array()); } }; }

  return { u8: u8, utf8: utf8, utf8decode: utf8decode, b64encode: b64encode, b64decode: b64decode, hex: hex, unhex: unhex, concat: concat, equal: equal,
           sha256: sha256Bytes, hasher: hasher, hmac: hmac, randomBytes: randomBytes,
           Session: Session, secretbox: nacl.secretbox, nacl: nacl };
}));
