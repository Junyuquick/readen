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
  function lp(b) { var l = new Uint8Array(4); l[0] = b.length >>> 24; l[1] = (b.length >>> 16) & 255; l[2] = (b.length >>> 8) & 255; l[3] = b.length & 255; return concat(l, b); }
  function equal(a, b) { if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

  function sha256Bytes(data) { return u8(sha256.array(u8(data))); }
  function hmac(key, msg) { return u8(sha256.hmac.array(u8(key), u8(msg))); }

  // RFC 5869
  function hkdf(ikm, salt, info, length) {
    var prk = hmac(salt && salt.length ? salt : new Uint8Array(32), ikm), t = new Uint8Array(0), okm = new Uint8Array(0), i = 1;
    info = u8(info);
    while (okm.length < length) {
      t = hmac(prk, concat(t, info, new Uint8Array([i++])));
      okm = concat(okm, t);
    }
    return okm.subarray(0, length);
  }

  function randomBytes(n) { return nacl.randomBytes(n); }
  function keyPair() { var k = nacl.box.keyPair(); return { publicKey: k.publicKey, secretKey: k.secretKey }; }
  function x25519(sk, pk) { return nacl.scalarMult(sk, pk); }

  // ---- pairing (commit-reveal ECDH + 6-digit short authentication string) ----
  var LABEL = utf8('readen-web-pair-v1');
  var Pairing = {
    commitment: function (pub, nonce) { return sha256Bytes(concat(LABEL, lp(pub), lp(nonce))); },
    derive: function (shared, idC, idS, pubC, pubS, nonceC, nonceS) {
      var th = sha256Bytes(concat(LABEL, lp(utf8(idC)), lp(utf8(idS)), lp(pubC), lp(pubS), lp(nonceC), lp(nonceS)));
      var okm = hkdf(shared, th, utf8('pair/keys'), 68);
      var n = ((okm[0] * 16777216) + (okm[1] << 16) + (okm[2] << 8) + okm[3]) % 1000000;
      var code = String(n); while (code.length < 6) code = '0' + code;
      var macKey = okm.subarray(36, 68);
      return {
        code: code, secret: okm.subarray(4, 36), transcriptHash: th,
        mac: function (role) { return hmac(macKey, concat(utf8(role), th)); }
      };
    }
  };

  // ---- authenticated session (static keys derived from the pairing secret; random 24-byte nonces) ----
  var Session = {
    keys: function (secret) {
      return { c2s: hkdf(secret, new Uint8Array(0), utf8('readen-web/v1/c2s'), 32), s2c: hkdf(secret, new Uint8Array(0), utf8('readen-web/v1/s2c'), 32) };
    },
    sealBytes: function (key, plain, nonce) {
      nonce = nonce || randomBytes(24);
      return { n: nonce, c: nacl.secretbox(plain, nonce, key) };
    },
    seal: function (key, obj) { var s = Session.sealBytes(key, utf8(JSON.stringify(obj))); return { n: b64encode(s.n), c: b64encode(s.c) }; },
    open: function (key, nB64, cB64) {
      var n = b64decode(nB64), c = b64decode(cB64);
      if (n.length !== 24) return null;
      var p = nacl.secretbox.open(c, n, key);
      return p ? JSON.parse(utf8decode(p)) : null;
    }
  };

  // Incremental SHA-256 for large files.
  function hasher() { var h = sha256.create(); return { update: function (b) { h.update(u8(b)); }, finish: function () { return u8(h.array()); } }; }

  return { u8: u8, utf8: utf8, utf8decode: utf8decode, b64encode: b64encode, b64decode: b64decode, hex: hex, unhex: unhex, concat: concat, equal: equal,
           sha256: sha256Bytes, hasher: hasher, hmac: hmac, hkdf: hkdf, randomBytes: randomBytes, keyPair: keyPair, x25519: x25519,
           Pairing: Pairing, Session: Session, secretbox: nacl.secretbox, nacl: nacl };
}));
