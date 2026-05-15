// kinopoisk.js — только сообщает popup что мы на странице фильма КП
(function () {
  'use strict';

  function getKinopoiskId() {
    const m = location.pathname.match(/\/(film|series|show)\/(\d+)/);
    return m ? { id: m[2], type: m[1] } : null;
  }

  const kp = getKinopoiskId();
  if (!kp) return;

  // Сообщаем background что открыта страница фильма КП
  chrome.runtime.sendMessage({
    type: 'KP_PAGE',
    kinopoiskId: kp.id,
    kinopoiskType: kp.type,
    url: location.href,
    title: document.title,
  }).catch(() => {});

  // Следим за SPA-навигацией
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      const newKp = getKinopoiskId();
      if (newKp) {
        chrome.runtime.sendMessage({
          type: 'KP_PAGE',
          kinopoiskId: newKp.id,
          kinopoiskType: newKp.type,
          url: location.href,
          title: document.title,
        }).catch(() => {});
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
