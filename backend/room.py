"""
Room management: generate room codes, store in Redis with TTL,
and validate room existence.
"""

import secrets
import string
import redis.asyncio as redis
from typing import Optional

# Redis connection. In production, read from env vars.
redis_client = redis.Redis(host="localhost", port=6379, decode_responses=True)

# Room code config.
CODE_LENGTH = 6
CODE_CHARSET = string.ascii_uppercase + string.digits  # avoid lowercase to reduce ambiguity
ROOM_TTL_SECONDS = 600  # 10 minutes
MAX_USERS_PER_ROOM = 4


def generate_code() -> str:
    """Generate a random 6-character room code (uppercase letters + digits)."""
    return "".join(secrets.choice(CODE_CHARSET) for _ in range(CODE_LENGTH))


async def create_room() -> str:
    """
    Create a new room with a unique code.
    Retries if code collision occurs (extremely rare).
    Returns the room code.
    """
    for _ in range(10):
        code = generate_code()
        # SET with NX (only if not exists) and EX (expire in seconds)
        created = await redis_client.set(
            f"room:{code}",
            "active",
            nx=True,
            ex=ROOM_TTL_SECONDS,
        )
        if created:
            return code
    raise RuntimeError("Failed to generate unique room code after 10 attempts")


async def room_exists(code: str) -> bool:
    """Check if a room is still active (not expired)."""
    return await redis_client.exists(f"room:{code}") == 1


async def get_user_count(code: str) -> int:
    """Get the current number of users in a room."""
    count = await redis_client.scard(f"room:{code}:users")
    return count


async def can_join(code: str) -> bool:
    """Check if a user can join the room (exists and not full)."""
    if not await room_exists(code):
        return False
    return await get_user_count(code) < MAX_USERS_PER_ROOM


# In-memory map: room_code -> set of active WebSocket connections.
# Note: this is per-process state. If you scale to multiple servers later,
# you'll need Redis pub/sub. For now, single process is fine.
room_connections: dict[str, set] = {}


def add_connection(code: str, websocket) -> None:
    """Register a WebSocket connection to a room."""
    if code not in room_connections:
        room_connections[code] = set()
    room_connections[code].add(websocket)


def remove_connection(code: str, websocket) -> None:
    """Unregister a WebSocket connection from a room."""
    if code in room_connections:
        room_connections[code].discard(websocket)
        if not room_connections[code]:
            del room_connections[code]


def get_connections(code: str) -> set:
    """Get all active connections in a room."""
    return room_connections.get(code, set())