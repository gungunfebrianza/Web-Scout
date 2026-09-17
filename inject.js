// Web-scout in-page agent. Loaded unconditionally from index.html (a single
// small <script> tag) but DORMANT by default - every line below the
// activation check is skipped entirely unless the page was loaded with the
// activation flag. This file, once active, has full DOM/IndexedDB/network
// access - the opposite trust model from tools/ui-verifier (Verity UI
// Relay), which deliberately refuses exactly this. See
// tools/web-scout/README.md for the full security model and non-goals
// before enabling this anywhere but a local dev session.
//
// Activation: `?webscout=1` in the URL, or `localStorage.webscout_enabled
// === '1'` (so it survives a reload without re-adding the query param).
// Relay address defaults to ws://127.0.0.1:8973/agent; override the port
// with `?webscout_port=NNNN`. Multiple tabs can connect at once under
// distinct names via `?webscout_name=NAME` - omitting it (the default,
// unchanged single-tab behavior) connects as 'default'.

(function initWebScout() {
  const params = new URLSearchParams(location.search);
  const active = params.get('webscout') === '1' || localStorage.getItem('webscout_enabled') === '1';
  if (!active) return;

  const port = params.get('webscout_port') || 8973;
  const agentName = params.get('webscout_name');
  const RELAY_URL = agentName ? `ws://127.0.0.1:${port}/agent?name=${encodeURIComponent(agentName)}` : `ws://127.0.0.1:${port}/agent`;
  const DB_NAME = 'AgentCapitalOS';

  console.warn('[web-scout] ACTIVE - full DOM/IndexedDB/network access is exposed to a local relay. Never leave this on for a real session.');

  // ---------- Fire-and-forget event push (console/net capture push to the
  // relay for durable, realtime dashboard display) - batched at BOTH ends
  // deliberately: node:sqlite's DatabaseSync is synchronous, so one INSERT
  // per captured entry would block the relay's whole event loop (including
  // concurrent /command handling) during a bursty page. Flushes every
  // 250ms while entries are pending, or immediately at EVENT_BATCH_CAP,
  // whichever first. Pending entries survive a WS reconnect (capped, same
  // bounding convention as the ring buffers below) rather than being
  // dropped - `ws` is referenced by reference here and is only assigned
  // once the "Relay connection" section below runs, which happens
  // synchronously before this timer's first tick. ----------

  let ws = null; // assigned in "Relay connection" below; referenced here by closure
  const EVENT_BATCH_CAP = 25;
  const MAX_PENDING_EVENTS = 1000;
  const pendingConsole = [];
  const pendingNet = [];

  function queueEvent(queue, entry) {
    queue.push(entry);
    if (queue.length > MAX_PENDING_EVENTS) queue.shift();
  }

  function flushQueue(type, queue) {
    if (!queue.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    const entries = queue.splice(0, queue.length);
    ws.send(JSON.stringify({ kind: 'event', type, entries }));
  }

  setInterval(() => {
    flushQueue('console', pendingConsole);
    flushQueue('net', pendingNet);
  }, 250);

  // ---------- Network capture (installed immediately on activation; only
  // covers requests made from this point forward - anything before
  // activation, including the page's own initial load, is not captured) ----------

  const netLog = [];
  const MAX_NET_LOG = 500;
  function recordNet(entry) {
    netLog.push(entry);
    if (netLog.length > MAX_NET_LOG) netLog.shift();
    queueEvent(pendingNet, entry);
    if (pendingNet.length >= EVENT_BATCH_CAP) flushQueue('net', pendingNet);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function webScoutFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const startedAt = new Date().toISOString();
    try {
      const res = await realFetch(input, init);
      recordNet({ via: 'fetch', method, url, status: res.status, startedAt, endedAt: new Date().toISOString() });
      return res;
    } catch (err) {
      recordNet({ via: 'fetch', method, url, error: String(err), startedAt, endedAt: new Date().toISOString() });
      throw err;
    }
  };

  const RealXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function webScoutXHR() {
    const xhr = new RealXHR();
    let method = 'GET';
    let url = null;
    let startedAt = null;
    const realOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u, ...rest) {
      method = (m || 'GET').toUpperCase();
      url = u;
      return realOpen(m, u, ...rest);
    };
    const realSend = xhr.send.bind(xhr);
    xhr.send = function (...args) {
      startedAt = new Date().toISOString();
      xhr.addEventListener('loadend', () => {
        recordNet({ via: 'xhr', method, url, status: xhr.status, startedAt, endedAt: new Date().toISOString() });
      });
      return realSend(...args);
    };
    return xhr;
  };

  // ---------- Console/error capture. Wraps console.error/warn preserving
  // call-through (devtools output unchanged) and listens for uncaught
  // errors/rejections WITHOUT preventDefault()/returning true - this tool
  // must only ever observe the page, never change its actual behavior,
  // including suppressing the browser's own default error logging. ----------

  const consoleLog = [];
  const MAX_CONSOLE_LOG = 500;
  function stringifyArg(a) {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  function recordConsole(entry) {
    consoleLog.push(entry);
    if (consoleLog.length > MAX_CONSOLE_LOG) consoleLog.shift();
    queueEvent(pendingConsole, entry);
    if (pendingConsole.length >= EVENT_BATCH_CAP) flushQueue('console', pendingConsole);
  }

  const realConsoleError = console.error.bind(console);
  console.error = function webScoutConsoleError(...args) {
    recordConsole({ level: 'error', message: args.map(stringifyArg).join(' '), stack: null, at: new Date().toISOString() });
    return realConsoleError(...args);
  };
  const realConsoleWarn = console.warn.bind(console);
  console.warn = function webScoutConsoleWarn(...args) {
    recordConsole({ level: 'warn', message: args.map(stringifyArg).join(' '), stack: null, at: new Date().toISOString() });
    return realConsoleWarn(...args);
  };
  window.addEventListener('error', (event) => {
    recordConsole({ level: 'uncaught', message: event.message || String(event.error), stack: event.error?.stack ?? null, at: new Date().toISOString() });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    recordConsole({ level: 'unhandledrejection', message: reason?.message ?? String(reason), stack: reason?.stack ?? null, at: new Date().toISOString() });
  });

  // ---------- IndexedDB access (read-only dump/snapshot; diffing happens
  // relay-side over persisted snapshots, see tools/web-scout/relay.mjs) ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Reads every row AND the store's real keyPath (not every store in this
  // app uses keyPath: 'id' - js/db.js has real exceptions like
  // capital_entries: 'date', settings: 'key', research_attachment_blobs:
  // 'sha256', network_health_snapshots: compound ['contact_id','date'] - a
  // diff engine that assumed 'id' would silently produce wrong/empty diffs
  // on those stores, so the real keyPath travels with the dump).
  function readStore(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keyPath = store.keyPath;
      const req = store.getAll();
      req.onsuccess = () => resolve({ keyPath, rows: req.result });
      req.onerror = () => reject(req.error);
    });
  }

  // Parallelized (each store's read is an independent IndexedDB request) -
  // was sequential, meaningfully slower on a real app with 150+ stores.
  // `storeFilter` (array of names) scopes the dump to just those stores -
  // a full 138-store snapshot timed out in practice against the real app;
  // callers who only care about a handful of stores should pass this.
  async function dumpAllStores(storeFilter) {
    const db = await openDb();
    let names = [...db.objectStoreNames];
    if (Array.isArray(storeFilter) && storeFilter.length) {
      const wanted = new Set(storeFilter);
      names = names.filter((n) => wanted.has(n));
    }
    const entries = await Promise.all(names.map(async (name) => [name, await readStore(db, name)]));
    db.close();
    return Object.fromEntries(entries);
  }

  // Resolves a selector to exactly one element. `document.querySelector`'s
  // silent first-match semantics let a mutating command (click/fill) hit
  // the wrong element with no warning whenever a selector isn't scoped
  // tightly enough - confirmed to happen in practice (a review button
  // selector that omitted a data-layer attribute silently clicked a
  // same-shaped button in an unrelated section). Ambiguous matches now
  // fail loudly with a preview of every match instead of silently picking
  // the first one; pass `nth` (0-based) once you've seen the preview.
  function resolveTarget(selector, nth) {
    const all = document.querySelectorAll(selector);
    if (all.length === 0) throw new Error(`no element matches selector: ${selector}`);
    if (nth !== undefined && nth !== null) {
      const idx = Number(nth);
      if (!Number.isInteger(idx) || idx < 0 || idx >= all.length) {
        throw new Error(`nth=${nth} out of range - selector matched ${all.length} element(s)`);
      }
      return all[idx];
    }
    if (all.length > 1) {
      const preview = [...all].slice(0, 5).map((el, i) => {
        const cls = el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : '';
        return `[${i}] <${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}> ${(el.textContent ?? '').trim().slice(0, 60)}`;
      });
      throw new Error(`selector matched ${all.length} elements, ambiguous: ${JSON.stringify(preview)} - pass nth to pick one`);
    }
    return all[0];
  }

  // ---------- Selector picker helpers (used by dom.pick) ----------

  function cssEscape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`); }
  function cssAttrEscape(s) { return String(s).replace(/["\\]/g, (c) => `\\${c}`); }

  function candidateSelectors(el) {
    const cands = [];
    if (el.id) cands.push(`#${cssEscape(el.id)}`);
    const dataAttrs = [...el.attributes].filter((a) => a.name.startsWith('data-'));
    if (dataAttrs.length) {
      const attrSel = dataAttrs.map((a) => `[${a.name}="${cssAttrEscape(a.value)}"]`).join('');
      cands.push(`${el.tagName.toLowerCase()}${attrSel}`);
    }
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).map(cssEscape).join('.');
      cands.push(`${el.tagName.toLowerCase()}.${cls}`);
    }
    return cands;
  }

  // Tries id, then data-* attrs, then class - in that order - returning the
  // first candidate that resolves to exactly this one element. Falls back
  // to a full nth-child ancestor path (always unique) if none of those do.
  function buildUniqueSelector(el) {
    for (const sel of candidateSelectors(el)) {
      try {
        const matches = document.querySelectorAll(sel);
        if (matches.length === 1 && matches[0] === el) return sel;
      } catch { /* invalid selector fragment (unlikely, but non-fatal) */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      const idx = [...parent.children].indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
      node = parent;
    }
    return `body > ${parts.join(' > ')}`;
  }

  // ---------- Screenshot helpers (used by dom.screenshot) ----------
  //
  // Zero-dependency, best-effort DOM rasterization via the SVG
  // foreignObject technique (no html2canvas/puppeteer - this is a normal
  // page-side script, not a browser-automation process, so there is no
  // CDP screenshot API available either way). Known limitation, stated
  // plainly rather than silently: cross-origin images/fonts can taint or
  // fail to render the canvas, and iframes are not captured. Computed
  // styles are inlined onto a clone (walking source/clone trees in
  // lockstep) because a foreignObject's content does NOT automatically
  // inherit the host document's stylesheets once serialized standalone.
  function inlineComputedStyles(sourceRoot, cloneRoot) {
    const srcAll = [sourceRoot, ...sourceRoot.querySelectorAll('*')];
    const cloneAll = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
    for (let i = 0; i < srcAll.length; i += 1) {
      const cs = getComputedStyle(srcAll[i]);
      cloneAll[i].setAttribute('style', cs.cssText);
    }
  }

  async function captureScreenshot(selector) {
    const el = selector ? document.querySelector(selector) : document.documentElement;
    if (!el) throw new Error(`no element matches selector: ${selector}`);
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(rect.width) || el.scrollWidth || window.innerWidth);
    const height = Math.max(1, Math.ceil(rect.height) || el.scrollHeight || window.innerHeight);
    const clone = el.cloneNode(true);
    inlineComputedStyles(el, clone);
    const xml = new XMLSerializer().serializeToString(clone);
    const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="all:initial">${xml}</div></foreignObject></svg>`;
    const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('screenshot rasterization failed - likely cross-origin content or CSS this simplified renderer cannot handle'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL('image/png'), width, height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Best-effort top-level-return check for eval's statement-body fallback
  // (see the 'eval' handler below) - a plain /\breturn\b/ text search
  // matches ANY 'return' anywhere in expr, including one nested inside an
  // inner function/arrow definition (e.g. a hand-wrapped IIFE), which never
  // reaches the outer statement body and still yields undefined - so the
  // __note below previously failed to fire for exactly the case it exists
  // to explain (confirmed live: a script wrapped as `(async () => { ...
  // return x; })();` has a textual 'return' but it's unreachable from the
  // outer body). Tracks brace depth (and skips string/template-literal
  // contents) and only counts a 'return' seen at depth 0 - not a real
  // parser (unbalanced braces inside a string/comment can still fool it),
  // but a real improvement over a bare substring search.
  function hasTopLevelReturn(src) {
    let depth = 0;
    let inString = null; // one of ' " ` or null
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (inString) {
        if (c === '\\') { i += 1; continue; }
        if (c === inString) inString = null;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') { inString = c; continue; }
      if (c === '{') { depth += 1; continue; }
      if (c === '}') { depth -= 1; continue; }
      if (depth === 0 && c === 'r' && src.slice(i, i + 6) === 'return'
        && !/[A-Za-z0-9_$]/.test(src[i - 1] || '') && !/[A-Za-z0-9_$]/.test(src[i + 6] || '')) {
        return true;
      }
    }
    return false;
  }

  // ---------- Command handlers ----------

  const handlers = {
    // Trivial reply used ONLY for a fast liveness probe (see the relay's
    // POST /ping and the CLI's `ping` command) - distinct from every other
    // handler here because it does no DOM/IndexedDB work at all, so a short
    // timeout on this one round trip (PING_TIMEOUT_MS in relay.mjs) is a
    // real signal, not just a smaller guess: if even THIS doesn't reply,
    // the page's JS thread itself is blocked, not merely a slow real
    // operation elsewhere. Still routes through the SAME message queue as
    // every other command, so it CANNOT distinguish "blocked" from "slow"
    // if the thread is genuinely stuck in a synchronous loop - only a
    // faster, cheaper way to ask the same question several other commands
    // already answer, confirmed real friction during a session where every
    // diagnostic paid its own full ~15-20s timeout in serial.
    ping: () => ({ pong: Date.now() }),
    'dom.query': ({ selector }) => {
      const el = document.querySelector(selector);
      if (!el) return { found: false };
      return {
        found: true,
        tag: el.tagName,
        id: el.id || null,
        className: el.className || null,
        outerHTML: el.outerHTML.slice(0, 20000),
        text: el.textContent?.slice(0, 5000) ?? null,
      };
    },
    // Uses the element's OWN `.click()` method, not a hand-dispatched
    // MouseEvent - confirmed by repeated real-session failures that a
    // dispatchEvent(new MouseEvent('click')) reliably reports success
    // ({clicked:true}) while never actually running the target's click
    // handling on elements inside a <dialog> (or otherwise gated on the
    // browser's native "activation behavior", which only a real click or
    // `.click()` triggers - a synthetic dispatchEvent does not). `.click()`
    // worked every time on the identical elements in that same session.
    // Falls back to dispatchEvent only for the rare element with no native
    // `.click` (e.g. some SVG elements in older engines).
    // `mutated`/`hrefChanged` give the caller a signal distinguishing "the
    // click was dispatched AND something observably happened" from "the
    // click was dispatched and nothing happened" (confirmed real gotcha: a
    // nav link whose target hash already equals location.hash reports
    // {clicked:true} but the SPA's hashchange-driven router never fires, so
    // the page never re-renders - previously indistinguishable from a
    // genuine successful no-visible-effect click with no signal at all).
    // Short (200ms) grace window, not a full dom.settle wait - this is a
    // cheap same-tick-ish signal, not a "wait until done" primitive; use
    // dom.wait/dom.settle after this for anything that renders async.
    'dom.click': ({ selector, nth }) => new Promise((resolve, reject) => {
      let el;
      try {
        el = resolveTarget(selector, nth);
      } catch (err) {
        reject(err);
        return;
      }
      const hrefBefore = location.href;
      let mutated = false;
      const observer = new MutationObserver(() => { mutated = true; });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      setTimeout(() => {
        observer.disconnect();
        resolve({ clicked: true, mutated, hrefChanged: location.href !== hrefBefore });
      }, 200);
    }),
    // Waits until the DOM has been quiet (no mutations observed) for
    // `quietMs` inside the subtree rooted at `selector` (default:
    // document.body) - a generic "settle" primitive, as opposed to
    // dom.wait's specific-selector-appears semantics. Exists because every
    // click/rebuild previously needed a hand-guessed `sleep N` before the
    // next dom.query/dom.click, and guesses were wrong often enough (some
    // renders took longer than others) that querying too early returned
    // pre-rebuild content indistinguishable from a real bug without an
    // independent idb dump to cross-check. Call this after a click/rebuild
    // and before the next dom.query/dom.click instead of guessing.
    'dom.settle': ({ selector, quietMs, timeoutMs }) => new Promise((resolve, reject) => {
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) { reject(new Error(`no element matches selector: ${selector}`)); return; }
      const quiet = Number(quietMs) || 300;
      const limit = Number(timeoutMs) || 10000;
      const start = Date.now();
      let lastMutationAt = Date.now();
      let mutationCount = 0;
      const observer = new MutationObserver(() => {
        lastMutationAt = Date.now();
        mutationCount += 1;
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      const check = () => {
        const now = Date.now();
        if (now - lastMutationAt >= quiet) {
          observer.disconnect();
          resolve({ settled: true, mutationCount, waitedMs: now - start });
          return;
        }
        if (now - start >= limit) {
          observer.disconnect();
          reject(new Error(`dom.settle timed out after ${limit}ms - DOM under '${selector || 'body'}' never went quiet for ${quiet}ms (last mutation ${now - lastMutationAt}ms ago, ${mutationCount} mutation(s) seen)`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    }),
    'dom.fill': ({ selector, value, nth }) => {
      const el = resolveTarget(selector, nth);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    },
    // Polls until `selector` matches (and, if given, its textContent
    // contains `text`) or `timeoutMs` elapses. Replaces the hand-rolled
    // bash polling loops every prior session reached for when waiting on
    // an async AI-review render or a debounced UI update.
    // `changed` mode: instead of requiring the caller to predict the
    // eventual substring, snapshot the selector's current textContent at
    // call time and resolve as soon as it differs. Exists for the
    // "placeholder swapped for a real result" pattern this app repeats
    // identically across every cognitive-layer AI-review button ("Asking
    // AI to review..." -> the real result) - the placeholder div already
    // exists, so a bare selector-exists wait resolves instantly on it and
    // tells the caller nothing; without `changed`, the caller has no choice
    // but to guess the eventual result text ahead of time just to wait
    // correctly.
    'dom.wait': ({ selector, text, timeoutMs, changed }) => new Promise((resolve, reject) => {
      const limit = Number(timeoutMs) || 10000;
      const start = Date.now();
      const baseline = changed ? (document.querySelector(selector)?.textContent ?? null) : null;
      const check = () => {
        const el = document.querySelector(selector);
        if (changed) {
          const current = el ? (el.textContent ?? '') : null;
          if (current !== baseline) {
            resolve({ found: true, changed: true, waitedMs: Date.now() - start, outerHTML: el ? el.outerHTML.slice(0, 2000) : null });
            return;
          }
        } else if (el && (text === undefined || text === null || (el.textContent ?? '').includes(text))) {
          resolve({ found: true, waitedMs: Date.now() - start, outerHTML: el.outerHTML.slice(0, 2000) });
          return;
        }
        if (Date.now() - start >= limit) {
          reject(new Error(`dom.wait timed out after ${limit}ms waiting for '${selector}'${changed ? ' to change from its baseline content' : text ? ` containing "${text}"` : ''}`));
          return;
        }
        setTimeout(check, 150);
      };
      check();
    }),
    // Arms a one-time capture-phase click listener and resolves with a
    // robust selector for whatever the operator clicks next in the real
    // browser - preventDefault+stopImmediatePropagation so the click never
    // reaches the app (picking must never trigger real app behavior).
    // Directly attacks the root cause behind the dom.click/dom.fill
    // ambiguity guard above: get a correct, scoped selector BEFORE ever
    // dispatching a mutating command, instead of discovering the ambiguity
    // only after a click already fired.
    'dom.pick': ({ timeoutMs }) => new Promise((resolve, reject) => {
      const limit = Number(timeoutMs) || 15000;
      const onClick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        cleanup();
        const target = ev.target;
        const selector = buildUniqueSelector(target);
        let matched = null;
        try { matched = document.querySelectorAll(selector).length; } catch { /* ignore */ }
        resolve({
          picked: true, selector, matched,
          tag: target.tagName, id: target.id || null, className: target.className || null,
          text: (target.textContent ?? '').trim().slice(0, 80),
        });
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`dom.pick timed out after ${limit}ms - no element clicked`)); }, limit);
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener('click', onClick, true);
      }
      document.addEventListener('click', onClick, true);
    }),
    // See "Screenshot helpers" above for the technique + its limitations.
    'dom.screenshot': ({ selector }) => captureScreenshot(selector),
    // `counts` uses IDBObjectStore.count() (cheap - the browser's own
    // index metadata, no row payload transferred) per store, not
    // store.getAll().length - gives a caller a real row-count estimate
    // BEFORE requesting a snapshot, instead of discovering a store is huge
    // only after idb.snapshot times out (SNAPSHOT_TIMEOUT_MS, 60s) against
    // it. `stores` (array of names) kept exactly as before for existing
    // callers; `counts` is additive.
    'idb.list': async () => {
      const db = await openDb();
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      const counts = Object.fromEntries(await Promise.all(names.map((name) => new Promise((resolve, reject) => {
        const req = tx.objectStore(name).count();
        req.onsuccess = () => resolve([name, req.result]);
        req.onerror = () => reject(req.error);
      }))));
      db.close();
      return { stores: names, counts };
    },
    'idb.dump': async ({ store }) => {
      const db = await openDb();
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        throw new Error(`no such store: ${store}`);
      }
      const { keyPath, rows } = await readStore(db, store);
      db.close();
      return { store, keyPath, count: rows.length, rows };
    },
    // Single-key lookup - idb.dump only ever does a whole-store scan (via
    // store.getAll()), so finding one row by an already-known key in a
    // large store (confirmed real: cfi_cognitive_runs) previously meant
    // either a slow full dump or a hand-rolled `eval` reaching for
    // db.getRecord directly. Uses store.get(key), the real indexed lookup,
    // not a filter over getAll().
    'idb.get': ({ store, key }) => new Promise((resolve, reject) => {
      openDb().then((db) => {
        if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`no such store: ${store}`)); return; }
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => { db.close(); resolve({ store, key, found: req.result !== undefined, row: req.result ?? null }); };
        req.onerror = () => { db.close(); reject(req.error); };
      }, reject);
    }),
    // Full per-store dump (each with its real keyPath), no local id/Map
    // bookkeeping - the relay owns persistence now (POST /state/snapshot),
    // so this survives a tab reload/close instead of living only in page
    // memory. Never dispatch this raw via /command - relay.mjs rejects it
    // (400) so there's exactly one sanctioned, persisted path to this data.
    // `stores` (array of names) scopes the dump - see dumpAllStores above.
    'idb.snapshot': async ({ stores } = {}) => ({ stores: await dumpAllStores(stores) }),
    // Scoped write path (previously only `eval` could mutate IndexedDB).
    // Still gated by the same session requirement as every other command -
    // no special-case gate beyond that.
    // Returns the full stored row, not just the key - a caller previously
    // had to assume an id (e.g. "delete this fixture, recreate it, it'll be
    // id 1 again") which silently breaks the moment IndexedDB autoIncrement
    // has already moved past that value (deleting a row does NOT reset the
    // counter - confirmed live: a re-seeded "same" fixture came back as id
    // 2, not 1, after an earlier cleanup pass). `row` merged with the real
    // generated key under the store's own keyPath removes the need to
    // guess or re-dump the store just to learn what was actually written.
    'idb.put': ({ store, row }) => new Promise((resolve, reject) => {
      openDb().then((db) => {
        if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`no such store: ${store}`)); return; }
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        const keyPath = os.keyPath;
        const req = os.put(row);
        req.onsuccess = () => {
          db.close();
          const key = req.result;
          let storedRow = row;
          if (typeof keyPath === 'string' && row && typeof row === 'object' && !(keyPath in row)) {
            storedRow = { ...row, [keyPath]: key };
          }
          resolve({ stored: true, key, row: storedRow });
        };
        req.onerror = () => { db.close(); reject(req.error); };
      }, reject);
    }),
    'idb.delete': ({ store, key }) => new Promise((resolve, reject) => {
      openDb().then((db) => {
        if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`no such store: ${store}`)); return; }
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).delete(key);
        req.onsuccess = () => { db.close(); resolve({ deleted: true }); };
        req.onerror = () => { db.close(); reject(req.error); };
      }, reject);
    }),
    // Bulk delete, one transaction - replaces a shell loop of individual
    // idb.delete calls (confirmed tedious cleaning up 12 rows by hand in a
    // real session).
    'idb.deleteMany': ({ store, keys }) => new Promise((resolve, reject) => {
      openDb().then((db) => {
        if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`no such store: ${store}`)); return; }
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        // deletedKeys/failedKeys (not just counts) so a caller can confirm
        // exactly which rows went away without a follow-up idb.dump/
        // snapshot just to double-check the delete actually happened.
        const deletedKeys = [];
        const failedKeys = [];
        tx.oncomplete = () => { db.close(); resolve({ deleted: deletedKeys.length, failed: failedKeys.length, deletedKeys, failedKeys }); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        for (const key of keys || []) {
          const req = os.delete(key);
          req.onsuccess = () => { deletedKeys.push(key); };
          req.onerror = () => { failedKeys.push(key); };
        }
      }, reject);
    }),
    'idb.clear': ({ store }) => new Promise((resolve, reject) => {
      openDb().then((db) => {
        if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`no such store: ${store}`)); return; }
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).clear();
        req.onsuccess = () => { db.close(); resolve({ cleared: true }); };
        req.onerror = () => { db.close(); reject(req.error); };
      }, reject);
    }),
    // Polls a store's row count - pairs with idb.wait to avoid hand-rolled
    // bash polling loops after a write that finishes asynchronously
    // (e.g. an AI-review round writing to cfi_cognitive_runs).
    'idb.wait': ({ store, countGte, timeoutMs }) => new Promise((resolve, reject) => {
      const limit = Number(timeoutMs) || 10000;
      const threshold = Number(countGte);
      const start = Date.now();
      const check = async () => {
        const db = await openDb();
        if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`no such store: ${store}`)); return; }
        const { rows } = await readStore(db, store);
        db.close();
        if (rows.length >= threshold) {
          resolve({ found: true, count: rows.length, waitedMs: Date.now() - start });
          return;
        }
        if (Date.now() - start >= limit) {
          reject(new Error(`idb.wait timed out after ${limit}ms waiting for '${store}' count >= ${threshold} (last seen: ${rows.length})`));
          return;
        }
        setTimeout(check, 200);
      };
      check();
    }),
    'dom.rect': ({ selector }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element matches selector: ${selector}`);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    },
    // Curated default subset (kebab-case CSS property names, matching
    // getComputedStyle().getPropertyValue's own convention) unless the
    // caller asks for specific properties - returning all 300+ computed
    // properties by default would be noise, not evidence.
    'dom.computedStyle': ({ selector, properties }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element matches selector: ${selector}`);
      const cs = getComputedStyle(el);
      const props = properties && properties.length ? properties
        : ['display', 'position', 'width', 'height', 'color', 'background-color', 'font-size', 'margin', 'padding', 'border', 'z-index', 'visibility', 'opacity'];
      const out = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    },
    // Reports the LIVE IndexedDB connection's own .version - pairs with the
    // CLI's `session start` DB_VERSION drift check (reads js/db.js's
    // DB_VERSION constant off disk and compares). Catches "the migration
    // was bumped in source but this tab never re-opened the DB" before a
    // whole CRV pass gets run against a stale schema - the schema-level
    // sibling of the page.fresh byte-hash check (which does the same thing
    // for a source FILE instead of the DB connection version).
    'db.version': () => new Promise((resolve, reject) => {
      openDb().then((db) => {
        const version = db.version;
        db.close();
        resolve({ name: DB_NAME, version });
      }, reject);
    }),
    // Answers "is an IndexedDB version-upgrade to targetVersion blocked
    // RIGHT NOW, and by what" - db.version alone only reports the CURRENT
    // live version, it can't tell a caller why a later "page reload" hangs.
    // Confirmed live: an upgrade hangs indefinitely (`blocked` fires, then
    // nothing) if ANY other tab on this origin - web-scout-connected or
    // not - still holds a connection at an older version; previously the
    // only way to see this was hand-rolling this exact indexedDB.open +
    // onblocked probe via `eval`. This IS that probe, made reusable.
    // Deliberately never commits a real upgrade: onupgradeneeded aborts its
    // own versionchange transaction immediately, so this call cannot change
    // the schema itself even when nothing is blocking it - it's read-only
    // diagnostics, not a migration trigger. Resolves fast (own short
    // internal wait, not the open() request's own eventual settlement,
    // which could otherwise hang exactly as long as the real blockage
    // would) - `blocked:true` without waiting for the blocking tab to close.
    'db.probeUpgrade': ({ targetVersion }) => new Promise((resolve, reject) => {
      if (targetVersion === undefined || targetVersion === null) { reject(new Error('db.probeUpgrade requires targetVersion')); return; }
      const start = Date.now();
      let settled = false;
      let blocked = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ blocked, waitedMs: Date.now() - start, ...result });
      };
      let req;
      try {
        req = indexedDB.open(DB_NAME, Number(targetVersion));
      } catch (err) {
        reject(err);
        return;
      }
      req.onblocked = () => { blocked = true; };
      req.onupgradeneeded = () => {
        // Never actually run the app's own migration logic here - abort the
        // versionchange transaction immediately, this call is a probe only.
        try { req.transaction.abort(); } catch { /* already aborting */ }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.close();
        finish({ opened: true, note: blocked ? 'was blocked but opened during the probe window (the blocking tab closed just in time)' : 'opened immediately - no other connection is holding an older version' });
      };
      req.onerror = () => {
        // Expected path when onupgradeneeded aborts the transaction (an
        // AbortError, not a real failure) - the probe still answers the
        // question either way.
        finish({ opened: false, note: blocked ? 'blocked by another connection (see blocked:true) - the probe request is still pending in the background and will resolve on its own once that connection closes, but this reply does not wait for it' : 'probe transaction aborted as designed - not blocked' });
      };
      // Own short deadline, independent of the open() request's own
      // eventual settlement - a real blockage can last as long as the
      // blocking tab stays open, and this call must not hang that long
      // just to answer "is it blocked right now".
      setTimeout(() => {
        if (blocked) finish({ opened: false, note: 'still blocked after the probe window - another connection (likely another open tab) is holding an older version; close it, then "page reload"' });
      }, 1500);
    }),
    // Attach-and-wait for a specific in-flight/about-to-fire request,
    // matched by substring against its URL. Exists because a long request
    // (a few seconds to a few minutes) previously had no way to be awaited
    // directly - only blind sleep+`net.log`-poll loops, which also risked
    // the entry scrolling out of MAX_NET_LOG under unrelated background
    // traffic before it was ever checked. `graceMs` (default 3000) also
    // matches an entry that already finished just BEFORE this call arrived
    // (the normal race: click fires the request, then this call follows a
    // beat later over the relay round trip) - not just entries recorded
    // strictly after this point.
    'net.wait': ({ urlPattern, timeoutMs, graceMs }) => new Promise((resolve, reject) => {
      if (!urlPattern) { reject(new Error('net.wait requires urlPattern (a substring to match against request URLs)')); return; }
      const limit = Number(timeoutMs) || 15000;
      const grace = Number(graceMs) || 3000;
      const start = Date.now();
      const cutoff = start - grace;
      const findMatch = () => netLog.find((e) => e.url && e.url.includes(urlPattern) && Date.parse(e.endedAt) >= cutoff);
      const already = findMatch();
      if (already) { resolve({ found: true, entry: already, waitedMs: 0 }); return; }
      const check = () => {
        const hit = findMatch();
        if (hit) { resolve({ found: true, entry: hit, waitedMs: Date.now() - start }); return; }
        if (Date.now() - start >= limit) {
          reject(new Error(`net.wait timed out after ${limit}ms waiting for a request whose URL contains "${urlPattern}"`));
          return;
        }
        setTimeout(check, 200);
      };
      check();
    }),
    'net.log': () => ({ count: netLog.length, entries: netLog.slice() }),
    'net.clear': () => {
      const cleared = netLog.length;
      netLog.length = 0;
      return { cleared };
    },
    'console.log': () => ({ count: consoleLog.length, entries: consoleLog.slice() }),
    'console.clear': () => {
      const cleared = consoleLog.length;
      consoleLog.length = 0;
      return { cleared };
    },
    // True reload primitive - replaces re-invoking a page module's own
    // init function via `eval` as a re-render workaround. Confirmed in a
    // real session that repeated init-function re-calls stack duplicate
    // document-level event listeners (no removal/dedup guard), causing a
    // single real click to fire a handler 3-4x and write duplicate rows.
    // location.reload() re-runs the page fresh instead, so the activation
    // flag (?webscout=1 / localStorage.webscout_enabled) re-activates this
    // script and it reconnects to the relay on its own (see "Relay
    // connection" below) - no special-case needed here beyond that.
    // The reply is resolved (and so sent) before reload() fires, on the
    // next macrotask, so the caller gets a reply instead of a dropped
    // connection.
    'page.reload': () => new Promise((resolve) => {
      resolve({ reloading: true });
      setTimeout(() => location.reload(), 120);
    }),
    // Hard-reload primitive: unregisters every Service Worker and clears
    // every Cache Storage entry BEFORE reloading. `page.reload` alone
    // (plain location.reload()) is not enough on a page whose SW answers
    // fetches from its own Cache Storage (e.g. stale-while-revalidate) -
    // confirmed live: a real code fix stayed invisible across multiple
    // plain reloads until this exact unregister+clear sequence was run by
    // hand. This is that sequence, as one command. Best-effort: a page with
    // no SW/Cache Storage support (or none registered) just reloads.
    'page.hardReload': () => new Promise((resolve) => {
      resolve({ reloading: true, hard: true });
      setTimeout(async () => {
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
          }
          if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch (err) {
          console.warn('[web-scout] page.hardReload cleanup failed, reloading anyway:', err);
        } finally {
          location.reload();
        }
      }, 120);
    }),
    // Fetches `path` through the PAGE's own origin/cache/SW stack (unlike a
    // plain disk read, this goes through whatever a real browser request
    // would) and hashes the bytes - pairs with the CLI's `page fresh`
    // (which hashes the same path on disk) to answer "is the code this tab
    // is actually running the code on disk" in one round trip, instead of
    // the prior back-and-forth of fetching a URL by hand and grepping the
    // response text for a marker string.
    'page.fileHash': ({ path }) => new Promise((resolve, reject) => {
      fetch(path, { cache: 'no-store' }).then(async (res) => {
        const buf = await res.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        resolve({ path, status: res.status, byteLength: buf.byteLength, sha256 });
      }, reject);
    }),
    // Escape hatch, deliberately separate/labeled - see README non-goals.
    // Runs in an async function body so `await` works inside expr.
    //
    // Races against its own page-side timeout (default 10000ms, `timeoutMs`
    // overrides) so an UNRESOLVED PROMISE (an `await` that never settles)
    // produces a clear diagnostic reply instead of silently masquerading as
    // the relay's own generic "command timed out" with nothing pointing
    // back at eval as the cause. This does NOT and CANNOT interrupt a
    // genuine SYNCHRONOUS infinite loop (e.g. `while(true){}`) - JS is
    // single-threaded, so a tight sync loop blocks this very setTimeout
    // callback from ever running, freezing the whole tab until it finishes
    // on its own or the page is reloaded. Stated plainly rather than
    // silently: this closes the async-hang case, not the sync-loop case,
    // which has no fix available to a normal page-side script.
    eval: async ({ expr, timeoutMs }) => {
      const limit = Number(timeoutMs) || 10000;
      // Tries `expr` as a single EXPRESSION first (the common case: `1+1`,
      // `document.title`, `await fetch(...).then(r=>r.json())`). Multiple
      // ;-separated statements are not a valid expression - `(a; b)` is a
      // SyntaxError - so previously every such call failed with a bare
      // "Unexpected token ';'" and no hint, forcing a caller to hand-wrap
      // in an IIFE. Falls back to treating `expr` as a function BODY
      // instead (statements, with an explicit `return` if a value is
      // wanted) - the IIFE-wrapping the caller used to have to do by hand.
      // Only a SyntaxError triggers the fallback; a runtime error from a
      // valid expression must still surface as-is, not be masked by a
      // confusing second attempt.
      let fn;
      let exprSyntaxError = null;
      let usedStatementFallback = false;
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function(`return (async () => { return (${expr}); })();`);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        exprSyntaxError = err;
      }
      if (!fn) {
        usedStatementFallback = true;
        try {
          // eslint-disable-next-line no-new-func
          fn = new Function(`return (async () => { ${expr} })();`);
        } catch (stmtErr) {
          throw new Error(`expr is valid neither as a single expression (${exprSyntaxError.message}) nor as a statement body (${stmtErr.message}). If you meant multiple statements, this fallback already handles that - the statement-body attempt's own error above is the one to fix.`);
        }
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `eval did not resolve within ${limit}ms. If this expression contains an unresolved 'await' (e.g. a Promise that never settles), that is the likely cause. If instead it contains a SYNCHRONOUS infinite loop, this message will never actually arrive - the tab is frozen, not just slow; reload the page. If this call is EXPECTED to take longer (e.g. a real AI-provider round trip), pass --timeout <ms> on the CLI (or timeoutMs in the MCP tool params) - the default is only ${limit}ms and is NOT related to any server-side/provider timeout.`,
        )), limit);
      });
      let result;
      try {
        result = await Promise.race([fn(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      // The statement-body fallback runs `expr` as a function BODY, not an
      // expression - so a body with no explicit `return` legitimately
      // evaluates to `undefined`, syntactically valid, no error thrown.
      // Confirmed to cost real debugging time in practice: `var x=...;
      // x.length` silently came back `undefined` (read as "x.length is
      // undefined", i.e. a bug in the page) when the real cause was just a
      // missing `return`. Flag that specific, easy-to-misread case
      // explicitly instead of returning a bare, ambiguous `undefined`.
      if (usedStatementFallback && result === undefined && !hasTopLevelReturn(expr)) {
        return {
          result: undefined,
          __note: "expr had no explicit 'return' and was run as a statement body (see eval's fallback), so this undefined may just mean nothing was returned - not that the expression itself is undefined. Add 'return' before the value you want back.",
        };
      }
      try {
        JSON.stringify(result);
        return result;
      } catch {
        // Non-JSON-safe value (DOM element, Map/Set, circular reference,
        // BigInt, ...) - silently returning String(result) alone would
        // read as real evidence ("it's just a generic object") when the
        // actual value was discarded. Marking the substitution explicitly
        // instead so the caller knows this is NOT the real serialized
        // value.
        return {
          __unserializable: true,
          typeofResult: typeof result,
          constructorName: result?.constructor?.name ?? null,
          stringified: String(result),
        };
      }
    },
  };

  // ---------- Relay connection ----------
  // (`ws` itself is declared earlier, alongside the event-batch flushing
  // that references it by closure)

  let reconnectDelayMs = 500;
  const MAX_RECONNECT_DELAY_MS = 8000;

  function connect() {
    ws = new WebSocket(RELAY_URL);
    ws.addEventListener('open', () => {
      console.info('[web-scout] connected to relay at', RELAY_URL);
      reconnectDelayMs = 500;
    });
    ws.addEventListener('message', async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.kind !== 'command') return;
      const handler = handlers[msg.type];
      if (!handler) {
        ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: false, error: `unknown command: ${msg.type}` }));
        return;
      }
      try {
        const result = await handler(msg.params || {});
        ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: false, error: err?.message || String(err) }));
      }
    });
    ws.addEventListener('close', scheduleReconnect);
    ws.addEventListener('error', () => ws.close());
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  connect();
}());
