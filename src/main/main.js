const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3000';

let mainWindow;
let socket = null;
let inputController = null;
let activeDisplayBounds = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'RemoteLink',
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Window control handlers
ipcMain.on('window-minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.on('window-close', () => {
  mainWindow?.close();
});

// --- Signaling server connection ---

function connectSocket() {
  if (socket && socket.connected) return socket;

  socket = ioClient(SERVER_URL, {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 5000,
  });

  socket.on('connect', () => {
    mainWindow?.webContents.send('server:session-event', { type: 'connected' });
  });

  socket.on('disconnect', () => {
    mainWindow?.webContents.send('server:session-event', { type: 'disconnected' });
  });

  socket.on('connect_error', () => {
    mainWindow?.webContents.send('server:session-event', {
      type: 'error',
      message: 'Cannot reach the signaling server. Make sure it is running.',
    });
  });

  // Forward session events from server to renderer
  socket.on('host:client-joined', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'client-joined', ...data });
  });

  socket.on('session:host-disconnected', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'host-disconnected', ...data });
  });

  socket.on('session:client-disconnected', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'client-disconnected', ...data });
  });

  // Remote input commands from client (handled directly in main process)
  socket.on('input:command', (data) => {
    if (!inputController) {
      try {
        inputController = require('../host/input-controller');
      } catch (err) {
        console.error('[Main] Failed to load input controller:', err.message);
        return;
      }
    }
    inputController.handleCommand(data, activeDisplayBounds);
  });

  // Monitor switch request from client
  socket.on('monitor:switch-request', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'monitor-switch-request', ...data });
  });

  // WebRTC relay forwarding
  socket.on('webrtc:offer', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'webrtc-offer', ...data });
  });

  socket.on('webrtc:answer', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'webrtc-answer', ...data });
  });

  socket.on('webrtc:ice-candidate', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'webrtc-ice-candidate', ...data });
  });

  return socket;
}

// Host: create a session
ipcMain.handle('server:start-hosting', async () => {
  try {
    const sock = connectSocket();

    // Wait for connection if not already connected
    if (!sock.connected) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
        sock.once('connect', () => { clearTimeout(timeout); resolve(); });
        sock.once('connect_error', () => { clearTimeout(timeout); reject(new Error('Cannot reach server')); });
      });
    }

    // Request a session from the server
    return new Promise((resolve, reject) => {
      sock.emit('host:create-session', (response) => {
        if (response.sessionId) {
          resolve({ sessionId: response.sessionId });
        } else {
          reject(new Error('Failed to create session'));
        }
      });
    });
  } catch (err) {
    return { error: err.message };
  }
});

// Client: join a session
ipcMain.handle('server:join-session', async (_event, sessionId) => {
  try {
    const sock = connectSocket();

    if (!sock.connected) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
        sock.once('connect', () => { clearTimeout(timeout); resolve(); });
        sock.once('connect_error', () => { clearTimeout(timeout); reject(new Error('Cannot reach server')); });
      });
    }

    return new Promise((resolve) => {
      sock.emit('client:join-session', { sessionId }, (response) => {
        resolve(response);
      });
    });
  } catch (err) {
    return { error: err.message };
  }
});

// Screen capture: enumerate available screens (includes display bounds for input mapping)
ipcMain.handle('screen:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  const displays = screen.getAllDisplays();

  return sources.map((s) => {
    const display = displays.find(d => d.id.toString() === s.display_id);
    return {
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      display_id: s.display_id,
      bounds: display ? display.bounds : null,
    };
  });
});

// WebRTC signaling: forward signal from renderer to server
ipcMain.on('webrtc:send-signal', (_event, { type, payload }) => {
  console.log('[Main] webrtc:send-signal type:', type, 'payload keys:', Object.keys(payload));
  if (payload.sdp) {
    console.log('[Main]   sdp.type:', payload.sdp.type, 'sdp.sdp length:', payload.sdp.sdp?.length);
  }
  if (payload.candidate) {
    console.log('[Main]   candidate keys:', Object.keys(payload.candidate));
  }
  if (socket && socket.connected) {
    socket.emit(type, payload);
  } else {
    console.warn('[Main] Cannot send signal: socket not connected');
  }
});

// Remote input: client sends input commands to host via signaling
ipcMain.on('input:send-command', (_event, data) => {
  if (socket && socket.connected) {
    socket.emit('input:command', data);
  }
});

// Remote input: host sets which display is being shared (for coordinate mapping)
ipcMain.on('input:set-active-display', (_event, bounds) => {
  activeDisplayBounds = bounds;
  console.log('[Main] Active display bounds set:', bounds);
});

// Disconnect from server
ipcMain.on('server:disconnect', () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
});
