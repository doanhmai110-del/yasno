(() => {
  if (window.__yasnoLoaded) return;
  window.__yasnoLoaded = true;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT",
    "CODE", "PRE", "KBD", "SAMP", "MATH", "SVG", "CANVAS", "IFRAME",
    "VIDEO", "AUDIO", "SOURCE", "IMG", "PICTURE", "HEAD", "META", "LINK",
    "BR", "HR", "OPTION",
  ]);
  const ATTRS = ["placeholder", "alt", "title", "aria-label"];
  const HOST_ID = "yasno-host";

  const cache = new Map();
  const textMap = new WeakMap();
  const attrMap = new WeakMap();
  const queue = new Set();
  const attrQueue = new Set();

  let settings = {
    enabled: true,
    autoTranslateEnglish: true,
    showOriginalOnHover: true,
    sourceLang: "en",
    targetLang: "ru",
    pausedHosts: [],
  };
  let observer = null;
  let mute = 0;
  let timer = null;
  let running = false;
  let active = false;
  let translated = 0;
  let pending = 0;
  let nativeTranslator = null;
  let nativeTried = false;
  let tooltipEl = null;
  let chip = null;

  function hostName() {
    try { return location.hostname; } catch { return ""; }
  }
  function isPausedHost() {
    return (settings.pausedHosts || []).includes(hostName());
  }
  function shouldTranslate(text) {
    const t = text.trim();
    if (t.length < 1) return false;
    if (!/[A-Za-z]/.test(t)) return false;
    const letters = t.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const cyr = t.match(/\p{Script=Cyrillic}/gu) || [];
    if (cyr.length / letters.length > 0.45) return false;
    if (/^https?:\/\//i.test(t)) return false;
    if (/^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(t)) return false;
    return true;
  }
  function splitEdges(s) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { lead: m ? m[1] : "", core: m ? m[2] : s, trail: m ? m[3] : "" };
  }
  function skipEl(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.id === HOST_ID || el.closest?.("#" + HOST_ID)) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.closest("[translate='no'], [contenteditable='true'], [contenteditable='']")) return true;
    if (el.getAttribute("translate") === "no") return true;
    return false;
  }
  function detectEnglish(sample) {
    const t = sample.slice(0, 1200);
    const letters = t.match(/\p{L}/gu) || [];
    if (letters.length < 40) return false;
    const latin = t.match(/[A-Za-z]/g) || [];
    const cyr = t.match(/\p{Script=Cyrillic}/gu) || [];
    return latin.length / letters.length > 0.55 && cyr.length / letters.length < 0.2;
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
      for (const t of unique) {
        try {
          const tr = await native.translate(t);
          if (tr) cache.set(t, tr);
        } catch { /* fallback */ }
      }
    }
    const still = unique.filter((t) => !cache.has(t));
    if (still.length) {
      const res = await send({
        type: "YASNO_TRANSLATE",
        texts: still,
        source: settings.sourceLang,
        target: settings.targetLang,
      });
      if (res?.ok && Array.isArray(res.translations)) {
        still.forEach((src, i) => {
          const tr = res.translations[i];
          if (typeof tr === "string" && tr) cache.set(src, tr);
        });
      }
    }
    return texts.map((t) => cache.get(t) || t);
  }
  function queueText(node) {
    if (!node || !node.nodeValue || !shouldTranslate(node.nodeValue)) return;
    const parent = node.parentElement;
    if (parent && skipEl(parent)) return;
    const core = splitEdges(node.nodeValue).core;
    if (cache.has(core)) {
      applyText(node, node.nodeValue, cache.get(core));
      return;
    }
    queue.add(node);
  }
  function queueAttrs(el) {
    if (skipEl(el)) return;
    for (const name of ATTRS) {
      const val = el.getAttribute(name);
      if (val && shouldTranslate(val)) {
        attrQueue.add(el);
        return;
      }
    }
  }
  function collect(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      queueText(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE && skipEl(node)) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || skipEl(p)) return NodeFilter.FILTER_REJECT;
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
      node.querySelectorAll("*").forEach((el) => queueAttrs(el));
    }
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
      try { node.nodeValue = rec.translated; } finally { mute--; }
      return;
    }
    rec.original = current;
    const core = splitEdges(current).core;
    if (cache.has(core)) {
      mute++;
      try { applyText(node, current, cache.get(core)); } finally { mute--; }
    } else if (shouldTranslate(current)) {
      queue.add(node);
    }
  }
  function schedule(ms) {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void flush(); }, ms);
  }
  async function flush() {
    if (!active || running) return;
    if (!queue.size && !attrQueue.size) { pending = 0; paintChip(); return; }
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
      for (const node of textNodes) {
        if (!node.nodeValue || !shouldTranslate(node.nodeValue)) continue;
        const original = node.nodeValue;
        const core = splitEdges(original).core;
        jobs.push({ node, original, core });
        if (!cache.has(core) && !seen.has(core)) { seen.add(core); unique.push(core); }
      }
      for (const el of els) {
        for (const name of ATTRS) {
          const original = el.getAttribute(name);
          if (!original || !shouldTranslate(original)) continue;
          const core = splitEdges(original).core;
          attrJobs.push({ el, name, original, core });
          if (!cache.has(core) && !seen.has(core)) { seen.add(core); unique.push(core); }
        }
      }
      pending = unique.length;
      paintChip();
      for (let i = 0; i < unique.length; i += 20) {
        if (!active) break;
        const batch = unique.slice(i, i + 20);
        const got = await translateTexts(batch);
        batch.forEach((src, j) => { if (got[j]) cache.set(src, got[j]); });
        pending = Math.max(0, unique.length - i - batch.length);
        paintChip();
      }
      mute++;
      try {
        for (const job of jobs) {
          const tr = cache.get(job.core);
          if (tr) applyText(job.node, job.original, tr);
        }
        for (const job of attrJobs) {
          const tr = cache.get(job.core);
          if (tr) applyAttr(job.el, job.name, job.original, tr);
        }
      } finally { mute--; }
    } finally {
      running = false;
      if (active && (queue.size || attrQueue.size)) schedule(16);
      else { pending = 0; paintChip(); }
    }
  }
  function observe() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (mute || !active) return;
      for (const m of mutations) {
        if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) handleTextChange(m.target);
        else if (m.type === "childList") m.addedNodes.forEach((n) => collect(n));
        else if (m.type === "attributes" && m.target instanceof Element) queueAttrs(m.target);
      }
      schedule(48);
    });
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }
  function restore() {
    active = false;
    mute++;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n) {
        const rec = textMap.get(n);
        if (rec) n.nodeValue = rec.original;
        n = walker.nextNode();
      }
      document.body.querySelectorAll("*").forEach((el) => {
        const recs = attrMap.get(el);
        if (!recs) return;
        for (const name of ATTRS) {
          if (recs[name]) el.setAttribute(name, recs[name].original);
        }
      });
    } finally { mute--; }
    queue.clear();
    attrQueue.clear();
    paintChip();
  }
  function start() {
    if (!document.body) return;
    active = true;
    ensureHud();
    observe();
    collect(document.body);
    schedule(0);
    paintChip();
  }
  function toggle() {
    if (active) {
      restore();
      const paused = new Set(settings.pausedHosts || []);
      paused.add(hostName());
      settings.pausedHosts = [...paused];
      send({ type: "YASNO_SET", patch: { pausedHosts: settings.pausedHosts } });
    } else {
      const paused = (settings.pausedHosts || []).filter((h) => h !== hostName());
      settings.pausedHosts = paused;
      send({ type: "YASNO_SET", patch: { pausedHosts: paused } });
      start();
    }
  }
  function ensureHud() {
    if (document.getElementById(HOST_ID)) {
      chip = document.getElementById(HOST_ID);
      return;
    }
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-yasno-ui", "1");
    host.setAttribute("translate", "no");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<style>:host{all:initial}.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483646;font-family:Georgia,serif;color:#f4f0e8}.chip{display:flex;align-items:center;gap:10px;background:#1c1916;color:#f4f0e8;border-radius:999px;padding:8px 8px 8px 14px;box-shadow:0 10px 30px rgba(28,25,22,.28);font-size:12px}.name{font-weight:600}.meta{opacity:.7;font-family:system-ui,sans-serif}.chip button{font-family:system-ui,sans-serif;font-size:11px;font-weight:600;border:0;border-radius:999px;height:28px;padding:0 10px;background:#f4f0e8;color:#1c1916;cursor:pointer}.tip{display:none;position:fixed;z-index:2147483647;max-width:280px;background:#1c1916;color:#f4f0e8;font-family:system-ui,sans-serif;font-size:12px;line-height:1.4;padding:8px 10px;border-radius:8px;pointer-events:none}.tip.on{display:block}</style><div class=wrap><div class=chip><span class=name>\u042f\u0441\u043d\u043e</span><span class=meta id=meta>\u2026</span><button type=button id=act>\u041f\u0430\u0443\u0437\u0430</button></div></div><div class=tip id=tip></div>";
    document.documentElement.appendChild(host);
    chip = host;
    shadow.getElementById("act").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    tooltipEl = shadow.getElementById("tip");
  }
  function paintChip() {
    if (!chip) return;
    const meta = chip.shadowRoot.getElementById("meta");
    const act = chip.shadowRoot.getElementById("act");
    if (!active) {
      meta.textContent = "\u043f\u0430\u0443\u0437\u0430";
      act.textContent = "\u0412\u043a\u043b\u044e\u0447\u0438\u0442\u044c";
      chip.style.display = settings.enabled ? "block" : "none";
      return;
    }
    chip.style.display = "block";
    meta.textContent = pending ? ("\u043f\u0435\u0440\u0435\u0432\u043e\u0434 \u00b7 " + translated) : ("\u0433\u043e\u0442\u043e\u0432\u043e \u00b7 " + translated);
    act.textContent = "\u041f\u0430\u0443\u0437\u0430";
  }
  function onHover(e) {
    if (!settings.showOriginalOnHover || !active || !tooltipEl) {
      if (tooltipEl) tooltipEl.classList.remove("on");
      return;
    }
    let node = null;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      node = r?.startContainer;
    } else if (document.caretPositionFromPoint) {
      node = document.caretPositionFromPoint(e.clientX, e.clientY)?.offsetNode;
    }
    if (node && node.nodeType !== Node.TEXT_NODE) node = node.childNodes?.[0];
    const rec = node && node.nodeType === Node.TEXT_NODE ? textMap.get(node) : null;
    if (!rec || rec.original.trim() === (node.nodeValue || "").trim()) {
      tooltipEl.classList.remove("on");
      return;
    }
    tooltipEl.textContent = rec.original.trim();
    tooltipEl.classList.add("on");
    tooltipEl.style.left = Math.min(e.clientX + 12, innerWidth - 300) + "px";
    tooltipEl.style.top = Math.min(e.clientY + 16, innerHeight - 80) + "px";
  }
  let detectTries = 0;
  function maybeStart() {
    if (active) return;
    if (!settings.enabled || isPausedHost()) { ensureHud(); paintChip(); return; }
    if (!settings.autoTranslateEnglish) return;
    if (detectEnglish(pageSample())) { start(); return; }
    if (detectTries++ < 10) setTimeout(maybeStart, 700);
  }
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "YASNO_TOGGLE") { toggle(); sendResponse({ active, translated }); return true; }
    if (msg?.type === "YASNO_STATUS") {
      sendResponse({ active, translated, pending, host: hostName(), paused: isPausedHost() });
      return true;
    }
    if (msg?.type === "YASNO_START") {
      const paused = (settings.pausedHosts || []).filter((h) => h !== hostName());
      settings.pausedHosts = paused;
      send({ type: "YASNO_SET", patch: { pausedHosts: paused } });
      start();
      sendResponse({ active: true });
      return true;
    }
    if (msg?.type === "YASNO_RESTORE") { restore(); sendResponse({ active: false }); return true; }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (changes.pausedHosts && isPausedHost() && active) restore();
    if (changes.showOriginalOnHover && !settings.showOriginalOnHover && tooltipEl) tooltipEl.classList.remove("on");
  });
  document.addEventListener("mousemove", onHover, { passive: true });
  send({ type: "YASNO_GET" }).then((s) => {
    if (s) settings = { ...settings, ...s };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", maybeStart, { once: true });
    else maybeStart();
  });
})();
