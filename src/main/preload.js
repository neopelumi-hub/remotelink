const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),

  // Session management
  startHosting: () => ipcRenderer.invoke('server:start-hosting'),
  joinSession: (sessionId) => ipcRenderer.invoke('server:join-session', sessionId),
  disconnectSession: () => ipcRenderer.send('server:disconnect'),

  // Machine ID & access control
  getMachineInfo: () => ipcRenderer.invoke('machine:get-info'),
  joinByMachineId: (targetMachineId) => ipcRenderer.invoke('machine:join-by-id', targetMachineId),
  respondToAccess: (data) => ipcRenderer.send('access:respond', data),
  getTrustedMachines: () => ipcRenderer.invoke('machine:get-trusted'),
  setMachineTrusted: (machineId, name, trusted) => ipcRenderer.invoke('machine:set-trusted', machineId, name, trusted),
  removeMachine: (machineId) => ipcRenderer.invoke('machine:remove', machineId),

  // Screen capture
  getScreenSources: () => ipcRenderer.invoke('screen:get-sources'),

  // WebRTC signaling
  sendWebRTCSignal: (type, payload) => ipcRenderer.send('webrtc:send-signal', { type, payload }),

  // Remote input control
  sendInputCommand: (data) => ipcRenderer.send('input:send-command', data),
  setActiveDisplay: (bounds) => ipcRenderer.send('input:set-active-display', bounds),

  // Chat
  sendChatMessage: (data) => ipcRenderer.send('chat:send-message', data),
  sendTypingIndicator: (data) => ipcRenderer.send('chat:send-typing', data),
  sendChatRead: (data) => ipcRenderer.send('chat:send-read', data),
  clearChat: () => ipcRenderer.send('chat:clear'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSetting: (key, value) => ipcRenderer.invoke('settings:update', key, value),

  // File transfer
  selectFiles: () => ipcRenderer.invoke('transfer:select-files'),
  selectFolder: () => ipcRenderer.invoke('transfer:select-folder'),
  sendTransferRequest: (data) => ipcRenderer.send('transfer:send-request', data),
  respondToTransfer: (data) => ipcRenderer.send('transfer:respond', data),
  cancelTransfer: (data) => ipcRenderer.send('transfer:cancel', data),
  openDownloadsFolder: () => ipcRenderer.send('transfer:open-downloads'),

  // Console management
  getConsoleConfig: () => ipcRenderer.invoke('console:get-config'),
  setupMaster: (password) => ipcRenderer.invoke('console:setup-master', password),
  verifyMasterPassword: (password) => ipcRenderer.invoke('console:verify-password', password),
  recoverMaster: (data) => ipcRenderer.invoke('console:recover-master', data),
  revokeMaster: () => ipcRenderer.send('console:revoke-master'),
  registerNode: (data) => ipcRenderer.invoke('console:register-node', data),
  unregisterNode: () => ipcRenderer.send('console:unregister-node'),
  getConsoleNodes: () => ipcRenderer.invoke('console:get-nodes'),
  quickConnectToNode: (machineId) => ipcRenderer.send('console:quick-connect', machineId),
  getConsoleAlerts: () => ipcRenderer.invoke('console:get-alerts'),
  dismissConsoleAlert: (id) => ipcRenderer.send('console:dismiss-alert', id),
  dismissAllConsoleAlerts: () => ipcRenderer.send('console:dismiss-all-alerts'),
  renameConsoleNode: (data) => ipcRenderer.send('console:rename-node', data),
  removeConsoleNode: (machineId) => ipcRenderer.send('console:remove-node', machineId),
  sendConsoleNotification: (data) => ipcRenderer.send('console:send-notification', data),
  requestNodeThumbnail: (machineId) => ipcRenderer.send('console:request-thumbnail', machineId),
  getSystemInfo: () => ipcRenderer.invoke('console:get-system-info'),
  setIdleTimeout: (minutes) => ipcRenderer.send('console:set-idle-timeout', minutes),

  // Session events from server
  onSessionEvent: (callback) => {
    ipcRenderer.on('server:session-event', (_event, data) => callback(data));
  },

  // Auto-updater — fired when a new version has been downloaded in the background
  onUpdateReady: (callback) => {
    ipcRenderer.on('updater:update-ready', (_event, data) => callback(data));
  },
});
