"""
Perch backend entry point.
FastAPI app with WebSocket support for real-time room sync.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from room import (
    create_room, can_join, get_user_count,
    add_connection, remove_connection, get_connections,
    redis_client,
)

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
    """Health check endpoint."""
    return {"status": "ok", "service": "perch"}


@app.get("/health")
async def health():
    """Used by monitoring tools to verify the service is alive."""
    return {"status": "healthy"}


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

    try:
        # Keep the connection alive and relay messages.
        while True:
            data = await websocket.receive_json()
            # For now, just broadcast whatever the client sends.
            # Later we'll dispatch based on message type (timer, todo, etc).
            await broadcast(code, {
                **data,
                "from": user_id,
            }, exclude=websocket)
    except WebSocketDisconnect:
        # Client disconnected (closed tab, lost network, etc).
        pass
    finally:
        remove_connection(code, websocket)
        await redis_client.srem(f"room:{code}:users", user_id)
        await broadcast(code, {
            "type": "user_left",
            "user_id": user_id,
            "user_count": await get_user_count(code),
        })


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