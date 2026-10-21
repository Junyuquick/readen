/* "Ask AI": explains a selected passage with the user's own OpenAI key. The key lives only in this browser's localStorage under its own
 * name (never in the synced state, never in a URL, never logged); the passage and book title go to api.openai.com and nowhere else. ES5. */
(function (root) {
  'use strict';
  var STORE = 'readen.openai.v1', ENDPOINT = 'https://api.openai.com/v1/chat/completions', DEFAULT_MODEL = 'gpt-4o-mini', MAX_PASSAGE = 6000, MAX_NOTE = 600;

  /** {key, model, sync, updatedAtMs}. `sync` = this device shares the key through cloud sync; updatedAtMs orders changes between devices
   * (a removal keeps the record with an empty key so it can be passed on as a tombstone). */
  function load() {
    var o = null; try { o = JSON.parse(localStorage.getItem(STORE)); } catch (e) { o = null; }
    o = o || {};
    return { key: typeof o.key === 'string' ? o.key : '', model: (typeof o.model === 'string' && o.model) ? o.model : DEFAULT_MODEL, sync: o.sync === true, updatedAtMs: o.updatedAtMs > 0 ? o.updatedAtMs : 0 };
  }
  function write(o) { try { localStorage.setItem(STORE, JSON.stringify(o)); return true; } catch (e) { return false; } }
  /** Header-safe: printable ASCII only, no spaces (blocks header injection and pasted-with-newline mistakes). */
  function cleanKey(k) { k = String(k || '').replace(/^\s+|\s+$/g, ''); return /^[\x21-\x7e]{20,300}$/.test(k) ? k : ''; }
  function cleanModel(m) { m = String(m || '').replace(/^\s+|\s+$/g, ''); return /^[A-Za-z0-9._:-]{1,60}$/.test(m) ? m : DEFAULT_MODEL; }
  function save(key, model) {
    var k = cleanKey(key); if (!k) return false;
    return write({ key: k, model: cleanModel(model), sync: load().sync, updatedAtMs: Date.now() });
  }
  function setModel(model) { var o = load(); if (!o.key) return; o.model = cleanModel(model); o.updatedAtMs = Date.now(); write(o); }
  /** Removing the key: forgotten at once; when sharing is on the empty record goes out as a tombstone so the other devices forget it too. */
  function clear() {
    var o = load();
    if (o.sync) write({ key: '', model: o.model, sync: true, updatedAtMs: Date.now() });
    else { try { localStorage.removeItem(STORE); } catch (e) { } }
  }
  /** Turning sharing on makes this device's key the newest one (you just chose to share it); with no key it will pick up the shared one. */
  function setSync(on) {
    var o = load(); o.sync = !!on;
    if (on && o.key) o.updatedAtMs = Date.now();
    if (!on && !o.key) { try { localStorage.removeItem(STORE); } catch (e) { } return; }
    write(o);
  }
  /** What to do with the shared copy: 'adopt' it, 'push' ours, or 'none'. Last change wins. */
  function decide(local, remote) {
    if (!local.sync) return 'none';
    if (!remote || !(remote.updatedAtMs > 0)) return local.key ? 'push' : 'none';
    if (remote.updatedAtMs > local.updatedAtMs) return (remote.removed || cleanKey(remote.key)) ? 'adopt' : 'none';
    if (remote.updatedAtMs < local.updatedAtMs) return 'push';
    return 'none';
  }
  function toWire(local, deviceId) { return { v: 1, key: local.key || null, removed: !local.key, model: local.model, updatedAtMs: local.updatedAtMs, savedBy: deviceId || '' }; }
  function applyRemote(w) {
    var o = load(); if (!o.sync || !w) return false;
    if (w.removed || !w.key) { o.key = ''; } else { var k = cleanKey(w.key); if (!k) return false; o.key = k; o.model = cleanModel(w.model); }
    o.updatedAtMs = w.updatedAtMs; return write(o);
  }
  function mask(k) { return k ? 'sk-…' + k.slice(-4) : ''; }

  // ---------- reading the selection ----------
  function touches(range, node) {
    if (range.intersectsNode) { try { return range.intersectsNode(node); } catch (e) { } }
    var x = document.createRange(); x.selectNode(node);
    return range.compareBoundaryPoints(Range.END_TO_START, x) < 0 && range.compareBoundaryPoints(Range.START_TO_END, x) > 0;
  }
  function px(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  /** Only real PDF words: walks the invisible text divs (in reading order) that the selection touches and keeps just the selected part of each,
   * so a selection that spilled over the picture, the bar or the whole page can never add anything but page text. Lines are re-joined
   * (hyphenated line ends mended, paragraph gaps kept), and the selection may run across a page break. */
  function selectedText(sel, container, info) {
    if (!sel || !sel.rangeCount) return '';
    var range = sel.getRangeAt(0), divs = container.querySelectorAll('.textLayer > div'), out = '', prevTop = null, prevSize = 0, prevPage = null, i, d, node, txt, a, b, top, size, page;
    for (i = 0; i < divs.length; i++) {
      d = divs[i]; if (/(^| )endOfContent( |$)/.test(d.className || '')) continue;
      if (!touches(range, d)) continue;
      txt = d.textContent || ''; a = 0; b = txt.length; node = d.firstChild;
      if (node && node.nodeType === 3) { if (range.startContainer === node) a = range.startOffset; if (range.endContainer === node) b = range.endOffset; }
      txt = txt.slice(a, b); if (!txt.replace(/\s+/g, '')) continue;
      top = px(d.style && d.style.top); size = px(d.style && d.style.fontSize) || 12; page = d.parentNode;
      if (out) {
        var newPara = prevPage === page && top !== null && prevTop !== null && Math.abs(top - prevTop) > Math.max(prevSize, size) * 1.9;
        if (prevPage !== page && /[.!?\u201d"]\s*$/.test(out)) out += '\n\n';
        else if (newPara) out += '\n\n';
        else if (/\w-$/.test(out) && /^[a-z]/.test(txt)) out = out.slice(0, -1);
        else if (!/\s$/.test(out) && !/^\s/.test(txt)) out += ' ';
      }
      out += txt; prevTop = top; prevSize = size; prevPage = page; if (info) info.last = d;
    }
    return out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/^\s+|\s+$/g, '');
  }

  /** The line of text after `from` (a text div, e.g. the last one of the selection) in reading order, joined from the divs that share its top.
   * {text, last} or null when no further text is drawn (the next page's text layer may not exist yet: "Add the next page" covers that). */
  function nextLine(container, from) {
    if (!from || !container.contains(from)) return null;
    var divs = container.querySelectorAll('.textLayer > div'), i = 0, d, lineTop = null, text = '', last = null;
    function lineOf(el) { return { top: px(el.style && el.style.top), size: px(el.style && el.style.fontSize) || 12, page: el.parentNode }; }
    function same(a, b) { return a.page === b.page && a.top !== null && b.top !== null && Math.abs(a.top - b.top) < Math.max(a.size, b.size) * 0.6; }
    var cur = lineOf(from);
    while (i < divs.length && divs[i] !== from) i++;
    for (i++; i < divs.length; i++) {                      // skip the rest of the line `from` sits on
      d = divs[i]; if (/(^| )endOfContent( |$)/.test(d.className || '')) continue;
      if (!same(cur, lineOf(d))) break;
    }
    for (; i < divs.length; i++) {
      d = divs[i]; if (/(^| )endOfContent( |$)/.test(d.className || '')) continue;
      if (!(d.textContent || '').replace(/\s+/g, '')) continue;
      var ln = lineOf(d);
      if (last && !same(lineTop, ln)) break;
      if (!last) lineTop = ln;
      text += (text && !/\s$/.test(text) && !/^\s/.test(d.textContent) ? ' ' : '') + d.textContent; last = d;
    }
    text = text.replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, '');
    return text ? { text: text, last: last } : null;
  }

  // ---------- saved explanations (this device; shared through cloud sync, readen/v1/explain.bin) ----------
  var EXPLAIN = 'readen.explain.v1', MAX_SAVED_PASSAGE = 2000;
  function loadExplain() {
    var a = null; try { a = JSON.parse(localStorage.getItem(EXPLAIN)); } catch (e) { a = null; }
    return (a instanceof Array) ? a.filter(function (r) { return r && typeof r.id === 'string' && r.updatedAtMs > 0; }) : [];
  }
  function writeExplain(list) { try { localStorage.setItem(EXPLAIN, JSON.stringify(list)); return true; } catch (e) { return false; } }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  /** Saves a finished explanation and returns the record. A removal leaves a bare tombstone so the other devices drop it too. */
  function addExplain(r) {
    var now = Date.now(), rec = { id: newId(), hash: String(r.hash || ''), book: clip(r.book, 200), page: r.page >= 0 ? r.page : 0, passage: clip(r.passage, MAX_SAVED_PASSAGE), text: String(r.text || ''), model: r.model || '', createdAtMs: now, updatedAtMs: now };
    var list = loadExplain(); list.push(rec); writeExplain(list); return rec;
  }
  function removeExplain(id) {
    var list = loadExplain(), i; for (i = 0; i < list.length; i++) if (list[i].id === id) { list[i] = { id: id, deleted: true, updatedAtMs: Date.now() }; return writeExplain(list); }
    return false;
  }
  function liveExplain(hash) {
    return loadExplain().filter(function (r) { return !r.deleted && (!hash || r.hash === hash); }).sort(function (a, b) { return b.createdAtMs - a.createdAtMs; });
  }
  /** Union by id, the newer updatedAtMs wins. pull = something here must be replaced/added; push = the cloud copy is behind. */
  function mergeExplain(local, remote) {
    var map = {}, out = [], pull = false, push = false, k, i, l, r;
    for (i = 0; i < local.length; i++) map[local[i].id] = { l: local[i] };
    for (i = 0; i < (remote || []).length; i++) { r = remote[i]; if (r && typeof r.id === 'string' && r.updatedAtMs > 0) (map[r.id] = map[r.id] || {}).r = r; }
    for (k in map) {
      l = map[k].l; r = map[k].r;
      if (l && (!r || l.updatedAtMs > r.updatedAtMs)) { out.push(l); push = true; }
      else if (r && (!l || r.updatedAtMs > l.updatedAtMs)) { out.push(r); pull = true; }
      else out.push(l);
    }
    return { list: out, pull: pull, push: push };
  }
  function applyExplain(list) { return writeExplain(list); }

  function clip(s, n) { s = String(s || '').replace(/^\s+|\s+$/g, ''); return s.length > n ? s.slice(0, n) : s; }
  function buildMessages(passage, title, note) {
    var ctx = [];
    if (clip(title, 200)) ctx.push('Book: ' + clip(title, 200));
    if (clip(note, MAX_NOTE)) ctx.push('Reader\'s note: ' + clip(note, MAX_NOTE));
    return [
      { role: 'system', content: 'You help someone read difficult texts such as poems, old prose and dense arguments. Explain the passage in plain, warm language: what it says literally, what it means or implies, and any hard words, allusions or devices. Be concise (under 250 words) and use short paragraphs. Do not invent facts about the book; if the context is not enough, say so.' },
      { role: 'user', content: (ctx.length ? ctx.join('\n') + '\n\n' : '') + 'Passage:\n"""\n' + clip(passage, MAX_PASSAGE) + '\n"""' }
    ];
  }
  function buildBody(passage, title, note, model) { return JSON.stringify({ model: cleanModel(model), messages: buildMessages(passage, title, note), temperature: 0.4 }); }

  /** {ok:true,text} or {ok:false,message}. Never includes the key or the request. */
  function parseReply(status, text) {
    var j = null; try { j = JSON.parse(text); } catch (e) { j = null; }
    if (status >= 200 && status < 300 && j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string') return { ok: true, text: j.choices[0].message.content };
    if (status === 401) return { ok: false, message: 'OpenAI did not accept this key. Check it and try again.' };
    if (status === 429) return { ok: false, message: 'OpenAI says the key is out of quota or rate-limited. Try again later.' };
    if (status === 404 || (j && j.error && j.error.code === 'model_not_found')) return { ok: false, message: 'That model is not available to this key. Pick another model name.' };
    if (status === 0) return { ok: false, message: 'Could not reach OpenAI. Check the connection (very old iPads may not be able to).' };
    return { ok: false, message: 'OpenAI returned an error (' + status + ').' };
  }

  /** Returns {abort()}. Calls cb(result) once. */
  function explain(settings, args, cb) {
    var x = new XMLHttpRequest(), done = false;
    function fin(r) { if (done) return; done = true; cb(r); }
    x.open('POST', ENDPOINT, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.setRequestHeader('Authorization', 'Bearer ' + settings.key);
    x.timeout = 60000;
    x.onload = function () { fin(parseReply(x.status, x.responseText)); };
    x.onerror = function () { fin(parseReply(0, '')); };
    x.ontimeout = function () { fin({ ok: false, message: 'OpenAI took too long to answer. Try a shorter passage.' }); };
    x.send(buildBody(args.passage, args.title, args.note, settings.model));
    return { abort: function () { done = true; try { x.abort(); } catch (e) { } } };
  }

  root.RAsk = { selectedText: selectedText, nextLine: nextLine, loadExplain: loadExplain, addExplain: addExplain, removeExplain: removeExplain, liveExplain: liveExplain, mergeExplain: mergeExplain, applyExplain: applyExplain, setModel: setModel, setSync: setSync, decide: decide, toWire: toWire, applyRemote: applyRemote, STORE: STORE, ENDPOINT: ENDPOINT, DEFAULT_MODEL: DEFAULT_MODEL, load: load, save: save, clear: clear, mask: mask, cleanKey: cleanKey, cleanModel: cleanModel, buildMessages: buildMessages, buildBody: buildBody, parseReply: parseReply, explain: explain, MAX_PASSAGE: MAX_PASSAGE };
}(this));
