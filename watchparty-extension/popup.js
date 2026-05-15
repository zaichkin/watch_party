let currentTabId = null;
let serverUrl = 'http://localhost:8000';
let streams = [];

// ── Init ──────────────────────────────────────────────────────────────────────
// ── Кинопоиск — специальная панель ───────────────────────────────────────────
function showKinopoiskPanel(kp) {
  // Скрываем вкладку потоков, показываем KP-панель
  const panel = document.getElementById('tab-streams');
  panel.innerHTML = `
    <div style="padding:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="font-size:28px">🎬</span>
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px">Кинопоиск</div>
          <div style="font-size:13px;font-weight:500;line-height:1.3;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(kp.title)}">${escHtml(kp.title)}</div>
        </div>
      </div>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px">ID фильма</div>
        <div style="font-size:18px;font-family:'Bebas Neue',sans-serif;letter-spacing:.1em;color:var(--accent)">${escHtml(kp.kinopoiskId)}</div>
      </div>

      <button id="kp-watch-party-btn" class="btn-sm btn-primary" style="width:100%;padding:12px;font-size:14px;border-radius:10px">
        🎬 Создать Watch Party
      </button>
      <div id="kp-status" style="margin-top:10px;font-size:12px;color:var(--muted);text-align:center;min-height:18px"></div>

      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <button id="kp-show-streams" style="background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;font-family:'DM Sans',sans-serif;padding:0">
          Показать найденные потоки →
        </button>
      </div>
    </div>
  `;

  document.getElementById('kp-watch-party-btn').addEventListener('click', async () => {
    const btn = document.getElementById('kp-watch-party-btn');
    const status = document.getElementById('kp-status');
    btn.disabled = true;
    btn.textContent = '⏳ Создаём комнату...';
    status.textContent = '';

    chrome.runtime.sendMessage({ type: 'CREATE_ROOM', streamUrl: kp.url }, async (resp) => {
      if (chrome.runtime.lastError || resp?.error) {
        btn.disabled = false;
        btn.textContent = '🎬 Создать Watch Party';
        status.style.color = 'var(--accent2)';
        status.textContent = '❌ ' + (resp?.error || chrome.runtime.lastError?.message);
        return;
      }

      const roomUrl = resp.roomUrl;
      chrome.tabs.create({ url: roomUrl });

      const copied = await copyToClipboard(roomUrl);
      btn.textContent = '✓ Готово!';
      status.style.color = 'var(--accent)';
      status.textContent = copied ? '✅ Ссылка скопирована!' : '✅ Комната открыта';

      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '🎬 Создать Watch Party';
      }, 3000);
    });
  });

  document.getElementById('kp-show-streams').addEventListener('click', () => {
    loadStreams();
  });
}

// ── YouTube — специальная панель ──────────────────────────────────────────────
function showYouTubePanel(yt) {
  const panel = document.getElementById('tab-streams');
  panel.innerHTML = `
    <div style="padding:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="font-size:28px">▶️</span>
        <div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px">YouTube</div>
          <div style="font-size:13px;font-weight:500;line-height:1.3;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(yt.title)}">${escHtml(yt.title)}</div>
        </div>
      </div>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px">ID видео</div>
        <div style="font-size:18px;font-family:'Bebas Neue',sans-serif;letter-spacing:.1em;color:var(--accent)">${escHtml(yt.videoId)}</div>
      </div>

      <button id="yt-watch-party-btn" class="btn-sm btn-primary" style="width:100%;padding:12px;font-size:14px;border-radius:10px">
        ▶️ Создать Watch Party
      </button>
      <div id="yt-status" style="margin-top:10px;font-size:12px;color:var(--muted);text-align:center;min-height:18px"></div>

      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <button id="yt-show-streams" style="background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;font-family:'DM Sans',sans-serif;padding:0">
          Показать найденные потоки →
        </button>
      </div>
    </div>
  `;

  document.getElementById('yt-watch-party-btn').addEventListener('click', async () => {
    const btn = document.getElementById('yt-watch-party-btn');
    const status = document.getElementById('yt-status');
    btn.disabled = true;
    btn.textContent = '⏳ Создаём комнату...';
    status.textContent = '';

    const ytUrl = 'youtube:' + yt.videoId;
    chrome.runtime.sendMessage({ type: 'CREATE_ROOM', streamUrl: ytUrl }, async (resp) => {
      if (chrome.runtime.lastError || resp?.error) {
        btn.disabled = false;
        btn.textContent = '▶️ Создать Watch Party';
        status.style.color = 'var(--accent2)';
        status.textContent = '❌ ' + (resp?.error || chrome.runtime.lastError?.message);
        return;
      }
      const roomUrl = resp.roomUrl;
      chrome.tabs.create({ url: roomUrl });
      const copied = await copyToClipboard(roomUrl);
      btn.textContent = '✓ Готово!';
      status.style.color = 'var(--accent)';
      status.textContent = copied ? '✅ Ссылка скопирована!' : '✅ Комната открыта';
      setTimeout(() => { btn.disabled = false; btn.textContent = '▶️ Создать Watch Party'; }, 3000);
    });
  });

  document.getElementById('yt-show-streams').addEventListener('click', () => loadStreams());
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (data) => {
    serverUrl = (data?.serverUrl || 'http://localhost:8000').replace(/\/$/, '');
    document.getElementById('server-url').value = serverUrl;
  });

  // Проверяем КП → YouTube → обычные потоки
  chrome.runtime.sendMessage({ type: 'GET_KP_PAGE', tabId: currentTabId }, (kp) => {
    if (kp) { showKinopoiskPanel(kp); return; }
    chrome.runtime.sendMessage({ type: 'GET_YT_PAGE', tabId: currentTabId }, (yt) => {
      if (yt) { showYouTubePanel(yt); return; }
      loadStreams();
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'NEW_STREAM' && msg.tabId === currentTabId) loadStreams();
  });
}

// ── Загрузка потоков ──────────────────────────────────────────────────────────
function loadStreams() {
  chrome.runtime.sendMessage({ type: 'GET_STREAMS', tabId: currentTabId }, (resp) => {
    streams = (resp?.streams || []).sort((a, b) => b.time - a.time);
    renderStreams();
  });
}

function renderStreams() {
  const empty = document.getElementById('streams-empty');
  const list  = document.getElementById('stream-list');
  const badge = document.getElementById('count-badge');

  if (streams.length === 0) {
    empty.style.display = '';
    list.style.display  = 'none';
    badge.textContent   = '0 потоков';
    badge.className     = 'badge none';
    return;
  }

  const n = streams.length;
  badge.textContent = n + (n === 1 ? ' поток' : n < 5 ? ' потока' : ' потоков');
  badge.className   = 'badge found';
  empty.style.display = 'none';
  list.style.display  = 'flex';

  list.innerHTML = streams.map((s, i) => `
    <div class="stream-item">
      <div class="stream-header">
        <span class="stream-type type-${s.type}">${s.type}</span>
        <span class="stream-time">${formatTime(s.time)}</span>
      </div>
      <div class="stream-url" title="${escHtml(s.url)}">${escHtml(s.url)}</div>
      <div class="stream-actions">
        <button class="btn-sm btn-primary"    data-action="watch" data-idx="${i}">▶ Watch Party</button>
        <button class="btn-sm btn-secondary"  data-action="copy"  data-idx="${i}" id="copy-${i}">Копировать</button>
      </div>
    </div>
  `).join('');

  // Вешаем обработчики через делегирование — onclick в innerHTML не работает с CSP
  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (btn.dataset.action === 'watch') sendToWatchParty(idx);
      if (btn.dataset.action === 'copy')  copyUrl(idx, btn);
    });
  });
}

// ── Копирование в буфер — работает прямо в popup ─────────────────────────────
function copyToClipboard(text) {
  // Способ 1: современный API (работает если popup в фокусе)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  // Способ 2: старый execCommand через textarea
  return new Promise((resolve) => {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
      const ok = document.execCommand('copy');
      resolve(ok);
    } catch {
      resolve(false);
    } finally {
      document.body.removeChild(el);
    }
  });
}

// ── Отправка в Watch Party ────────────────────────────────────────────────────
async function sendToWatchParty(index) {
  const stream = streams[index];
  if (!stream) return;

  toast('⏳ Создаём комнату...');

  chrome.runtime.sendMessage(
    { type: 'CREATE_ROOM', streamUrl: stream.url },
    async (resp) => {
      if (chrome.runtime.lastError) {
        toast('❌ ' + chrome.runtime.lastError.message);
        return;
      }
      if (resp?.error) {
        toast('❌ ' + resp.error);
        return;
      }

      const roomUrl = resp.roomUrl;
      chrome.tabs.create({ url: roomUrl });

      const copied = await copyToClipboard(roomUrl);
      if (copied) {
        toast('✅ Комната создана! Ссылка скопирована.');
      } else {
        toast('✅ Готово! Ссылка: ' + roomUrl, 8000);
      }
    }
  );
}

// ── Копирование URL потока ────────────────────────────────────────────────────
async function copyUrl(index, btn) {
  const stream = streams[index];
  if (!stream) return;

  // Копируем оригинальный URL (rawUrl), а не embed
  const textToCopy = stream.rawUrl || stream.url;
  const copied = await copyToClipboard(textToCopy);

  if (copied) {
    const orig = btn.textContent;
    btn.textContent = '✓ Скопировано';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 2000);
  } else {
    toast('Скопируйте вручную: ' + textToCopy, 8000);
  }
}

// ── Очистка ───────────────────────────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_STREAMS', tabId: currentTabId }, () => {
    streams = [];
    renderStreams();
  });
});

// ── Табы ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab, .panel').forEach(el => el.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Настройки ─────────────────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', () => {
  const url = document.getElementById('server-url').value.trim().replace(/\/$/, '');
  serverUrl = url;
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', serverUrl: url }, () => {
    const ok = document.getElementById('save-ok');
    ok.style.display = 'block';
    setTimeout(() => ok.style.display = 'none', 2000);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function toast(text, duration = 3500) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
