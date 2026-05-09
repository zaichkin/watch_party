// injected.js — выполняется В КОНТЕКСТЕ СТРАНИЦЫ (не расширения)
// Единственный способ перехватить fetch/XHR до того как страница их вызовет
(function () {
  'use strict';

  if (window.__watchPartyInjected) return;
  window.__watchPartyInjected = true;

  const PATTERNS = [
    /\.m3u8(\?.*)?$/i,
    /\.mpd(\?.*)?$/i,
    /\/hls\//i,
    /\/dash\//i,
    /\/manifest(\?.*)?$/i,
    /\/playlist(\?.*)?$/i,
    /videoplayback/i,
    /\.mp4(\?.*)?$/i,
    /\.webm(\?.*)?$/i,
    /\/video\//i,
    /stream/i,
  ];

  // Фильтруем мусор — сегменты, трекеры, мелкие mp4
  const IGNORE = [
    /\.ts(\?.*)?$/i,
    /segment/i,
    /chunk/i,
    /frag/i,
    /\/seg\d/i,
    /analytics/i,
    /tracking/i,
    /pixel/i,
    /beacon/i,
    /thumbnail/i,
    /poster/i,
    /\.jpg/i,
    /\.png/i,
    /\.gif/i,
    /\.webp/i,
    /\.svg/i,
    /\.css/i,
    /\.woff/i,
  ];

  function isStream(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:') || url.startsWith('data:')) return false;
    if (IGNORE.some(p => p.test(url))) return false;
    return PATTERNS.some(p => p.test(url));
  }

  function report(url) {
    // Отправляем через CustomEvent — content.js его поймает
    window.dispatchEvent(new CustomEvent('__watchPartyStream', {
      detail: { url }
    }));
  }

  // ── 1. Перехват fetch ──────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0]
        : args[0] instanceof Request ? args[0].url
        : String(args[0]);
      if (isStream(url)) report(url);
    } catch {}
    return origFetch.apply(this, args);
  };

  // ── 2. Перехват XHR ────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && isStream(url)) report(url);
    } catch {}
    return origOpen.call(this, method, url, ...rest);
  };

  // ── 3. Перехват MediaSource / URL.createObjectURL ──────────────────────────
  // Некоторые плееры передают blob URL — ловим исходный src через атрибут
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const result = origCreateObjectURL.call(URL, obj);
    // Если это MediaSource — src уже известен через другие хуки
    return result;
  };

  // ── 4. Перехват HTMLVideoElement.src ──────────────────────────────────────
  const videoProto = HTMLVideoElement.prototype;
  const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (origSrcDescriptor) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      set(val) {
        try { if (isStream(val)) report(val); } catch {}
        return origSrcDescriptor.set.call(this, val);
      },
      get() { return origSrcDescriptor.get.call(this); },
      configurable: true,
    });
  }

  // ── 5. Перехват через атрибут src у <source> ───────────────────────────────
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (name === 'src' && (this.tagName === 'VIDEO' || this.tagName === 'SOURCE')) {
        if (isStream(value)) report(value);
      }
    } catch {}
    return origSetAttribute.call(this, name, value);
  };

  // ── 6. HLS.js / Shaka / Video.js внутренние вызовы ────────────────────────
  // Многие плееры используют свои внутренние URL — ловим через MutationObserver
  new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (!node.tagName) continue;
        const tag = node.tagName.toUpperCase();
        if (tag === 'VIDEO' || tag === 'SOURCE') {
          const src = node.src || node.currentSrc || node.getAttribute('src') || '';
          if (isStream(src)) report(src);
        }
      }
      // Изменение атрибута src
      if (mut.type === 'attributes' && mut.attributeName === 'src') {
        const src = mut.target.getAttribute('src') || '';
        if (isStream(src)) report(src);
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // ── 7. Периодическое сканирование video элементов ─────────────────────────
  function scanVideos() {
    document.querySelectorAll('video, source').forEach(el => {
      const src = el.src || el.currentSrc || el.getAttribute('src') || '';
      if (isStream(src)) report(src);
    });
  }
  // Сканируем сразу и потом раз в секунду первые 30 сек
  let scanCount = 0;
  const scanInterval = setInterval(() => {
    scanVideos();
    if (++scanCount >= 30) clearInterval(scanInterval);
  }, 1000);

})();
