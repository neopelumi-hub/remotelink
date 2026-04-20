// =============================================
// RemoteLink - Renderer Process
// =============================================

// --- State ---
let isHosting = false;
let isJoined = false;
let webrtcManager = null;
let screenSources = [];
let currentMonitorIndex = 0;

// --- File transfer state ---
const activeTransfers = new Map();
let pendingTransferRequest = null;
const transferRafPending = new Set();

// --- Remote control state ---
let controlActive = false;
let lastMouseMoveTime = 0;
const MOUSE_THROTTLE_MS = 16; // ~60fps cap

// --- Connection mode state ---
let connectionMode = 'session'; // 'session' or 'machine'
let currentAccessRequest = null;
let accessTimerInterval = null;
let accessCountdown = 30;

// --- DOM Elements ---
const statusDot = document.querySelector('.status-dot');
const statusLabel = document.querySelector('.sidebar-footer .sidebar-label');
const idValueEl = document.querySelector('.id-value');
const hostBtn = document.querySelector('.btn-host');
const joinBtn = document.querySelector('.btn-join');
const joinInput = document.querySelector('.card-input');
const joinError = document.getElementById('join-error');

// --- Window controls ---
document.getElementById('btn-minimize').addEventListener('click', () => {
  window.electronAPI.minimizeWindow();
});

document.getElementById('btn-maximize').addEventListener('click', () => {
  window.electronAPI.maximizeWindow();
});

document.getElementById('btn-close').addEventListener('click', () => {
  window.electronAPI.closeWindow();
});

// --- Sidebar navigation ---
const sidebarButtons = document.querySelectorAll('.sidebar-btn');
const pages = document.querySelectorAll('.page');

sidebarButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetPage = btn.dataset.page;
    sidebarButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pages.forEach(page => page.classList.remove('active'));
    document.getElementById(`page-${targetPage}`).classList.add('active');

    // Load settings data when navigating to settings page
    if (targetPage === 'settings') {
      renderSettingsPage();
    }
  });
});

// --- Page navigation (programmatic) ---
function navigateToPage(pageId) {
  sidebarButtons.forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.sidebar-btn[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
  pages.forEach(page => page.classList.remove('active'));
  document.getElementById(`page-${pageId}`).classList.add('active');
}

// --- Status helpers ---
function setStatus(online) {
  statusDot.classList.toggle('offline', !online);
  statusDot.classList.toggle('online', online);
  statusLabel.textContent = online ? 'Online' : 'Offline';
}

function showError(message) {
  joinError.textContent = message;
  joinError.classList.add('visible');
  setTimeout(() => {
    joinError.classList.remove('visible');
  }, 5000);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// =============================================
// Machine ID display
// =============================================

async function initMachineInfo() {
  try {
    const info = await window.electronAPI.getMachineInfo();
    document.getElementById('machine-id-display').textContent = info.machineId;
    document.getElementById('settings-machine-id').textContent = info.machineId;
    document.getElementById('settings-machine-name').textContent = info.machineName;
  } catch (err) {
    console.error('[Renderer] Failed to get machine info:', err);
  }
}

// =============================================
// Connection Mode Toggle
// =============================================

const modeButtons = document.querySelectorAll('.mode-btn');
modeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode === connectionMode) return;

    connectionMode = mode;
    modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

    // Update input field
    joinInput.value = '';
    joinError.classList.remove('visible');

    if (mode === 'machine') {
      joinInput.placeholder = 'XXXX-XXXX-XXXX';
      joinInput.maxLength = 14;
    } else {
      joinInput.placeholder = 'Enter session ID';
      joinInput.maxLength = 6;
    }
  });
});

// --- Host Session ---
hostBtn.addEventListener('click', async () => {
  if (isHosting) {
    // Stop hosting
    if (webrtcManager) {
      webrtcManager.destroy();
      webrtcManager = null;
    }
    hideMonitorPanel();
    window.electronAPI.disconnectSession();
    isHosting = false;
    idValueEl.textContent = '— — —';
    hostBtn.textContent = 'Start Hosting';
    hostBtn.classList.remove('btn-danger');
    hostBtn.classList.add('btn-primary');
    setStatus(false);
    showToast('Hosting stopped', 'info');
    return;
  }

  hostBtn.disabled = true;
  hostBtn.textContent = 'Connecting...';

  const result = await window.electronAPI.startHosting();

  if (result.error) {
    hostBtn.disabled = false;
    hostBtn.textContent = 'Start Hosting';
    showToast(result.error, 'error');
    return;
  }

  isHosting = true;
  idValueEl.textContent = result.sessionId;
  hostBtn.disabled = false;
  hostBtn.textContent = 'Stop Hosting';
  hostBtn.classList.remove('btn-primary');
  hostBtn.classList.add('btn-danger');
  setStatus(true);
  showToast('Session started — share your ID', 'success');
});

// --- Join Session ---
joinBtn.addEventListener('click', async () => {
  const inputValue = joinInput.value.trim().toUpperCase();

  if (!inputValue) {
    showError(connectionMode === 'machine' ? 'Please enter a Machine ID.' : 'Please enter a Session ID.');
    return;
  }

  if (connectionMode === 'session') {
    // --- Session ID mode (existing flow) ---
    if (inputValue.length < 6) {
      showError('Session ID must be 6 characters.');
      return;
    }

    joinError.classList.remove('visible');
    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting...';

    const result = await window.electronAPI.joinSession(inputValue);

    joinBtn.disabled = false;

    if (result.error) {
      joinBtn.textContent = 'Connect';
      showError(result.error);
      return;
    }

    isJoined = true;
    joinBtn.textContent = 'Connected';
    joinBtn.classList.remove('btn-success');
    joinBtn.classList.add('btn-joined');
    setStatus(true);
    setTransferButtonsEnabled(true);
    showToast('Connected to session ' + result.sessionId, 'success');
  } else {
    // --- Machine ID mode (access control flow) ---
    const machineId = inputValue.replace(/[^A-Z0-9]/g, '');
    if (machineId.length !== 12) {
      showError('Enter a valid Machine ID (XXXX-XXXX-XXXX).');
      return;
    }

    const formatted = `${machineId.slice(0, 4)}-${machineId.slice(4, 8)}-${machineId.slice(8, 12)}`;

    joinError.classList.remove('visible');
    joinBtn.disabled = true;
    joinBtn.textContent = 'Requesting access...';

    const result = await window.electronAPI.joinByMachineId(formatted);

    if (result.error) {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Connect';
      showError(result.error);
      return;
    }

    // Pending — waiting for host to accept/deny
    // Button stays disabled with "Requesting access..." text
    // Will be updated by access-granted or access-denied events
  }
});

// Auto-format input based on connection mode
joinInput.addEventListener('input', () => {
  if (connectionMode === 'machine') {
    // Auto-format: XXXX-XXXX-XXXX
    let val = joinInput.value.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 12);
    let formatted = '';
    for (let i = 0; i < val.length; i++) {
      if (i > 0 && i % 4 === 0) formatted += '-';
      formatted += val[i];
    }
    joinInput.value = formatted;
  } else {
    joinInput.value = joinInput.value.toUpperCase();
  }
  joinError.classList.remove('visible');
});

// =============================================
// Host Monitor Panel
// =============================================

async function loadScreenSources() {
  screenSources = await window.electronAPI.getScreenSources();
  return screenSources;
}

function renderMonitorPanel() {
  const panel = document.getElementById('host-monitors');
  const grid = document.getElementById('monitors-grid');
  grid.innerHTML = '';

  screenSources.forEach((source, index) => {
    const card = document.createElement('div');
    card.className = 'monitor-card' + (index === currentMonitorIndex ? ' active' : '');
    card.innerHTML = `
      <img class="monitor-thumbnail" src="${source.thumbnail}" alt="${source.name}">
      <span class="monitor-label">${source.name}</span>
    `;
    card.addEventListener('click', () => handleMonitorSelect(index));
    grid.appendChild(card);
  });

  panel.style.display = '';
}

function hideMonitorPanel() {
  document.getElementById('host-monitors').style.display = 'none';
  document.getElementById('monitors-grid').innerHTML = '';
  screenSources = [];
  currentMonitorIndex = 0;
}

async function handleMonitorSelect(index) {
  if (index === currentMonitorIndex || !screenSources[index]) return;
  currentMonitorIndex = index;

  try {
    await webrtcManager.switchMonitor(screenSources[index].id);

    // Update host display bounds for input mapping
    if (screenSources[index].bounds) {
      window.electronAPI.setActiveDisplay(screenSources[index].bounds);
    }

    // Update active card
    document.querySelectorAll('.monitor-card').forEach((card, i) => {
      card.classList.toggle('active', i === index);
    });

    showToast(`Switched to ${screenSources[index].name}`, 'info');
  } catch (err) {
    showToast('Failed to switch monitor: ' + err.message, 'error');
  }
}

// =============================================
// Client Viewer
// =============================================

function showViewer() {
  navigateToPage('viewer');
  document.getElementById('viewer-loading').style.display = '';
  document.getElementById('viewer-status').textContent = 'Connecting...';
}

function hideViewer() {
  disableControl();
  const video = document.getElementById('remote-video');
  video.srcObject = null;
  document.getElementById('viewer-loading').style.display = '';
  document.getElementById('monitor-tabs').innerHTML = '';
  navigateToPage('home');
}

function displayRemoteStream(stream) {
  const video = document.getElementById('remote-video');
  video.srcObject = stream;
  document.getElementById('viewer-loading').style.display = 'none';
  document.getElementById('viewer-status').textContent = 'Connected';
}

function renderMonitorTabs(sources) {
  const tabs = document.getElementById('monitor-tabs');
  tabs.innerHTML = '';

  if (!sources || sources.length <= 1) return;

  sources.forEach((source, index) => {
    const tab = document.createElement('button');
    tab.className = 'monitor-tab' + (index === 0 ? ' active' : '');
    tab.textContent = source.name;
    tab.addEventListener('click', () => {
      // Send switch request to host via signaling
      window.electronAPI.sendWebRTCSignal('monitor:switch-request', { index });
      tabs.querySelectorAll('.monitor-tab').forEach((t, i) => {
        t.classList.toggle('active', i === index);
      });
    });
    tabs.appendChild(tab);
  });
}

// =============================================
// Remote Control — Input Capture
// =============================================

function enableControl() {
  controlActive = true;
  const video = document.getElementById('remote-video');
  const viewport = document.querySelector('.viewer-viewport');
  viewport.classList.add('control-active');
  document.getElementById('control-btn').textContent = 'Release Control';
  document.getElementById('control-btn').classList.add('active');
  document.getElementById('control-indicator').classList.add('visible');
  video.style.cursor = 'none';
  showToast('Remote control active — press Esc to release', 'info');
}

function disableControl() {
  if (!controlActive) return;
  controlActive = false;

  // Release any potentially stuck modifier keys on the host
  ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
   'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].forEach(code => {
    window.electronAPI.sendInputCommand({ type: 'key-up', code });
  });

  const video = document.getElementById('remote-video');
  const viewport = document.querySelector('.viewer-viewport');
  viewport.classList.remove('control-active');
  document.getElementById('control-btn').textContent = 'Take Control';
  document.getElementById('control-btn').classList.remove('active');
  document.getElementById('control-indicator').classList.remove('visible');
  video.style.cursor = '';
}

function toggleControl() {
  if (controlActive) {
    disableControl();
  } else {
    enableControl();
  }
}

// Compute normalized coordinates (0-1) accounting for object-fit: contain letterboxing
function getScaledCoords(e) {
  const video = document.getElementById('remote-video');
  const rect = video.getBoundingClientRect();

  if (!video.videoWidth || !video.videoHeight) {
    return { x: 0, y: 0, inBounds: false };
  }

  const videoAspect = video.videoWidth / video.videoHeight;
  const elementAspect = rect.width / rect.height;

  let renderW, renderH, offsetX, offsetY;

  if (videoAspect > elementAspect) {
    // Video wider than element — letterbox top/bottom
    renderW = rect.width;
    renderH = rect.width / videoAspect;
    offsetX = 0;
    offsetY = (rect.height - renderH) / 2;
  } else {
    // Video taller than element — letterbox left/right
    renderH = rect.height;
    renderW = rect.height * videoAspect;
    offsetX = (rect.width - renderW) / 2;
    offsetY = 0;
  }

  const relX = (e.clientX - rect.left - offsetX) / renderW;
  const relY = (e.clientY - rect.top - offsetY) / renderH;

  const x = Math.max(0, Math.min(1, relX));
  const y = Math.max(0, Math.min(1, relY));

  // Check if click is within the actual video area (not letterbox)
  const inBounds = relX >= 0 && relX <= 1 && relY >= 0 && relY <= 1;

  return { x, y, inBounds };
}

// --- Control toggle button ---
document.getElementById('control-btn').addEventListener('click', toggleControl);

// --- Mouse event listeners on the video element ---
const remoteVideo = document.getElementById('remote-video');

remoteVideo.addEventListener('mousemove', (e) => {
  if (!controlActive) return;
  const now = Date.now();
  if (now - lastMouseMoveTime < MOUSE_THROTTLE_MS) return;
  lastMouseMoveTime = now;

  const coords = getScaledCoords(e);
  if (!coords.inBounds) return;

  window.electronAPI.sendInputCommand({
    type: 'mouse-move',
    x: coords.x,
    y: coords.y,
  });
});

remoteVideo.addEventListener('mousedown', (e) => {
  if (!controlActive) return;
  e.preventDefault();
  const button = ['left', 'middle', 'right'][e.button] || 'left';
  const coords = getScaledCoords(e);

  window.electronAPI.sendInputCommand({
    type: 'mouse-down',
    button,
    x: coords.x,
    y: coords.y,
  });
});

remoteVideo.addEventListener('mouseup', (e) => {
  if (!controlActive) return;
  e.preventDefault();
  const button = ['left', 'middle', 'right'][e.button] || 'left';

  window.electronAPI.sendInputCommand({
    type: 'mouse-up',
    button,
  });
});

remoteVideo.addEventListener('wheel', (e) => {
  if (!controlActive) return;
  e.preventDefault();

  window.electronAPI.sendInputCommand({
    type: 'mouse-scroll',
    deltaX: e.deltaX,
    deltaY: e.deltaY,
  });
}, { passive: false });

remoteVideo.addEventListener('contextmenu', (e) => {
  if (controlActive) e.preventDefault();
});

// Double-click on video to enter control mode (convenience shortcut)
remoteVideo.addEventListener('dblclick', (e) => {
  if (!controlActive && isJoined) {
    e.preventDefault();
    enableControl();
  }
});

// --- Keyboard event listeners ---
document.addEventListener('keydown', (e) => {
  if (!controlActive) return;

  // Escape releases control
  if (e.code === 'Escape') {
    disableControl();
    return;
  }

  // Ctrl+Alt+Delete cannot be simulated from user-mode apps
  if (e.ctrlKey && e.altKey && e.code === 'Delete') {
    showToast('Ctrl+Alt+Delete cannot be sent remotely', 'info');
    e.preventDefault();
    return;
  }

  e.preventDefault();
  window.electronAPI.sendInputCommand({
    type: 'key-down',
    code: e.code,
    key: e.key,
  });
});

document.addEventListener('keyup', (e) => {
  if (!controlActive) return;
  e.preventDefault();

  window.electronAPI.sendInputCommand({
    type: 'key-up',
    code: e.code,
    key: e.key,
  });
});

// =============================================
// Access Request Modal (Host side)
// =============================================

function showAccessModal(requestId, clientName, clientId) {
  currentAccessRequest = { requestId, clientMachineId: clientId, clientMachineName: clientName };

  document.getElementById('access-client-name').textContent = clientName;
  document.getElementById('access-client-id').textContent = clientId;
  document.getElementById('access-modal').style.display = '';

  // Start countdown timer
  accessCountdown = 30;
  const timerBar = document.getElementById('timer-bar');
  const timerText = document.getElementById('timer-text');
  timerBar.style.width = '100%';
  timerText.textContent = '30s';

  if (accessTimerInterval) clearInterval(accessTimerInterval);
  accessTimerInterval = setInterval(() => {
    accessCountdown--;
    timerBar.style.width = `${(accessCountdown / 30) * 100}%`;
    timerText.textContent = `${accessCountdown}s`;
    if (accessCountdown <= 0) {
      clearInterval(accessTimerInterval);
      accessTimerInterval = null;
      hideAccessModal();
    }
  }, 1000);
}

function hideAccessModal() {
  document.getElementById('access-modal').style.display = 'none';
  if (accessTimerInterval) {
    clearInterval(accessTimerInterval);
    accessTimerInterval = null;
  }
  currentAccessRequest = null;
}

function respondToAccess(accepted, trusted) {
  if (!currentAccessRequest) return;
  window.electronAPI.respondToAccess({
    requestId: currentAccessRequest.requestId,
    accepted,
    trusted: !!trusted,
    clientMachineId: currentAccessRequest.clientMachineId,
    clientMachineName: currentAccessRequest.clientMachineName,
  });
  hideAccessModal();

  if (accepted) {
    showToast(`Access granted to ${currentAccessRequest.clientMachineName}`, 'success');
  } else {
    showToast('Access denied', 'info');
  }
}

// Access modal button handlers
document.getElementById('access-deny').addEventListener('click', () => respondToAccess(false, false));
document.getElementById('access-accept').addEventListener('click', () => respondToAccess(true, false));
document.getElementById('access-trust').addEventListener('click', () => respondToAccess(true, true));

// =============================================
// Settings Page
// =============================================

async function renderSettingsPage() {
  try {
    const info = await window.electronAPI.getMachineInfo();
    document.getElementById('settings-machine-id').textContent = info.machineId;
    document.getElementById('settings-machine-name').textContent = info.machineName;

    const result = await window.electronAPI.getTrustedMachines();
    const trusted = result.trusted || {};
    const entries = Object.entries(trusted);
    const list = document.getElementById('trusted-machines-list');

    if (entries.length === 0) {
      list.innerHTML = '<div class="machines-empty">No trusted machines yet.</div>';
      return;
    }

    list.innerHTML = '';
    entries.forEach(([id, info]) => {
      const item = document.createElement('div');
      item.className = 'machine-item';
      item.innerHTML = `
        <div class="machine-info">
          <span class="machine-name">${escapeHtml(info.name)}</span>
          <span class="machine-id-small">${escapeHtml(id)}</span>
        </div>
        <button class="btn-remove">Remove</button>
      `;
      item.querySelector('.btn-remove').addEventListener('click', async () => {
        await window.electronAPI.removeMachine(id);
        renderSettingsPage();
        showToast(`Removed ${info.name} from trusted list`, 'info');
      });
      list.appendChild(item);
    });
  } catch (err) {
    console.error('[Renderer] Failed to render settings:', err);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================
// WebRTC Initialization
// =============================================

async function initHostWebRTC() {
  try {
    await loadScreenSources();
    if (screenSources.length === 0) {
      showToast('No screens found to share', 'error');
      return;
    }

    currentMonitorIndex = 0;
    renderMonitorPanel();

    // Tell the main process which display is active (for input coordinate mapping)
    if (screenSources[0].bounds) {
      window.electronAPI.setActiveDisplay(screenSources[0].bounds);
    }

    webrtcManager = new WebRTCManager();
    webrtcManager.createPeerConnection();

    webrtcManager.onConnectionStateChange = (state) => {
      if (state === 'disconnected' || state === 'failed') {
        showToast('WebRTC connection lost', 'error');
      }
    };

    await webrtcManager.startScreenCapture(screenSources[0].id);

    // Build monitor info to send with the offer
    const monitorInfo = screenSources.map((s) => ({ name: s.name, id: s.id }));
    await webrtcManager.createAndSendOffer(monitorInfo);
  } catch (err) {
    showToast('Screen capture failed: ' + err.message, 'error');
  }
}

function initClientWebRTC() {
  webrtcManager = new WebRTCManager();
  webrtcManager.createPeerConnection();

  webrtcManager.onRemoteStream = (stream) => {
    displayRemoteStream(stream);
  };

  webrtcManager.onConnectionStateChange = (state) => {
    const statusEl = document.getElementById('viewer-status');
    if (state === 'connected') {
      statusEl.textContent = 'Connected';
    } else if (state === 'disconnected' || state === 'failed') {
      statusEl.textContent = 'Disconnected';
      disableControl();
      showToast('Connection to host lost', 'error');
    }
  };
}

function cleanupWebRTC() {
  disableControl();
  if (webrtcManager) {
    webrtcManager.destroy();
    webrtcManager = null;
  }
}

// =============================================
// Server events
// =============================================
window.electronAPI.onSessionEvent((event) => {
  switch (event.type) {
    case 'client-joined':
      console.log('[Renderer] Client joined, isHosting:', isHosting);
      showToast('A client has connected to your session', 'success');
      setTransferButtonsEnabled(true);
      if (isHosting) {
        initHostWebRTC();
      }
      break;

    case 'webrtc-offer':
      console.log('[Renderer] Received WebRTC offer, sdp type:', event.sdp?.type, 'sdp length:', event.sdp?.sdp?.length);
      if (isJoined) {
        showViewer();
        initClientWebRTC();
        if (event.monitors) {
          renderMonitorTabs(event.monitors);
        }
        webrtcManager.handleOffer(event.sdp).catch((err) => {
          console.error('[Renderer] handleOffer failed:', err);
          showToast('Failed to handle offer: ' + err.message, 'error');
        });
      }
      break;

    case 'webrtc-answer':
      console.log('[Renderer] Received WebRTC answer, sdp type:', event.sdp?.type, 'sdp length:', event.sdp?.sdp?.length);
      if (webrtcManager) {
        webrtcManager.handleAnswer(event.sdp).catch((err) => {
          console.error('[Renderer] handleAnswer failed:', err);
        });
      }
      break;

    case 'webrtc-ice-candidate':
      console.log('[Renderer] Received ICE candidate:', !!event.candidate);
      if (webrtcManager) {
        webrtcManager.handleIceCandidate(event.candidate).catch((err) => {
          console.error('[Renderer] handleIceCandidate failed:', err);
        });
      }
      break;

    case 'monitor-switch-request':
      if (isHosting && webrtcManager && typeof event.index === 'number') {
        handleMonitorSelect(event.index);
      }
      break;

    // --- Access control events ---
    case 'access-request':
      if (isHosting) {
        showAccessModal(event.requestId, event.clientMachineName, event.clientMachineId);
      }
      break;

    case 'access-auto-accepted':
      if (isHosting) {
        showToast(`Trusted machine "${event.clientMachineName}" auto-connected`, 'success');
      }
      break;

    case 'access-granted':
      // Client: access was granted, now treated as joined
      isJoined = true;
      joinBtn.disabled = false;
      joinBtn.textContent = 'Connected';
      joinBtn.classList.remove('btn-success');
      joinBtn.classList.add('btn-joined');
      setStatus(true);
      setTransferButtonsEnabled(true);
      showToast('Access granted — connected!', 'success');
      break;

    case 'access-denied':
      joinBtn.disabled = false;
      joinBtn.textContent = 'Connect';
      showError(event.reason || 'Access denied by host.');
      showToast(event.reason || 'Access denied', 'error');
      break;

    case 'access-timeout':
      if (isHosting) {
        hideAccessModal();
        showToast('Access request timed out', 'info');
      }
      break;

    // --- File transfer events ---
    case 'transfer-request':
      showTransferModal(event);
      break;

    case 'transfer-accepted': {
      const t = activeTransfers.get(event.transferId);
      if (t) {
        t.status = 'sending';
        t.startTime = Date.now();
        renderTransferItem(event.transferId);
      }
      break;
    }

    case 'transfer-denied': {
      const t = activeTransfers.get(event.transferId);
      if (t) {
        t.status = 'cancelled';
        renderTransferItem(event.transferId);
        showToast('Transfer denied by peer', 'info');
      }
      break;
    }

    case 'transfer-progress': {
      const t = activeTransfers.get(event.transferId);
      if (t) {
        if (event.direction === 'outgoing') {
          t.bytesSent = event.bytesSent;
        } else {
          t.bytesReceived = event.bytesReceived;
        }
        if (event.currentFile) t.currentFile = event.currentFile;
        if (event.totalSize) t.totalSize = event.totalSize;
        throttledRenderTransferItem(event.transferId);
      }
      break;
    }

    case 'transfer-complete': {
      const t = activeTransfers.get(event.transferId);
      if (t) {
        t.status = 'complete';
        renderTransferItem(event.transferId);
        showToast(`Transfer complete: ${t.name}`, 'success');
      }
      break;
    }

    case 'transfer-cancelled': {
      const t = activeTransfers.get(event.transferId);
      if (t) {
        t.status = 'cancelled';
        renderTransferItem(event.transferId);
        showToast('Transfer cancelled by peer', 'info');
      }
      break;
    }

    case 'transfer-error': {
      const t = activeTransfers.get(event.transferId);
      if (t) {
        t.status = 'error';
        t.errorMessage = event.message;
        renderTransferItem(event.transferId);
        showToast(`Transfer error: ${event.message}`, 'error');
      }
      break;
    }

    // --- Disconnection events ---
    case 'host-disconnected':
      cleanupWebRTC();
      hideViewer();
      isJoined = false;
      joinBtn.textContent = 'Connect';
      joinBtn.disabled = false;
      joinBtn.classList.remove('btn-joined');
      joinBtn.classList.add('btn-success');
      setStatus(false);
      setTransferButtonsEnabled(false);
      showToast('Host has disconnected', 'error');
      break;

    case 'client-disconnected':
      cleanupWebRTC();
      hideMonitorPanel();
      setTransferButtonsEnabled(false);
      showToast('Client has disconnected', 'info');
      break;

    case 'disconnected':
      cleanupWebRTC();
      hideAccessModal();
      setTransferButtonsEnabled(false);
      if (isHosting) {
        hideMonitorPanel();
        isHosting = false;
        idValueEl.textContent = '— — —';
        hostBtn.textContent = 'Start Hosting';
        hostBtn.classList.remove('btn-danger');
        hostBtn.classList.add('btn-primary');
      }
      if (isJoined) {
        hideViewer();
        isJoined = false;
        joinBtn.textContent = 'Connect';
        joinBtn.disabled = false;
        joinBtn.classList.remove('btn-joined');
        joinBtn.classList.add('btn-success');
      }
      setStatus(false);
      break;

    case 'error':
      showToast(event.message, 'error');
      break;
  }
});

// =============================================
// File Transfer UI
// =============================================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatEta(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function renderTransferItem(transferId) {
  const t = activeTransfers.get(transferId);
  if (!t) return;

  const list = document.getElementById('transfer-list');
  const emptyEl = document.getElementById('transfer-empty');
  if (emptyEl) emptyEl.style.display = 'none';

  let el = document.getElementById(`transfer-${transferId}`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'transfer-item';
    el.id = `transfer-${transferId}`;
    list.appendChild(el);
  }

  const isOutgoing = t.direction === 'outgoing';
  const icon = t.type === 'folder'
    ? '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="var(--accent-blue)" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="var(--accent-blue)" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2 5 5h-5V4zM6 20V4h5v6h6v10H6z"/></svg>';

  const dirBadge = isOutgoing
    ? '<span class="transfer-item-direction outgoing">Sending</span>'
    : '<span class="transfer-item-direction incoming">Receiving</span>';

  const totalBytes = t.totalSize || 0;
  const currentBytes = isOutgoing ? (t.bytesSent || 0) : (t.bytesReceived || 0);
  const percent = totalBytes > 0 ? Math.min(100, Math.round((currentBytes / totalBytes) * 100)) : 0;

  // Calculate speed/ETA
  let speedText = '';
  let etaText = '';
  if (t.status === 'sending' || t.status === 'receiving') {
    const now = Date.now();
    const elapsed = (now - (t.startTime || now)) / 1000;
    if (elapsed > 0.5) {
      const speed = currentBytes / elapsed;
      speedText = formatBytes(speed) + '/s';
      const remaining = totalBytes - currentBytes;
      etaText = speed > 0 ? formatEta(remaining / speed) : '--';
    }
  }

  let statusLabel = '';
  let progressSection = '';
  let actions = '';

  switch (t.status) {
    case 'pending':
      statusLabel = '<span class="transfer-item-status-label pending">Pending</span>';
      actions = `<button class="btn-transfer-cancel" data-transfer-id="${transferId}">Cancel</button>`;
      break;
    case 'sending':
    case 'receiving':
      progressSection = `
        <div class="transfer-progress-bar"><div class="transfer-progress-fill" style="width:${percent}%"></div></div>
        <div class="transfer-progress-stats">
          <span>${percent}% &middot; ${formatBytes(currentBytes)} / ${formatBytes(totalBytes)}</span>
          <span>${speedText}${etaText ? ' &middot; ' + etaText + ' left' : ''}</span>
        </div>
        ${t.currentFile ? `<div class="transfer-item-current-file">${escapeHtml(t.currentFile)}</div>` : ''}
      `;
      actions = `<button class="btn-transfer-cancel" data-transfer-id="${transferId}">Cancel</button>`;
      break;
    case 'complete':
      statusLabel = '<span class="transfer-item-status-label complete">Complete</span>';
      actions = `<button class="btn-transfer-dismiss" data-transfer-id="${transferId}">Dismiss</button>`;
      break;
    case 'cancelled':
      statusLabel = '<span class="transfer-item-status-label cancelled">Cancelled</span>';
      actions = `<button class="btn-transfer-dismiss" data-transfer-id="${transferId}">Dismiss</button>`;
      break;
    case 'error':
      statusLabel = `<span class="transfer-item-status-label error">Error${t.errorMessage ? ': ' + escapeHtml(t.errorMessage) : ''}</span>`;
      actions = `<button class="btn-transfer-dismiss" data-transfer-id="${transferId}">Dismiss</button>`;
      break;
  }

  const fileCountInfo = t.fileCount ? `${t.fileCount} file${t.fileCount > 1 ? 's' : ''}` : '';

  el.innerHTML = `
    <div class="transfer-item-icon">${icon}</div>
    <div class="transfer-item-info">
      <div class="transfer-item-name">${escapeHtml(t.name)}</div>
      <div class="transfer-item-meta">${dirBadge} ${formatBytes(totalBytes)}${fileCountInfo ? ' &middot; ' + fileCountInfo : ''}</div>
      ${statusLabel}
      ${progressSection}
    </div>
    <div class="transfer-item-actions">${actions}</div>
  `;

  // Bind action buttons
  const cancelBtn = el.querySelector('.btn-transfer-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      window.electronAPI.cancelTransfer({ transferId });
      t.status = 'cancelled';
      renderTransferItem(transferId);
    });
  }

  const dismissBtn = el.querySelector('.btn-transfer-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      activeTransfers.delete(transferId);
      el.remove();
      if (activeTransfers.size === 0) {
        const emptyEl = document.getElementById('transfer-empty');
        if (emptyEl) emptyEl.style.display = '';
      }
    });
  }
}

function throttledRenderTransferItem(transferId) {
  if (transferRafPending.has(transferId)) return;
  transferRafPending.add(transferId);
  requestAnimationFrame(() => {
    transferRafPending.delete(transferId);
    renderTransferItem(transferId);
  });
}

function showTransferModal(data) {
  pendingTransferRequest = data;
  document.getElementById('transfer-req-name').textContent = data.name || 'Unknown';
  document.getElementById('transfer-req-type').textContent = data.type === 'folder' ? 'Folder' : 'File';
  document.getElementById('transfer-req-size').textContent = 'Size: ' + formatBytes(data.totalSize || 0);
  document.getElementById('transfer-req-count').textContent = data.fileCount
    ? `${data.fileCount} file${data.fileCount > 1 ? 's' : ''}`
    : '';
  document.getElementById('transfer-modal').style.display = '';
}

function hideTransferModal() {
  document.getElementById('transfer-modal').style.display = 'none';
  pendingTransferRequest = null;
}

function respondToTransfer(accepted) {
  if (!pendingTransferRequest) return;
  const transferId = pendingTransferRequest.transferId;

  window.electronAPI.respondToTransfer({ transferId, accepted });

  if (accepted) {
    activeTransfers.set(transferId, {
      ...pendingTransferRequest,
      direction: 'incoming',
      status: 'receiving',
      bytesReceived: 0,
      startTime: Date.now(),
    });
    renderTransferItem(transferId);
    showToast('Transfer accepted', 'success');
  } else {
    showToast('Transfer denied', 'info');
  }

  hideTransferModal();
}

// Transfer modal buttons
document.getElementById('transfer-deny').addEventListener('click', () => respondToTransfer(false));
document.getElementById('transfer-accept').addEventListener('click', () => respondToTransfer(true));

// Send Files button
document.getElementById('btn-send-files').addEventListener('click', async () => {
  const transfers = await window.electronAPI.selectFiles();
  if (!transfers) return;

  for (const t of transfers) {
    activeTransfers.set(t.transferId, {
      ...t,
      direction: 'outgoing',
      status: 'pending',
      bytesSent: 0,
      fileCount: t.files ? t.files.length : 0,
      startTime: Date.now(),
    });
    window.electronAPI.sendTransferRequest({
      transferId: t.transferId,
      name: t.name,
      type: t.type,
      totalSize: t.totalSize,
      fileCount: t.files ? t.files.length : 0,
    });
    renderTransferItem(t.transferId);
  }
});

// Send Folder button
document.getElementById('btn-send-folder').addEventListener('click', async () => {
  const transfers = await window.electronAPI.selectFolder();
  if (!transfers) return;

  for (const t of transfers) {
    activeTransfers.set(t.transferId, {
      ...t,
      direction: 'outgoing',
      status: 'pending',
      bytesSent: 0,
      fileCount: t.files ? t.files.length : 0,
      startTime: Date.now(),
    });
    window.electronAPI.sendTransferRequest({
      transferId: t.transferId,
      name: t.name,
      type: t.type,
      totalSize: t.totalSize,
      fileCount: t.files ? t.files.length : 0,
    });
    renderTransferItem(t.transferId);
  }
});

// Open Downloads button
document.getElementById('btn-open-downloads').addEventListener('click', () => {
  window.electronAPI.openDownloadsFolder();
});

// Enable/disable transfer buttons based on connection state
function setTransferButtonsEnabled(enabled) {
  document.getElementById('btn-send-files').disabled = !enabled;
  document.getElementById('btn-send-folder').disabled = !enabled;
}

// =============================================
// Initialize
// =============================================
initMachineInfo();
