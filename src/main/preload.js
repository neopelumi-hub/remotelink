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

  // File transfer
  selectFiles: () => ipcRenderer.invoke('transfer:select-files'),
  selectFolder: () => ipcRenderer.invoke('transfer:select-folder'),
  sendTransferRequest: (data) => ipcRenderer.send('transfer:send-request', data),
  respondToTransfer: (data) => ipcRenderer.send('transfer:respond', data),
  cancelTransfer: (data) => ipcRenderer.send('transfer:cancel', data),
  openDownloadsFolder: () => ipcRenderer.send('transfer:open-downloads'),

  // Session events from server
  onSessionEvent: (callback) => {
    ipcRenderer.on('server:session-event', (_event, data) => callback(data));
  },
});
