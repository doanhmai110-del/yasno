const DEFAULTS = {
  enabled: true,
  autoTranslateEnglish: true,
  showOriginalOnHover: true,
  sourceLang: "en",
  targetLang: "ru",
  pausedHosts: [],
};

const cache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULTS, ...cur });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "yasno-toggle",
      title: "Ясно: перевести / вернуть страницу",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "yasno-toggle" && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "YASNO_TOGGLE" }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "YASNO_TOGGLE" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "YASNO_TRANSLATE") {
    translateBatch(msg.texts || [], msg.source || "en", msg.target || "ru")
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg?.type === "YASNO_GET") {
    chrome.storage.sync.get(DEFAULTS).then(sendResponse);
    return true;
  }
  if (msg?.type === "YASNO_SET") {
    chrome.storage.sync.set(msg.patch || {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

function ck(sl, tl, t) {
  return `${sl}|${tl}|${t}`;
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
  const n = Math.min(limit, Math.max(items.length, 0));
  if (!n) return out;
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function translateBatch(texts, sl, tl) {
  const unique = [];
  const seen = new Set();
  for (const t of texts) {
    if (typeof t !== "string") continue;
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  const map = new Map();
  const missing = [];
  for (const t of unique) {
    const hit = cache.get(ck(sl, tl, t));
    if (hit) map.set(t, hit);
    else missing.push(t);
  }

  const chunks = [];
  for (let i = 0; i < missing.length; i += 8) chunks.push(missing.slice(i, i + 8));

  await pool(chunks, 4, async (chunk) => {
    let got = await googleGtx(chunk, sl, tl);
    if (!got) got = await lingva(chunk, sl, tl);
    if (!got) got = await myMemory(chunk, sl, tl);
    chunk.forEach((src, i) => {
      const tr = got?.[i] || src;
      cache.set(ck(sl, tl, src), tr);
      map.set(src, tr);
    });
  });

  return texts.map((t) => map.get(t) ?? t);
}

async function googleOne(t, sl, tl) {
  const params = new URLSearchParams({
    client: "gtx",
    sl,
    tl,
    dt: "t",
    dj: "1",
    ie: "UTF-8",
    oe: "UTF-8",
    q: t.slice(0, 1800),
  });
  const r = await fetch("https://translate.googleapis.com/translate_a/single?" + params);
  if (!r.ok) return null;
  const data = await r.json();
  if (data && Array.isArray(data.sentences)) {
    return data.sentences.map((s) => s.trans || "").join("");
  }
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].map((row) => row?.[0] || "").join("");
  }
  return null;
}

async function googleGtx(texts, sl, tl) {
  try {
    const out = await pool(texts, 6, async (t) => {
      try {
        return (await googleOne(t, sl, tl)) || t;
      } catch {
        return t;
      }
    });
    return out;
  } catch {
    return null;
  }
}

async function lingva(texts, sl, tl) {
  const bases = ["https://lingva.ml/api/v1", "https://lingva.garudalinux.org/api/v1"];
  return pool(texts, 4, async (t) => {
    const encoded = encodeURIComponent(t.slice(0, 1400));
    for (const base of bases) {
      try {
        const r = await fetch(`${base}/${sl}/${tl}/${encoded}`);
        if (!r.ok) continue;
        const j = await r.json();
        if (j?.translation) return j.translation;
      } catch { /* next */ }
    }
    return t;
  });
}

async function myMemory(texts, sl, tl) {
  return pool(texts, 4, async (t) => {
    try {
      const q = encodeURIComponent(t.slice(0, 450));
      const r = await fetch(
        `https://api.mymemory.translated.net/get?q=${q}&langpair=${encodeURIComponent(sl + "|" + tl)}`,
      );
      if (!r.ok) return t;
      const j = await r.json();
      const tr = j?.responseData?.translatedText;
      return tr && !/invalid|query length/i.test(tr) ? tr : t;
    } catch {
      return t;
    }
  });
}
