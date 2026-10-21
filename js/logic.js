/* Readen web client data logic: reading progress, bookmarks (one per page), documents, and sync bookkeeping.
 * Mirrors the Mac's rules (Sources/ReadenCore/Sync/ConflictResolution.swift). ES5; no DOM access, so it runs in node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RLogic = factory();
}(this, function () {
  'use strict';

  /** `state` is one JSON-serialisable object persisted by the app (localStorage); PDF bytes live elsewhere (IndexedDB). */
  function newState() {
    return { deviceId: null, clock: 0, seq: 0, docs: {}, progress: {}, bookmarks: {}, settings: { mode: 'continuous', zoom: 'fitWidth' } };
  }

  /** A device needs its identity from the very first launch: records saved before pairing carry it as their author. */
  function ensureIdentity(state) {
    if (!state.deviceId) state.deviceId = randomHex16();
    var k;
    for (k in state.progress) if (!state.progress[k].originDeviceId) state.progress[k].originDeviceId = state.deviceId;     // repair older records
    for (k in state.bookmarks) if (!state.bookmarks[k].originDeviceId) state.bookmarks[k].originDeviceId = state.deviceId;
    return state;
  }

  function tick(state) { var now = Date.now(); state.clock = Math.max(now, (state.clock || 0) + 1); return state.clock; }
  function observe(state, ms) { if (ms > state.clock && ms < Date.now() + 86400000) state.clock = ms; }
  function nextSeq(state) { state.seq = (state.seq || 0) + 1; return state.seq; }

  function tupleGreater(a, b) {                   // lexicographic compare of arrays
    for (var i = 0; i < a.length; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
    return false;
  }
  /** Newest hybrid-clock timestamp wins; ties by revision, then device id. Strict, so re-applying is a no-op. */
  function progressSupersedes(a, b) { return tupleGreater([a.updatedAtMs, a.revision, a.originDeviceId], [b.updatedAtMs, b.revision, b.originDeviceId]); }
  function bookmarkSupersedes(a, b) { return tupleGreater([a.updatedAtMs, a.originDeviceId], [b.updatedAtMs, b.originDeviceId]); }

  function samePosition(a, b) {
    return a.pageIndex === b.pageIndex && a.anchorX === b.anchorX && a.anchorY === b.anchorY && a.zoomScale === b.zoomScale &&
           a.zoomMode === b.zoomMode && a.readingMode === b.readingMode;
  }

  // ---- progress ----
  function saveProgress(state, hash, pos) {
    var existing = state.progress[hash];
    var rec = { contentHash: hash, pageIndex: pos.pageIndex, anchorX: pos.anchorX === undefined ? null : pos.anchorX, anchorY: pos.anchorY === undefined ? null : pos.anchorY,
                zoomScale: pos.zoomScale || 1, zoomMode: pos.zoomMode || 'fitWidth', readingMode: pos.readingMode || 'continuous' };
    if (existing && samePosition(existing, rec)) return existing;
    rec.updatedAtMs = tick(state); rec.revision = (existing ? existing.revision : 0) + 1; rec.originDeviceId = state.deviceId; rec.seq = nextSeq(state);
    state.progress[hash] = rec;
    return rec;
  }

  // ---- bookmarks (at most one live bookmark per page) ----
  function liveBookmarks(state, hash, page) {
    var out = [], id;
    for (id in state.bookmarks) { var b = state.bookmarks[id]; if (b.contentHash === hash && !b.deleted && (page === undefined || b.pageIndex === page)) out.push(b); }
    out.sort(function (x, y) { return tupleGreater([y.updatedAtMs, y.id], [x.updatedAtMs, x.id]) ? 1 : -1; });   // newest first
    return out;
  }
  function tombstone(state, b) { b.deleted = true; b.updatedAtMs = tick(state); b.originDeviceId = state.deviceId; b.seq = nextSeq(state); }
  function dedupeBookmarks(state, hash, page) { var l = liveBookmarks(state, hash, page); for (var i = 1; i < l.length; i++) tombstone(state, l[i]); }

  /** Adds, or replaces the bookmark already on that page. Returns {bookmark, replaced}. */
  function saveBookmark(state, hash, pageIndex, title) {
    var now = tick(state), existing = liveBookmarks(state, hash, pageIndex), b = existing[0];
    var replaced = !!b;
    if (!b) b = { id: randomHex16(), contentHash: hash, pageIndex: pageIndex };
    b.title = title; b.createdAtMs = now; b.updatedAtMs = now; b.deleted = false; b.originDeviceId = state.deviceId; b.seq = nextSeq(state);
    state.bookmarks[b.id] = b;
    for (var i = 1; i < existing.length; i++) tombstone(state, existing[i]);
    return { bookmark: b, replaced: replaced };
  }
  var _rand = null;
  function randomHex16() {
    var out = '', i, c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (!_rand && typeof require === 'function') { try { _rand = require('crypto'); } catch (e) { _rand = null; } }
    var bytes = new Uint8Array(16);
    if (c) c.getRandomValues(bytes); else if (_rand) bytes = new Uint8Array(_rand.randomBytes(16)); else for (i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (i = 0; i < 16; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }
  function deleteBookmark(state, id) { var b = state.bookmarks[id]; if (b && !b.deleted) tombstone(state, b); }
  function renameBookmark(state, id, title) { var b = state.bookmarks[id]; if (b && !b.deleted) { b.title = title; b.updatedAtMs = tick(state); b.originDeviceId = state.deviceId; b.seq = nextSeq(state); } }

  // ---- merging records from another device (cloud sync) ----
  /** Applies another device's records. Returns the number of records adopted. */
  function applyRemote(state, cs) {
    var adopted = 0, i, p, b, local, touched = {};
    for (i = 0; i < (cs.progress || []).length; i++) {
      p = cs.progress[i];
      if (!p || !/^[0-9a-f]{64}$/.test(p.contentHash) || !(p.pageIndex >= 0) || p.originDeviceId === state.deviceId) continue;
      observe(state, p.updatedAtMs);
      local = state.progress[p.contentHash];
      if (local && !progressSupersedes(p, local)) continue;
      p.seq = 0; state.progress[p.contentHash] = p; adopted++;
    }
    for (i = 0; i < (cs.bookmarks || []).length; i++) {
      b = cs.bookmarks[i];
      if (!b || !/^[0-9a-f]{64}$/.test(b.contentHash) || !(b.pageIndex >= 0) || typeof b.id !== 'string' || b.originDeviceId === state.deviceId && !state.bookmarks[b.id]) continue;
      observe(state, b.updatedAtMs);
      local = state.bookmarks[b.id];
      if (local && !bookmarkSupersedes(b, local)) continue;
      b.seq = 0; state.bookmarks[b.id] = b; adopted++; touched[b.contentHash + '#' + b.pageIndex] = [b.contentHash, b.pageIndex];
    }
    for (var key in touched) dedupeBookmarks(state, touched[key][0], touched[key][1]);
    return adopted;
  }

  function upsertDoc(state, d) { state.docs[d.hash] = d; }
  function sortedDocs(state) {
    var out = [], k; for (k in state.docs) out.push(state.docs[k]);
    out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    return out;
  }

  return { ensureIdentity: ensureIdentity, newState: newState, tick: tick, observe: observe, saveProgress: saveProgress, saveBookmark: saveBookmark, deleteBookmark: deleteBookmark,
           renameBookmark: renameBookmark, liveBookmarks: liveBookmarks, applyRemote: applyRemote,
           progressSupersedes: progressSupersedes, bookmarkSupersedes: bookmarkSupersedes, upsertDoc: upsertDoc, sortedDocs: sortedDocs };
}));
