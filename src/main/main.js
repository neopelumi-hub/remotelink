const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const machineConfig = require('../utils/machine-id');

const SERVER_URL = 'http://localhost:3000';

let mainWindow;
let socket = null;
let inputController = null;
let activeDisplayBounds = null;
let userDataPath;
let config;

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

app.whenReady().then(() => {
  userDataPath = app.getPath('userData');
  config = machineConfig.getOrCreateConfig(userDataPath);
  console.log('[Main] Machine ID:', config.machineId);
  createWindow();
});

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
    // Register this machine with the server
    if (config) {
      socket.emit('register-machine', {
        machineId: config.machineId,
        machineName: config.machineName,
      });
    }
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

  // --- Access control events ---
  socket.on('access:request', (data) => {
    const { requestId, clientMachineId, clientMachineName } = data;
    // Check if client is in trusted list — auto-accept
    if (machineConfig.isTrusted(userDataPath, clientMachineId)) {
      socket.emit('access:response', { requestId, accepted: true, trusted: true });
      machineConfig.addConnectedMachine(userDataPath, clientMachineId, clientMachineName);
      mainWindow?.webContents.send('server:session-event', {
        type: 'access-auto-accepted',
        clientMachineName,
        clientMachineId,
      });
      console.log(`[Main] Auto-accepted trusted machine ${clientMachineId}`);
    } else {
      // Forward to renderer for user decision
      mainWindow?.webContents.send('server:session-event', {
        type: 'access-request',
        requestId,
        clientMachineId,
        clientMachineName,
      });
    }
  });

  socket.on('access:granted', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'access-granted', ...data });
  });

  socket.on('access:denied', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'access-denied', ...data });
  });

  socket.on('access:timeout', (data) => {
    mainWindow?.webContents.send('server:session-event', { type: 'access-timeout', ...data });
  });

  return socket;
}

// --- Machine info ---
ipcMain.handle('machine:get-info', () => ({
  machineId: config.machineId,
  machineName: config.machineName,
}));

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

// Client: join a session (by Session ID)
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

// Client: join by Machine ID (access control flow)
ipcMain.handle('machine:join-by-id', async (_event, targetMachineId) => {
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
      sock.emit('client:join-machine', {
        targetMachineId,
        clientMachineId: config.machineId,
        clientMachineName: config.machineName,
      }, (response) => {
        resolve(response);
      });
    });
  } catch (err) {
    return { error: err.message };
  }
});

// Host: respond to access request
ipcMain.on('access:respond', (_event, data) => {
  const { requestId, accepted, trusted, clientMachineId, clientMachineName } = data;
  if (socket && socket.connected) {
    socket.emit('access:response', { requestId, accepted, trusted });
  }
  if (accepted) {
    machineConfig.addConnectedMachine(userDataPath, clientMachineId, clientMachineName);
    if (trusted) {
      machineConfig.setTrusted(userDataPath, clientMachineId, clientMachineName, true);
    }
  }
});

// Trusted machines management
ipcMain.handle('machine:get-trusted', () => {
  const cfg = machineConfig.loadConfig(userDataPath) || config;
  return {
    trusted: cfg.trustedMachines || {},
    connected: cfg.connectedMachines || {},
  };
});

ipcMain.handle('machine:set-trusted', (_event, machineId, name, trusted) => {
  machineConfig.setTrusted(userDataPath, machineId, name, trusted);
  return { success: true };
});

ipcMain.handle('machine:remove', (_event, machineId) => {
  machineConfig.removeMachine(userDataPath, machineId);
  return { success: true };
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
