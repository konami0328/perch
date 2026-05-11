# Perch 🪶

A lightweight co-study browser extension. No accounts, no cameras required, no social pressure — just a room code and a friend.

## What is Perch?

Perch lets you and up to 4 friends study or work together in a temporary shared room. Generate a 6-character code, share it, and you're in. The room expires after 10 minutes of inactivity. No sign-up, no history, no rankings.

## Features

### Done
- [x] Room creation with a random 6-character code (TTL: 10 minutes, stored in Redis)
- [x] WebSocket-based real-time communication (join/leave broadcasts)
- [x] Per-user Pomodoro timer with start, pause, reset, and break — synced to the room
- [x] Per-user todo list with add, delete, toggle, and edit — visible to everyone in the room
- [x] Room state snapshot sent to late joiners (see existing timers and todos on entry)

### In Progress
- [ ] Browser extension frontend (manifest, popup, room UI)
- [ ] Optional camera with Q-style face overlay (MediaPipe + WebRTC)

### Planned
- [ ] Room code input and validation in the popup
- [ ] Pomodoro timer UI with visible countdown
- [ ] Todo list UI with real-time updates
- [ ] Camera toggle (off by default, opt-in per user)
- [ ] Face landmark detection with cartoon overlay via MediaPipe FaceMesh
- [ ] WebRTC peer-to-peer video (mesh, up to 5 users)
- [ ] Ambient scene backgrounds
- [ ] Freemium model: free tier with basic features, paid tier for themes and history

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, WebSocket |
| Cache / State | Redis |
| Frontend | JavaScript (Chrome Extension, Manifest V3) |
| Camera | MediaPipe FaceMesh, WebRTC |
| Deployment | TBD (single VPS, Redis instance) |

## Project Structure

```
perch/
├── backend/
│   ├── main.py        # FastAPI app, WebSocket endpoint, message dispatch
│   ├── room.py        # Room code generation, Redis storage, connection registry
│   ├── timer.py       # Per-user Pomodoro timer logic
│   ├── todo.py        # Per-user todo list logic
│   └── requirements.txt
│
├── extension/
│   ├── manifest.json  # Chrome Extension manifest (MV3)
│   ├── popup.html     # Entry point: enter or create a room code
│   ├── popup.js
│   ├── room.html      # Main study room UI
│   ├── room.js        # WebSocket client, timer and todo sync
│   ├── camera.js      # MediaPipe face detection, WebRTC signaling
│   └── styles.css
│
└── README.md
```

## Running Locally

```bash
# Start Redis
sudo service redis-server start

# Install dependencies
pip install -r backend/requirements.txt

# Start the backend
cd backend
uvicorn main:app --reload --port 8000
```

The backend will be available at `http://localhost:8000`.  
API docs at `http://localhost:8000/docs`.

## Privacy

The extension frontend is open source. Camera video (when enabled) is transmitted peer-to-peer via WebRTC and never passes through the server. No user data is stored beyond the duration of a room session.

## Status

Early development. Walking skeleton complete. Frontend not yet started.