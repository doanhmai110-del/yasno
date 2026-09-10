window.__yasnoLoaded = true;

var SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
  "CODE", "PRE", "KBD", "SAMP", "MATH", "CANVAS", "IFRAME",
  "VIDEO", "AUDIO", "SOURCE", "IMG", "PICTURE", "HEAD", "META", "LINK",
  "BR", "HR", "OPTION", "NOSCRIPT",
]);
var ATTRS = ["placeholder", "alt", "title", "aria-label", "aria-placeholder"];
var HOST_ID = "yasno-host";
var ICON_CLASS = /\b(fa|fas|far|fal|fab|fa-solid|fa-regular|material-icons|material-symbols|glyphicon|iconfont|icon)\b/i;
var ICON_FONT = /font\s*awesome|material\s*icons|glyphicon|icomoon|fontello|bootstrap-icons|octicon|feather/i;

var cache = new Map();
var textMap = new WeakMap();
var attrMap = new WeakMap();
var observed = new WeakSet();
var queue = new Set();
var attrQueue = new Set();

var settings = {
  enabled: true,
  autoTranslateEnglish: true,
  showOriginalOnHover: true,
  sourceLang: "en",
  targetLang: "ru",
  pausedHosts: [],
};
var observer = null;
var mute = 0;
var timer = null;
var running = false;
var active = false;
var translated = 0;
var pending = 0;
var nativeTranslator = null;
var nativeTried = false;
var tooltipEl = null;
var chip = null;
var scanTimer = 0;
var lastFullScan = 0;

function hostName() {
  try { return location.hostname; } catch { return ""; }
}
function isPausedHost() {
  return (settings.pausedHosts || []).includes(hostName());
}

function shouldTranslate(text) {
  const t = text.trim();
  if (t.length < 2) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  const letters = t.match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const cyr = t.match(/\p{Script=Cyrillic}/gu) || [];
  if (cyr.length / letters.length > 0.5) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(t)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return false;
  return true;
}

function splitEdges(s) {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return { lead: m ? m[1] : "", core: m ? m[2] : s, trail: m ? m[3] : "" };
}

function isIconEl(el) {
  if (!el || el.nodeType !== 1) return false;
  const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
  if (ICON_CLASS.test(cls)) return true;
  const ff = el.getAttribute("style") || "";
  if (ICON_FONT.test(ff)) return true;
  return false;
}

function skipEl(el) {
  if (!el || el.nodeType !== 1) return true;
  if (el.id === HOST_ID || el.closest?.("#" + HOST_ID)) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.closest("[translate='no'], [contenteditable='true'], [contenteditable='']")) return true;
  if (el.getAttribute("translate") === "no") return true;
  if (isIconEl(el)) return true;
  return false;
}

function inView(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !el.getBoundingClientRect) return true;
  const r = el.getBoundingClientRect();
  const pad = 600;
  return r.bottom >= -pad && r.top <= innerHeight + pad && r.right >= -40 && r.left <= innerWidth + 40;
}

function detectEnglish(sample) {
  const t = sample.slice(0, 1600);
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length < 24) return false;
  const latin = t.match(/[A-Za-z]/g) || [];
  const cyr = t.match(/\p{Script=Cyrillic}/gu) || [];
  return latin.length / letters.length > 0.5 && cyr.length / letters.length < 0.25;
}

function pageSample() {
  const t = document.body ? document.body.innerText || "" : "";
  return t.replace(/\s+/g, " ").trim();
}

async function ensureNative() {
  if (nativeTried) return nativeTranslator;
  nativeTried = true;
  if (!("Translator" in self)) return null;
  try {
    const availability = await self.Translator.availability({
      sourceLanguage: settings.sourceLang,
      targetLanguage: settings.targetLang,
    });
    if (availability === "unavailable") return null;
    nativeTranslator = await self.Translator.create({
      sourceLanguage: settings.sourceLang,
      targetLanguage: settings.targetLang,
    });
    return nativeTranslator;
  } catch {
    nativeTranslator = null;
    return null;
  }
}

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch { resolve(null); }
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length) || 0;
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function translateTexts(texts) {
  const unique = [];
  const seen = new Set();
  for (const t of texts) {
    if (cache.has(t) || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  if (!unique.length) return texts.map((t) => cache.get(t) || t);
  const native = await ensureNative();
  if (native) {
    await pool(unique, 8, async (t) => {
      if (cache.has(t)) return;
      try {
        const tr = await native.translate(t);
        if (tr) cache.set(t, tr);
      } catch { /* background */ }
    });
  }
  const still = unique.filter((t) => !cache.has(t));
  for (let i = 0; i < still.length; i += 12) {
    const batch = still.slice(i, i + 12);
    const res = await send({
      type: "YASNO_TRANSLATE",
      texts: batch,
      source: settings.sourceLang,
      target: settings.targetLang,
    });
    if (res?.ok && Array.isArray(res.translations)) {
      batch.forEach((src, j) => {
        const tr = res.translations[j];
        if (typeof tr === "string" && tr) cache.set(src, tr);
      });
    }
  }
  return texts.map((t) => cache.get(t) || t);
}

function applyText(node, original, translatedCore) {
  const { lead, trail } = splitEdges(original);
  const next = lead + translatedCore + trail;
  textMap.set(node, { original, translated: next });
  if (node.nodeValue !== next) node.nodeValue = next;
  translated += 1;
}

function applyAttr(el, name, original, translatedCore) {
  const { lead, trail } = splitEdges(original);
  const next = lead + translatedCore + trail;
  const bag = attrMap.get(el) || {};
  bag[name] = { original, translated: next };
  attrMap.set(el, bag);
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
  translated += 1;
}

function queueText(node) {
  if (!node || !node.nodeValue || !shouldTranslate(node.nodeValue)) return;
  const parent = node.parentElement;
  if (parent && skipEl(parent)) return;
  const core = splitEdges(node.nodeValue).core;
  if (cache.has(core)) {
    mute++;
    try { applyText(node, node.nodeValue, cache.get(core)); }
    finally { mute--; }
    return;
  }
  queue.add(node);
}

function queueAttrs(el) {
  if (skipEl(el)) return;
  for (const name of ATTRS) {
    const val = el.getAttribute(name);
    if (val && shouldTranslate(val)) {
      const core = splitEdges(val).core;
      if (cache.has(core)) {
        mute++;
        try { applyAttr(el, name, val, cache.get(core)); }
        finally { mute--; }
      } else {
        attrQueue.add(el);
      }
    }
  }
}

function walkShadow(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) {
      collect(el.shadowRoot);
      observeRoot(el.shadowRoot);
    }
  });
}

function collect(node) {
  if (!node) return;
  if (node.nodeType === Node.TEXT_NODE) {
    queueText(node);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
  if (node.nodeType === Node.ELEMENT_NODE && skipEl(node)) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (skipEl(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let cur = walker.nextNode();
  while (cur) {
    queueText(cur);
    cur = walker.nextNode();
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    queueAttrs(node);
    node.querySelectorAll?.("*").forEach((el) => queueAttrs(el));
  } else if (node.querySelectorAll) {
    node.querySelectorAll("*").forEach((el) => queueAttrs(el));
  }
  walkShadow(node);
}

function handleTextChange(node) {
  const rec = textMap.get(node);
  const current = node.nodeValue || "";
  if (!rec) {
    if (shouldTranslate(current)) queue.add(node);
    return;
  }
  if (current === rec.translated) return;
  if (current === rec.original && rec.translated) {
    mute++;
    try { node.nodeValue = rec.translated; }
    finally { mute--; }
    return;
  }
  rec.original = current;
  const core = splitEdges(current).core;
  if (cache.has(core)) {
    mute++;
    try { applyText(node, current, cache.get(core)); }
    finally { mute--; }
  } else if (shouldTranslate(current)) {
    queue.add(node);
  }
}

function schedule(ms) {
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

function applyReady(jobs, attrJobs) {
  mute++;
  try {
    for (const job of jobs) {
      if (job.done) continue;
      const tr = cache.get(job.core);
      if (!tr) continue;
      if (job.node.nodeValue && splitEdges(job.node.nodeValue).core === job.core) {
        applyText(job.node, job.node.nodeValue, tr);
      } else {
        applyText(job.node, job.original, tr);
      }
      job.done = true;
    }
    for (const job of attrJobs) {
      if (job.done) continue;
      const tr = cache.get(job.core);
      if (!tr) continue;
      applyAttr(job.el, job.name, job.original, tr);
      job.done = true;
    }
  } finally { mute--; }
}

async function flush() {
  if (!active || running) return;
  if (!queue.size && !attrQueue.size) {
    pending = 0;
    paintChip();
    return;
  }
  running = true;
  paintChip();
  try {
    const textNodes = [...queue];
    queue.clear();
    const els = [...attrQueue];
    attrQueue.clear();
    const jobs = [];
    const attrJobs = [];
    const unique = [];
    const seen = new Set();
    const hot = new Set();
    for (const node of textNodes) {
      if (!node.nodeValue || !shouldTranslate(node.nodeValue)) continue;
      const original = node.nodeValue;
      const core = splitEdges(original).core;
      jobs.push({ node, original, core, done: false });
      if (inView(node)) hot.add(core);
      if (!cache.has(core) && !seen.has(core)) {
        seen.add(core);
        unique.push(core);
      }
    }
    for (const el of els) {
      for (const name of ATTRS) {
        const original = el.getAttribute(name);
        if (!original || !shouldTranslate(original)) continue;
        const core = splitEdges(original).core;
        attrJobs.push({ el, name, original, core, done: false });
        if (inView(el)) hot.add(core);
        if (!cache.has(core) && !seen.has(core)) {
          seen.add(core);
          unique.push(core);
        }
      }
    }
    unique.sort((a, b) => (hot.has(a) === hot.has(b) ? 0 : hot.has(a) ? -1 : 1));
    applyReady(jobs, attrJobs);
    const missing = unique.filter((t) => !cache.has(t));
    pending = missing.length;
    paintChip();
    for (let i = 0; i < missing.length; i += 10) {
      if (!active) break;
      const batch = missing.slice(i, i + 10);
      await translateTexts(batch);
      pending = Math.max(0, missing.length - i - batch.length);
      applyReady(jobs, attrJobs);
      paintChip();
    }
  } finally {
    running = false;
    if (active && (queue.size || attrQueue.size)) schedule(0);
    else {
      pending = 0;
      paintChip();
    }
  }
}
