"""
Pomodoro timer logic.
Each user has their own timer. State is broadcast to the room on every change.
"""

import time
from enum import Enum


class TimerStatus(str, Enum):
    IDLE = "idle"           # not started
    RUNNING = "running"     # counting down
    PAUSED = "paused"       # paused mid-session
    BREAK = "break"         # break period


# Default durations in seconds.
POMODORO_DURATION = 25 * 60   # 25 minutes
BREAK_DURATION = 5 * 60       # 5 minutes


class UserTimer:
    """Represents one user's pomodoro timer state."""

    def __init__(self, user_id: str):
        self.user_id = user_id
        self.status = TimerStatus.IDLE
        self.duration = POMODORO_DURATION
        self.remaining = POMODORO_DURATION
        self.started_at: float | None = None  # unix timestamp when last started

    def start(self) -> None:
        """Start or resume the timer."""
        if self.status in (TimerStatus.IDLE, TimerStatus.PAUSED):
            self.started_at = time.time()
            self.status = TimerStatus.RUNNING

    def pause(self) -> None:
        """Pause the timer and update remaining time."""
        if self.status == TimerStatus.RUNNING:
            elapsed = time.time() - self.started_at
            self.remaining = max(0, self.remaining - elapsed)
            self.started_at = None
            self.status = TimerStatus.PAUSED

    def reset(self) -> None:
        """Reset timer back to full pomodoro duration."""
        self.status = TimerStatus.IDLE
        self.remaining = POMODORO_DURATION
        self.started_at = None

    def start_break(self) -> None:
        """Switch to break mode."""
        self.status = TimerStatus.BREAK
        self.remaining = BREAK_DURATION
        self.started_at = time.time()

    def get_remaining(self) -> float:
        """Calculate current remaining seconds (accounts for time elapsed since start)."""
        if self.status == TimerStatus.RUNNING and self.started_at:
            elapsed = time.time() - self.started_at
            return max(0, self.remaining - elapsed)
        return self.remaining

    def to_dict(self) -> dict:
        """Serialize timer state to send over WebSocket."""
        return {
            "user_id": self.user_id,
            "status": self.status,
            "remaining": round(self.get_remaining()),
            "duration": self.duration,
        }


# In-memory store: user_id -> UserTimer
# Keyed by user_id so each user has exactly one timer regardless of room.
user_timers: dict[str, UserTimer] = {}


def get_or_create_timer(user_id: str) -> UserTimer:
    """Get existing timer for a user, or create a new one."""
    if user_id not in user_timers:
        user_timers[user_id] = UserTimer(user_id)
    return user_timers[user_id]


def remove_timer(user_id: str) -> None:
    """Clean up timer when user leaves the room."""
    user_timers.pop(user_id, None)


def handle_timer_action(user_id: str, action: str) -> dict:
    """
    Process a timer action from the client.
    Returns the updated timer state to broadcast.
    """
    timer = get_or_create_timer(user_id)

    if action == "start":
        timer.start()
    elif action == "pause":
        timer.pause()
    elif action == "reset":
        timer.reset()
    elif action == "break":
        timer.start_break()

    return timer.to_dict()