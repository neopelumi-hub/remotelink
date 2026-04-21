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

// --- Chat state ---
const chatMessages = [];
let chatConnectedPeer = null; // { name, id }
let chatUnreadCount = 0;
let remoteIsTyping = false;
let typingTimeout = null;
let lastTypingSent = 0;
let chatAudioCtx = null;

// --- Remote control state ---
let controlActive = false;
let lastMouseMoveTime = 0;
const MOUSE_THROTTLE_MS = 16; // ~60fps cap

// --- Connection mode state ---
let connectionMode = 'session'; // 'session' or 'machine'
let currentAccessRequest = null;
let accessTimerInterval = null;
let accessCountdown = 30;

// --- Console state ---
let consoleRole = null;
let consoleMasterKey = null;
let consoleNodes = new Map();
let consoleAlerts = [];
let consoleUnreadCount = 0;
let consoleManagingNodeId = null;

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
      renderConsoleSettings();
    }

    // Refresh + render console dashboard when navigating to console page
    if (targetPage === 'console') {
      refreshConsoleNodes();
    }

    // Mark chat messages as read when switching to chat page
    if (targetPage === 'chat') {
      // Render any unread messages that arrived while on other pages
      const unrendered = chatMessages.filter(m => !document.getElementById(`chat-msg-${m.id}`));
      unrendered.forEach(m => renderChatMessage(m));
      markChatAsRead();
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
  statusDot.classList.remove('offline', 'online', 'reconnecting');
  statusDot.classList.add(online ? 'online' : 'offline');
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
    const aboutId = document.getElementById('about-machine-id');
    if (aboutId) {
      const val = aboutId.querySelector('.about-machine-id-value');
      if (val) val.textContent = info.machineId;
    }
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
    clearChatUI();
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
    setChatPeer('Host', null);
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
  showModal('access-modal');

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
  hideModal('access-modal');
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

    // Load and apply settings toggles
    const settings = await window.electronAPI.getSettings();
    document.getElementById('toggle-start-windows').checked = settings.startWithWindows;
    document.getElementById('toggle-start-minimized').checked = settings.startMinimized;
    document.getElementById('toggle-show-notifications').checked = settings.showNotifications;

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
// Auto-updater events
// =============================================
if (window.electronAPI.onUpdateReady) {
  window.electronAPI.onUpdateReady(({ version }) => {
    const banner = document.getElementById('update-banner');
    if (banner) {
      const text = banner.querySelector('.update-banner-text');
      if (text) text.textContent = `Update v${version} installed — restart to apply`;
      banner.hidden = false;
    }
    showToast(`Update v${version} installed — restart to apply`, 'success');
  });
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
      setChatPeer(event.clientMachineName || 'Client', event.clientMachineId);
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
      setChatPeer('Host', null);
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

    // --- Chat events ---
    case 'chat-message': {
      const msg = {
        id: event.id,
        sender: 'remote',
        senderName: event.senderName,
        text: event.text,
        timestamp: event.timestamp,
        delivered: true,
        read: false,
      };
      chatMessages.push(msg);

      if (!chatConnectedPeer && event.senderName) {
        setChatPeer(event.senderName, null);
      }

      if (isChatPageActive()) {
        renderChatMessage(msg);
        msg.read = true;
        window.electronAPI.sendChatRead({ messageId: msg.id });
      } else {
        chatUnreadCount++;
        updateChatBadge();
        showToast(`${event.senderName}: ${event.text.slice(0, 60)}${event.text.length > 60 ? '...' : ''}`, 'info');
      }
      playNotificationSound();
      break;
    }

    case 'chat-delivered': {
      const msg = chatMessages.find(m => m.id === event.messageId);
      if (msg) {
        msg.delivered = true;
        updateMessageReceipt(event.messageId, 'delivered');
      }
      break;
    }

    case 'chat-read': {
      for (const msg of chatMessages) {
        if (msg.sender === 'local' && !msg.read) {
          msg.read = true;
          updateMessageReceipt(msg.id, 'read');
        }
        if (msg.id === event.messageId) break;
      }
      break;
    }

    case 'chat-typing':
      remoteIsTyping = !!event.typing;
      document.getElementById('chat-typing').style.display = remoteIsTyping ? '' : 'none';
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
      clearChatUI();
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
      clearChatUI();
      setTransferButtonsEnabled(false);
      showToast('Client has disconnected', 'info');
      break;

    case 'connected':
      setStatus(true);
      break;

    case 'disconnected':
      cleanupWebRTC();
      hideAccessModal();
      clearChatUI();
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

    case 'reconnecting':
      setStatus(false);
      statusLabel.textContent = 'Reconnecting...';
      statusDot.classList.remove('online', 'offline');
      statusDot.classList.add('reconnecting');
      break;

    case 'hosting-resumed':
      // Server reconnected and hosting was automatically resumed
      isHosting = true;
      idValueEl.textContent = event.sessionId;
      hostBtn.textContent = 'Stop Hosting';
      hostBtn.classList.remove('btn-primary');
      hostBtn.classList.add('btn-danger');
      hostBtn.disabled = false;
      setStatus(true);
      showToast('Reconnected — hosting resumed', 'success');
      break;

    case 'hosting-started':
      // Hosting started from tray
      isHosting = true;
      idValueEl.textContent = event.sessionId;
      hostBtn.textContent = 'Stop Hosting';
      hostBtn.classList.remove('btn-primary');
      hostBtn.classList.add('btn-danger');
      hostBtn.disabled = false;
      setStatus(true);
      showToast('Hosting started from tray', 'success');
      break;

    case 'hosting-stopped':
      // Hosting stopped from tray
      if (webrtcManager) {
        webrtcManager.destroy();
        webrtcManager = null;
      }
      hideMonitorPanel();
      clearChatUI();
      isHosting = false;
      idValueEl.textContent = '— — —';
      hostBtn.textContent = 'Start Hosting';
      hostBtn.classList.remove('btn-danger');
      hostBtn.classList.add('btn-primary');
      setStatus(false);
      setTransferButtonsEnabled(false);
      showToast('Hosting stopped from tray', 'info');
      break;

    case 'error':
      showToast(event.message, 'error');
      break;

    // --- Console events ---
    case 'console-nodes-updated':
      consoleNodes = new Map((event.nodes || []).map(n => [n.machineId, n]));
      renderConsoleDashboard();
      break;

    case 'console-node-online':
      // Use full nodes array if provided, otherwise update individually
      if (event.nodes) {
        consoleNodes = new Map(event.nodes.map(n => [n.machineId, n]));
      } else if (consoleNodes.has(event.machineId)) {
        const node = consoleNodes.get(event.machineId);
        node.status = 'online';
        node.activity = 'active';
      } else {
        consoleNodes.set(event.machineId, { machineId: event.machineId, name: event.name, machineName: event.machineName, status: 'online', activity: 'active' });
      }
      if (event.alerts) consoleAlerts = event.alerts;
      if (event.unreadCount !== undefined) consoleUnreadCount = event.unreadCount;
      updateConsoleBadge(consoleUnreadCount);
      renderConsoleDashboard();
      break;

    case 'console-node-offline':
      // Use full nodes array if provided, otherwise update individually
      if (event.nodes) {
        consoleNodes = new Map(event.nodes.map(n => [n.machineId, n]));
      } else if (consoleNodes.has(event.machineId)) {
        const node = consoleNodes.get(event.machineId);
        node.status = 'offline';
        node.activity = 'offline';
      }
      if (event.alerts) consoleAlerts = event.alerts;
      if (event.unreadCount !== undefined) consoleUnreadCount = event.unreadCount;
      updateConsoleBadge(consoleUnreadCount);
      renderConsoleDashboard();
      break;

    case 'console-activity-update':
      if (consoleNodes.has(event.machineId)) {
        const node = consoleNodes.get(event.machineId);
        node.activity = event.activity;
        if (event.systemInfo) node.systemInfo = event.systemInfo;
      }
      if (event.alerts) consoleAlerts = event.alerts;
      if (event.unreadCount !== undefined) consoleUnreadCount = event.unreadCount;
      updateConsoleBadge(consoleUnreadCount);
      renderConsoleDashboard();
      break;

    case 'console-system-info':
      if (consoleNodes.has(event.machineId)) {
        consoleNodes.get(event.machineId).systemInfo = event.info;
      }
      renderConsoleDashboard();
      break;

    case 'console-alert-update':
      if (event.alerts) consoleAlerts = event.alerts;
      if (event.unreadCount !== undefined) consoleUnreadCount = event.unreadCount;
      updateConsoleBadge(consoleUnreadCount);
      renderConsoleDashboard();
      break;

    case 'console-master-revoked':
      consoleRole = null;
      consoleMasterKey = null;
      consoleNodes = new Map();
      consoleAlerts = [];
      consoleUnreadCount = 0;
      hideConsoleSidebarButton();
      updateConsoleBadge(0);
      renderConsoleSettings();
      showToast('Master console has been revoked', 'info');
      break;

    case 'console-notification':
      showToast(event.message, 'info');
      break;

    case 'console-connect-error':
      showToast(event.error, 'error');
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
  showModal('transfer-modal');
}

function hideTransferModal() {
  hideModal('transfer-modal');
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
// Chat UI
// =============================================

const EMOJI_LIST = [
  '😀','😂','😊','😍','🥰','😎','🤔','😅','😢','😭',
  '😤','🤣','😏','🙄','😴','🤗','😇','🤩','😋','😜',
  '👍','👎','👋','🙌','👏','🤝','💪','🎉','🔥','❤️',
  '💯','✅','❌','⭐','💡','📎','🖥️','📁','🔒','🔓',
];

function playNotificationSound() {
  try {
    if (!chatAudioCtx) chatAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = chatAudioCtx.createOscillator();
    const gain = chatAudioCtx.createGain();
    osc.connect(gain);
    gain.connect(chatAudioCtx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.value = 0.08;
    gain.gain.exponentialRampToValueAtTime(0.001, chatAudioCtx.currentTime + 0.15);
    osc.start();
    osc.stop(chatAudioCtx.currentTime + 0.15);
  } catch (e) { /* ignore audio errors */ }
}

function formatChatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isChatPageActive() {
  const chatPage = document.getElementById('page-chat');
  return chatPage && chatPage.classList.contains('active');
}

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (chatUnreadCount > 0) {
    badge.textContent = chatUnreadCount > 99 ? '99+' : chatUnreadCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function renderChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  const emptyEl = document.getElementById('chat-empty');
  if (emptyEl) emptyEl.style.display = 'none';

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${msg.sender === 'local' ? 'chat-bubble-local' : 'chat-bubble-remote'}`;
  bubble.id = `chat-msg-${msg.id}`;

  const textEl = document.createElement('div');
  textEl.className = 'chat-bubble-text';
  textEl.textContent = msg.text;

  const metaEl = document.createElement('div');
  metaEl.className = 'chat-bubble-meta';

  let metaContent = formatChatTime(msg.timestamp);
  if (msg.sender === 'local') {
    let receipt = '';
    if (msg.read) {
      receipt = '<span class="chat-receipt read" title="Read">&#10003;&#10003;</span>';
    } else if (msg.delivered) {
      receipt = '<span class="chat-receipt delivered" title="Delivered">&#10003;&#10003;</span>';
    } else {
      receipt = '<span class="chat-receipt" title="Sent">&#10003;</span>';
    }
    metaContent += ' ' + receipt;
  }
  metaEl.innerHTML = metaContent;

  bubble.appendChild(textEl);
  bubble.appendChild(metaEl);
  container.appendChild(bubble);
  scrollChatToBottom();
}

function updateMessageReceipt(messageId, status) {
  const el = document.getElementById(`chat-msg-${messageId}`);
  if (!el) return;
  const meta = el.querySelector('.chat-bubble-meta');
  if (!meta) return;

  const receiptEl = meta.querySelector('.chat-receipt');
  if (!receiptEl) return;

  if (status === 'read') {
    receiptEl.className = 'chat-receipt read';
    receiptEl.title = 'Read';
    receiptEl.innerHTML = '&#10003;&#10003;';
  } else if (status === 'delivered') {
    receiptEl.className = 'chat-receipt delivered';
    receiptEl.title = 'Delivered';
    receiptEl.innerHTML = '&#10003;&#10003;';
  }
}

function clearChatUI() {
  chatMessages.length = 0;
  chatConnectedPeer = null;
  chatUnreadCount = 0;
  remoteIsTyping = false;
  updateChatBadge();
  document.getElementById('chat-header-title').textContent = 'No active session';
  document.getElementById('chat-typing').style.display = 'none';
  const container = document.getElementById('chat-messages');
  container.innerHTML = `
    <div class="chat-empty" id="chat-empty">
      <svg viewBox="0 0 24 24" width="48" height="48"><path fill="var(--text-muted)" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
      <p>No messages yet. Start the conversation!</p>
    </div>
  `;
  setChatEnabled(false);
  window.electronAPI.clearChat();
}

function setChatEnabled(enabled) {
  document.getElementById('chat-input').disabled = !enabled;
  document.getElementById('chat-send-btn').disabled = !enabled;
}

function setChatPeer(name, id) {
  chatConnectedPeer = { name, id };
  document.getElementById('chat-header-title').textContent = `Connected to ${name || id || 'peer'}`;
  setChatEnabled(true);
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !(isHosting || isJoined)) return;

  const info = await window.electronAPI.getMachineInfo();
  const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

  const msg = {
    id,
    sender: 'local',
    senderName: info.machineName,
    text,
    timestamp: Date.now(),
    delivered: false,
    read: false,
  };

  chatMessages.push(msg);
  renderChatMessage(msg);

  window.electronAPI.sendChatMessage({
    id,
    text,
    senderName: info.machineName,
  });

  input.value = '';
  // Send stop-typing
  window.electronAPI.sendTypingIndicator({ typing: false });
}

// Chat input handlers
document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

document.getElementById('chat-input').addEventListener('input', () => {
  if (!(isHosting || isJoined)) return;
  const now = Date.now();
  if (now - lastTypingSent > 2000) {
    lastTypingSent = now;
    window.electronAPI.sendTypingIndicator({ typing: true });
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    window.electronAPI.sendTypingIndicator({ typing: false });
  }, 3000);
});

// Emoji picker
function buildEmojiPicker() {
  const picker = document.getElementById('chat-emoji-picker');
  picker.innerHTML = '';
  EMOJI_LIST.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      const input = document.getElementById('chat-input');
      input.value += emoji;
      input.focus();
    });
    picker.appendChild(btn);
  });
}

document.getElementById('chat-emoji-btn').addEventListener('click', () => {
  const picker = document.getElementById('chat-emoji-picker');
  const isVisible = picker.style.display !== 'none';
  picker.style.display = isVisible ? 'none' : '';
  if (!isVisible && picker.children.length === 0) {
    buildEmojiPicker();
  }
});

// Close emoji picker when clicking outside
document.getElementById('chat-messages').addEventListener('click', () => {
  document.getElementById('chat-emoji-picker').style.display = 'none';
});

// Mark messages as read when chat page is active
function markChatAsRead() {
  if (!isChatPageActive()) return;
  const unread = chatMessages.filter(m => m.sender === 'remote' && !m.read);
  if (unread.length === 0) return;

  const lastMsg = unread[unread.length - 1];
  unread.forEach(m => m.read = true);
  chatUnreadCount = 0;
  updateChatBadge();
  window.electronAPI.sendChatRead({ messageId: lastMsg.id });
}

// =============================================
// Settings Toggle Handlers
// =============================================

document.getElementById('toggle-start-windows').addEventListener('change', (e) => {
  window.electronAPI.updateSetting('startWithWindows', e.target.checked);
});

document.getElementById('toggle-start-minimized').addEventListener('change', (e) => {
  window.electronAPI.updateSetting('startMinimized', e.target.checked);
});

document.getElementById('toggle-show-notifications').addEventListener('change', (e) => {
  window.electronAPI.updateSetting('showNotifications', e.target.checked);
});

// =============================================
// Console Dashboard
// =============================================

async function initConsole() {
  try {
    const config = await window.electronAPI.getConsoleConfig();
    consoleRole = config.role;
    consoleMasterKey = config.console?.masterKey || null;

    if (consoleRole === 'master') {
      showConsoleSidebarButton();
      const nodes = await window.electronAPI.getConsoleNodes();
      consoleNodes = new Map((nodes || []).map(n => [n.machineId, n]));
      const alertData = await window.electronAPI.getConsoleAlerts();
      consoleAlerts = alertData.alerts || [];
      consoleUnreadCount = alertData.unreadCount || 0;
      updateConsoleBadge(consoleUnreadCount);
    } else {
      hideConsoleSidebarButton();
    }
    renderConsoleSettings();
  } catch (e) {
    console.error('[Console] Init error:', e);
  }
}

function showConsoleSidebarButton() {
  const btn = document.getElementById('sidebar-console');
  if (btn) btn.style.display = '';
}

function hideConsoleSidebarButton() {
  const btn = document.getElementById('sidebar-console');
  if (btn) btn.style.display = 'none';
}

function updateConsoleBadge(count) {
  const badge = document.getElementById('console-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

async function refreshConsoleNodes() {
  try {
    const nodes = await window.electronAPI.getConsoleNodes();
    consoleNodes = new Map((nodes || []).map(n => [n.machineId, n]));
  } catch (e) {
    console.error('[Console] Refresh error:', e);
  }
  renderConsoleDashboard();
}

function renderConsoleDashboard() {
  renderNodeGrid();
  renderAlertsFeed();
}

function renderNodeGrid() {
  const grid = document.getElementById('console-node-grid');
  if (!grid) return;

  const count = document.getElementById('console-node-count');
  if (count) count.textContent = `(${consoleNodes.size})`;

  if (consoleNodes.size === 0) {
    grid.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" width="48" height="48"><path fill="var(--text-muted)" d="M4 2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6l2 3v1H8v-1l2-3H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 2v10h16V4H4z"/></svg>
      <div class="empty-state-title">No nodes registered</div>
      <div class="empty-state-subtitle">Register machines as nodes from Settings to monitor them here.</div>
    </div>`;
    return;
  }

  let html = '';
  for (const [machineId, node] of consoleNodes) {
    const status = node.activity || node.status || 'offline';
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
    const name = node.name || node.machineName || machineId;
    const sysInfo = node.systemInfo;
    let infoLine = '';
    if (sysInfo) {
      infoLine = `${sysInfo.platform || ''} | ${sysInfo.cpuCores || '?'} cores | ${sysInfo.usedMemoryPercent || '?'}% mem`;
    }

    html += `
      <div class="console-node-card ${status}" data-machine-id="${machineId}">
        <div class="console-node-header">
          <span class="console-node-name">${escapeHtml(name)}</span>
          <span class="console-node-status ${status}">
            <span class="status-indicator"></span>
            ${statusLabel}
          </span>
        </div>
        ${infoLine ? `<div class="console-node-info">${escapeHtml(infoLine)}</div>` : ''}
        <div class="console-node-actions">
          <button class="btn-node-connect" data-connect-id="${machineId}" ${status === 'offline' ? 'disabled' : ''}>Connect</button>
          <button class="btn-node-manage" data-manage-id="${machineId}">Manage</button>
        </div>
      </div>
    `;
  }
  grid.innerHTML = html;

  // Attach event listeners
  grid.querySelectorAll('.btn-node-connect').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleQuickConnect(btn.dataset.connectId);
    });
  });

  grid.querySelectorAll('.btn-node-manage').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showNodeManageModal(btn.dataset.manageId);
    });
  });
}

function renderAlertsFeed() {
  const feed = document.getElementById('console-alerts-feed');
  if (!feed) return;

  if (consoleAlerts.length === 0) {
    feed.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" width="40" height="40"><path fill="var(--text-muted)" d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
      <div class="empty-state-title">No alerts yet</div>
      <div class="empty-state-subtitle">Node status changes will appear here.</div>
    </div>`;
    return;
  }

  const shown = consoleAlerts.slice(0, 50);
  let html = '';
  for (const alert of shown) {
    html += `
      <div class="console-alert-item ${alert.read ? '' : 'unread'}">
        <span class="console-alert-icon ${alert.priority}"></span>
        <span class="console-alert-message">${escapeHtml(alert.message)}</span>
        <span class="console-alert-time">${formatAlertTime(alert.timestamp)}</span>
      </div>
    `;
  }
  feed.innerHTML = html;
}

function formatAlertTime(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function handleQuickConnect(machineId) {
  window.electronAPI.quickConnectToNode(machineId);
  showToast('Connecting to node...', 'info');
}

function showNodeManageModal(machineId) {
  consoleManagingNodeId = machineId;
  const node = consoleNodes.get(machineId);
  if (!node) return;

  const modal = document.getElementById('node-manage-modal');
  document.getElementById('node-manage-title').textContent = node.name || node.machineName || 'Node Details';
  document.getElementById('node-manage-id').textContent = machineId;
  document.getElementById('node-manage-status').textContent = (node.activity || node.status || 'offline').charAt(0).toUpperCase() + (node.activity || node.status || 'offline').slice(1);
  document.getElementById('node-manage-rename').value = node.name || '';
  showModal('node-manage-modal');
}

function hideNodeManageModal() {
  hideModal('node-manage-modal');
  consoleManagingNodeId = null;
}

function renderConsoleSettings() {
  const noRole = document.getElementById('console-no-role');
  const masterInfo = document.getElementById('console-master-info');
  const nodeInfo = document.getElementById('console-node-info');

  if (!noRole || !masterInfo || !nodeInfo) return;

  noRole.style.display = 'none';
  masterInfo.style.display = 'none';
  nodeInfo.style.display = 'none';

  if (consoleRole === 'master') {
    masterInfo.style.display = '';
    document.getElementById('console-master-key-display').textContent = consoleMasterKey || '------';
  } else if (consoleRole === 'node') {
    nodeInfo.style.display = '';
    document.getElementById('console-node-key-display').textContent = consoleMasterKey || '------';
    window.electronAPI.getConsoleConfig().then(cfg => {
      document.getElementById('console-node-name-display').textContent = cfg.console?.nodeName || '—';
    });
  } else {
    noRole.style.display = '';
  }
}

// --- Console Settings Button Handlers ---

document.getElementById('btn-setup-master')?.addEventListener('click', () => {
  showModal('master-setup-modal');
  // Reset to step 1
  document.getElementById('master-setup-step1').classList.add('active');
  document.getElementById('master-setup-step2').classList.remove('active');
  document.getElementById('master-password-input').value = '';
  document.getElementById('master-password-confirm').value = '';
  document.getElementById('master-setup-error').textContent = '';
  document.getElementById('master-password-input').focus();
});

document.getElementById('master-setup-cancel')?.addEventListener('click', () => {
  hideModal('master-setup-modal');
});

document.getElementById('master-setup-confirm')?.addEventListener('click', async () => {
  const pass = document.getElementById('master-password-input').value;
  const confirmVal = document.getElementById('master-password-confirm').value;
  const errorEl = document.getElementById('master-setup-error');

  if (!pass || pass.length < 4) {
    errorEl.textContent = 'Password must be at least 4 characters.';
    return;
  }
  if (pass !== confirmVal) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }

  const result = await window.electronAPI.setupMaster(pass);
  if (result.masterKey) {
    consoleRole = 'master';
    consoleMasterKey = result.masterKey;
    showConsoleSidebarButton();
    renderConsoleSettings();

    // Show step 2 with keys
    document.getElementById('master-setup-step1').classList.remove('active');
    document.getElementById('master-setup-step2').classList.add('active');
    document.getElementById('setup-master-key-value').textContent = result.masterKey;
    document.getElementById('setup-recovery-key-value').textContent = result.recoveryKey || '------';
  }
});

document.getElementById('master-setup-done')?.addEventListener('click', () => {
  hideModal('master-setup-modal');
  showToast(`Master Console set up! Key: ${consoleMasterKey}`, 'success');
});

document.getElementById('setup-copy-master-key')?.addEventListener('click', () => {
  const val = document.getElementById('setup-master-key-value')?.textContent;
  if (val && val !== '------') {
    navigator.clipboard.writeText(val);
    showToast('Master key copied', 'success');
  }
});

document.getElementById('setup-copy-recovery-key')?.addEventListener('click', () => {
  const val = document.getElementById('setup-recovery-key-value')?.textContent;
  if (val && val !== '------') {
    navigator.clipboard.writeText(val);
    showToast('Recovery key copied', 'success');
  }
});

document.getElementById('btn-register-node')?.addEventListener('click', () => {
  showModal('node-register-modal');
  document.getElementById('node-master-key-input').value = '';
  document.getElementById('node-friendly-name-input').value = '';
  document.getElementById('node-register-error').textContent = '';
  document.getElementById('node-master-key-input').focus();
});

document.getElementById('node-register-cancel')?.addEventListener('click', () => {
  hideModal('node-register-modal');
});

document.getElementById('node-register-confirm')?.addEventListener('click', async () => {
  const masterKey = document.getElementById('node-master-key-input').value.trim().toUpperCase();
  const nodeName = document.getElementById('node-friendly-name-input').value.trim();
  const errorEl = document.getElementById('node-register-error');

  if (!masterKey || masterKey.length !== 6) {
    errorEl.textContent = 'Master Key must be 6 characters.';
    return;
  }
  if (!nodeName) {
    errorEl.textContent = 'Please enter a friendly name.';
    return;
  }

  const result = await window.electronAPI.registerNode({ masterKey, nodeName });
  if (result.error) {
    errorEl.textContent = result.error;
    return;
  }

  consoleRole = 'node';
  consoleMasterKey = masterKey;
  hideConsoleSidebarButton();
  renderConsoleSettings();
  hideModal('node-register-modal');
  showToast('Registered as node successfully!', 'success');
});

document.getElementById('btn-revoke-master')?.addEventListener('click', () => {
  showModal('revoke-password-modal');
  document.getElementById('revoke-password-input').value = '';
  document.getElementById('revoke-password-error').textContent = '';
  document.getElementById('revoke-password-input').focus();
});

document.getElementById('revoke-password-cancel')?.addEventListener('click', () => {
  hideModal('revoke-password-modal');
});

document.getElementById('revoke-password-confirm')?.addEventListener('click', async () => {
  const pass = document.getElementById('revoke-password-input').value;
  const errorEl = document.getElementById('revoke-password-error');

  if (!pass) {
    errorEl.textContent = 'Please enter your password.';
    return;
  }

  const valid = await window.electronAPI.verifyMasterPassword(pass);
  if (!valid) {
    errorEl.textContent = 'Incorrect password.';
    return;
  }

  window.electronAPI.revokeMaster();
  consoleRole = null;
  consoleMasterKey = null;
  consoleNodes = new Map();
  consoleAlerts = [];
  consoleUnreadCount = 0;
  hideConsoleSidebarButton();
  updateConsoleBadge(0);
  renderConsoleSettings();
  hideModal('revoke-password-modal');
  showToast('Master console revoked.', 'info');
});

document.getElementById('btn-unregister-node')?.addEventListener('click', () => {
  window.electronAPI.unregisterNode();
  consoleRole = null;
  consoleMasterKey = null;
  renderConsoleSettings();
  showToast('Unregistered from master console.', 'info');
});

// --- Console idle timeout selector ---
document.getElementById('console-idle-timeout')?.addEventListener('change', (e) => {
  window.electronAPI.setIdleTimeout(parseInt(e.target.value, 10));
});

// --- Dismiss All Alerts ---
document.getElementById('btn-dismiss-all-alerts')?.addEventListener('click', () => {
  window.electronAPI.dismissAllConsoleAlerts();
  consoleAlerts.forEach(a => a.read = true);
  consoleUnreadCount = 0;
  updateConsoleBadge(0);
  renderConsoleDashboard();
});

// --- Refresh nodes from server ---
document.getElementById('btn-refresh-nodes')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-nodes');
  btn.textContent = 'Refreshing...';
  btn.disabled = true;
  try {
    const nodes = await window.electronAPI.getConsoleNodes();
    consoleNodes = new Map((nodes || []).map(n => [n.machineId, n]));
    renderConsoleDashboard();
    showToast('Node list refreshed', 'success');
  } catch (e) {
    showToast('Failed to refresh nodes', 'error');
  }
  btn.textContent = 'Refresh';
  btn.disabled = false;
});

// --- Node Manage Modal handlers ---
document.getElementById('node-manage-connect')?.addEventListener('click', () => {
  if (consoleManagingNodeId) {
    handleQuickConnect(consoleManagingNodeId);
    hideNodeManageModal();
  }
});

document.getElementById('node-manage-remove')?.addEventListener('click', () => {
  if (consoleManagingNodeId) {
    window.electronAPI.removeConsoleNode(consoleManagingNodeId);
    consoleNodes.delete(consoleManagingNodeId);
    renderConsoleDashboard();
    hideNodeManageModal();
    showToast('Node removed.', 'info');
  }
});

document.getElementById('node-manage-close')?.addEventListener('click', () => {
  // Save rename if changed
  if (consoleManagingNodeId) {
    const newName = document.getElementById('node-manage-rename').value.trim();
    const node = consoleNodes.get(consoleManagingNodeId);
    if (newName && node && newName !== node.name) {
      window.electronAPI.renameConsoleNode({ machineId: consoleManagingNodeId, newName });
      node.name = newName;
      renderConsoleDashboard();
    }
  }
  hideNodeManageModal();
});

// =============================================
// About Section
// =============================================

function renderAboutSection() {
  // Machine ID is already populated by initMachineInfo
}

document.getElementById('about-copy-machine-id')?.addEventListener('click', () => {
  const val = document.querySelector('.about-machine-id-value');
  if (val && val.textContent && val.textContent !== '--------------') {
    navigator.clipboard.writeText(val.textContent);
    showToast('Machine ID copied', 'success');
  }
});

// =============================================
// Modal Animation Helpers
// =============================================

function showModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.style.display = '';
  requestAnimationFrame(() => {
    modal.classList.add('modal-visible');
  });
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('modal-visible');
  setTimeout(() => {
    modal.style.display = 'none';
  }, 200);
}

// =============================================
// Recovery Flow
// =============================================

document.getElementById('revoke-forgot-password')?.addEventListener('click', () => {
  hideModal('revoke-password-modal');
  showModal('master-recovery-modal');
  document.getElementById('recovery-key-input').value = '';
  document.getElementById('recovery-new-password').value = '';
  document.getElementById('recovery-confirm-password').value = '';
  document.getElementById('recovery-error').textContent = '';
  document.getElementById('recovery-key-input').focus();
});

document.getElementById('recovery-cancel')?.addEventListener('click', () => {
  hideModal('master-recovery-modal');
});

document.getElementById('recovery-confirm')?.addEventListener('click', async () => {
  const recoveryKey = document.getElementById('recovery-key-input').value.trim().toUpperCase();
  const newPassword = document.getElementById('recovery-new-password').value;
  const confirmPassword = document.getElementById('recovery-confirm-password').value;
  const errorEl = document.getElementById('recovery-error');

  if (!recoveryKey) {
    errorEl.textContent = 'Please enter your recovery key.';
    return;
  }
  if (!newPassword || newPassword.length < 4) {
    errorEl.textContent = 'New password must be at least 4 characters.';
    return;
  }
  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }

  const result = await window.electronAPI.recoverMaster({ recoveryKey, newPassword });
  if (result.success) {
    hideModal('master-recovery-modal');
    showToast('Password reset successfully!', 'success');
    renderConsoleSettings();
  } else {
    errorEl.textContent = 'Invalid recovery key.';
  }
});

// =============================================
// Initialize
// =============================================
async function init() {
  await initMachineInfo();
  await initConsole();
  renderAboutSection();

  // Dismiss loading screen
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('loaded');
    setTimeout(() => loadingScreen.remove(), 500);
  }
}

init();
