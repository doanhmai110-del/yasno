const $ = (id) => document.getElementById(id);

async function tab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function sendToTab(payload) {
  const t = await tab();
  if (!t?.id) return null;
  try {
    return await chrome.tabs.sendMessage(t.id, payload);
  } catch {
    return null;
  }
}

async function settings() {
  return chrome.runtime.sendMessage({ type: "YASNO_GET" });
}

function paint(status, s, hostname) {
  $("host").textContent = hostname || "эта вкладка";
  $("auto").checked = !!s.autoTranslateEnglish;
  $("hover").checked = !!s.showOriginalOnHover;

  if (status?.active) {
    $("status").textContent = `Переведено ${status.translated || 0} фрагментов. Новые блоки подхватываются сами.`;
    $("toggle").textContent = "Пауза на этом сайте";
  } else if (status?.paused) {
    $("status").textContent = "Этот сайт на паузе. Оригинал на месте.";
    $("toggle").textContent = "Перевести страницу";
  } else {
    $("status").textContent = "Страница ещё на языке оригинала.";
    $("toggle").textContent = "Перевести страницу";
  }
}

async function refresh() {
  const t = await tab();
  let hostname = "";
  try {
    hostname = t?.url ? new URL(t.url).hostname : "";
  } catch {
    hostname = "";
  }
  const s = (await settings()) || {};
  const status = await sendToTab({ type: "YASNO_STATUS" });
  paint(status, s, hostname);
}

$("toggle").addEventListener("click", async () => {
  const status = await sendToTab({ type: "YASNO_STATUS" });
  if (status?.active) await sendToTab({ type: "YASNO_TOGGLE" });
  else await sendToTab({ type: "YASNO_START" });
  const t = await tab();
  if (t?.id && !(await sendToTab({ type: "YASNO_STATUS" }))) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ["content.css"] });
      await sendToTab({ type: "YASNO_START" });
    } catch {
      $("status").textContent = "На служебных страницах Chrome перевод недоступен.";
      return;
    }
  }
  await refresh();
});

$("restore").addEventListener("click", async () => {
  await sendToTab({ type: "YASNO_RESTORE" });
  await refresh();
});

$("auto").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({
    type: "YASNO_SET",
    patch: { autoTranslateEnglish: e.target.checked },
  });
});

$("hover").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({
    type: "YASNO_SET",
    patch: { showOriginalOnHover: e.target.checked },
  });
});

refresh();
