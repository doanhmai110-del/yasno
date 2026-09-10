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
  for (let i = 0; i < missing.length; i += 16) chunks.push(missing.slice(i, i + 16));
  for (const chunk of chunks) {
    let got = null;
    got = await googleGtx(chunk, sl, tl);
    if (!got) got = await lingva(chunk, sl, tl);
    if (!got) got = await myMemory(chunk, sl, tl);
    chunk.forEach((src, i) => {
      const tr = got?.[i] || src;
      cache.set(ck(sl, tl, src), tr);
      map.set(src, tr);
    });
  }
  return texts.map((t) => map.get(t) ?? t);
}

async function googleGtx(texts, sl, tl) {
  try {
    const params = new URLSearchParams({
      client: "gtx",
      sl,
      tl,
      dt: "t",
      dj: "1",
      ie: "UTF-8",
      oe: "UTF-8",
    });
    const body = texts.map((t) => "q=" + encodeURIComponent(t.slice(0, 1800))).join("&");
    const r = await fetch("https://translate.googleapis.com/translate_a/single?" + params, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data)) {
      if (texts.length === 1) {
        const joined = (data[0] || []).map((row) => row?.[0] || "").join("");
        return [joined || null].map((x) => x || texts[0]);
      }
    }
    if (data && Array.isArray(data.sentences)) {
      const joined = data.sentences.map((s) => s.trans || "").join("");
      if (texts.length === 1) return [joined];
    }
    if (texts.length > 1) {
      const out = [];
      for (const t of texts) {
        const one = await googleGtx([t], sl, tl);
        out.push(one?.[0] || t);
      }
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

async function lingva(texts, sl, tl) {
  const bases = ["https://lingva.ml/api/v1", "https://lingva.garudalinux.org/api/v1"];
  const out = [];
  for (const t of texts) {
    const encoded = encodeURIComponent(t.slice(0, 1400));
    let done = null;
    for (const base of bases) {
      try {
        const r = await fetch(`${base}/${sl}/${tl}/${encoded}`);
        if (!r.ok) continue;
        const j = await r.json();
        if (j?.translation) {
          done = j.translation;
          break;
        }
      } catch {
      }
    }
    out.push(done || t);
  }
  return out;
}

async function myMemory(texts, sl, tl) {
  const out = [];
  for (const t of texts) {
    try {
      const q = encodeURIComponent(t.slice(0, 450));
      const r = await fetch(
        `https://api.mymemory.translated.net/get?q=${q}&langpair=${encodeURIComponent(sl + "|" + tl)}`,
      );
      if (!r.ok) {
        out.push(t);
        continue;
      }
      const j = await r.json();
      const tr = j?.responseData?.translatedText;
      out.push(tr && !/invalid|query length/i.test(tr) ? tr : t);
    } catch {
      out.push(t);
    }
  }
  return out;
}
