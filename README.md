# RemoteLink

A Windows remote desktop application similar to TeamViewer, built with Electron and Node.js. Enables screen sharing, remote control, file transfer, and secure monitoring between machines over the internet.

## Current Features

- **Electron Desktop App** - Custom-themed dark UI with titlebar, sidebar navigation, and session management cards
- **Relay/Signaling Server** - Socket.io-based server that brokers connections between host and client using 6-character session IDs
- **Screen Streaming** - Real-time screen capture and streaming via WebRTC (peer-to-peer video)
- **Multi-Monitor Support** - Host can select which monitor to share; client can request monitor switches via tabs

## Tech Stack

- **Electron** - Desktop app framework (Chromium + Node.js)
- **Node.js** - Backend runtime for the relay server
- **WebRTC** - Peer-to-peer screen streaming (built into Chromium)
- **Socket.io** - Signaling/relay server for connection brokering
- **electron-builder** - Packaging and Windows installer creation

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install Dependencies

```bash
cd C:\Users\Olu\Desktop\RemoteLink\remotelink
npm install
```

### Run the Project

1. Start the signaling server:
```bash
node src/server/index.js
```

2. In a separate terminal, start the Electron app:
```bash
npm start
```

3. To test screen streaming, open a second instance of the app (`npm start` in another terminal), start hosting on one, and connect from the other using the session ID.

### Build Windows Installer

```bash
npm run build
```

This creates a `.exe` installer in the `dist/` folder.

## Project Structure

```
remotelink/
├── assets/              # App icons and static assets
├── src/
│   ├── main/            # Electron main process
│   │   ├── main.js      # App entry point, window management, IPC handlers
│   │   └── preload.js   # Secure bridge between main and renderer
│   ├── renderer/        # Frontend UI
│   │   ├── index.html   # Main app shell (home, viewer, placeholder pages)
│   │   ├── styles/      # CSS stylesheets
│   │   └── scripts/     # Client-side JS (renderer.js, webrtc.js)
│   ├── server/          # Relay/signaling server (Socket.io)
│   ├── host/            # Host module (placeholder)
│   ├── client/          # Client module (placeholder)
│   ├── transfer/        # File transfer module (placeholder)
│   ├── chat/            # Chat module (placeholder)
│   ├── security/        # Security/surveillance module (placeholder)
│   └── utils/           # Shared utilities (placeholder)
├── package.json
└── .gitignore
```

## Phase Progress

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Electron app shell, UI, custom titlebar, sidebar navigation | Complete |
| 2 | Relay/signaling server, session creation and joining | Complete |
| 3 | Screen capture, WebRTC streaming, multi-monitor support | Complete |
| 4 | Keyboard and mouse remote control | Pending |
| 5 | File transfer between connected machines | Pending |
| 6 | Real-time chat messaging | Pending |
| 7 | Permanent machine IDs and auto-start on boot | Pending |
| 8 | Silent security/surveillance mode | Pending |

## Planned Features

- **Keyboard & Mouse Control** - Send input events from client to host for full remote control
- **File Transfer** - Drag-and-drop file sharing between connected machines
- **Chat** - Real-time text messaging during remote sessions
- **Permanent Machine IDs** - Persistent identifiers so machines can reconnect without new session codes
- **Auto-Start on Boot** - Option to launch RemoteLink automatically on system startup
- **Silent Security Mode** - Background monitoring and surveillance capabilities
