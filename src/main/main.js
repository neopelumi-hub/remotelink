const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { io: ioClient } = require('socket.io-client');
const machineConfig = require('../utils/machine-id');
const { FileTransferManager } = require('../transfer/file-transfer');
const { ChatManager } = require('../chat/index');

const SERVER_URL = 'http://localhost:3000';
const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REGISTRY_NAME = 'RemoteLink';

let mainWindow;
let tray = null;
let socket = null;
let inputController = null;
let activeDisplayBounds = null;
let userDataPath;
let config;
let isQuitting = false;
let wasHosting = false; // Track hosting state for auto-reconnect
let lastSessionId = null;

const transferManager = new FileTransferManager();
const progressThrottles = new Map(); // transferId -> last send time
const chatManager = new ChatManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'RemoteLink',
    frame: false,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    const settings = machineConfig.getSettings(userDataPath);
    const launchedSilent = process.argv.includes('--silent');
    if (launchedSilent && settings.startMinimized) {
      // Don't show window — it stays in tray
    } else {
      mainWindow.show();
    }
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  userDataPath = app.getPath('userData');
  config = machineConfig.getOrCreateConfig(userDataPath);
  console.log('[Main] Machine ID:', config.machineId);

  createTray();
  createWindow();

  // Apply auto-start setting on first run
  const settings = machineConfig.getSettings(userDataPath);
  applyAutoStart(settings.startWithWindows);
});

app.on('window-all-closed', () => {
  // Don't quit — app lives in tray
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
  mainWindow?.close(); // Will minimize to tray due to close handler
});

// --- Signaling server connection ---

function connectSocket() {
  if (socket && socket.connected) return socket;

  socket = ioClient(SERVER_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 5000,
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

    // Auto-resume hosting after reconnection
    if (wasHosting) {
      console.log('[Main] Reconnected — auto-resuming hosting...');
      socket.emit('host:create-session', (response) => {
        if (response.sessionId) {
          lastSessionId = response.sessionId;
          mainWindow?.webContents.send('server:session-event', {
            type: 'hosting-resumed',
            sessionId: response.sessionId,
          });
          const settings = machineConfig.getSettings(userDataPath);
          if (settings.showNotifications && tray) {
            tray.displayBalloon({
              title: 'RemoteLink',
              content: 'Reconnected — hosting resumed.',
            });
          }
        }
      });
    }

    updateTrayMenu();
  });

  socket.on('disconnect', () => {
    mainWindow?.webContents.send('server:session-event', { type: 'disconnected' });
    mainWindow?.webContents.send('server:session-event', { type: 'reconnecting' });
    updateTrayMenu();
  });

  socket.on('reconnect_attempt', (attempt) => {
    mainWindow?.webContents.send('server:session-event', {
      type: 'reconnecting',
      attempt,
    });
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

  // --- File transfer socket listeners ---
  socket.on('transfer:request', (data) => {
    const { transferId } = data;
    transferManager.incoming.set(transferId, {
      ...data,
      status: 'pending',
      bytesReceived: 0,
      filesReceived: 0,
      savePath: transferManager.getDownloadsPath(),
      currentStream: null,
      currentFile: null,
    });
    mainWindow?.webContents.send('server:session-event', { type: 'transfer-request', ...data });
  });

  socket.on('transfer:accepted', (data) => {
    const { transferId } = data;
    const outgoing = transferManager.outgoing.get(transferId);
    if (outgoing) {
      outgoing.status = 'sending';
      mainWindow?.webContents.send('server:session-event', { type: 'transfer-accepted', transferId });
      transferManager.startSending(transferId, socket, (progress) => {
        const now = Date.now();
        const lastSent = progressThrottles.get(transferId) || 0;
        if (now - lastSent >= 100) {
          progressThrottles.set(transferId, now);
          mainWindow?.webContents.send('server:session-event', {
            type: 'transfer-progress',
            transferId,
            bytesSent: progress.bytesSent,
            totalSize: progress.totalSize,
            currentFile: progress.currentFile,
            direction: 'outgoing',
          });
        }
      }).catch(err => {
        console.error('[Main] Transfer send error:', err.message);
        mainWindow?.webContents.send('server:session-event', {
          type: 'transfer-error',
          transferId,
          message: err.message,
        });
      });
    }
  });

  socket.on('transfer:denied', (data) => {
    const { transferId } = data;
    const outgoing = transferManager.outgoing.get(transferId);
    if (outgoing) outgoing.status = 'cancelled';
    mainWindow?.webContents.send('server:session-event', { type: 'transfer-denied', transferId });
  });

  socket.on('transfer:file-start', (data) => {
    transferManager.handleFileStart(data.transferId, data);
  });

  socket.on('transfer:chunk', (data) => {
    transferManager.handleChunk(data.transferId, data);
    const transfer = transferManager.incoming.get(data.transferId);
    if (transfer) {
      const now = Date.now();
      const lastSent = progressThrottles.get(data.transferId) || 0;
      if (now - lastSent >= 100) {
        progressThrottles.set(data.transferId, now);
        mainWindow?.webContents.send('server:session-event', {
          type: 'transfer-progress',
          transferId: data.transferId,
          bytesReceived: transfer.bytesReceived,
          totalSize: transfer.totalSize,
          currentFile: transfer.currentFile,
          direction: 'incoming',
        });
      }
    }
  });

  socket.on('transfer:file-end', (data) => {
    transferManager.handleFileEnd(data.transferId, data);
  });

  socket.on('transfer:empty-dirs', (data) => {
    transferManager.handleEmptyDirs(data.transferId, data);
  });

  socket.on('transfer:complete', (data) => {
    transferManager.handleComplete(data.transferId);
    mainWindow?.webContents.send('server:session-event', {
      type: 'transfer-complete',
      transferId: data.transferId,
    });
  });

  socket.on('transfer:cancel', (data) => {
    transferManager.handleRemoteCancel(data.transferId);
    mainWindow?.webContents.send('server:session-event', {
      type: 'transfer-cancelled',
      transferId: data.transferId,
    });
  });

  socket.on('transfer:error', (data) => {
    mainWindow?.webContents.send('server:session-event', {
      type: 'transfer-error',
      transferId: data.transferId,
      message: data.message,
    });
  });

  // --- Chat socket listeners ---
  socket.on('chat:message', (data) => {
    const msg = chatManager.addIncoming(data);
    // Send delivery receipt back
    if (socket.connected) {
      socket.emit('chat:delivered', { messageId: data.id });
    }
    mainWindow?.webContents.send('server:session-event', {
      type: 'chat-message',
      ...msg,
    });
  });

  socket.on('chat:delivered', (data) => {
    chatManager.markDelivered(data.messageId);
    mainWindow?.webContents.send('server:session-event', {
      type: 'chat-delivered',
      messageId: data.messageId,
    });
  });

  socket.on('chat:read', (data) => {
    chatManager.markRead(data.messageId);
    mainWindow?.webContents.send('server:session-event', {
      type: 'chat-read',
      messageId: data.messageId,
    });
  });

  socket.on('chat:typing', (data) => {
    mainWindow?.webContents.send('server:session-event', {
      type: 'chat-typing',
      typing: data.typing,
    });
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
          wasHosting = true;
          lastSessionId = response.sessionId;
          updateTrayMenu();
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

// --- File transfer IPC handlers ---
ipcMain.handle('transfer:select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const transfers = [];
  for (const filePath of result.filePaths) {
    const transferId = crypto.randomBytes(8).toString('hex');
    const scanned = await transferManager.scanPath(filePath);
    transferManager.outgoing.set(transferId, {
      transferId,
      ...scanned,
      status: 'pending',
      bytesSent: 0,
    });
    transfers.push({ transferId, ...scanned });
  }
  return transfers;
});

ipcMain.handle('transfer:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const transferId = crypto.randomBytes(8).toString('hex');
  const scanned = await transferManager.scanPath(result.filePaths[0]);
  transferManager.outgoing.set(transferId, {
    transferId,
    ...scanned,
    status: 'pending',
    bytesSent: 0,
  });
  return [{ transferId, ...scanned }];
});

ipcMain.on('transfer:send-request', (_event, data) => {
  if (socket && socket.connected) {
    socket.emit('transfer:request', data);
  }
});

ipcMain.on('transfer:respond', (_event, data) => {
  if (socket && socket.connected) {
    const eventName = data.accepted ? 'transfer:accepted' : 'transfer:denied';
    socket.emit(eventName, { transferId: data.transferId });
  }
});

ipcMain.on('transfer:cancel', (_event, data) => {
  transferManager.cancelTransfer(data.transferId, socket);
});

ipcMain.on('transfer:open-downloads', () => {
  shell.openPath(transferManager.getDownloadsPath());
});

// --- Chat IPC handlers ---
ipcMain.on('chat:send-message', (_event, data) => {
  const msg = chatManager.addOutgoing(data.id, data.text, data.senderName);
  if (socket && socket.connected) {
    socket.emit('chat:message', {
      id: data.id,
      text: data.text,
      senderName: data.senderName,
      timestamp: msg.timestamp,
    });
  }
});

ipcMain.on('chat:send-typing', (_event, data) => {
  if (socket && socket.connected) {
    socket.emit('chat:typing', { typing: data.typing });
  }
});

ipcMain.on('chat:send-read', (_event, data) => {
  chatManager.markAllIncomingRead();
  if (socket && socket.connected) {
    socket.emit('chat:read', { messageId: data.messageId });
  }
});

ipcMain.on('chat:clear', () => {
  chatManager.clear();
});

// Disconnect from server
ipcMain.on('server:disconnect', () => {
  wasHosting = false;
  lastSessionId = null;
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  updateTrayMenu();
});

// =============================================
// System Tray
// =============================================

// --- PNG helper: CRC32 for PNG chunk checksums ---
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createTrayIcon() {
  // Build a 16x16 RGBA PNG in memory (blue monitor icon)
  const size = 16;
  const rowBytes = 1 + size * 4; // filter byte + RGBA per pixel
  const rawData = Buffer.alloc(rowBytes * size);

  for (let y = 0; y < size; y++) {
    const rowOff = y * rowBytes;
    rawData[rowOff] = 0; // PNG row filter: None
    for (let x = 0; x < size; x++) {
      const off = rowOff + 1 + x * 4;
      const inMonitor = y >= 2 && y <= 10 && x >= 1 && x <= 14;
      const inScreen  = y >= 4 && y <= 8  && x >= 3 && x <= 12;
      const inStand   = (y === 12 && x >= 6 && x <= 9) ||
                         (y === 13 && x >= 5 && x <= 10);

      if (inScreen) {
        // Dark screen interior
        rawData[off]     = 13;  // R
        rawData[off + 1] = 17;  // G
        rawData[off + 2] = 23;  // B
        rawData[off + 3] = 255; // A
      } else if (inMonitor || inStand) {
        // Blue frame & stand (#3b82f6)
        rawData[off]     = 59;  // R
        rawData[off + 1] = 130; // G
        rawData[off + 2] = 246; // B
        rawData[off + 3] = 255; // A
      }
      // else: stays 0,0,0,0 (transparent)
    }
  }

  const compressed = zlib.deflateSync(rawData);

  // IHDR: width, height, bitDepth=8, colorType=6 (RGBA), compress=0, filter=0, interlace=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  console.log('[Main] Tray icon PNG generated:', png.length, 'bytes');
  return nativeImage.createFromBuffer(png);
}

function createTray() {
  console.log('[Main] Creating system tray...');
  const icon = createTrayIcon();

  if (icon.isEmpty()) {
    console.error('[Main] ERROR: Tray icon image is empty! Tray will not appear.');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip('RemoteLink');
  console.log('[Main] System tray created successfully');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const isConnected = socket && socket.connected;
  const hostingLabel = wasHosting
    ? `Hosting: ${lastSessionId || 'Active'}`
    : 'Not hosting';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open RemoteLink',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: wasHosting ? 'Stop Hosting' : 'Start Hosting',
      click: async () => {
        if (wasHosting) {
          wasHosting = false;
          lastSessionId = null;
          if (socket) {
            socket.disconnect();
            socket = null;
          }
          mainWindow?.webContents.send('server:session-event', { type: 'hosting-stopped' });
          updateTrayMenu();
        } else {
          // Start hosting from tray
          try {
            const sock = connectSocket();
            if (!sock.connected) {
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
                sock.once('connect', () => { clearTimeout(timeout); resolve(); });
                sock.once('connect_error', () => { clearTimeout(timeout); reject(new Error('Cannot reach server')); });
              });
            }
            sock.emit('host:create-session', (response) => {
              if (response.sessionId) {
                wasHosting = true;
                lastSessionId = response.sessionId;
                mainWindow?.webContents.send('server:session-event', {
                  type: 'hosting-started',
                  sessionId: response.sessionId,
                });
                updateTrayMenu();
              }
            });
          } catch (err) {
            console.error('[Main] Tray start hosting error:', err.message);
          }
        }
      },
    },
    {
      label: `Status: ${isConnected ? 'Connected' : 'Disconnected'}`,
      enabled: false,
    },
    {
      label: hostingLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        if (socket) {
          socket.disconnect();
          socket = null;
        }
        if (tray) {
          tray.destroy();
          tray = null;
        }
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// =============================================
// Auto-Start (Windows Registry)
// =============================================

function applyAutoStart(enabled) {
  try {
    if (enabled) {
      const exePath = process.execPath;
      const args = '--silent';
      execSync(`reg add "${REGISTRY_KEY}" /v "${REGISTRY_NAME}" /t REG_SZ /d "\\"${exePath}\\" ${args}" /f`, { stdio: 'ignore' });
      console.log('[Main] Auto-start enabled');
    } else {
      execSync(`reg delete "${REGISTRY_KEY}" /v "${REGISTRY_NAME}" /f`, { stdio: 'ignore' });
      console.log('[Main] Auto-start disabled');
    }
  } catch (err) {
    // Ignore errors (e.g. key doesn't exist when disabling)
    console.log('[Main] Auto-start registry update:', err.message);
  }
}

function getAutoStartEnabled() {
  try {
    const output = execSync(`reg query "${REGISTRY_KEY}" /v "${REGISTRY_NAME}"`, { encoding: 'utf-8' });
    return output.includes(REGISTRY_NAME);
  } catch {
    return false;
  }
}

// =============================================
// Settings IPC handlers
// =============================================

ipcMain.handle('settings:get', () => {
  return machineConfig.getSettings(userDataPath);
});

ipcMain.handle('settings:update', (_event, key, value) => {
  const settings = machineConfig.updateSetting(userDataPath, key, value);

  // Apply side effects
  if (key === 'startWithWindows') {
    applyAutoStart(value);
  }

  return settings;
});
