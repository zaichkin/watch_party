// content.js — работает в контексте расширения, внедряет injected.js в страницу

(function () {
  'use strict';

  // ── Внедряем injected.js в контекст СТРАНИЦЫ ──────────────────────────────
  // content.js изолирован — fetch/XHR страницы он не видит напрямую
  // Единственный способ — вставить <script> тег с нашим кодом
  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }
  injectScript();

  // ── Слушаем события от injected.js ────────────────────────────────────────
  const seen = new Set();

  window.addEventListener('__watchPartyStream', (e) => {
    const url = e.detail?.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    // Передаём в background service worker
    chrome.runtime.sendMessage({ type: 'STREAM_FOUND', url }).catch(() => {});
  });

})();
