"""
Todo list management.
Each user has their own todo list stored in memory.
Lists are broadcast to the room on every change.
"""

import secrets
from dataclasses import dataclass, field, asdict


@dataclass
class TodoItem:
    """A single todo item belonging to a user."""
    id: str
    text: str
    done: bool = False


@dataclass
class UserTodoList:
    """All todos for a single user."""
    user_id: str
    items: list[TodoItem] = field(default_factory=list)

    def add(self, text: str) -> TodoItem:
        """Add a new todo item. Returns the created item."""
        item = TodoItem(id=secrets.token_hex(4), text=text)
        self.items.append(item)
        return item

    def delete(self, item_id: str) -> bool:
        """Delete a todo by id. Returns True if found and deleted."""
        before = len(self.items)
        self.items = [i for i in self.items if i.id != item_id]
        return len(self.items) < before

    def toggle(self, item_id: str) -> bool:
        """Toggle done status. Returns True if found."""
        for item in self.items:
            if item.id == item_id:
                item.done = not item.done
                return True
        return False

    def edit(self, item_id: str, text: str) -> bool:
        """Edit the text of a todo. Returns True if found."""
        for item in self.items:
            if item.id == item_id:
                item.text = text
                return True
        return False

    def to_dict(self) -> dict:
        """Serialize to send over WebSocket."""
        return {
            "user_id": self.user_id,
            "items": [asdict(i) for i in self.items],
        }


# In-memory store: user_id -> UserTodoList
user_todos: dict[str, UserTodoList] = {}


def get_or_create_todolist(user_id: str) -> UserTodoList:
    """Get existing todo list for a user, or create a new one."""
    if user_id not in user_todos:
        user_todos[user_id] = UserTodoList(user_id)
    return user_todos[user_id]


def remove_todolist(user_id: str) -> None:
    """Clean up todo list when user leaves the room."""
    user_todos.pop(user_id, None)


def handle_todo_action(user_id: str, action: str, payload: dict) -> dict | None:
    """
    Process a todo action from the client.
    Returns the updated todo list to broadcast, or None if action is invalid.
    """
    todo_list = get_or_create_todolist(user_id)

    if action == "add":
        text = payload.get("text", "").strip()
        if not text:
            return None
        todo_list.add(text)

    elif action == "delete":
        item_id = payload.get("item_id")
        if not item_id or not todo_list.delete(item_id):
            return None

    elif action == "toggle":
        item_id = payload.get("item_id")
        if not item_id or not todo_list.toggle(item_id):
            return None

    elif action == "edit":
        item_id = payload.get("item_id")
        text = payload.get("text", "").strip()
        if not item_id or not text or not todo_list.edit(item_id, text):
            return None

    else:
        return None

    return todo_list.to_dict()