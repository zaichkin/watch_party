// background.js — service worker, хранит найденные потоки

const STREAM_PATTERNS = [
  /\.m3u8(\?.*)?$/i,
  /\.mpd(\?.*)?$/i,
  /\/hls\//i,
  /\/dash\//i,
  /\/manifest(\?.*)?$/i,
  /\/playlist(\?.*)?$/i,
  /videoplayback/i,
];

const IGNORE = [
  /\.ts(\?.*)?$/i,
  /segment/i,
  /chunk/i,
  /analytics/i,
  /tracking/i,
  /\.jpg/i, /\.png/i, /\.gif/i, /\.css/i, /\.woff/i,
];

// tabId → Map<url, streamInfo>
const streamsByTab = {};

function isStream(url) {
  if (!url) return false;
  if (IGNORE.some(p => p.test(url))) return false;
  return STREAM_PATTERNS.some(p => p.test(url));
}

function detectType(url) {
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  return 'Stream';
}

function addStream(tabId, url) {
  if (!streamsByTab[tabId]) streamsByTab[tabId] = new Map();
  const map = streamsByTab[tabId];
  if (map.has(url)) return false;

  map.set(url, { url, type: detectType(url), time: Date.now() });
  updateBadge(tabId, map.size);
  return true;
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e8ff47', tabId });
  try { chrome.action.setBadgeTextColor({ color: '#080810', tabId }); } catch {}
}

// ── 1. webRequest — ловит сетевые запросы (самый надёжный способ) ──────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return;
    if (!isStream(url)) return;
    if (addStream(tabId, url)) {
      chrome.runtime.sendMessage({ type: 'NEW_STREAM', tabId, url }).catch(() => {});
    }
  },
  { urls: ['<all_urls>'] }
);

// ── 2. Сообщения от content.js (fetch/XHR/video.src хуки) ─────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Поток найден через хук в странице
  if (msg.type === 'STREAM_FOUND' && tabId) {
    const { url } = msg;
    if (isStream(url) || /\.mp4/i.test(url) || /\.webm/i.test(url)) {
      if (addStream(tabId, url)) {
        chrome.runtime.sendMessage({ type: 'NEW_STREAM', tabId, url }).catch(() => {});
      }
    }
    return;
  }

  // Popup запрашивает список потоков
  if (msg.type === 'GET_STREAMS') {
    const map = streamsByTab[msg.tabId];
    sendResponse({ streams: map ? Array.from(map.values()) : [] });
    return true;
  }

  // Очистка
  if (msg.type === 'CLEAR_STREAMS') {
    delete streamsByTab[msg.tabId];
    chrome.action.setBadgeText({ text: '', tabId: msg.tabId });
    sendResponse({ ok: true });
    return true;
  }

  // Создать комнату — fetch идёт отсюда, у SW нет CSP ограничений popup
  if (msg.type === 'CREATE_ROOM') {
    chrome.storage.sync.get({ serverUrl: 'http://localhost:8000' }, async (data) => {
      const base = (data.serverUrl || 'http://localhost:8000').replace(/\/$/, '');
      try {
        const resp = await fetch(`${base}/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stream_url: msg.streamUrl }),
        });
        if (!resp.ok) throw new Error(`Сервер вернул ${resp.status}`);
        const json = await resp.json();
        sendResponse({ roomUrl: `${base}/room/${json.room_id}` });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true; // async sendResponse
  }

  // Копировать в буфер — выполняем через scripting API в активной вкладке
  if (msg.type === 'COPY_TO_CLIPBOARD') {
    const text = msg.text;
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse({ ok: false }); return; }
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (t) => navigator.clipboard.writeText(t),
          args: [text],
        });
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    });
    return true;
  }

  // Настройки
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.sync.get({ serverUrl: 'http://localhost:8000' }, sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.sync.set({ serverUrl: msg.serverUrl }, () => sendResponse({ ok: true }));
    return true;
  }
});

// ── Очищаем при навигации ──────────────────────────────────────────────────
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    delete streamsByTab[details.tabId];
    chrome.action.setBadgeText({ text: '', tabId: details.tabId }).catch?.(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete streamsByTab[tabId];
});
