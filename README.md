# Perch 🪶

A lightweight co-study web app. Instant rooms, ambient presence, no pressure.

## What is Perch?

Perch lets you study alongside others in a temporary shared room — with people you know via invite code, or strangers via instant random matching. No scheduling, no leaderboards, no mandatory camera. Just show up and focus.

Target users: Chinese-speaking students, freelancers, and remote workers.

## Features

### Done
- [x] Room creation with a random 6-character code (TTL: 10 minutes, stored in Redis)
- [x] WebSocket-based real-time communication (join/leave broadcasts)
- [x] Per-user Pomodoro timer with start, pause, reset, and break — synced to the room
- [x] Per-user todo list with add, delete, toggle, and edit — visible to everyone in the room
- [x] Room state snapshot sent to late joiners (see existing timers and todos on entry)

### In Progress
- [ ] Web app frontend (room entry, session UI, user auth)
- [ ] User accounts (email + password, JWT)
- [ ] Daily usage quota tracking (6 hrs / calendar day)

### Planned
- [ ] Random matching with AI-companion fallback
- [ ] Session configuration (20–90 min) and break-time prompt on session end
- [ ] Per-session todo limit (max 3)
- [ ] Optional camera: direct feed or SVG cartoon overlay (MediaPipe FaceMesh + WebRTC)
- [ ] Freemium model: camera feature gated behind day / week / month subscription
- [ ] Browser extension (Chrome / Edge) as secondary entry point
- [ ] Deployment to Hong Kong VPS (SSL required for camera permissions)

## How Rooms Work

| Entry method | Description |
|---|---|
| Create | Get a 6-character invite code. Choose whether the room is open to random matching. |
| Join by code | Enter a code to join a specific room. |
| Random match | Drop into any open matchable room. Falls back to an AI-companion room if none available. |

Rooms are never destroyed while a human user is present. TTL only ticks down after the last user leaves.

## Session Rules

- Duration: 20–90 minutes (user-specified)
- Todo items: max 3 per session
- On session end: choose a break (5–20 min), or be auto-removed after 60 seconds of no response
- Daily cap: 6 hours of active session time per calendar day (all users)

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, WebSocket |
| Cache / State | Redis |
| Frontend | JavaScript (Web app + Chrome Extension, Manifest V3) |
| Auth | Email + password, JWT |
| Camera | MediaPipe FaceMesh, WebRTC |
| Deployment | Hong Kong VPS, SSL |

## Project Structure

```
perch/
├── backend/
│   ├── main.py          # FastAPI app, WebSocket endpoint, message dispatch
│   ├── room.py          # Room code generation, Redis storage, connection registry
│   ├── timer.py         # Per-user Pomodoro timer logic
│   ├── todo.py          # Per-user todo list logic
│   └── requirements.txt
│
├── frontend/            # Web app (in progress)
│
├── extension/
│   ├── manifest.json    # Chrome Extension manifest (MV3)
│   ├── popup.html/js    # Entry point
│   ├── room.html/js     # Study room UI, WebSocket client
│   ├── camera.js        # MediaPipe face detection, WebRTC signaling
│   └── styles.css
│
└── README.md
```

## Running Locally

```bash
# Start Redis (WSL2: required each session)
sudo service redis-server start

# Install dependencies
pip install -r backend/requirements.txt

# Start the backend
cd backend
uvicorn main:app --reload --port 8000
```

Backend: `http://localhost:8000`  
API docs: `http://localhost:8000/docs`

## Privacy

Camera video (when enabled) is transmitted peer-to-peer via WebRTC and never passes through the server. No user data is retained after a session ends.