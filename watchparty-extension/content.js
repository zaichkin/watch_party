// content.js — внедряет injected.js + детектирует YouTube

(function () {
  'use strict';

  // ── Внедряем injected.js в контекст страницы ──────────────────────────────
  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }
  injectScript();

  // ── Слушаем потоки от injected.js ─────────────────────────────────────────
  const seen = new Set();
  window.addEventListener('__watchPartyStream', (e) => {
    const url = e.detail?.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    chrome.runtime.sendMessage({ type: 'STREAM_FOUND', url }).catch(() => {});
  });

  // ── YouTube: извлекаем video ID и отправляем как embed ────────────────────
  function getYouTubeVideoId() {
    // Страница видео: youtube.com/watch?v=ID
    const match = location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    // Короткая ссылка: youtu.be/ID
    const short = location.href.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (short) return short[1];
    return null;
  }

  function reportYouTube() {
    const id = getYouTubeVideoId();
    if (!id) return;
    const embedUrl = 'youtube:' + id; // специальный префикс
    if (seen.has(embedUrl)) return;
    seen.add(embedUrl);
    chrome.runtime.sendMessage({ type: 'STREAM_FOUND', url: embedUrl }).catch(() => {});
  }

  if (location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be')) {
    // Сразу и при навигации (YouTube — SPA)
    reportYouTube();
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        seen.clear();
        reportYouTube();
      }
    }, 1000);
  }

})();
