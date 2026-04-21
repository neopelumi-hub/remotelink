# RemoteLink v1.0.0

## Project Overview

A Windows remote desktop application similar to TeamViewer built with Electron, Node.js, WebRTC and Socket.io.

## Project Location

```
C:\Users\Olu\Desktop\RemoteLink\remotelink
```

## How to Run

1. Start the relay server:
```bash
cd C:\Users\Olu\Desktop\RemoteLink\remotelink
node src/server/index.js
```

2. Start the app:
```bash
npm start
```

3. Start a Node instance for testing:
```bash
npx electron . --profile=node
```

## Important Details

- **Machine ID:** F7F7-0AF2-6236
- **Master Key:** B2B4AE
- **Server runs on port:** 3000
- **Installer location:** `dist/RemoteLink Setup 1.0.0.exe`

## Phases Completed

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Project setup and UI | Complete |
| 2 | Relay/signaling server | Complete |
| 3 | Screen streaming and multi-monitor support | Complete |
| 4 | Keyboard and mouse control | Complete |
| 5 | Permanent Machine IDs and access control | Complete |
| 6 | File and folder transfer | Complete |
| 7 | Chat messaging | Complete |
| 8 | System tray and auto-start on Windows boot | Complete |
| 9 | Silent security/surveillance mode | SKIPPED - revisit later |
| 10 | Master Console and Node registration | Complete |
| 11 | UI polish and Windows installer | Complete |

## Next Steps (pick up here next session)

- Set up cloud relay server so app works across different locations
- Deploy relay server to Render.com or Railway.app (free tier)
- Update server URL in app from localhost:3000 to cloud URL
- Test connection between two real computers at different locations
- Install RemoteLink on all computers using the .exe installer
- Register all computers as Nodes using Master Key B2B4AE
- Revisit Phase 9 (security/surveillance mode)

## Features Built

- Remote screen streaming with multi-monitor support (up to 4 screens)
- Full keyboard and mouse control
- File and folder transfer with progress bars
- Chat messaging with emoji and typing indicator
- System tray with minimize to tray
- Auto-start on Windows boot
- Permanent Machine IDs
- Accept/Deny access control
- Trusted machines list
- Master Console dashboard
- Node registration system
- Live alerts (Active/Idle/Online/Offline)
- Quick Connect from Master to Nodes
- Windows installer (.exe)

## Tech Stack

- **Electron** - Desktop app framework
- **Node.js** - Backend
- **WebRTC** - Screen streaming
- **Socket.io** - Real time communication
- **electron-builder** - Windows installer

## Project Structure

```
remotelink/
├── assets/              # App icons (icon.png, icon.ico)
├── scripts/             # Build scripts (generate-icon.js)
├── src/
│   ├── main/            # Electron main process
│   │   ├── main.js      # App entry point, window management, IPC handlers
│   │   └── preload.js   # Secure bridge between main and renderer
│   ├── renderer/        # Frontend UI
│   │   ├── index.html   # Main app shell
│   │   ├── styles/      # CSS stylesheets
│   │   └── scripts/     # Client-side JS (renderer.js, webrtc.js)
│   ├── server/          # Relay/signaling server (Socket.io)
│   ├── host/            # Host module (screen capture, input control)
│   ├── client/          # Client module
│   ├── console/         # Master Console manager
│   ├── transfer/        # File transfer module
│   ├── chat/            # Chat module
│   ├── security/        # Security/surveillance module
│   └── utils/           # Machine ID and config management
├── dist/                # Build output (installer .exe)
├── package.json
└── .gitignore
```

## Build Windows Installer

```bash
npm run build
```

This creates `dist/RemoteLink Setup 1.0.0.exe`.
