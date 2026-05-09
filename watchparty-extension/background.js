// background.js — service worker

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

// tabId → Map<fingerprint, streamInfo>
const streamsByTab = {};

function isStream(url) {
  if (!url) return false;
  if (IGNORE.some(p => p.test(url))) return false;
  return STREAM_PATTERNS.some(p => p.test(url));
}

function detectType(url) {
  if (url.startsWith('youtube:')) return 'YouTube';
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/\.mp4/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  return 'Stream';
}

// youtube:VIDEO_ID → embed URL для плеера
function toPlayableUrl(url) {
  if (url.startsWith('youtube:')) {
    return 'https://www.youtube.com/embed/' + url.slice(8) + '?enablejsapi=1&autoplay=1';
  }
  return url;
}

// Возвращает ключ дедупликации.
// Один и тот же поток с разных CDN-хостов даёт одинаковый fingerprint.
function fingerprint(url) {
  try {
    const u = new URL(url);

    // ── YouTube videoplayback ──────────────────────────────────────────────────
    // rr1--sn-xxx.googlevideo.com и rr5--sn-yyy.googlevideo.com — это один файл.
    // Ключ: id видео + itag (качество) + range (сегмент)
    if (u.hostname.includes('googlevideo.com')) {
      const id   = u.searchParams.get('id')    || '';
      const itag = u.searchParams.get('itag')  || '';
      return 'yt:' + id + ':' + itag;
    }

    // ── HLS / DASH манифесты ───────────────────────────────────────────────────
    // Убираем числовой/cdn субдомен, оставляем путь к манифесту
    if (/\.m3u8|\.mpd|manifest|playlist/i.test(u.pathname)) {
      // cdn1.example.com → example.com
      const domain = u.hostname.replace(/^[\w-]+\d[\w-]*\./, '');
      const path   = u.pathname.replace(/\/$/, '');
      return 'manifest:' + domain + ':' + path;
    }

    // ── MP4 / WebM ─────────────────────────────────────────────────────────────
    if (/\.(mp4|webm)/i.test(u.pathname)) {
      const domain = u.hostname.replace(/^[\w-]+\d[\w-]*\./, '');
      return 'video:' + domain + ':' + u.pathname;
    }

    // Всё остальное — хост + путь без query
    return u.hostname + ':' + u.pathname;
  } catch {
    return url;
  }
}

function addStream(tabId, url) {
  if (!streamsByTab[tabId]) streamsByTab[tabId] = new Map();
  const map = streamsByTab[tabId];
  const key = fingerprint(url);
  if (map.has(key)) return false;

  map.set(key, {
    url: toPlayableUrl(url),   // URL для Watch Party плеера
    rawUrl: url,               // оригинальный URL для копирования
    type: detectType(url),
    time: Date.now(),
  });
  updateBadge(tabId, map.size);
  return true;
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e8ff47', tabId });
  try { chrome.action.setBadgeTextColor({ color: '#080810', tabId }); } catch {}
}

// ── 1. webRequest — ловит сетевые запросы ─────────────────────────────────────
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

// ── 2. Сообщения ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'STREAM_FOUND' && tabId) {
    const { url } = msg;
    if (url.startsWith('youtube:') || isStream(url) || /\.(mp4|webm)/i.test(url)) {
      if (addStream(tabId, url)) {
        chrome.runtime.sendMessage({ type: 'NEW_STREAM', tabId, url }).catch(() => {});
      }
    }
    return;
  }

  if (msg.type === 'GET_STREAMS') {
    const map = streamsByTab[msg.tabId];
    sendResponse({ streams: map ? Array.from(map.values()) : [] });
    return true;
  }

  if (msg.type === 'CLEAR_STREAMS') {
    delete streamsByTab[msg.tabId];
    chrome.action.setBadgeText({ text: '', tabId: msg.tabId });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CREATE_ROOM') {
    chrome.storage.sync.get({ serverUrl: 'http://localhost:8000' }, async (data) => {
      const base = (data.serverUrl || 'http://localhost:8000').replace(/\/$/, '');
      try {
        const resp = await fetch(base + '/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stream_url: msg.streamUrl }),
        });
        if (!resp.ok) throw new Error('Сервер вернул ' + resp.status);
        const json = await resp.json();
        sendResponse({ roomUrl: base + '/room/' + json.room_id });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }

  if (msg.type === 'COPY_TO_CLIPBOARD') {
    const text = msg.text;
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tid = tabs[0]?.id;
      if (!tid) { sendResponse({ ok: false }); return; }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tid },
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

  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.sync.get({ serverUrl: 'http://localhost:8000' }, sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.sync.set({ serverUrl: msg.serverUrl }, () => sendResponse({ ok: true }));
    return true;
  }
});

// ── Очищаем при навигации ──────────────────────────────────────────────────────
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    delete streamsByTab[details.tabId];
    try { chrome.action.setBadgeText({ text: '', tabId: details.tabId }); } catch {}
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete streamsByTab[tabId];
});
