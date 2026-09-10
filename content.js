function onMut(mutations) {
  if (!active) return;
  for (const m of mutations) {
    if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) {
      if (mute) continue;
      handleTextChange(m.target);
    } else if (m.type === "childList") {
      m.addedNodes.forEach((n) => collect(n));
    } else if (m.type === "attributes" && m.target instanceof Element) {
      if (mute) continue;
      queueAttrs(m.target);
    }
  }
  schedule(mute ? 40 : 8);
}

function observeRoot(root) {
  if (!root || observed.has(root)) return;
  if (!observer) observer = new MutationObserver(onMut);
  try {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    observed.add(root);
  } catch { /* detached */ }
}

function observe() {
  if (!observer) observer = new MutationObserver(onMut);
  observeRoot(document.documentElement);
  if (document.body) observeRoot(document.body);
}

function restore() {
  active = false;
  mute++;
  try {
    const roots = [document.documentElement];
    const walk = (root) => {
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n) {
        const rec = textMap.get(n);
        if (rec) n.nodeValue = rec.original;
        n = walker.nextNode();
      }
      root.querySelectorAll?.("*").forEach((el) => {
        const recs = attrMap.get(el);
        if (recs) {
          for (const name of ATTRS) {
            if (recs[name]) el.setAttribute(name, recs[name].original);
          }
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    roots.forEach(walk);
  } finally { mute--; }
  queue.clear();
  attrQueue.clear();
  paintChip();
}

function fullScan() {
  if (!active) return;
  lastFullScan = Date.now();
  collect(document.documentElement);
  if (document.body) collect(document.body);
  schedule(0);
}

function poke() {
  if (!active) return;
  const now = Date.now();
  if (now - lastFullScan > 180) fullScan();
  else schedule(0);
}

function start() {
  active = true;
  ensureHud();
  observe();
  fullScan();
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    if (active) fullScan();
  }, 900);
  paintChip();
}

function toggle() {
  if (active) {
    restore();
    if (scanTimer) clearInterval(scanTimer);
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
  if (window !== window.top) return;
  if (document.getElementById(HOST_ID)) {
    chip = document.getElementById(HOST_ID);
    return;
  }
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-yasno-ui", "1");
  host.setAttribute("translate", "no");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<style>:host{all:initial}.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483646;font-family:Georgia,"Iowan Old Style",serif;color:#f4f0e8}.chip{display:flex;align-items:center;gap:10px;background:#1c1916;color:#f4f0e8;border-radius:999px;padding:8px 8px 8px 14px;box-shadow:0 10px 30px rgba(28,25,22,.28);font-size:12px}.name{font-weight:600}.meta{opacity:.7;font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums}button{font-family:system-ui,sans-serif;font-size:11px;font-weight:600;border:0;border-radius:999px;height:28px;padding:0 10px;background:#f4f0e8;color:#1c1916;cursor:pointer}.tip{display:none;position:fixed;z-index:2147483647;max-width:280px;background:#1c1916;color:#f4f0e8;font-family:system-ui,sans-serif;font-size:12px;line-height:1.4;padding:8px 10px;border-radius:8px;pointer-events:none}.tip.on{display:block}</style><div class="wrap"><div class="chip"><span class="name">Ясно</span><span class="meta" id="meta">…</span><button type="button" id="act">Пауза</button></div></div><div class="tip" id="tip"></div>';
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
  if (!chip || !chip.shadowRoot) return;
  const meta = chip.shadowRoot.getElementById("meta");
  const act = chip.shadowRoot.getElementById("act");
  if (!meta || !act) return;
  if (!active) {
    meta.textContent = "пауза";
    act.textContent = "Включить";
    chip.style.display = settings.enabled ? "block" : "none";
    return;
  }
  chip.style.display = "block";
  meta.textContent = pending ? ("перевод \u00b7 " + translated) : ("готово \u00b7 " + translated);
  act.textContent = "Пауза";
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

var detectTries = 0;
function maybeStart() {
  if (active) return;
  if (!settings.enabled || isPausedHost()) {
    ensureHud();
    paintChip();
    return;
  }
  if (!settings.autoTranslateEnglish) return;
  if (detectEnglish(pageSample())) {
    start();
    return;
  }
  if (detectTries++ < 16) setTimeout(maybeStart, 400);
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "YASNO_TOGGLE") {
    toggle();
    sendResponse({ active, translated });
    return true;
  }
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
  if (msg?.type === "YASNO_RESTORE") {
    restore();
    sendResponse({ active: false });
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  if (changes.pausedHosts && isPausedHost() && active) restore();
  if (changes.showOriginalOnHover && !settings.showOriginalOnHover && tooltipEl) {
    tooltipEl.classList.remove("on");
  }
});

document.addEventListener("mousemove", onHover, { passive: true });
document.addEventListener("scroll", poke, { passive: true, capture: true });
document.addEventListener("click", () => {
  poke();
  setTimeout(poke, 80);
  setTimeout(poke, 320);
}, true);
document.addEventListener("keydown", poke, { passive: true, capture: true });
window.addEventListener("hashchange", poke);
window.addEventListener("popstate", poke);

send({ type: "YASNO_GET" }).then((s) => {
  if (s) settings = { ...settings, ...s };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeStart, { once: true });
  } else {
    maybeStart();
  }
});
