"""
Perch backend entry point.
FastAPI app with WebSocket support for real-time room sync.
"""
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from room import (
    create_room, can_join, get_user_count,
    add_connection, remove_connection, get_connections,
    redis_client,
)
from timer import handle_timer_action, remove_timer, get_or_create_timer
from todo import handle_todo_action, remove_todolist, get_or_create_todolist

import os
import json
import secrets


app = FastAPI(title="Perch", version="0.1.0")

# Allow browser extension to call this API.
# In production, restrict origins to the extension ID.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/health")
async def health():
    """Used by monitoring tools to verify the service is alive."""
    return {"status": "healthy"}


@app.get("/face")
async def face_page():
    """Serve the MediaPipe face detection page (runs in extension iframe)."""
    face_html = os.path.join(os.path.dirname(__file__), "face.html")
    return FileResponse(face_html, media_type="text/html")

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

@app.get("/room")
async def room_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "room.html"))


@app.post("/rooms")
async def create_new_room():
    """Create a new room and return its code."""
    code = await create_room()
    return {"code": code, "ttl_seconds": 600}


@app.get("/rooms/{code}")
async def check_room(code: str):
    """Check if a room exists and can be joined."""
    code = code.upper()
    joinable = await can_join(code)
    if not joinable:
        return {"exists": False, "joinable": False}
    user_count = await get_user_count(code)
    return {
        "exists": True,
        "joinable": True,
        "user_count": user_count,
        "max_users": 5,
    }


@app.websocket("/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    """
    WebSocket endpoint for real-time room communication.
    Each connection is tied to a room code.
    """
    code = code.upper()

    # Check if room is joinable before accepting the connection.
    if not await can_join(code):
        await websocket.close(code=4004, reason="Room not available")
        return

    await websocket.accept()

    # Generate a temporary user ID for this connection.
    user_id = secrets.token_hex(4)
    add_connection(code, websocket)

    # Add user to the Redis set so get_user_count() reflects reality.
    await redis_client.sadd(f"room:{code}:users", user_id)

    # Notify everyone else in the room that a new user joined.
    await broadcast(code, {
        "type": "user_joined",
        "user_id": user_id,
        "user_count": await get_user_count(code),
    }, exclude=websocket)

    # Send the new user their own ID and current room state.
    await websocket.send_json({
        "type": "welcome",
        "user_id": user_id,
        "user_count": await get_user_count(code),
    })

    # Send current room state to the new user (other users' timers and todos).
    from timer import user_timers
    from todo import user_todos

    room_state = {
        "type": "room_state",
        "timers": [t.to_dict() for t in user_timers.values()],
        "todos": [td.to_dict() for td in user_todos.values()],
    }
    await websocket.send_json(room_state)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "timer_action":
                # User controlling their own timer.
                action = data.get("action")
                timer_state = handle_timer_action(user_id, action)
                # Broadcast updated timer state to everyone in the room.
                await broadcast(code, {
                    "type": "timer_update",
                    "timer": timer_state,
                })
            
            elif msg_type == "todo_action":
                # User modifying their own todo list.
                action = data.get("action")
                payload = data.get("payload", {})
                todo_state = handle_todo_action(user_id, action, payload)
                if todo_state:
                    await broadcast(code, {
                        "type": "todo_update",
                        "todo": todo_state,
                    })

            elif msg_type == "face_metrics":
                # Relay face landmark metrics to other users in the room.
                # metrics=None means the user turned their camera off.
                await broadcast(code, {
                    "type":    "face_metrics",
                    "user_id": user_id,
                    "metrics": data.get("metrics"),
                    "state":   data.get("state"),   # focused/distracted/severe/away
                }, exclude=websocket)
            
            else:
                # Unknown message type: relay as-is for now.
                await broadcast(code, {
                    **data,
                    "from": user_id,
                }, exclude=websocket)

    except WebSocketDisconnect:
        pass
    finally:
        remove_connection(code, websocket)
        remove_timer(user_id)
        remove_todolist(user_id)
        await redis_client.srem(f"room:{code}:users", user_id)
        await broadcast(code, {
            "type": "user_left",
            "user_id": user_id,
            "user_count": await get_user_count(code),
        })


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


async def broadcast(code: str, message: dict, exclude=None) -> None:
    """Send a message to all connections in a room, optionally excluding one."""
    connections = get_connections(code)
    for ws in connections:
        if ws is exclude:
            continue
        try:
            await ws.send_json(message)
        except Exception:
            # Connection might be dead. We'll clean it up on the next disconnect event.
            pass