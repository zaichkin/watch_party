import uuid
import time
import traceback
import logging
from pathlib import Path
from typing import Dict, Set, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
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
        self.connections: Set[WebSocket] = set()
        self.is_playing: bool = False
        self.current_time: float = 0.0
        self.last_sync: float = time.time()

    def to_state(self) -> dict:
        elapsed = (time.time() - self.last_sync) if self.is_playing else 0
        return {
            "type": "state",
            "stream_url": self.stream_url,
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

@app.post("/create")
async def create_room(data: dict):
    stream_url = (data.get("stream_url") or "").strip()
    if not stream_url:
        raise HTTPException(status_code=400, detail="stream_url is required")
    room_id = uuid.uuid4().hex[:8]
    rooms[room_id] = Room(room_id, stream_url)
    log.info(f"Room created: {room_id}  url={stream_url[:80]}")
    return {"room_id": room_id}

@app.get("/room/{room_id}", response_class=HTMLResponse)
async def room_page(room_id: str):
    if room_id not in rooms:
        log.warning(f"Room not found: {room_id}")
        return RedirectResponse("/")
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