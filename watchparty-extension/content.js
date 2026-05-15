// content.js — внедряет injected.js + детектирует YouTube + чистит плеер

(function () {
  'use strict';

  // ── Внедряем injected.js в контекст страницы ──────────────────────────────
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── Слушаем потоки от injected.js ─────────────────────────────────────────
  const seen = new Set();
  window.addEventListener('__watchPartyStream', (e) => {
    const url = e.detail?.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    chrome.runtime.sendMessage({ type: 'STREAM_FOUND', url }).catch(() => {});
  });

  // ── YouTube ────────────────────────────────────────────────────────────────
  const getYouTubeVideoId = () => {
    const m1 = location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m1) return m1[1];
    const m2 = location.href.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (m2) return m2[1];
    return null;
  };

  if (location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be')) {
    const reportYouTubePage = () => {
      const id = getYouTubeVideoId();
      if (!id) return;
      const title = document.title.replace(' - YouTube', '').trim();
      chrome.runtime.sendMessage({
        type: 'YT_PAGE',
        videoId: id,
        url: location.href,
        title: title || 'YouTube видео',
      }).catch(() => {});
      const embedUrl = 'youtube:' + id;
      if (!seen.has(embedUrl)) {
        seen.add(embedUrl);
        chrome.runtime.sendMessage({ type: 'STREAM_FOUND', url: embedUrl }).catch(() => {});
      }
    };

    reportYouTubePage();
    let lastHref = location.href;
    setInterval(() => {
      if (!chrome.runtime?.id) return; // контекст расширения недоступен
      if (location.href !== lastHref) {
        lastHref = location.href;
        seen.clear();
        reportYouTubePage();
      }
      // Название обновляется позже URL — шлём каждую секунду
      const id = getYouTubeVideoId();
      if (id) {
        const title = document.title.replace(' - YouTube', '').trim();
        if (title) chrome.runtime.sendMessage({ type: 'YT_PAGE', videoId: id, url: location.href, title }).catch(() => {});
      }
    }, 1000);
  }

  // ── Удаление tgWrapper на fbdomen и похожих плеерах ───────────────────────
  const PLAYER_DOMAINS = ['fbdomen', 'bazon', 'videocdn', 'kodik', 'alloha'];

  if (PLAYER_DOMAINS.some(d => location.hostname.includes(d))) {
    const removeTgWrapper = () => {
      ['tgWrapper', 'tg-wrapper'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
        document.querySelectorAll('.' + id).forEach(e => e.remove());
      });
    };
    removeTgWrapper();
    new MutationObserver(removeTgWrapper).observe(
      document.documentElement, { childList: true, subtree: true }
    );
  }

})();
