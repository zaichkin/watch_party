import uuid
import time
import re
import traceback
import logging
from pathlib import Path
from typing import Dict, Set, Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
import uvicorn

# ── Пути ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"

def read_template(name: str, **replacements) -> str:
    """Читает HTML-файл и подставляет {{KEY}} заглушки."""
    html = (TEMPLATES_DIR / name).read_text(encoding="utf-8")
    for key, value in replacements.items():
        html = html.replace("{{" + key + "}}", str(value))
    return html

# ── Логирование ───────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("watchparty")

app = FastAPI()

@app.middleware("http")
async def add_ngrok_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["ngrok-skip-browser-warning"] = "1"
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response

# ── Данные ─────────────────────────────────────────────────────────────────────

class Room:
    def __init__(self, room_id: str, stream_url: str):
        self.room_id = room_id
        self.stream_url = stream_url
        self.player_type: str = "hls"  # 'hls' | 'iframe'
        self.connections: Set[WebSocket] = set()
        self.is_playing: bool = False
        self.current_time: float = 0.0
        self.last_sync: float = time.time()

    def to_state(self) -> dict:
        elapsed = (time.time() - self.last_sync) if self.is_playing else 0
        return {
            "type": "state",
            "stream_url": self.stream_url,
            "player_type": self.player_type,
            "is_playing": self.is_playing,
            "current_time": self.current_time + elapsed,
        }

rooms: Dict[str, Room] = {}

# ── Broadcast ──────────────────────────────────────────────────────────────────

async def broadcast(room: Room, message: dict, exclude: Optional[WebSocket] = None):
    dead: Set[WebSocket] = set()
    for ws in room.connections:
        if ws is exclude:
            continue
        try:
            await ws.send_json(message)
        except Exception:
            dead.add(ws)
    room.connections -= dead

# ── HTTP ───────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(read_template("index.html"))

# ── Прокси для iframe-плеера ───────────────────────────────────────────────────
# Скачиваем HTML плеера на сервере, чистим ненужные элементы,
# отдаём с нашего домена → браузер считает same-origin → JS имеет доступ

ELEMENTS_TO_REMOVE = [
    'tgWrapper', 'topAdPad', 'adPad', 'bannerAd',
    'top-ad', 'bottom-ad', 'ad-banner', 'tg-wrapper',
]

async def fetch_and_clean_player(url: str) -> str:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.kinopoisk.ru/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        html = resp.text

    # Удаляем элементы по id и классу через regex
    for elem_id in ELEMENTS_TO_REMOVE:
        # <div id="tgWrapper"...>...</div> — убираем через display:none в style
        html = re.sub(
            r'(<[^>]+(?:id|class)=["\'][^"\']*' + re.escape(elem_id) + r'[^"\']*["\'][^>]*)(>)',
            r'\1 style="display:none!important"\2',
            html, flags=re.IGNORECASE
        )

    # Фиксируем относительные URL ресурсов (src="/...", href="/...")
    base = '/'.join(url.split('/')[:3])  # https://fbdomen.cfd
    html = re.sub(r'(src|href)=(["\'])/(?!/)', lambda m: f'{m.group(1)}={m.group(2)}{base}/', html)

    return html

@app.get("/proxy/player")
async def proxy_player(url: str):
    """Прокси для iframe-плеера — возвращает очищенный HTML."""
    if not url.startswith('http'):
        raise HTTPException(400, "Invalid URL")
    try:
        html = await fetch_and_clean_player(url)
        return HTMLResponse(html, headers={
            "X-Frame-Options": "SAMEORIGIN",
            "Content-Security-Policy": "frame-ancestors 'self'",
        })
    except Exception as e:
        log.error(f"Proxy error for {url}: {e}")
        # Fallback — отдаём прямой iframe если прокси не сработал
        return HTMLResponse(f'''<!DOCTYPE html><html><head>
<style>*{{margin:0;padding:0}}body{{overflow:hidden}}</style></head>
<body><iframe src="{url}" style="width:100%;height:100vh;border:none"
allowfullscreen allow="autoplay;fullscreen"></iframe></body></html>''')

def resolve_stream_url(url: str) -> tuple[str, str]:
    """
    Возвращает (player_url, player_type).
    player_type: 'iframe' | 'hls'
    Если это ссылка Кинопоиска — конвертируем в fbdomen, затем через прокси.
    """
    from urllib.parse import quote

    def via_proxy(player_url: str) -> str:
        return "/proxy/player?url=" + quote(player_url, safe='')

    # Кинопоиск: kinopoisk.ru/film/123456/ или kinopoisk.ru/series/123456/
    kp = re.search(r'kinopoisk\.ru/(?:film|series|show)/(\d+)', url)
    if kp:
        kp_id = kp.group(1)
        embed_url = f"https://fbdomen.cfd/film/{kp_id}/"
        log.info(f"Kinopoisk ID {kp_id} → proxy → {embed_url}")
        return via_proxy(embed_url), "iframe"

    # Прямая ссылка на fbdomen / bazon / videocdn — тоже через прокси
    if "fbdomen" in url or "bazon" in url or "videocdn" in url:
        return via_proxy(url), "iframe"

    # YouTube embed — без прокси (нельзя проксировать)
    if url.startswith("https://www.youtube.com/embed/"):
        return url, "iframe"

    # YouTube watch: youtube.com/watch?v=ID
    yt_watch = re.search(r'youtube\.com/watch\?.*v=([a-zA-Z0-9_-]{11})', url)
    if yt_watch:
        vid = yt_watch.group(1)
        return f"https://www.youtube.com/embed/{vid}?autoplay=1&enablejsapi=1", "iframe"

    # youtube:VIDEO_ID — от расширения
    if url.startswith('youtube:'):
        vid = url[8:19]  # ровно 11 символов ID
        return f"https://www.youtube.com/embed/{vid}?autoplay=1&enablejsapi=1", "iframe"
        return url, "iframe"

    # Всё остальное — HLS/MP4 поток
    return url, "hls"

@app.post("/create")
async def create_room(data: dict):
    raw_url = (data.get("stream_url") or "").strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="stream_url is required")

    player_url, player_type = resolve_stream_url(raw_url)
    room_id = uuid.uuid4().hex[:8]
    room = Room(room_id, player_url)
    room.player_type = player_type  # 'hls' или 'iframe'
    rooms[room_id] = room
    log.info(f"Room created: {room_id}  type={player_type}  url={player_url[:80]}")
    return {"room_id": room_id}

@app.get("/room/{room_id}", response_class=HTMLResponse)
async def room_page(room_id: str):
    if room_id not in rooms:
        log.warning(f"Room not found: {room_id}")
        return HTMLResponse(f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Комната не найдена</title>
<style>
  body {{ background:#080810; color:#e8e8f0; font-family:sans-serif;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; flex-direction:column; gap:16px; text-align:center; }}
  .logo {{ font-size:48px; font-weight:900; letter-spacing:2px; }}
  .logo span {{ color:#e8ff47; }}
  h2 {{ color:#ff4f7b; margin:0; }}
  p {{ color:#6a6a80; max-width:360px; line-height:1.6; }}
  a {{ color:#e8ff47; }}
</style>
</head>
<body>
  <div class="logo">WATCH<span>PARTY</span></div>
  <h2>Комната не найдена</h2>
  <p>Комната <b>{room_id}</b> не существует или сервер был перезапущен.<br>
  Попросите хоста создать новую комнату.</p>
  <a href="/">← На главную</a>
</body>
</html>""", status_code=404)
    return HTMLResponse(read_template("room.html", ROOM_ID=room_id))

# ── WebSocket ──────────────────────────────────────────────────────────────────

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str):
    if room_id not in rooms:
        await ws.close(code=4004)
        return

    room = rooms[room_id]
    await ws.accept()
    room.connections.add(ws)
    log.info(f"[{room_id}] viewer joined  total={len(room.connections)}")

    try:
        await ws.send_json(room.to_state())
        await broadcast(room, {"type": "viewers", "count": len(room.connections)})

        # Ждём первое сообщение с именем пользователя (join)
        viewer_name = f"Зритель {len(room.connections)}"

        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "play":
                room.current_time = float(data.get("current_time", room.current_time))
                room.is_playing = True
                room.last_sync = time.time()
                log.info(f"[{room_id}] PLAY  t={room.current_time:.1f}s")
                await broadcast(room, {"type": "play", "current_time": room.current_time}, exclude=ws)

            elif msg_type == "pause":
                elapsed = (time.time() - room.last_sync) if room.is_playing else 0
                room.current_time = float(data.get("current_time", room.current_time + elapsed))
                room.is_playing = False
                room.last_sync = time.time()
                log.info(f"[{room_id}] PAUSE t={room.current_time:.1f}s")
                await broadcast(room, {"type": "pause", "current_time": room.current_time}, exclude=ws)

            elif msg_type == "seek":
                room.current_time = float(data.get("current_time", 0))
                room.last_sync = time.time()
                log.info(f"[{room_id}] SEEK  t={room.current_time:.1f}s")
                await broadcast(room, {"type": "seek", "current_time": room.current_time}, exclude=ws)

            elif msg_type == "join":
                name = str(data.get("name", "Зритель"))[:50]
                log.info(f"[{room_id}] JOIN name={name}")
                await broadcast(room, {
                    "type": "join",
                    "text": f"{name} присоединился к просмотру"
                }, exclude=ws)

            elif msg_type == "chat":
                name = str(data.get("name", "Зритель"))[:50]
                text = str(data.get("text", ""))[:300].strip()
                if text:
                    log.info(f"[{room_id}] CHAT {name}: {text[:40]}")
                    await broadcast(room, {
                        "type": "chat",
                        "name": name,
                        "text": text,
                        "time": data.get("time", int(time.time() * 1000))
                    }, exclude=ws)

            elif msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "join":
                viewer_name = data.get("name", viewer_name)[:30]
                log.info(f"[{room_id}] {viewer_name} joined")
                await broadcast(room, {
                    "type": "join",
                    "text": f"{viewer_name} присоединился",
                }, exclude=ws)

            elif msg_type == "chat":
                name = data.get("name", viewer_name)[:30]
                text = data.get("text", "").strip()[:300]
                if text:
                    log.info(f"[{room_id}] chat <{name}>: {text[:50]}")
                    await broadcast(room, {
                        "type": "chat",
                        "name": name,
                        "text": text,
                        "time": data.get("time", 0),
                    }, exclude=ws)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.error(f"[{room_id}] WS error: {e}\n{traceback.format_exc()}")
    finally:
        room.connections.discard(ws)
        count = len(room.connections)
        log.info(f"[{room_id}] viewer left  total={count}")
        await broadcast(room, {"type": "viewers", "count": count})
        await broadcast(room, {"type": "leave", "text": f"{viewer_name} покинул комнату"})

# ── Глобальный обработчик ошибок ──────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error(f"Unhandled error on {request.url}: {exc}\n{traceback.format_exc()}")
    return JSONResponse(status_code=500, content={"detail": str(exc)})

# ── Запуск ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info(f"BASE_DIR      : {BASE_DIR}")
    log.info(f"TEMPLATES_DIR : {TEMPLATES_DIR}")
    log.info(f"index.html    : {(TEMPLATES_DIR / 'index.html').exists()}")
    log.info(f"room.html     : {(TEMPLATES_DIR / 'room.html').exists()}")
    print("\n🎬  Watch Party")
    print(f"   http://localhost:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")